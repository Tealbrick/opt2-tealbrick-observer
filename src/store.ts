// Table access over the app's own tables (migrations/0001_init.sql): plain functions over the SDK `Db`, so handlers stay
// thin and tests run them against the migrated database. Time is always passed in (injected clock).
//
// Privacy shape (DESIGN §5.5, §5.7): message text lives only in obs_messages.text and is returned only by the person
// record views (recordView with messages). The agent `status` view is built here from labels and counts alone.
import { createHash } from "node:crypto";
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";

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
export function excludeOf(r: Row): Exclude {
  try {
    const v = JSON.parse(str(r.exclude_json)) as Partial<Exclude>;
    return { senders: Array.isArray(v.senders) ? v.senders.map(String) : [], domains: Array.isArray(v.domains) ? v.domains.map(String) : [] };
  } catch {
    return { senders: [], domains: [] };
  }
}
export function conversationsOf(r: Row): string[] {
  return parseList(r.conversations_json);
}

/** Source view. Labels, kinds and counts only: no message text, sender or conversation title is ever read here except the
 *  owner-chosen conversation ids, which only the person views (`withConversations`) return. */
export function sourceView(db: Db, r: Row): SourceView {
  const jobs = db.prepare("SELECT * FROM obs_jobs WHERE source_id = ? ORDER BY created_at DESC, id DESC").all(str(r.id));
  const live = jobs.find((j) => j.kind === "live");
  const hist = jobs.find((j) => j.kind === "backfill");
  return {
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
  };
}

