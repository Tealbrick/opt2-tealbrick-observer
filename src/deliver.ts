// S4: deliveries to Knowledge (C373). The outbox drain is ONE job on the SDK runner (`obs.deliver`): every tick it sends the due
// outbox rows (obs_deliveries, written by decideRecord for the owner's click or a rule) through the Knowledge companion grant:
//
//   knowledge.document_create { area, title, body, summary, tags, status }          the first delivery
//   knowledge.document_update { id, title, body, summary, tags, status }            a newer revision
//
// status: "published" for the owner's click; a rule that delivers says its own ("as draft" → "draft"), and may name its own area.
//
// with `idempotencyKey` = the row's stored key. The call is built ONCE, at the first attempt, and stored (`payload_json`): every
// retry sends the same bytes with the same key, so a send whose answer was lost cannot make a second document.
//  - area: the rule's area when a rule delivered it and names one, else the owner's pick (Routing page, obs_settings
//    `delivery_area`), else Knowledge's shared company area (the `shared` area of
//    `areas_list`; "company" when the list cannot say)
//  - body: the record's stored text (a CSV document, e.g. a database table page, has its formula cells escaped: = + - @ get a leading ') (secrets were removed before storage). `deliver_redacted` replaces every detected span with its
//    label ([email], [name], …) and leaves author handles out; `deliver` keeps them. Control, bidi and zero-width characters go
//  - tags: `observer`, `source:<collection or conversation>`, `pii:<class>` for every class found, `kind:<kind>` for a document
//    with a kind hint (`kind:table` for database table pages); normalised the way Knowledge stores them, at most 20
//  - which Knowledge document a thing lives in is kept per provenance (obs_targets): a document by (account, collection, id), a
//    message record by its id. A newer revision updates that document; if Knowledge no longer has it, the next attempt creates one
//  - before every send: `deliverySendable` (still the owner's last decision, not superseded, not a secret record)
//  - answers: ok → `sent` (the record is `delivered`); held (an owner policy in Knowledge) → `held`, asked again every minute with
//    the same key until decided; a refusal that cannot get better (403, 404, 400, 422) → `failed` with a plain sentence; anything
//    else → retried with backoff, `failed` after 5 attempts. Activity shows every state; Retry there sends it again
//  - Observer sends only to Knowledge in this version: a row for Task Board or Inbox fails with a sentence that says so
//  - Knowledge not reachable (no companion grant in the slice): the row waits (no attempt counted) and says why
import { normalizeTag } from "@opt2-tealbrick/manifest";
import type { Db, Job, JobContext, JobOutcome, JobSpec, JobsApi, Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { classifyText } from "./classify.ts";
import { now as clockNow } from "./clock.ts";
import { companionTargets } from "./connect.ts";
import { cleanText } from "./contract.ts";
import { LABELS } from "./detect/redact.ts";
import type { DetectClass } from "./detect/types.ts";
import { piiClassesOf } from "./router.ts";
import { deliverySendable, getSetting, humanTime, loadClassifierConfig, parsePii, putSetting, type Row, recordRow, sourceRow } from "./store.ts";

export const KNOWLEDGE = "knowledge";
export const DELIVER_KIND = "obs.deliver";
export const AREA_SETTING = "delivery_area";
/** the shared company area of Knowledge (its SHARED_AREA_ID); used when `areas_list` names no shared area */
export const COMPANY_AREA = "company";
export const DRAIN_BATCH = 20;
export const DRAIN_IDLE_MS = 15_000;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_BACKOFF_BASE_MS = 30_000;
export const DELIVERY_BACKOFF_CAP_MS = 30 * 60_000;
/** a delivery Knowledge holds for an owner decision: ask again (same key) this often */
export const HELD_RECHECK_MS = 60_000;
/** Knowledge is not reachable: look again this often (no attempt is counted) */
export const MISSING_RECHECK_MS = 5 * 60_000;
export const BODY_MAX = 500_000;
const TITLE_MAX = 200;
const SUMMARY_MAX = 2000;
const TAG_MAX = 40;
const TAGS_MAX = 20;
export const AREA_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ONLY_KNOWLEDGE = "Observer sends only to Knowledge in this version. Decide the record again with Knowledge as the destination.";
export const KNOWLEDGE_MISSING = "Knowledge is not available to Observer now (add Knowledge to the workspace and give it a licence in Portal). Observer sends when it is.";
export const TEXT_GONE = "The text of this record is gone (purged or past its retention), so there is nothing to send.";

const str = (v: unknown): string => String(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ───────────────────────────────────────────────────────────────────────── the call, in plain words
const PLAIN: Record<string, string> = {
  scope_denied: "Knowledge refused: Observer may not write to this area. Give Observer write access to the area in Knowledge, or pick another area on Routing, then press Retry.",
  not_found: "Knowledge does not have this area or document. Pick another area on Routing, then press Retry.",
  input_invalid: "Knowledge did not accept the document Observer built (input_invalid).",
  caller_unverified: "Knowledge could not verify that the caller is Observer. Ask the workspace owner to update Observer and Knowledge.",
  companion_undeclared: "Observer is not allowed to call Knowledge in this workspace.",
  narrowing_violation: "An owner rule in Knowledge does not let Observer write documents with these tags.",
  key_missing: "Knowledge needs a model key before it can store documents. Add it on the Keys page in Portal, then press Retry.",
  rate_limited: "Knowledge is busy. Observer waits and tries again by itself.",
  area_not_ready: "The Knowledge area is still being prepared. Observer tries again by itself.",
};
/** 4xx answers that are waits, not refusals */
const WAIT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);
const WAIT_CODES: ReadonlySet<string> = new Set(["rate_limited", "area_not_ready", "paused"]);
export function isRefusal(e: unknown): boolean {
  if (!(e instanceof TbError)) return false;
  if (WAIT_CODES.has(e.code)) return false;
  return e.httpStatus >= 400 && e.httpStatus < 500 && !WAIT_STATUSES.has(e.httpStatus);
}
export function deliveryError(code: string, mode: "retry" | "final"): string {
  const c = code.slice(0, 60);
  const known = PLAIN[code];
  if (mode === "retry") return known ?? `Sending to Knowledge failed (${c}). Observer tries again by itself.`;
  return known ?? `Knowledge refused the document (${c}). Press Retry when the cause is fixed.`;
}

/** Exponential with jitter, like the ingest jobs: between half and all of base·2^(n-1), at most the cap. */
export function deliveryBackoffMs(attempts: number, random: () => number = Math.random): number {
  const full = Math.min(DELIVERY_BACKOFF_CAP_MS, DELIVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(full / 2 + (random() * full) / 2);
}

// ───────────────────────────────────────────────────────────────────────── the target area
export interface KnowledgeArea {
  id: string;
  label: string;
  kind: string;
  /** what Knowledge says Observer may do there: "read" or "read_write" */
  access: string;
}
type CallApp = (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => Promise<{ status: string; output?: unknown; holdId?: string }>;

/** Knowledge's `areas_list` as Observer sees it (bounded, defensive: the answer is another app's). */
export async function knowledgeAreas(callApp: CallApp): Promise<KnowledgeArea[]> {
  const r = await callApp(KNOWLEDGE, "areas_list", {});
  const out = r.status === "ok" && isObj(r.output) && Array.isArray(r.output.areas) ? r.output.areas : [];
  return out
    .filter((a): a is Record<string, unknown> => isObj(a) && typeof a.id === "string" && AREA_RE.test(a.id))
    .slice(0, 200)
    .map((a) => ({ id: str(a.id), label: cleanText(typeof a.label === "string" ? a.label : str(a.id)).slice(0, 120), kind: a.kind === "shared" ? "shared" : "agent", access: a.access === "read_write" ? "read_write" : "read" }));
}
/** The owner's pick, or null (= Knowledge's shared company area). */
export function chosenArea(db: Db): string | null {
  const v = getSetting(db, AREA_SETTING);
  return v !== null && AREA_RE.test(v) ? v : null;
}
export function setChosenArea(db: Db, area: string | null, now: number): void {
  db.transaction(() => {
    if (area === null) db.prepare("DELETE FROM obs_settings WHERE key = ?").run(AREA_SETTING);
    else putSetting(db, AREA_SETTING, area);
    // a refused first delivery is built again for the new area when the owner presses Retry (it never reached Knowledge)
    db.prepare("UPDATE obs_deliveries SET payload_json = NULL, updated_at = ? WHERE status = 'failed' AND destination = 'knowledge' AND target_ref IS NULL").run(now);
  });
}
/** The area a new document goes to: the owner's pick, else the shared area Knowledge lists, else "company". */
export function defaultArea(areas: readonly KnowledgeArea[]): string {
  return areas.find((a) => a.kind === "shared")?.id ?? COMPANY_AREA;
}

// ───────────────────────────────────────────────────────────────────────── the payload
/** The provenance key of a record: a document by (account, collection, id), a message record by its id. */
export function targetKeyOf(db: Db, rec: Row): { key: string; rev: string; collection: string; kind: string | null; url: string | null; path: string | null; mime: string } {
  const doc = db.prepare("SELECT d.*, s.account FROM obs_documents d JOIN obs_sources s ON s.id = d.source_id WHERE d.record_id = ?").get(str(rec.id));
  if (doc) {
    return {
      mime: str(doc.mime),
      key: `doc:${str(doc.account)}\u0000${str(doc.collection)}\u0000${str(doc.doc_id)}`,
      rev: str(doc.rev),
      collection: str(doc.collection),
      kind: doc.kind === null ? null : str(doc.kind),
      url: doc.url === null ? null : str(doc.url),
      path: doc.path === null ? null : str(doc.path),
    };
  }
  const conv = db.prepare("SELECT conversation FROM obs_messages WHERE record_id = ? ORDER BY sent_at, provider_msg_id LIMIT 1").get(str(rec.id));
  return { key: `rec:${str(rec.id)}`, rev: String(rec.revision), collection: conv ? str(conv.conversation) : "", kind: null, url: null, path: null, mime: "text/plain" };
}

/** Replace every detected span of one text with its label (the owner's "deliver redacted"). */
export function redactForDelivery(text: string, cfg: ReturnType<typeof loadClassifierConfig>): string {
  let out = "";
  let at = 0;
  for (const s of classifyText(text, cfg).spans) {
    out += text.slice(at, s.start) + LABELS[s.class as DetectClass];
    at = s.end;
  }
  return out + text.slice(at);
}

/** CSV formula injection: a cell that starts with = + - @ (or a tab / carriage return) gets a leading apostrophe, so a spreadsheet
 *  that opens the delivered table never runs it. Quoted cells are handled (the apostrophe goes inside the quotes). */
const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);
export function escapeCsvFormulas(csv: string): string {
  let out = "";
  let fieldStart = true;
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string;
    if (fieldStart) {
      fieldStart = false;
      if (c === '"') {
        out += c;
        quoted = true;
        const next = csv[i + 1];
        if (next !== undefined && FORMULA_START.has(next)) out += "'";
        continue;
      }
      if (FORMULA_START.has(c)) out += "'";
    }
    out += c;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          out += '"';
          i++;
        } else quoted = false;
      }
    } else if (c === "," || c === "\n") fieldStart = true;
  }
  return out;
}

