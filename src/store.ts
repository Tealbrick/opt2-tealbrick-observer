// Table access over the app's own tables (migrations/0001_init.sql): plain functions over the SDK `Db`, so handlers stay
// thin and tests run them against the migrated database. Time is always passed in (injected clock).
//
// Privacy shape (DESIGN §5.5, §5.7): message text lives only in obs_messages.text and is returned only by the person
// record views (recordView with messages). The agent `status` view is built here from labels and counts alone.
import { createHash, createHmac } from "node:crypto";
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type ClassifyConfig, classifyText } from "./classify.ts";
import { validWordEntry } from "./detect/words.ts";

export type Row = Record<string, unknown>;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const RULE_ZERO_ID = "rul_00000000000000000000000000";
export const MAX_RULES = 200;
export const PAGE_SIZE = 50;
export const FLAGS_PER_AGENT_PER_DAY = 50;
/** SDK idempotency covers 24 h; Observer re-sends with the same key only inside 23 h (DESIGN §4.1). */
export const SAME_KEY_WINDOW_MS = 23 * HOUR_MS;
export const BACKFILL_MAX_YEARS = 3;
export const BACKFILL_DEFAULT_MAX_MESSAGES = 50_000;
export const RECORD_STATES = ["open", "classified", "review", "approved", "delivered", "dropped"] as const;
export type RecordState = (typeof RECORD_STATES)[number];
export type Destination = "knowledge" | "kanban" | "inbox";

export const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function notFound(what: string): TbError {
  return new TbError("not_found", `${what} not found`, 404);
}

/** Parse a date input (ISO 8601 or anything Date.parse reads). */
export function parseDate(v: string, field: string): number {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new TbError("invalid_date", `${field} is not a date`, 400);
  return t;
}

// ───────────────────────────────────────────────────────────────────────── settings
export interface Privacy {
  textRetentionDays: number;
  reviewRetentionDays: number;
  onSourceDelete: "purge" | "keep";
}
export const PRIVACY_DEFAULTS: Privacy = { textRetentionDays: 30, reviewRetentionDays: 90, onSourceDelete: "purge" };

export function getPrivacy(db: Db): Privacy {
  const rows = db.prepare("SELECT key, value FROM obs_settings WHERE key IN ('text_retention_days', 'review_retention_days', 'on_source_delete')").all();
  const m = new Map(rows.map((r) => [str(r.key), str(r.value)]));
  const text = Number(m.get("text_retention_days"));
  const review = Number(m.get("review_retention_days"));
  const del = m.get("on_source_delete");
  return {
    textRetentionDays: Number.isInteger(text) && text >= 1 && text <= 365 ? text : PRIVACY_DEFAULTS.textRetentionDays,
    reviewRetentionDays: Number.isInteger(review) && review >= 1 && review <= 365 ? review : PRIVACY_DEFAULTS.reviewRetentionDays,
    onSourceDelete: del === "keep" ? "keep" : "purge",
  };
}

