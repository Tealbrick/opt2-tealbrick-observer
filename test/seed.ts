// Seed rows straight into the tables (S1 has no op that reads a source, so these are the rows S2 will write).
// Shared by the unit tests and by conformance.start.ts (fixed ids there, so tealbrick-conformance.json can name them).
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type IncomingMessage, storeMessage } from "../src/ingest.ts";
import { attachWindow } from "../src/records.ts";
import { authorKey } from "../src/store.ts";
import { liveWindows } from "../src/window.ts";

/** A valid 26-character ULID body that ends in `tag` (Crockford: no I, L, O, U). */
export const fixedId = (prefix: string, tag: string): string => `${prefix}_01J${"0".repeat(23 - tag.length)}${tag}`;

export interface SourceSeed {
  id?: string;
  label?: string;
  kind?: string;
  account?: string;
  conversations?: string[];
  exclude?: { senders: string[]; domains: string[] };
  historyCapable?: boolean;
  retentionDays?: number | null;
  createdAt?: number;
}
export function seedSource(db: Db, s: SourceSeed = {}): string {
  const id = s.id ?? `src_${ulid()}`;
  const t = s.createdAt ?? Date.UTC(2026, 9, 1);
  db.prepare(
    `INSERT INTO obs_sources (id, account, kind, label, conversations_json, exclude_json, live_interval_s, retention_days, history_capable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 60, ?, ?, ?, ?)`,
  ).run(id, s.account ?? "acc_gmail_1", s.kind ?? "gmail", s.label ?? "Work mail", JSON.stringify(s.conversations ?? ["inbox", "projects"]), JSON.stringify(s.exclude ?? { senders: [], domains: [] }), s.retentionDays ?? null, s.historyCapable === false ? 0 : 1, t, t);
  return id;
}