export function tagsFor(collection: string, classes: Readonly<Record<string, number>>, kind: string | null): string[] {
  const raw = ["observer", collection ? `source:${collection}` : "", ...piiClassesOf(classes).map((c) => `pii:${c}`), kind ? `kind:${kind}` : ""];
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeTag(cleanText(t)).slice(0, TAG_MAX);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, TAGS_MAX);
}

const clip = (s: string, max: number, marker = " […cut]"): string => (s.length > max ? `${s.slice(0, max - marker.length)}${marker}` : s);

export interface Payload {
  op: "document_create" | "document_update";
  input: Record<string, Json>;
  /** provenance key + revision, written to obs_targets once Knowledge answers */
  key: string;
  rev: string;
  area: string | null;
}

/** Build the call for one outbox row (null: the record has no text left). `area` = where a NEW document goes. */
export function buildPayload(db: Db, row: Row, targetArea: string): Payload | null {
  let area = targetArea;
  const rec = recordRow(db, str(row.record_id));
  if (!rec) return null;
  const src = sourceRow(db, str(rec.source_id));
  let decision = "deliver";
  let ruleId: string | null = null;
  try {
    const i = JSON.parse(str(row.input_json)) as { decision?: unknown; rule?: unknown };
    if (i.decision === "deliver_redacted") decision = "deliver_redacted";
    if (typeof i.rule === "string") ruleId = i.rule;
  } catch {
    decision = "deliver_redacted"; // unreadable: the safe side
  }
  // a rule that delivered the record may name its own area and status (Routing: "area …", "as draft"); the owner's click publishes
  // to the delivery target
  let status: "draft" | "published" = "published";
  if (ruleId !== null) {
    const rule = db.prepare("SELECT action_json FROM obs_rules WHERE id = ?").get(ruleId);
    try {
      const action = rule ? (JSON.parse(str(rule.action_json)) as { area?: unknown; knowledgeStatus?: unknown }) : {};
      if (typeof action.area === "string" && AREA_RE.test(action.area)) area = action.area;
      if (action.knowledgeStatus === "draft") status = "draft";
    } catch {
      // a damaged rule action: the delivery target and published, as for a click
    }
  }
  const redact = decision === "deliver_redacted";
  const purgeAt = rec.text_purge_at === null || rec.text_purge_at === undefined ? null : Number(rec.text_purge_at);
  if (purgeAt !== null && purgeAt <= clockNow()) return null;
  const msgs = db.prepare("SELECT author_ref, sent_at, text FROM obs_messages WHERE record_id = ? AND deleted = 0 AND text IS NOT NULL ORDER BY sent_at, provider_msg_id").all(str(rec.id));
  if (msgs.length === 0) return null;
  const target = targetKeyOf(db, rec);
  const isDoc = target.key.startsWith("doc:");
  const cfg = loadClassifierConfig(db);
  const show = (t: string): string => cleanText(redact ? redactForDelivery(t, cfg) : t);
  // a document is its chunks in order; a conversation is its messages, each with its time (and its author unless redacted)
  const body = isDoc
    ? show(msgs.map((m) => str(m.text)).join(""))
    : msgs.map((m) => `${humanTime(Number(m.sent_at))}${redact ? "" : ` · ${cleanText(str(m.author_ref)) || "unknown"}`}\n${show(str(m.text))}`).join("\n\n");
  const finalBody = clip(target.mime === "text/csv" ? escapeCsvFormulas(body) : body, BODY_MAX);
  const label = src ? str(src.label) : "a source";
  const subject = rec.thread === null || rec.thread === undefined ? "" : show(str(rec.thread)).trim();
  const title = clip(subject || `${label} · ${target.collection} · ${humanTime(Number(rec.window_start))}`, TITLE_MAX, "…");
  const where = [target.path ? `Path: ${target.path}` : "", target.url ? `Original: ${target.url}` : ""].filter(Boolean).join(". ");
  const summary = clip(`From ${label} (${target.collection}) through Observer${redact ? ", personal data redacted" : ""}.${where ? ` ${where}.` : ""}`, SUMMARY_MAX);
  const tags = tagsFor(target.collection, parsePii(rec.pii_json), target.kind);
  const existing = db.prepare("SELECT target_ref FROM obs_targets WHERE key = ? AND destination = 'knowledge'").get(target.key);
  const common: Record<string, Json> = { title, body: finalBody, summary, tags, status };
  if (existing) return { op: "document_update", input: { id: str(existing.target_ref), ...common }, key: target.key, rev: target.rev, area: null };
  return { op: "document_create", input: { area, ...common }, key: target.key, rev: target.rev, area };
}