export function setPrivacy(db: Db, patch: Partial<Privacy>): Privacy {
  return db.transaction(() => {
    const put = (key: string, value: string | number) =>
      db.prepare("INSERT INTO obs_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(value));
    if (patch.textRetentionDays !== undefined) put("text_retention_days", patch.textRetentionDays);
    if (patch.reviewRetentionDays !== undefined) put("review_retention_days", patch.reviewRetentionDays);
    if (patch.onSourceDelete !== undefined) put("on_source_delete", patch.onSourceDelete);
    return getPrivacy(db);
  });
}

export function getSetting(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM obs_settings WHERE key = ?").get(key);
  return r ? str(r.value) : null;
}
export function putSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO obs_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ───────────────────────────────────────────────────────────────────────── jobs
export type JobState = "queued" | "running" | "waiting" | "paused" | "done" | "failed" | "cancelled";
export type JobAction = "start" | "pause" | "resume" | "cancel";

export interface JobView {
  id: string;
  source: string;
  kind: "live" | "backfill";
  state: string;
  counts: { read: number; records: number; failures: number };
  lastError: string | null;
  retryAt: string | null;
}

export function jobRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM obs_jobs WHERE id = ?").get(id);
}
export function jobView(r: Row): JobView {
  return {
    id: str(r.id),
    source: str(r.source_id),
    kind: r.kind === "backfill" ? "backfill" : "live",
    state: str(r.state),
    counts: { read: Number(r.read_count), records: Number(r.record_count), failures: Number(r.consecutive_failures) },
    lastError: r.last_error === null || r.last_error === undefined ? null : str(r.last_error).slice(0, 280),
    retryAt: iso(r.retry_at),
  };
}
export function listJobs(db: Db, source: string | undefined, limit = 200): JobView[] {
  const rows = source
    ? db.prepare("SELECT * FROM obs_jobs WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(source, limit)
    : db.prepare("SELECT * FROM obs_jobs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
  return rows.map(jobView);
}

/**
 * The job state machine (obs_jobs.state). Only the owner uses start / resume / cancel; an agent can only pause.
 *   start   : paused, never paused by anyone (paused_by NULL: the state a new live job is created in) → queued
 *   resume  : paused (paused_by set) or failed → queued   (failed: clears the failure count, error and retry time)
 *   pause   : queued | running | waiting → paused, paused_by = the caller; pausing a paused job is a no-op
 *   cancel  : queued | running | waiting | paused | failed → cancelled; cancelling a cancelled job is a no-op
 * `done` and `cancelled` are final. Anything else is `job_state_invalid` (409).
 *
 * TODO(S2): the SDK job runner (R1, `defineApp({ jobs })`, ctx.jobs.{start,pause,resume,cancel}) executes the jobs. When it
 * lands, every transition below also calls the runner for `sdk_job_id`, and the runner (not this table) moves
 * queued → running → waiting/done/failed. S1 keeps obs_jobs consistent on its own; nothing reads from a source yet.
 */
export function transitionJob(db: Db, r: Row, action: JobAction, by: string, now: number): { row: Row; changed: boolean } {
  const state = str(r.state) as JobState;
  const bad = () => new TbError("job_state_invalid", `cannot ${action} a job that is ${state}`, 409);
  let next: JobState | null = null;
  let pausedBy: string | null = strOrNull(r.paused_by);
  let reset = false;
  switch (action) {
    case "start":
      if (state !== "paused" || r.paused_by !== null) throw bad();
      next = "queued";
      break;
    case "resume":
      if (state === "paused" && r.paused_by !== null) next = "queued";
      else if (state === "failed") {
        next = "queued";
        reset = true;
      } else throw bad();
      pausedBy = null;
      break;
    case "pause":
      if (state === "paused") return { row: r, changed: false };
      if (state !== "queued" && state !== "running" && state !== "waiting") throw bad();
      next = "paused";
      pausedBy = by;
      break;
    case "cancel":
      if (state === "cancelled") return { row: r, changed: false };
      if (state === "done") throw bad();
      next = "cancelled";
      break;
  }
  db.prepare(
    `UPDATE obs_jobs SET state = ?, paused_by = ?, updated_at = ?${reset ? ", consecutive_failures = 0, last_error = NULL, retry_at = NULL" : ""} WHERE id = ?`,
  ).run(next, pausedBy, now, str(r.id));
  const row = jobRow(db, str(r.id));
  if (!row) throw notFound("job");
  return { row, changed: true };
}

// ───────────────────────────────────────────────────────────────────────── sources
export interface SourceView {
  id: string;
  label: string;
  kind: string;
  account: string;
  conversations: string[];
  live: { state: string; lastReadAt: string | null; nextAt: string | null };
  history: { state: string; done: number; total: number | null; since: string | null };
}
export interface Exclude {
  senders: string[];
  domains: string[];
}

export function sourceRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM obs_sources WHERE id = ?").get(id);
}
function parseList(json: unknown): string[] {
  try {
    const v: unknown = JSON.parse(str(json));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
/** The stored exclusions. A damaged value THROWS: empty exclusions would silently read the senders the owner excluded. */
export function excludeOf(r: Row): Exclude {
  const broken = () => new TbError("exclude_corrupt", "the stored exclusions of this source are damaged; refusing to use them", 500);
  let v: unknown;
  try {
    v = JSON.parse(str(r.exclude_json));
  } catch {
    throw broken();
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw broken();
  const { senders, domains } = v as { senders?: unknown; domains?: unknown };
  const list = (x: unknown): string[] => {
    if (!Array.isArray(x) || !x.every((e) => typeof e === "string")) throw broken();
    return x as string[];
  };
  return { senders: list(senders), domains: list(domains) };
}
export function conversationsOf(r: Row): string[] {
  return parseList(r.conversations_json);
}

/** Source view. Labels, kinds and counts only: no message text, sender or conversation title is ever read here except the
 *  owner-chosen conversation ids, which only the person views (`withConversations`) return. */
export function sourceView(db: Db, r: Row): SourceView {
  return sourceParts(db, r).view;
}
function sourceParts(db: Db, r: Row): { view: SourceView; liveJobId: string | null; historyJobId: string | null } {
  const jobs = db.prepare("SELECT * FROM obs_jobs WHERE source_id = ? ORDER BY created_at DESC, id DESC").all(str(r.id));
  const live = jobs.find((j) => j.kind === "live");
  const hist = jobs.find((j) => j.kind === "backfill");
  return {
    view: {
      id: str(r.id),
      label: str(r.label),
      kind: str(r.kind),
      account: str(r.account),
      conversations: conversationsOf(r),
      // TODO(S2): lastReadAt needs a column the job runner writes after each page (obs_jobs has none yet); null until then.
      live: { state: live ? str(live.state) : "none", lastReadAt: null, nextAt: live ? iso(live.retry_at) : null },
      history: {
        state: hist ? str(hist.state) : "none",
        done: hist ? Number(hist.read_count) : 0,
        total: hist && hist.max_messages !== null ? Number(hist.max_messages) : null,
        since: hist ? iso(hist.since_at) : null,
      },
    },
    liveJobId: live ? str(live.id) : null,
    historyJobId: hist ? str(hist.id) : null,
  };
}

/** The agent view of the sources: labels and counts only (DESIGN §3.1, §5.7). Built field by field so a new column can never leak. */
export function statusView(db: Db): {
  sources: (Pick<SourceView, "id" | "label" | "kind" | "live" | "history"> & { liveJobId: string | null; historyJobId: string | null })[];
  review: { waiting: number };
} {
  const rows = db.prepare("SELECT * FROM obs_sources ORDER BY created_at, id LIMIT 100").all();
  return {
    sources: rows.map((r) => {
      const { view: v, liveJobId, historyJobId } = sourceParts(db, r);
      // job ids so an agent can pause a job (job_pause); ids only, no text
      return { id: v.id, label: v.label, kind: v.kind, live: v.live, history: v.history, liveJobId, historyJobId };
    }),
    review: { waiting: pendingCount(db) },
  };
}

export function listSources(db: Db): SourceView[] {
  return db
    .prepare("SELECT * FROM obs_sources ORDER BY created_at, id LIMIT 100")
    .all()
    .map((r) => sourceView(db, r));
}

export interface NewSource {
  account: string;
  kind: string;
  label: string;
  conversations: string[];
  exclude: Exclude;
  liveIntervalS: number;
  retentionDays: number | null;
  historyCapable: boolean;
}
/** A new source and its live job, PAUSED until the owner presses Start (live watching is off by default, C169). */
export function createSource(db: Db, s: NewSource, now: number): { source: string; job: string } {
  const source = `src_${ulid(now)}`;
  const job = `job_${ulid(now)}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO obs_sources (id, account, kind, label, conversations_json, exclude_json, live_interval_s, retention_days, history_capable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(source, s.account, s.kind, s.label, JSON.stringify(s.conversations), JSON.stringify(s.exclude), s.liveIntervalS, s.retentionDays, s.historyCapable ? 1 : 0, now, now);
    db.prepare(
      `INSERT INTO obs_jobs (id, source_id, kind, state, paused_by, created_at, updated_at) VALUES (?, ?, 'live', 'paused', NULL, ?, ?)`,
    ).run(job, source, now, now);
  });
  return { source, job };
}

/** Exclusion entries as stored: trimmed, NFC + lower case (the same form as author_key), no empties or duplicates; an "@domain"
 *  in senders is a domain. A list the caller leaves out keeps `base`. */
export function normalizeExclude(raw: { senders?: readonly string[]; domains?: readonly string[] }, base: Exclude): Exclude {
  const clean = (x: string): string => authorKey(x.trim());
  const senders: string[] = [];
  const domains: string[] = [];
  for (const x of raw.senders ?? base.senders) {
    const v = clean(x);
    if (v.startsWith("@")) domains.push(v.replace(/^@+/, "").trim());
    else senders.push(v);
  }
  for (const x of raw.domains ?? base.domains) domains.push(clean(x).replace(/^@+/, "").trim());
  return { senders: [...new Set(senders.filter(Boolean))], domains: [...new Set(domains.filter(Boolean))] };
}

// ── author keys and exclusions. SQLite lower() only folds ASCII, so "ÄRGER@Beispiel.de" would survive an exclusion of
// "ärger@beispiel.de". The key is made in JS (NFC + toLowerCase) when a message is stored and compared in JS.
export function authorKey(ref: string): string {
  return ref.normalize("NFC").toLowerCase();
}
const valuePart = (key: string): string => key.slice(key.indexOf(":") + 1);
/** An email as the mailbox sees it: no "+tag", no dots in the local part, googlemail = gmail. Other values are returned as they are. */
export function emailCanonical(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = (value.slice(0, at).split("+")[0] as string).replace(/\./g, "");
  const domain = value.slice(at + 1);
  return `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}
/** Does the exclusion list hide this author? `senders` match the whole handle or its value part (email: "+tag" and dots ignored),
 *  `domains` the part after "@". */
export function isExcluded(key: string, ex: Exclude): boolean {
  const value = valuePart(key);
  const at = value.lastIndexOf("@");
  const canon = emailCanonical(value);
  const channel = key.includes(":") ? key.slice(0, key.indexOf(":")) : "";
  for (const s of ex.senders) {
    const k = authorKey(s);
    // "email:anna@x.com" names a channel and must be that channel; a bare "anna@x.com" fits any (email "+tag" and dots ignored)
    const kChannel = k.includes(":") ? k.slice(0, k.indexOf(":")) : null;
    if (kChannel !== null && kChannel !== channel) continue;
    const kv = valuePart(k);
    if (key === k || value === kv || (kv.includes("@") && canon === emailCanonical(kv))) return true;
  }
  if (at >= 0) {
    const domain = value.slice(at + 1);
    for (const d of ex.domains) if (domain === authorKey(d).replace(/^@/, "")) return true;
  }
  return false;
}

/**
 * After messages of a record were deleted (narrowing) or their text purged: nothing of the removed text may survive in a
 * record, a delivery or a flag. Same transaction as the delete (the caller's).
 *  - unsent deliveries of the record are deleted (they would send the removed text), a sent one keeps its ledger row but its
 *    stored input is emptied (from S4 it holds the text that was sent)
 *  - narrowing: a record left with no message is deleted with its deliveries and flags; a record that keeps some messages
 *    gets a new revision (its content changed) and goes back to Review if it was approved
 *  - in both modes the thread subject of a touched record is nulled
 *  - purge: message ids stay, so no record is deleted; thread subjects are nulled; an approved record goes back to Review
 */
function scrubRecords(db: Db, recordIds: Iterable<string>, mode: "narrow" | "purge", now: number): void {
  for (const id of new Set(recordIds)) {
    if (mode === "narrow" && Number(db.prepare("SELECT COUNT(*) AS c FROM obs_messages WHERE record_id = ?").get(id)?.c ?? 0) === 0) {
      db.prepare("DELETE FROM obs_flags WHERE record_id = ?").run(id);
      db.prepare("DELETE FROM obs_deliveries WHERE record_id = ?").run(id);
      db.prepare("DELETE FROM obs_records WHERE id = ?").run(id);
      continue;
    }
    db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status <> 'sent'").run(id);
    db.prepare("UPDATE obs_deliveries SET input_json = '{}', updated_at = ? WHERE record_id = ? AND status = 'sent'").run(now, id);
    db.prepare(
      `UPDATE obs_records SET state = CASE WHEN state = 'approved' THEN 'review' ELSE state END,
         revision = revision + ?, thread = NULL, updated_at = ? WHERE id = ?`,
    ).run(mode === "narrow" ? 1 : 0, now, id);
  }
}

/** Delete stored messages that a source no longer may hold (a narrowed conversation list, new exclusions): "narrowing applies at
 *  once", and no text of an excluded sender survives in messages, records or deliveries. One transaction. */
export function dropOutOfScope(db: Db, sourceId: string, removedConversations: string[], exclude: Exclude | null, now: number): number {
  return db.transaction(() => {
    const doomed = new Map<string, { conversation: string; id: string; record: string | null }>();
    const take = (r: Row) => doomed.set(`${str(r.conversation)}\u0000${str(r.provider_msg_id)}`, { conversation: str(r.conversation), id: str(r.provider_msg_id), record: strOrNull(r.record_id) });
    if (removedConversations.length > 0) {
      const marks = removedConversations.map(() => "?").join(", ");
      for (const r of db.prepare(`SELECT conversation, provider_msg_id, record_id FROM obs_messages WHERE source_id = ? AND conversation IN (${marks})`).all(sourceId, ...removedConversations)) take(r);
    }
    if (exclude && (exclude.senders.length > 0 || exclude.domains.length > 0)) {
      for (const r of db.prepare("SELECT conversation, provider_msg_id, record_id, author_key FROM obs_messages WHERE source_id = ?").all(sourceId)) if (isExcluded(str(r.author_key), exclude)) take(r);
    }
    const del = db.prepare("DELETE FROM obs_messages WHERE source_id = ? AND conversation = ? AND provider_msg_id = ?");
    for (const m of doomed.values()) del.run(sourceId, m.conversation, m.id);
    scrubRecords(db, [...doomed.values()].flatMap((m) => (m.record ? [m.record] : [])), "narrow", now);
    return doomed.size;
  });
}

/**
 * Remove a source: cancel its jobs, delete stored text, message ids, records, deliveries ledger and flags, then the source.
 * One transaction. Documents already delivered to Knowledge stay (the owner deletes them there). This deletes EVERYTHING of the
 * source by design; the privacy setting `onSourceDelete` is NOT consulted here: it is about deletions on the PROVIDER side
 * (a message the provider deleted, DESIGN §5.5), not about the owner removing a source.
 * TODO(S2): also cancel the SDK jobs (`sdk_job_id`) with the runner.
 */
export function removeSource(db: Db, id: string, now: number): { messagesPurged: number; sdkJobs: string[] } {
  return db.transaction(() => {
    const sdkJobs = db
      .prepare("SELECT sdk_job_id FROM obs_jobs WHERE source_id = ? AND sdk_job_id IS NOT NULL")
      .all(id)
      .map((r) => str(r.sdk_job_id));
    db.prepare("UPDATE obs_jobs SET state = 'cancelled', updated_at = ? WHERE source_id = ? AND state NOT IN ('done', 'cancelled')").run(now, id);
    const messagesPurged = Number(db.prepare("SELECT COUNT(*) AS c FROM obs_messages WHERE source_id = ?").get(id)?.c ?? 0);
    const records = "(SELECT id FROM obs_records WHERE source_id = ?)";
    db.prepare(`DELETE FROM obs_flags WHERE record_id IN ${records}`).run(id);
    db.prepare(`DELETE FROM obs_deliveries WHERE record_id IN ${records}`).run(id);
    db.prepare("DELETE FROM obs_records WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM obs_messages WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM obs_jobs WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM obs_sources WHERE id = ?").run(id);
    return { messagesPurged, sdkJobs };
  });
}

/** Delete stored message TEXT now (ids, digests, author and conversation stay so nothing is read twice; thread subjects go).
 *  Returns how many texts went. Unsent deliveries of the touched records go too and sent ones lose their stored input. */
export function purgeText(db: Db, f: { source?: string; before?: number }, now: number): number {
  return db.transaction(() => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.source !== undefined) {
      where.push("source_id = ?");
      args.push(f.source);
    }
    if (f.before !== undefined) {
      where.push("sent_at < ?");
      args.push(f.before);
    }
    const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const texts = Number(db.prepare(`SELECT COUNT(*) AS c FROM obs_messages${w}${w ? " AND" : " WHERE"} text IS NOT NULL`).get(...args)?.c ?? 0);
    const records = db
      .prepare(`SELECT DISTINCT record_id FROM obs_messages${w}${w ? " AND" : " WHERE"} record_id IS NOT NULL AND (text IS NOT NULL OR thread IS NOT NULL)`)
      .all(...args)
      .map((r) => str(r.record_id));
    db.prepare(`UPDATE obs_messages SET text = NULL, thread = NULL${w}`).run(...args);
    scrubRecords(db, records, "purge", now);
    return texts;
  });
}

// ───────────────────────────────────────────────────────────────────────── records
export function recordRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM obs_records WHERE id = ?").get(id);
}
export function parsePii(json: unknown): Record<string, number> {
  try {
    const v = JSON.parse(str(json)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Number(n)]));
  } catch {
    return {};
  }
}
export interface RecordView {
  id: string;
  source: string;
  thread: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  revision: number;
  state: string;
  pii: Record<string, number>;
  secret: boolean;
  /** a token in the text looks like a secret (suspect_secret): held for the owner, shown as "possible secret" */
  possibleSecret: boolean;
  ruleId: string | null;
  actionable: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  textPurgeAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
/** A token in the record looks like a secret (suspect_secret). Such a record is held as a whole: the owner sees its text only on purpose. */
export const isPossibleSecret = (r: Row): boolean => (parsePii(r.pii_json).suspect_secret ?? 0) > 0;
/** Record summary: no message text (lists never carry text). For a possible secret the thread subject is blank: a subject can carry the token itself, and a
 *  list title, a heading or an Activity row would show it in clear text. */
export function recordView(r: Row): RecordView {
  return {
    id: str(r.id),
    source: str(r.source_id),
    thread: isPossibleSecret(r) ? null : strOrNull(r.thread),
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    revision: Number(r.revision),
    state: str(r.state),
    pii: parsePii(r.pii_json),
    secret: Number(r.secret) === 1,
    possibleSecret: isPossibleSecret(r),
    ruleId: strOrNull(r.rule_id),
    actionable: Number(r.actionable) === 1,
    decidedBy: strOrNull(r.decided_by),
    decidedAt: iso(r.decided_at),
    textPurgeAt: iso(r.text_purge_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
/** Characters of message text that one recordDetail call will classify (2 MiB); messages beyond it are shown without spans. */
export const SPAN_BUDGET_CHARS = 2 * 1024 * 1024;
export interface MessageView {
  conversation: string;
  id: string;
  thread: string | null;
  sentAt: string | null;
  editedAt: string | null;
  deleted: boolean;
  author: string;
  authorKind: string;
  /** null once purged, after the record's text_purge_at, or when the provider deleted the message */
  text: string | null;
  /** detected sensitive spans in `text`: classes and offsets only (never the matched value); [] when there is no text */
  spans: { class: string; start: number; end: number }[];
}
/** Record with its messages (person ops only). Text is shown only while inside retention. */
export function recordDetail(db: Db, r: Row, now: number): RecordView & { messages: MessageView[] } {
  const purgeAt = r.text_purge_at === null || r.text_purge_at === undefined ? null : Number(r.text_purge_at);
  const expired = purgeAt !== null && purgeAt <= now;
  const msgs = db.prepare("SELECT * FROM obs_messages WHERE record_id = ? ORDER BY sent_at, provider_msg_id LIMIT 500").all(str(r.id));
  const cfg = loadClassifierConfig(db);
  let budget = SPAN_BUDGET_CHARS; // classification work per call: a record of many large messages must not stall the UI
  const held = isPossibleSecret(r); // subject and author handle of a possible secret stay out of every answer (the text itself is shown, on purpose)
  return {
    ...recordView(r),
    messages: msgs.map((m) => {
      const text = expired || Number(m.deleted) === 1 || m.text === null ? null : str(m.text);
      const inBudget = text !== null && text.length <= budget;
      if (text !== null) budget -= text.length;
      return {
        conversation: str(m.conversation),
        id: str(m.provider_msg_id),
        thread: held ? null : strOrNull(m.thread),
        sentAt: iso(m.sent_at),
        editedAt: iso(m.edited_at),
        deleted: Number(m.deleted) === 1,
        author: held ? "" : str(m.author_ref),
        authorKind: str(m.author_kind),
        text,
        // owner view only (review_get / record_get): where the detectors found something, never what
        spans: text === null || !inBudget ? [] : classifyText(text, cfg).spans.map((s) => ({ class: s.class, start: s.start, end: s.end })),
      };
    }),
  };
}

/** Classifier settings (obs_settings): `gov_id_countries` (JSON list, default SK, CZ, DE, US), `actionable_words` (JSON list). */
export function loadClassifierConfig(db: Db): ClassifyConfig {
  const list = (key: string): string[] | undefined => {
    const v = getSetting(db, key);
    if (v === null) return undefined;
    try {
      const a: unknown = JSON.parse(v);
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : undefined;
    } catch {
      return undefined;
    }
  };
  const gov = list("gov_id_countries");
  const own = list("actionable_words")?.filter(validWordEntry); // an unusable entry (empty, "*", a short stem) is dropped
  return { ...(gov ? { govCountries: gov } : {}), ...(own ? { ownerWords: own } : {}) };
}

/** Records waiting for the owner (C86 canvas badge). */
export function pendingCount(db: Db): number {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM obs_records WHERE state = 'review'").get()?.c ?? 0);
}

// ── keyset pagination: cursor = "<updated_at>.<id>", newest first
export function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (cursor === undefined) return null;
  const m = /^(\d{1,16})\.([A-Za-z0-9_]{1,64})$/.exec(cursor);
  if (!m) throw new TbError("cursor_invalid", "the cursor is not valid", 400);
  return { at: Number(m[1]), id: str(m[2]) };
}
export function pageOf<T>(db: Db, table: "obs_records" | "obs_deliveries", where: string[], args: unknown[], cursor: string | undefined, view: (r: Row) => T): { items: T[]; nextCursor: string | null } {
  const c = decodeCursor(cursor);
  const w = [...where];
  const a = [...args];
  if (c) {
    w.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    a.push(c.at, c.at, c.id);
  }
  const rows = db.prepare(`SELECT * FROM ${table}${w.length ? ` WHERE ${w.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...a, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { items: page.map(view), nextCursor: rows.length > PAGE_SIZE && last ? `${Number(last.updated_at)}.${str(last.id)}` : null };
}

// ───────────────────────────────────────────────────────────────────────── review and deliveries
/** Delivery idempotency key (DESIGN §4.1): "obs_" + sha256(record id, revision, destination)[0..40]. */
export function deliveryKey(recordId: string, revision: number, destination: string, salt?: number): string {
  const parts: unknown[] = [recordId, revision, destination];
  if (salt !== undefined) parts.push(salt);
  return `obs_${sha256(JSON.stringify(parts)).slice(0, 40)}`;
}
export interface DeliveryView {
  id: string;
  recordId: string;
  revision: number;
  destination: string;
  targetRef: string | null;
  status: string;
  holdId: string | null;
  attempts: number;
  nextAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** e.g. "may_duplicate: …", kept on the row (set by a retry after 23 h) */
  warning: string | null;
  /** the record went back to Review after this row was written: it must not be sent */
  superseded: boolean;
}
/** The stored input (`input_json`) is NOT part of the view: from S4 it holds the text that is sent. */
export function deliveryView(r: Row): DeliveryView {
  return {
    id: str(r.id),
    recordId: str(r.record_id),
    revision: Number(r.revision),
    destination: str(r.destination),
    targetRef: strOrNull(r.target_ref),
    status: str(r.status),
    holdId: strOrNull(r.hold_id),
    attempts: Number(r.attempts),
    nextAt: iso(r.next_at),
    lastError: r.last_error === null || r.last_error === undefined ? null : str(r.last_error).slice(0, 280),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    warning: strOrNull(r.warning),
    superseded: Number(r.superseded) === 1,
  };
}
export function deliveryRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM obs_deliveries WHERE id = ?").get(id);
}

/** A record that held a secret: the `secret` column (set when the secret was removed before storage) or a `secret` class in
 *  pii_json. Such a record can only be dropped, whatever a rule or the owner's click says (DESIGN §5.3). FAIL CLOSED: a pii_json
 *  that cannot be read is treated as a secret. */
export function isSecretRecord(r: Row): boolean {
  if (Number(r.secret) === 1) return true;
  try {
    const v: unknown = JSON.parse(str(r.pii_json));
    if (!v || typeof v !== "object" || Array.isArray(v)) return true;
    const n = (v as Record<string, unknown>).secret;
    return n !== undefined && !(typeof n === "number" && n === 0);
  } catch {
    return true;
  }
}

export type Decision = "deliver" | "deliver_redacted" | "drop" | "keep";
const MAY_DUPLICATE_AFTER_REDECIDE = "may_duplicate: an earlier attempt may have reached the destination with the previous decision";
/**
 * The owner decides a waiting record. ALL guards live here (one place, whoever calls):
 *  1. a secret record (column or pii class, unreadable pii counts too) can only be dropped → secret_drop_only (409)
 *  2. the record must be in `review` → record_not_waiting (409)
 *  3. destination: deliver* needs knowledge | kanban | inbox (destination_required / destination_invalid, 400); drop takes
 *     none or "drop"; keep takes none. keep needs a record that was delivered → nothing_to_keep (409)
 *  4. deliver* and keep need text: some message of the record still has text and text_purge_at has not passed → text_gone (409)
 *  5. a delivery of the record that is `held` blocks every decision → delivery_held (409): decide the hold in Holds first
 *     (S4 will be able to cancel holds; until then deleting the row would orphan the hold)
 * Effects, one transaction:
 *  - EVERY decision deletes all non-sent outbox rows of the record except the one being rewritten (a superseded row can never
 *    be revived by delivery_retry)
 *  - drop → `dropped`, text goes after the retention. keep → a flagged record goes back to `delivered`, no new delivery.
 *  - deliver / deliver_redacted → `approved` + ONE outbox row per (record, revision, destination), status `pending`, with the
 *    idempotency key and the exact decide input. SENDING is S4 (nothing is called here). A row that is not sent is overwritten
 *    (input, status, attempts, hold, time, error): the NEW decision wins. If an attempt was made before, it gets a new key and
 *    the warning may_duplicate, because the destination may hold the old input under the old key.
 *  - every decision closes the open flags of the record
 */
export function decideRecord(
  db: Db,
  r: Row,
  d: { decision: Decision; destination: string | undefined; acknowledged?: boolean | undefined; input: unknown },
  by: string,
  now: number,
  textRetentionDays: number,
): void {
  const id = str(r.id);
  const revision = Number(r.revision);
  const deliver = d.decision === "deliver" || d.decision === "deliver_redacted";
  if (isSecretRecord(r) && d.decision !== "drop") throw new TbError("secret_drop_only", "this record held a secret; it can only be dropped", 409);
  // a record held as a possible secret is delivered AS IT IS only when the owner says so, on purpose (a UI gate alone is not enough)
  if (d.decision === "deliver" && isPossibleSecret(r) && d.acknowledged !== true) {
    throw new TbError("acknowledgement_required", "this record was held as a possible secret; delivering it as it is needs acknowledged: true after you read the text", 400);
  }
  if (str(r.state) !== "review") throw new TbError("record_not_waiting", `this record is ${str(r.state)}, not waiting for review`, 409);
  if (deliver) {
    if (d.destination === undefined) throw new TbError("destination_required", "choose where to deliver the record", 400);
    if (d.destination !== "knowledge" && d.destination !== "kanban" && d.destination !== "inbox") throw new TbError("destination_invalid", "choose knowledge, kanban or inbox", 400);
  } else if (d.destination !== undefined && (d.decision === "keep" || d.destination !== "drop")) {
    throw new TbError("destination_invalid", `a ${d.decision === "keep" ? "kept" : "dropped"} record has no destination`, 400);
  }
  if (d.decision === "keep" && !hasSentDelivery(db, id)) throw new TbError("nothing_to_keep", "this record was never delivered, so there is nothing to keep", 409);
  if (d.decision !== "drop") {
    const text = db.prepare("SELECT 1 AS x FROM obs_messages WHERE record_id = ? AND text IS NOT NULL AND deleted = 0 LIMIT 1").get(id);
    const expired = r.text_purge_at !== null && r.text_purge_at !== undefined && Number(r.text_purge_at) <= now;
    if (!text || expired) throw new TbError("text_gone", "the text of this record is gone (purged or past its retention); it can only be dropped", 409);
  }
  if (db.prepare("SELECT 1 AS x FROM obs_deliveries WHERE record_id = ? AND status = 'held'").get(id)) {
    throw new TbError("delivery_held", "a delivery of this record waits for approval; decide the hold in Holds first", 409);
  }
  db.transaction(() => {
    const purgeAt = now + textRetentionDays * DAY_MS;
    if (d.decision === "keep") {
      db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status <> 'sent'").run(id);
      db.prepare("UPDATE obs_records SET state = 'delivered', decided_by = ?, decided_at = ?, decided_destination = NULL, updated_at = ? WHERE id = ?").run(by, now, now, id);
    } else if (d.decision === "drop") {
      db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status <> 'sent'").run(id);
      db.prepare("UPDATE obs_records SET state = 'dropped', decided_by = ?, decided_at = ?, decided_destination = NULL, text_purge_at = ?, updated_at = ? WHERE id = ?").run(by, now, purgeAt, now, id);
    } else {
      const dest = d.destination as Destination;
      const input = JSON.stringify(d.input);
      const existing = db.prepare("SELECT * FROM obs_deliveries WHERE record_id = ? AND revision = ? AND destination = ?").get(id, revision, dest);
      if (existing && str(existing.status) === "sent") throw new TbError("already_delivered", "this revision of the record was already delivered to this destination", 409);
      // every other non-sent row is superseded by this decision
      db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status <> 'sent' AND id <> ?").run(id, existing ? str(existing.id) : "");
      if (!existing) {
        db.prepare(
          `INSERT INTO obs_deliveries (id, record_id, revision, destination, idem_key, input_json, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        ).run(`dlv_${ulid(now)}`, id, revision, dest, deliveryKey(id, revision, dest), input, now, now);
      } else {
        const attempted = existing.first_attempt_at !== null && existing.first_attempt_at !== undefined;
        db.prepare(
          `UPDATE obs_deliveries SET input_json = ?, status = 'pending', attempts = 0, hold_id = NULL, next_at = NULL, first_attempt_at = NULL,
             last_error = NULL, warning = ?, superseded = 0, idem_key = ?, updated_at = ? WHERE id = ?`,
        ).run(input, attempted ? MAY_DUPLICATE_AFTER_REDECIDE : null, attempted ? deliveryKey(id, revision, dest, now) : str(existing.idem_key), now, str(existing.id));
      }
      db.prepare("UPDATE obs_records SET state = 'approved', decided_by = ?, decided_at = ?, decided_destination = ?, text_purge_at = ?, updated_at = ? WHERE id = ?").run(by, now, dest, purgeAt, now, id);
    }
    db.prepare("UPDATE obs_flags SET closed_at = ? WHERE record_id = ? AND closed_at IS NULL").run(now, id);
  });
}

/** A held (or any unsent) delivery row of a record that goes back to Review is marked superseded: it may still be approved in Holds, but it must never be sent. */
export function supersedeHeld(db: Db, recordId: string): void {
  db.prepare("UPDATE obs_deliveries SET superseded = 1 WHERE record_id = ? AND status IN ('held', 'pending')").run(recordId);
}

/**
 * The one question S4 asks before it sends a row (also right after a hold is approved): is this delivery still what the owner decided?
 * Only a row of the owner's LAST decision (record approved, same revision, same destination), not superseded, of a record that is not a
 * secret record. A record in Review can never send anything.
 * TODO(S4): call this immediately before the companion call and after every hold approval.
 */
export function deliverySendable(db: Db, deliveryId: string): boolean {
  const d = deliveryRow(db, deliveryId);
  if (!d || Number(d.superseded) === 1 || !["pending", "held"].includes(str(d.status))) return false;
  const rec = recordRow(db, str(d.record_id));
  if (!rec || isSecretRecord(rec)) return false;
  return str(rec.state) === "approved" && Number(rec.revision) === Number(d.revision) && strOrNull(rec.decided_destination) === str(d.destination);
}

/** Does this record have a delivery Observer sent? (a `keep` makes sense only then) */
export function hasSentDelivery(db: Db, recordId: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM obs_deliveries WHERE record_id = ? AND status = 'sent'").get(recordId);
}

/**
 * Retry a delivery: S1 changes the row only (failed → pending); the send is S4. Inside 23 h of the first attempt the SAME
 * stored key is kept (idempotent re-send). After that the SDK's 24 h idempotency can no longer protect the call: a NEW key is
 * made and the row keeps a may_duplicate warning (shown by deliveries_list).
 */
export function retryDelivery(db: Db, r: Row, now: number): DeliveryView {
  const rec = recordRow(db, str(r.record_id));
  // a secret record is never delivered, also not by a retry of a row that was written before the secret was found
  if (rec && isSecretRecord(rec)) throw new TbError("secret_drop_only", "this record held a secret; it can only be dropped", 409);
  // only the row the owner's LAST decision made: the record is approved, at this row's revision, for this row's destination.
  // A row left over from an earlier decision (another destination, an older revision, a dropped record) is never revived.
  if (!rec || str(rec.state) !== "approved" || Number(rec.revision) !== Number(r.revision) || strOrNull(rec.decided_destination) !== str(r.destination)) {
    throw new TbError("delivery_state_invalid", "this delivery does not belong to the owner's last decision on the record; decide the record in Review", 409);
  }
  if (str(r.status) !== "failed") throw new TbError("delivery_state_invalid", `cannot retry a delivery that is ${str(r.status)}`, 409);
  const first = r.first_attempt_at === null || r.first_attempt_at === undefined ? null : Number(r.first_attempt_at);
  const stale = first !== null && now - first > SAME_KEY_WINDOW_MS;
  const key = stale ? deliveryKey(str(r.record_id), Number(r.revision), str(r.destination), now) : str(r.idem_key);
  const warning = stale ? "may_duplicate: the first attempt was more than 23 hours ago, so the destination may now hold a copy" : strOrNull(r.warning);
  db.prepare("UPDATE obs_deliveries SET status = 'pending', idem_key = ?, first_attempt_at = ?, next_at = ?, last_error = NULL, hold_id = NULL, warning = ?, updated_at = ? WHERE id = ?").run(
    key,
    stale ? null : first,
    now,
    warning,
    now,
    str(r.id),
  );
  const row = deliveryRow(db, str(r.id));
  if (!row) throw notFound("delivery");
  return deliveryView(row);
}

// ───────────────────────────────────────────────────────────────────────── flags (agent)
/** The record Observer delivered that `recordId` / `documentId` name: it has a `sent` outbox row (documentId = its target_ref).
 *  When both are given they must name the same record. null = unknown or never delivered. */
export function deliveredRecord(db: Db, i: { recordId?: string; documentId?: string }): { id: string; state: string } | null {
  const find = (sql: string, v: string): string | null => {
    const r = db.prepare(sql).get(v);
    return r ? str(r.id) : null;
  };
  const byRecord = i.recordId !== undefined ? find("SELECT d.record_id AS id FROM obs_deliveries d WHERE d.record_id = ? AND d.status = 'sent' LIMIT 1", i.recordId) : null;
  const byDocument = i.documentId !== undefined ? find("SELECT d.record_id AS id FROM obs_deliveries d WHERE d.target_ref = ? AND d.status = 'sent' LIMIT 1", i.documentId) : null;
  if (i.recordId !== undefined && byRecord === null) return null;
  if (i.documentId !== undefined && byDocument === null) return null;
  if (byRecord !== null && byDocument !== null && byRecord !== byDocument) return null;
  const id = byRecord ?? byDocument;
  const rec = id ? db.prepare("SELECT id, state FROM obs_records WHERE id = ?").get(id) : undefined;
  return rec ? { id: str(rec.id), state: str(rec.state) } : null;
}
/** The flag this agent already has open on the record (one open flag per agent and record). */
export function openFlag(db: Db, agent: string, recordId: string): string | null {
  const r = db.prepare("SELECT id FROM obs_flags WHERE by_id = ? AND record_id = ? AND closed_at IS NULL ORDER BY created_at, id LIMIT 1").get(agent, recordId);
  return r ? str(r.id) : null;
}
export function flagsToday(db: Db, agent: string, now: number): number {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM obs_flags WHERE by_id = ? AND created_at > ?").get(agent, now - DAY_MS)?.c ?? 0);
}
/** Record the flag and put the record back into Review (one transaction). The revision goes up, so the owner can replace the
 *  flagged delivery: deliver / deliver_redacted to the same destination is then a NEW outbox row (the old one stays `sent`). */
export function addFlag(db: Db, recordId: string, by: { type: string; id: string }, reason: string, now: number): string {
  const id = `flg_${ulid(now)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO obs_flags (id, record_id, by_type, by_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, recordId, by.type, by.id, reason, now);
    db.prepare("UPDATE obs_records SET state = 'review', revision = revision + 1, decided_by = NULL, decided_at = NULL, decided_destination = NULL, updated_at = ? WHERE id = ?").run(now, recordId);
    supersedeHeld(db, recordId);
  });
  return id;
}

// ───────────────────────────────────────────────────────────────────────── digests
/** text_digest = HMAC-SHA256 under the app secret `obs_digest_key` (a plain hash of a short message can be guessed).
 *  The key itself is handled by digest.ts. */
export function textDigest(key: string, text: string): string {
  return `hmac-sha256:${createHmac("sha256", key).update(text, "utf8").digest("hex")}`;
}

// ───────────────────────────────────────────────────────────────────────── rules
export interface RuleView {
  id: string;
  position: number;
  locked: boolean;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
}
function json(v: unknown): Record<string, unknown> {
  try {
    const o: unknown = JSON.parse(str(v));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export function ruleView(r: Row): RuleView {
  return { id: str(r.id), position: Number(r.position), locked: Number(r.locked) === 1, match: json(r.match_json), action: json(r.action_json) };
}
export function listRules(db: Db): RuleView[] {
  return db.prepare("SELECT * FROM obs_rules ORDER BY position, id LIMIT 500").all().map(ruleView);
}
function setOrder(db: Db, ids: string[], now: number): void {
  ids.forEach((id, position) => {
    db.prepare("UPDATE obs_rules SET position = ?, updated_at = ? WHERE id = ? AND position <> ?").run(position, now, id, position);
  });
}

/** Rule 0, "never keep secrets": locked, always first, created (and re-asserted) at start. */
export const RULE_ZERO = {
  match: { pii: ["secret"] },
  action: { deliver: "drop", redact: false },
} as const;
export function ensureRuleZero(db: Db, now: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO obs_rules (id, position, locked, match_json, action_json, created_at, updated_at) VALUES (?, 0, 1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET position = 0, locked = 1, match_json = excluded.match_json, action_json = excluded.action_json`,
    ).run(RULE_ZERO_ID, JSON.stringify(RULE_ZERO.match), JSON.stringify(RULE_ZERO.action), now, now);
    const others = db
      .prepare("SELECT id FROM obs_rules WHERE id <> ? ORDER BY position, id")
      .all(RULE_ZERO_ID)
      .map((r) => str(r.id));
    setOrder(db, [RULE_ZERO_ID, ...others], now);
  });
}

export interface RuleInput {
  id?: string;
  position: number;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
}
/** Create or change a rule and place it at `position` (rule 0 keeps position 0, so a rule's position is at least 1). */
export function putRule(db: Db, i: RuleInput, now: number): RuleView {
  return db.transaction(() => {
    const existing = i.id !== undefined ? db.prepare("SELECT * FROM obs_rules WHERE id = ?").get(i.id) : undefined;
    if (i.id !== undefined && !existing) throw notFound("rule");
    if (existing && Number(existing.locked) === 1) throw new TbError("rule_locked", "rule 0 (never keep secrets) is locked and cannot be edited or moved", 409);
    if (i.position < 1) throw new TbError("rule_locked", "position 0 belongs to the locked rule 0 (never keep secrets)", 409);
    const order = db
      .prepare("SELECT id FROM obs_rules ORDER BY position, id")
      .all()
      .map((r) => str(r.id));
    if (!existing && order.length >= MAX_RULES) throw new TbError("rules_limit", `at most ${MAX_RULES} rules`, 409);
    const id = existing ? str(existing.id) : `rul_${ulid(now)}`;
    // a safe default: Knowledge documents are drafts unless the rule says published
    const action = i.action.deliver === "knowledge" && i.action.knowledgeStatus === undefined ? { ...i.action, knowledgeStatus: "draft" } : i.action;
    if (existing) db.prepare("UPDATE obs_rules SET match_json = ?, action_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(i.match), JSON.stringify(action), now, id);
    else db.prepare("INSERT INTO obs_rules (id, position, locked, match_json, action_json, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)").run(id, order.length, JSON.stringify(i.match), JSON.stringify(action), now, now);
    const rest = order.filter((x) => x !== id);
    rest.splice(Math.min(i.position, rest.length), 0, id);
    setOrder(db, rest, now);
    const row = db.prepare("SELECT * FROM obs_rules WHERE id = ?").get(id);
    if (!row) throw notFound("rule");
    return ruleView(row);
  });
}
export function deleteRule(db: Db, id: string, now: number): boolean {
  return db.transaction(() => {
    const r = db.prepare("SELECT * FROM obs_rules WHERE id = ?").get(id);
    if (!r) return false;
    if (Number(r.locked) === 1) throw new TbError("rule_locked", "rule 0 (never keep secrets) is locked and cannot be deleted", 409);
    db.prepare("DELETE FROM obs_rules WHERE id = ?").run(id);
    setOrder(
      db,
      db
        .prepare("SELECT id FROM obs_rules ORDER BY position, id")
        .all()
        .map((x) => str(x.id)),
      now,
    );
    return true;
  });
}
export function reorderRules(db: Db, ids: string[], now: number): RuleView[] {
  return db.transaction(() => {
    const current = db
      .prepare("SELECT id FROM obs_rules")
      .all()
      .map((r) => str(r.id));
    const same = ids.length === current.length && new Set(ids).size === ids.length && current.every((c) => ids.includes(c));
    if (!same) throw new TbError("rules_mismatch", "ids must list every rule exactly once", 400);
    if (ids[0] !== RULE_ZERO_ID) throw new TbError("rule_locked", "rule 0 (never keep secrets) is locked at position 0", 409);
    setOrder(db, ids, now);
    return listRules(db);
  });
}

// ───────────────────────────────────────────────────────────────────────── backfill
export function activeBackfill(db: Db, source: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM obs_jobs WHERE source_id = ? AND kind = 'backfill' AND state IN ('queued', 'running', 'waiting', 'paused')").get(source);
}
export function createBackfill(db: Db, source: string, f: { since: number; until: number | null; maxMessages: number }, now: number): Row {
  const id = `job_${ulid(now)}`;
  db.prepare(
    `INSERT INTO obs_jobs (id, source_id, kind, state, since_at, until_at, max_messages, created_at, updated_at) VALUES (?, ?, 'backfill', 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, source, f.since, f.until, f.maxMessages, now, now);
  const row = jobRow(db, id);
  if (!row) throw notFound("job");
  return row;
}