export interface JobSeed {
  id?: string;
  kind?: "live" | "backfill";
  state?: string;
  pausedBy?: string | null;
  readCount?: number;
  recordCount?: number;
  failures?: number;
  maxMessages?: number | null;
  sinceAt?: number | null;
  retryAt?: number | null;
  lastError?: string | null;
  createdAt?: number;
}
export function seedJob(db: Db, source: string, j: JobSeed = {}): string {
  const id = j.id ?? `job_${ulid()}`;
  const t = j.createdAt ?? Date.UTC(2026, 9, 1);
  db.prepare(
    `INSERT INTO obs_jobs (id, source_id, kind, state, paused_by, read_count, record_count, consecutive_failures, max_messages, since_at, retry_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, source, j.kind ?? "live", j.state ?? "paused", j.pausedBy ?? null, j.readCount ?? 0, j.recordCount ?? 0, j.failures ?? 0, j.maxMessages ?? null, j.sinceAt ?? null, j.retryAt ?? null, j.lastError ?? null, t, t);
  return id;
}

export interface MessageSeed {
  conversation?: string;
  id?: string;
  author?: string;
  authorKind?: "person" | "bot" | "self";
  text?: string | null;
  sentAt?: number;
  deleted?: boolean;
  record?: string | null;
  thread?: string | null;
}
export function seedMessage(db: Db, source: string, m: MessageSeed = {}): string {
  const id = m.id ?? `m_${ulid()}`;
  db.prepare(
    `INSERT INTO obs_messages (source_id, conversation, provider_msg_id, thread, sent_at, deleted, author_ref, author_key, author_kind, text, text_digest, record_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(source, m.conversation ?? "inbox", id, m.thread ?? null, m.sentAt ?? Date.UTC(2026, 9, 2), m.deleted ? 1 : 0, m.author ?? "email:anna@example.com", authorKey(m.author ?? "email:anna@example.com"), m.authorKind ?? "person", m.text === undefined ? "hello there" : m.text, `sha256:${id}`, m.record ?? null);
  return id;
}

export interface RecordSeed {
  id?: string;
  state?: string;
  revision?: number;
  secret?: boolean;
  pii?: Record<string, number>;
  thread?: string | null;
  textPurgeAt?: number | null;
  updatedAt?: number;
  /** also store one message with text for this record (a record can be delivered only while it has text) */
  withText?: boolean;
  /** the destination the owner decided (an approved record) */
  destination?: "knowledge" | "kanban" | "inbox" | null;
}
export function seedRecord(db: Db, source: string, r: RecordSeed = {}): string {
  const id = r.id ?? `rec_${ulid()}`;
  const t = r.updatedAt ?? Date.UTC(2026, 9, 3);
  db.prepare(
    `INSERT INTO obs_records (id, source_id, thread, window_start, window_end, revision, state, pii_json, secret, text_purge_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, source, r.thread ?? "t1", t - 60_000, t, r.revision ?? 1, r.state ?? "review", JSON.stringify(r.pii ?? {}), r.secret ? 1 : 0, r.textPurgeAt ?? null, t, t);
  if (r.destination) db.prepare("UPDATE obs_records SET decided_destination = ? WHERE id = ?").run(r.destination, id);
  if (r.withText) seedMessage(db, source, { record: id, text: "some words", id: `m_${id}` });
  return id;
}

export interface DeliverySeed {
  id?: string;
  revision?: number;
  destination?: "knowledge" | "kanban" | "inbox";
  status?: "pending" | "held" | "sent" | "failed";
  targetRef?: string | null;
  firstAttemptAt?: number | null;
  key?: string;
  updatedAt?: number;
}
export function seedDelivery(db: Db, record: string, d: DeliverySeed = {}): string {
  const id = d.id ?? `dlv_${ulid()}`;
  const t = d.updatedAt ?? Date.UTC(2026, 9, 4);
  db.prepare(
    `INSERT INTO obs_deliveries (id, record_id, revision, destination, target_ref, idem_key, input_json, status, attempts, first_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, ?)`,
  ).run(id, record, d.revision ?? 1, d.destination ?? "knowledge", d.targetRef ?? null, d.key ?? `obs_${id}`, d.status ?? "sent", d.firstAttemptAt ?? null, t, t);
  // an approved record without a decided destination takes the one of its first delivery (what review_decide would have set)
  db.prepare("UPDATE obs_records SET decided_destination = ? WHERE id = ? AND state = 'approved' AND decided_destination IS NULL AND revision = ?").run(d.destination ?? "knowledge", record, d.revision ?? 1);
  return id;
}

/** What `pnpm conformance` needs so every agent op runs on valid input (ids are named in tealbrick-conformance.json). */
export const CONFORMANCE = {
  job: fixedId("job", "C0NFJ0B"),
  record: fixedId("rec", "C0NFREC"),
};
export function seedConformance(db: Db): void {
  // the harness restarts the app on the same data dir (A7.restart): seed once
  if (db.prepare("SELECT 1 AS x FROM obs_sources WHERE id = ?").get(fixedId("src", "C0NF5RC"))) return;
  const src = seedSource(db, { id: fixedId("src", "C0NF5RC"), label: "Conformance source" });
  seedJob(db, src, { id: CONFORMANCE.job, kind: "live", state: "queued" });
  const rec = seedRecord(db, src, { id: CONFORMANCE.record, state: "delivered" });
  seedDelivery(db, rec, { id: fixedId("dlv", "C0NFD1V"), status: "sent", targetRef: "doc_conformance", key: "obs_conformance_fixture" });
}

/** Ingest texts the way S2 will: storeMessage for each (secrets cleaned, exclusions applied), then the window → record mapping.
 *  Returns the record id (all texts end up in one window: they are one minute apart in one thread). */
export function ingestRecord(db: Db, source: string, texts: string[], at: number, extra: Partial<IncomingMessage> = {}): string {
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) {
    const providerMsgId = `ing_${at}_${i}_${Math.random().toString(36).slice(2, 8)}`;
    storeMessage(db, source, { conversation: "inbox", providerMsgId, thread: "t1", sentAt: at - 60_000 * (texts.length - i), author: "email:anna@example.com", authorKind: "person", text, ...extra }, at);
    ids.push(providerMsgId);
  }
  const windows = liveWindows(
    ids.map((id, i) => ({ id, conversation: "inbox", thread: "t1", sentAt: at - 60_000 * (texts.length - i), chars: 10 })),
    at,
  );
  let record = "";
  for (const w of windows) record = attachWindow(db, source, w, at).recordId;
  return record;
}