// ───────────────────────────────────────────────────────────────────────── the drain
export interface DrainDeps {
  db: Db;
  callApp: CallApp;
  /** the products the slice lets Observer call now */
  targets(): string[];
  /** the lease-fenced write of the SDK job (ctx.checkpoint); tests: a plain transaction */
  write<T>(fn: (db: Db) => T): T;
  random?: () => number;
  statusChanged?(): void;
}
export interface DrainResult {
  sent: number;
  held: number;
  failed: number;
  waiting: number;
  /** ms until the next row is due (null: none waits) */
  nextInMs: number | null;
  /** more rows were due than one batch */
  more: boolean;
}

function due(db: Db, now: number, limit: number): Row[] {
  return db
    .prepare("SELECT * FROM obs_deliveries WHERE status IN ('pending', 'held') AND superseded = 0 AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at, id LIMIT ?")
    .all(now, limit);
}

/** Send the due outbox rows once. Pure over its deps (the job tick and the tests call it). */
export async function drainOutbox(d: DrainDeps): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, held: 0, failed: 0, waiting: 0, nextInMs: null, more: false };
  const now0 = clockNow();
  const rows = due(d.db, now0, DRAIN_BATCH + 1);
  out.more = rows.length > DRAIN_BATCH;
  let areaCache: string | null = null;
  for (const row of rows.slice(0, DRAIN_BATCH)) {
    const id = str(row.id);
    const at = clockNow();
    // the one question before every send: is this still the owner's last decision?
    if (!deliverySendable(d.db, id)) continue;
    if (str(row.destination) !== KNOWLEDGE) {
      d.write((db) => db.prepare("UPDATE obs_deliveries SET status = 'failed', last_error = ?, next_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'held')").run(ONLY_KNOWLEDGE, at, id));
      out.failed += 1;
      continue;
    }
    if (!d.targets().includes(KNOWLEDGE)) {
      d.write((db) => db.prepare("UPDATE obs_deliveries SET last_error = ?, next_at = ?, updated_at = ? WHERE id = ?").run(KNOWLEDGE_MISSING, at + MISSING_RECHECK_MS, at, id));
      out.waiting += 1;
      continue;
    }
    let payload: Payload | null;
    try {
      if (row.payload_json !== null && row.payload_json !== undefined) payload = JSON.parse(str(row.payload_json)) as Payload;
      else {
        if (areaCache === null) areaCache = chosenArea(d.db) ?? defaultArea(await knowledgeAreas(d.callApp));
        payload = buildPayload(d.db, row, areaCache);
        if (payload === null) {
          d.write((db) => db.prepare("UPDATE obs_deliveries SET status = 'failed', last_error = ?, next_at = NULL, updated_at = ? WHERE id = ?").run(TEXT_GONE, at, id));
          out.failed += 1;
          continue;
        }
        const built = payload;
        d.write((db) => db.prepare("UPDATE obs_deliveries SET payload_json = ?, first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ? WHERE id = ?").run(JSON.stringify(built), at, at, id));
      }
      const r = await d.callApp(KNOWLEDGE, payload.op, payload.input as Json, { idempotencyKey: str(row.idem_key) });
      const done = clockNow();
      if (r.status === "held") {
        d.write((db) =>
          db.prepare("UPDATE obs_deliveries SET status = 'held', hold_id = ?, last_error = NULL, next_at = ?, updated_at = ? WHERE id = ?").run(typeof r.holdId === "string" ? r.holdId : null, done + HELD_RECHECK_MS, done, id),
        );
        out.held += 1;
        continue;
      }
      const output = isObj(r.output) ? r.output : {};
      const ref = typeof output.id === "string" ? output.id : payload.op === "document_update" ? str(payload.input.id) : null;
      if (ref === null) throw new TbError("knowledge_answer", "Knowledge answered without a document id", 502);
      const sentPayload = payload;
      d.write((db) => {
        db.prepare("UPDATE obs_deliveries SET status = 'sent', target_ref = ?, attempts = attempts + 1, last_error = NULL, next_at = NULL, hold_id = NULL, updated_at = ? WHERE id = ?").run(ref, done, id);
        db.prepare("UPDATE obs_records SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'approved' AND revision = ?").run(done, str(row.record_id), Number(row.revision));
        db.prepare(
          `INSERT INTO obs_targets (key, destination, target_ref, area, rev, updated_at) VALUES (?, 'knowledge', ?, ?, ?, ?)
           ON CONFLICT (key, destination) DO UPDATE SET target_ref = excluded.target_ref, area = COALESCE(excluded.area, obs_targets.area), rev = excluded.rev, updated_at = excluded.updated_at`,
        ).run(sentPayload.key, ref, typeof output.area === "string" ? output.area : sentPayload.area, sentPayload.rev, done);
      });
      out.sent += 1;
    } catch (e) {
      if (e instanceof TbError && e.code === "job_lease_lost") throw e;
      const code = e instanceof TbError ? e.code : "error";
      const fresh = d.db.prepare("SELECT * FROM obs_deliveries WHERE id = ?").get(id);
      if (!fresh) continue;
      const attempts = Number(fresh.attempts) + 1;
      const p = fresh.payload_json === null ? null : (JSON.parse(str(fresh.payload_json)) as Payload);
      // the Knowledge document was deleted there: forget the link, the next attempt creates a new document
      if (code === "not_found" && p?.op === "document_update") {
        d.write((db) => {
          db.prepare("DELETE FROM obs_targets WHERE key = ? AND destination = 'knowledge'").run(p.key);
          db.prepare("UPDATE obs_deliveries SET payload_json = NULL, attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?").run(attempts, "The Knowledge document is gone; Observer creates a new one.", at, at, id);
        });
        out.waiting += 1;
        continue;
      }
      if (isRefusal(e) || attempts >= MAX_DELIVERY_ATTEMPTS) {
        d.write((db) => db.prepare("UPDATE obs_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_at = NULL, updated_at = ? WHERE id = ?").run(attempts, deliveryError(code, "final"), at, id));
        out.failed += 1;
      } else {
        d.write((db) => db.prepare("UPDATE obs_deliveries SET attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?").run(attempts, deliveryError(code, "retry"), at + deliveryBackoffMs(attempts, d.random), at, id));
        out.waiting += 1;
      }
    }
  }
  if (out.sent + out.failed + out.held > 0) d.statusChanged?.();
  const next = d.db.prepare("SELECT MIN(next_at) AS n FROM obs_deliveries WHERE status IN ('pending', 'held') AND superseded = 0").get();
  const n = next?.n;
  const pendingNow = d.db.prepare("SELECT 1 AS x FROM obs_deliveries WHERE status = 'pending' AND superseded = 0 AND next_at IS NULL LIMIT 1").get();
  out.nextInMs = pendingNow ? 0 : n === null || n === undefined ? null : Math.max(0, Number(n) - clockNow());
  return out;
}