/** The agent view of the sources: labels and counts only (DESIGN §3.1, §5.7). Built field by field so a new column can never leak. */
export function statusView(db: Db): { sources: Pick<SourceView, "id" | "label" | "kind" | "live" | "history">[]; review: { waiting: number } } {
  const rows = db.prepare("SELECT * FROM obs_sources ORDER BY created_at, id LIMIT 100").all();
  return {
    sources: rows.map((r) => {
      const v = sourceView(db, r);
      return { id: v.id, label: v.label, kind: v.kind, live: v.live, history: v.history };
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

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Delete stored messages that a source no longer may hold (a narrowed conversation list, new exclusions): "narrowing applies at once". */
export function dropOutOfScope(db: Db, sourceId: string, removedConversations: string[], exclude: Exclude | null): number {
  let n = 0;
  if (removedConversations.length > 0) {
    const marks = removedConversations.map(() => "?").join(", ");
    n += db.prepare(`DELETE FROM obs_messages WHERE source_id = ? AND conversation IN (${marks})`).run(sourceId, ...removedConversations).changes;
  }
  if (exclude) {
    // author_ref is "<channel>:<value>"; a sender matches the whole ref or the value part, a domain matches "…@domain"
    for (const s of exclude.senders) {
      const v = s.toLowerCase();
      n += db
        .prepare("DELETE FROM obs_messages WHERE source_id = ? AND (lower(author_ref) = ? OR lower(substr(author_ref, instr(author_ref, ':') + 1)) = ?)")
        .run(sourceId, v, v).changes;
    }
    for (const d of exclude.domains) {
      n += db.prepare("DELETE FROM obs_messages WHERE source_id = ? AND lower(author_ref) LIKE ? ESCAPE '\\'").run(sourceId, `%@${likeEscape(d.toLowerCase())}`).changes;
    }
  }
  return n;
}

/**
 * Remove a source: cancel its jobs, delete stored text, message ids, records, deliveries ledger and flags, then the source.
 * One transaction. Documents already delivered to Knowledge stay (the owner deletes them there).
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

/** Delete stored message TEXT now (ids and digests stay so nothing is read twice). Returns how many texts went. */
export function purgeText(db: Db, f: { source?: string; before?: number }): number {
  const where = ["text IS NOT NULL"];
  const args: unknown[] = [];
  if (f.source !== undefined) {
    where.push("source_id = ?");
    args.push(f.source);
  }
  if (f.before !== undefined) {
    where.push("sent_at < ?");
    args.push(f.before);
  }
  return db.prepare(`UPDATE obs_messages SET text = NULL WHERE ${where.join(" AND ")}`).run(...args).changes;
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
  ruleId: string | null;
  actionable: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  textPurgeAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
/** Record summary: no message text (lists never carry text). */
export function recordView(r: Row): RecordView {
  return {
    id: str(r.id),
    source: str(r.source_id),
    thread: strOrNull(r.thread),
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    revision: Number(r.revision),
    state: str(r.state),
    pii: parsePii(r.pii_json),
    secret: Number(r.secret) === 1,
    ruleId: strOrNull(r.rule_id),
    actionable: Number(r.actionable) === 1,
    decidedBy: strOrNull(r.decided_by),
    decidedAt: iso(r.decided_at),
    textPurgeAt: iso(r.text_purge_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
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
}
/** Record with its messages (person ops only). Text is shown only while inside retention. */
export function recordDetail(db: Db, r: Row, now: number): RecordView & { messages: MessageView[]; spans: never[] } {
  const purgeAt = r.text_purge_at === null || r.text_purge_at === undefined ? null : Number(r.text_purge_at);
  const expired = purgeAt !== null && purgeAt <= now;
  const msgs = db.prepare("SELECT * FROM obs_messages WHERE record_id = ? ORDER BY sent_at, provider_msg_id LIMIT 500").all(str(r.id));
  return {
    ...recordView(r),
    messages: msgs.map((m) => ({
      conversation: str(m.conversation),
      id: str(m.provider_msg_id),
      thread: strOrNull(m.thread),
      sentAt: iso(m.sent_at),
      editedAt: iso(m.edited_at),
      deleted: Number(m.deleted) === 1,
      author: str(m.author_ref),
      authorKind: str(m.author_kind),
      text: expired || Number(m.deleted) === 1 || m.text === null ? null : str(m.text),
    })),
    // TODO(S3): detected PII spans (offsets + class) once the deterministic detectors exist.
    spans: [],
  };
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
  warning: string | null;
}
/** The stored input (`input_json`) is NOT part of the view: from S4 it holds the text that is sent. */
export function deliveryView(r: Row, warning: string | null = null): DeliveryView {
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
    warning,
  };
}
export function deliveryRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM obs_deliveries WHERE id = ?").get(id);
}

/**
 * The owner decides a waiting record. Secret records: only drop (checked by the caller, which owns the error).
 * drop → state `dropped`, text goes after the retention. deliver / deliver_redacted → state `approved` + one outbox row in
 * status `pending` with the idempotency key and the exact decide input. SENDING is S4 (nothing is called here).
 */
export function decideRecord(
  db: Db,
  r: Row,
  d: { decision: "deliver" | "deliver_redacted" | "drop"; destination: Destination | null; input: unknown },
  by: string,
  now: number,
  textRetentionDays: number,
): void {
  db.transaction(() => {
    const id = str(r.id);
    const revision = Number(r.revision);
    if (d.decision === "drop") {
      db.prepare("UPDATE obs_records SET state = 'dropped', decided_by = ?, decided_at = ?, text_purge_at = ?, updated_at = ? WHERE id = ?").run(by, now, now + textRetentionDays * DAY_MS, now, id);
      return;
    }
    const dest = d.destination as Destination;
    const key = deliveryKey(id, revision, dest);
    const existing = db.prepare("SELECT * FROM obs_deliveries WHERE idem_key = ?").get(key);
    if (existing && str(existing.status) === "sent") throw new TbError("already_delivered", "this revision of the record was already delivered to this destination", 409);
    if (!existing) {
      db.prepare(
        `INSERT INTO obs_deliveries (id, record_id, revision, destination, idem_key, input_json, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(`dlv_${ulid(now)}`, id, revision, dest, key, JSON.stringify(d.input), now, now);
    }
    db.prepare("UPDATE obs_records SET state = 'approved', decided_by = ?, decided_at = ?, text_purge_at = ?, updated_at = ? WHERE id = ?").run(by, now, now + textRetentionDays * DAY_MS, now, id);
  });
}

/**
 * Retry a delivery: S1 changes the row only (failed → pending); the send is S4. Inside 23 h of the first attempt the SAME
 * stored key is kept (idempotent re-send). After that the SDK's 24 h idempotency can no longer protect the call: a NEW key is
 * made and the row says it may duplicate.
 */
export function retryDelivery(db: Db, r: Row, now: number): DeliveryView {
  if (str(r.status) !== "failed") throw new TbError("delivery_state_invalid", `cannot retry a delivery that is ${str(r.status)}`, 409);
  const first = r.first_attempt_at === null || r.first_attempt_at === undefined ? null : Number(r.first_attempt_at);
  const stale = first !== null && now - first > SAME_KEY_WINDOW_MS;
  const key = stale ? deliveryKey(str(r.record_id), Number(r.revision), str(r.destination), now) : str(r.idem_key);
  db.prepare("UPDATE obs_deliveries SET status = 'pending', idem_key = ?, first_attempt_at = ?, next_at = ?, last_error = NULL, hold_id = NULL, updated_at = ? WHERE id = ?").run(
    key,
    stale ? null : first,
    now,
    now,
    str(r.id),
  );
  const row = deliveryRow(db, str(r.id));
  if (!row) throw notFound("delivery");
  return deliveryView(row, stale ? "may_duplicate: the first attempt was more than 23 hours ago, so the destination may now hold a copy" : null);
}

// ───────────────────────────────────────────────────────────────────────── flags (agent)
/** A record counts as delivered by Observer when one of its outbox rows is `sent`. documentId is matched with target_ref. */
export function deliveredRecordId(db: Db, i: { recordId?: string; documentId?: string }): string | null {
  let byRecord: string | null = null;
  let byDocument: string | null = null;
  if (i.recordId !== undefined) {
    const r = db.prepare("SELECT d.record_id AS id FROM obs_deliveries d WHERE d.record_id = ? AND d.status = 'sent' LIMIT 1").get(i.recordId);
    if (!r) return null;
    byRecord = str(r.id);
  }
  if (i.documentId !== undefined) {
    const r = db.prepare("SELECT d.record_id AS id FROM obs_deliveries d WHERE d.target_ref = ? AND d.status = 'sent' LIMIT 1").get(i.documentId);
    if (!r) return null;
    byDocument = str(r.id);
  }
  if (byRecord !== null && byDocument !== null && byRecord !== byDocument) return null;
  return byRecord ?? byDocument;
}
export function flagsToday(db: Db, agent: string, now: number): number {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM obs_flags WHERE by_id = ? AND created_at > ?").get(agent, now - DAY_MS)?.c ?? 0);
}
/** Record the flag and put the record back into Review (one transaction). */
export function addFlag(db: Db, recordId: string, by: { type: string; id: string }, reason: string, now: number): string {
  const id = `flg_${ulid(now)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO obs_flags (id, record_id, by_type, by_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, recordId, by.type, by.id, reason, now);
    db.prepare("UPDATE obs_records SET state = 'review', decided_by = NULL, decided_at = NULL, updated_at = ? WHERE id = ?").run(now, recordId);
  });
  return id;
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