/** The drain job's tick: never fails (an unexpected error waits and tries again), so the outbox always has its runner. */
export const deliverJob: JobSpec = {
  async run(_input, ctx: JobContext): Promise<JobOutcome> {
    try {
      const p = ctx.paused(null);
      if (p.workspace || p.instance) return { status: "again", afterMs: DRAIN_IDLE_MS };
      const r = await drainOutbox({
        db: ctx.db,
        callApp: (product, op, input, opts) => ctx.callApp(product, op, input, opts) as ReturnType<CallApp>,
        targets: () => companionTargets(ctx),
        write: (fn) => ctx.checkpoint({}, fn),
        statusChanged: () => ctx.statusChanged(),
      });
      const wait = r.more ? 0 : r.nextInMs === null ? DRAIN_IDLE_MS : Math.min(DRAIN_IDLE_MS, Math.max(1000, r.nextInMs));
      return { status: "again", afterMs: wait };
    } catch (e) {
      if (e instanceof TbError && e.code === "job_lease_lost") throw e;
      ctx.log.error("outbox drain failed; trying again", { error: e instanceof TbError ? e.code : "error" });
      return { status: "again", afterMs: DRAIN_IDLE_MS };
    }
  },
};

/** The drain job exists exactly once while the app runs: onStart and every decision call this (cheap when it runs). */
export function ensureDrainJob(jobs: JobsApi | null): Job | null {
  if (!jobs) return null;
  try {
    const live = new Set(["queued", "running", "waiting", "paused"]);
    const active = jobs.list({ kind: DELIVER_KIND, status: ["queued", "running", "waiting", "paused"], limit: 5 }).filter((j) => j.kind === DELIVER_KIND && live.has(j.status));
    if (active.length > 0) return active[0] as Job;
    return jobs.enqueue(DELIVER_KIND, {});
  } catch {
    return null;
  }
}

/** What the Activity page needs to say about deliveries in one line each (counts, no text). */
export function deliveryCounts(db: Db): Record<"pending" | "held" | "sent" | "failed", number> {
  const out = { pending: 0, held: 0, sent: 0, failed: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) AS c FROM obs_deliveries GROUP BY status").all()) if (str(r.status) in out) out[str(r.status) as keyof typeof out] = Number(r.c);
  return out;
}
