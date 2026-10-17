// Records and their messages (DESIGN §4.3 step 2): which record a window belongs to, what happens when a record's content changes
// after it was decided, and the purge of a record whose secret spans messages.
//
//  - attachWindow: the window → record mapping is PERSISTED in obs_messages.record_id. A window whose messages already belong to a
//    record gets that record back (the earliest one if a late message bridged two); only the messages not yet linked are added, and
//    that is a new revision. Nothing in the window key has to stay stable.
//  - reclassifyRecord: after an edit or a late message. A record that was approved or delivered and now holds MORE sensitive content
//    (a secret, a new PII class, more of one) goes back to Review with a new revision and without its unsent deliveries; the secret
//    flag is set when a secret appeared (then only "drop" is allowed). An approved record whose content changed at all goes back too:
//    its unsent delivery would send the old text.
//  - scanRecord / purgeRecordText: a secret found across messages. The texts are joined with "\n", "" and " ", and every adjacent pair
//    and triple is scanned at its seams too. A hit purges every message text of the record (ids, digests and the secret flag stay).
//    Above 256 KiB (or 2000 messages) the record is not scanned further: it is marked suspect and held for Review.
//  - a record with secret = 1 stores new and edited text as NULL (ids and digests only).
//  - KNOWN LIMIT: a secret split across two DIFFERENT records (two windows 30+ minutes apart) is not found.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { classifyMeta, classifyRecord } from "./classify.ts";
import { detectSecrets } from "./detect/secret.ts";
import { detectSuspect } from "./detect/suspect.ts";
import { loadClassifierConfig, parsePii, type Row, recordRow, supersedeHeld } from "./store.ts";
import type { MessageWindow } from "./window.ts";

const str = (v: unknown): string => String(v);

export function recordTexts(db: Db, recordId: string): (string | null)[] {
  return db
    .prepare("SELECT text FROM obs_messages WHERE record_id = ? AND deleted = 0 ORDER BY sent_at, provider_msg_id")
    .all(recordId)
    .map((r) => (r.text === null ? null : str(r.text)));
}

/** Thread subjects and author handles of a record, classified with the secret and suspect detectors. */
export function recordMetaFacts(db: Db, recordId: string): { secret: number; suspect: number } {
  const values: (string | null)[] = [];
  for (const r of db.prepare("SELECT DISTINCT thread, author_ref FROM obs_messages WHERE record_id = ?").all(recordId)) values.push(r.thread === null ? null : str(r.thread), str(r.author_ref));
  const thread = db.prepare("SELECT thread FROM obs_records WHERE id = ?").get(recordId)?.thread;
  values.push(thread === null || thread === undefined ? null : str(thread));
  return classifyMeta(values);
}

export function purgeRecordText(db: Db, recordId: string, now: number): void {
  db.transaction(() => {
    db.prepare("UPDATE obs_messages SET text = NULL, thread = NULL WHERE record_id = ?").run(recordId);
    db.prepare("UPDATE obs_records SET secret = 1, thread = NULL, updated_at = ? WHERE id = ?").run(now, recordId);
  });
}

export const JOINED_CAP = 256 * 1024;
export const MAX_SCANNED_MESSAGES = 2000;
const SEAM = 4096;
/** Past this many messages the seams look at a shorter tail / head: a secret split over messages is short. */
const MANY_MESSAGES = 200;
const SEAM_MANY = 512;

export interface JoinedScan {
  /** a secret appears when the texts are joined or at a seam */
  secret: boolean;
  /** a token that looks like a secret appears when the texts are joined or at a seam (it may be new: or found in one message too) */
  suspect: boolean;
  /** over the cap: not scanned across messages */
  toolarge: boolean;
}

/**
 * Scan the joined texts of a record for what no single message holds: the whole text with three separators, then each adjacent pair
 * and triple around its seams, with BOTH detectors (secrets and suspect tokens). Runs only when a record closes or changes.
 */
export function joinedScan(texts: readonly (string | null)[]): JoinedScan {
  const out: JoinedScan = { secret: false, suspect: false, toolarge: false };
  const parts = texts.filter((t): t is string => t !== null && t.length > 0);
  if (parts.length === 0) return out;
  const total = parts.reduce((n, t) => n + t.length, 0);
  if (total > JOINED_CAP || parts.length > MAX_SCANNED_MESSAGES) return { ...out, toolarge: true };
  const seps = ["\n", "", " "];
  const look = (t: string): boolean => {
    if (detectSecrets(t).count > 0) out.secret = true;
    else if (!out.suspect && detectSuspect(t).count > 0) out.suspect = true;
    return out.secret;
  };
  if (parts.length > 1) for (const sep of seps) if (look(parts.join(sep))) return out;
  const seam = parts.length > MANY_MESSAGES ? SEAM_MANY : SEAM;
  for (let i = 0; i + 1 < parts.length; i++) {
    const a = (parts[i] as string).slice(-seam);
    const b = parts[i + 1] as string;
    const c = parts[i + 2];
    for (const sep of seps) {
      if (look(a + sep + b.slice(0, seam))) return out;
      if (c !== undefined && look(a + sep + b.slice(0, 2 * seam) + sep + c.slice(0, seam))) return out;
    }
  }
  return out;
}

/** The secret part of joinedScan as before: "hit" (a secret), "toolarge", or "clean". */
export function joinedSecretScan(texts: readonly (string | null)[]): "hit" | "toolarge" | "clean" {
  const r = joinedScan(texts);
  return r.secret ? "hit" : r.toolarge ? "toolarge" : "clean";
}

/** Run the joined scan on a stored record; a secret purges every message text of the record. */
export function scanRecord(db: Db, recordId: string, now: number): JoinedScan {
  const result = joinedScan(recordTexts(db, recordId));
  if (result.secret) purgeRecordText(db, recordId, now);
  return result;
}

/** Re-read the record's messages after a change and apply the rules above. Returns true when the record went back to Review. */
export function reclassifyRecord(db: Db, recordId: string, now: number): boolean {
  const rec = recordRow(db, recordId);
  if (!rec) return false;
  const state = str(rec.state);
  if (state === "dropped") return false; // nothing to protect
  // the SAME joined scan as at close: an edit or a late message can complete a secret that was split over messages
  const scan = scanRecord(db, recordId, now);
  if (state === "open" || state === "classified") return false; // routed (and dropped, for a secret) when the window closes
  const facts = classifyRecord(recordTexts(db, recordId), loadClassifierConfig(db));
  if (scan.secret) {
    facts.classes.secret = Math.max(facts.classes.secret ?? 0, 1);
    facts.secret = true;
  }
  if (scan.toolarge || scan.suspect) facts.classes.suspect_secret = Math.max(facts.classes.suspect_secret ?? 0, 1);
  const meta = recordMetaFacts(db, recordId);
  if (meta.secret > 0) {
    facts.classes.secret = Math.max(facts.classes.secret ?? 0, meta.secret);
    facts.secret = true;
  }
  if (meta.suspect > 0) facts.classes.suspect_secret = Math.max(facts.classes.suspect_secret ?? 0, meta.suspect);
  const before = parsePii(rec.pii_json);
  const hadSecret = Number(rec.secret) === 1 || (before.secret ?? 0) > 0;
  const grew = (facts.secret && !hadSecret) || Object.entries(facts.classes).some(([c, n]) => c !== "secret" && n > (before[c] ?? 0));
  const secret = hadSecret || facts.secret ? 1 : 0;
  const pii = JSON.stringify(facts.classes);
  if (state === "review") {
    db.prepare("UPDATE obs_records SET pii_json = ?, secret = ?, actionable = ?, updated_at = ? WHERE id = ?").run(pii, secret, facts.actionable ? 1 : 0, now, recordId);
    return false;
  }
  if (state === "delivered" && !grew) return false;
  db.transaction(() => {
    // a held row is not deleted (its hold is in Holds): it is marked superseded and S4 never sends it
    supersedeHeld(db, recordId);
    db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status IN ('pending', 'failed')").run(recordId);
    db.prepare(
      `UPDATE obs_records SET state = 'review', revision = revision + 1, pii_json = ?, secret = ?, actionable = ?, decided_by = NULL, decided_at = NULL,
         decided_destination = NULL, updated_at = ? WHERE id = ?`,
    ).run(pii, secret, facts.actionable ? 1 : 0, now, recordId);
  });
  return true;
}

export interface Attached {
  recordId: string;
  created: boolean;
  /** messages newly linked to the record */
  added: number;
  revision: number;
}

/** Give a window its record: the one its messages already belong to, or a new one. Late messages are added as a new revision. */
export function attachWindow(db: Db, sourceId: string, w: MessageWindow, now: number): Attached {
  return db.transaction(() => {
    const found = new Set<string>();
    for (let i = 0; i < w.messageIds.length; i += 400) {
      const ids = w.messageIds.slice(i, i + 400);
      const marks = ids.map(() => "?").join(", ");
      for (const r of db.prepare(`SELECT DISTINCT record_id FROM obs_messages WHERE source_id = ? AND conversation = ? AND provider_msg_id IN (${marks}) AND record_id IS NOT NULL`).all(sourceId, w.conversation, ...ids)) found.add(str(r.record_id));
    }
    let target: Row | undefined;
    if (found.size > 0) {
      const marks = [...found].map(() => "?").join(", ");
      // a late message may bridge two records: the earliest one keeps the window (the other stays as it is)
      target = db.prepare(`SELECT * FROM obs_records WHERE id IN (${marks}) ORDER BY created_at, id LIMIT 1`).get(...found);
    }
    const created = !target;
    const recordId = target ? str(target.id) : `rec_${ulid(now)}`;
    if (!target) {
      db.prepare(
        `INSERT INTO obs_records (id, source_id, thread, window_start, window_end, revision, state, pii_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'open', '{}', ?, ?)`,
      ).run(recordId, sourceId, w.thread, w.start, w.end, now, now);
    }
    let added = 0;
    const link = db.prepare("UPDATE obs_messages SET record_id = ? WHERE source_id = ? AND conversation = ? AND provider_msg_id = ? AND record_id IS NULL");
    for (const id of w.messageIds) added += link.run(recordId, sourceId, w.conversation, id).changes;
    // a secret record keeps ids and digests only: text that arrives for it is not stored
    if (Number(recordRow(db, recordId)?.secret) === 1) db.prepare("UPDATE obs_messages SET text = NULL, thread = NULL WHERE record_id = ?").run(recordId);
    if (!created && added > 0) {
      const state = str(target?.state);
      db.prepare(
        "UPDATE obs_records SET revision = revision + 1, window_start = MIN(window_start, ?), window_end = MAX(window_end, ?), state = CASE WHEN state = 'classified' THEN 'open' ELSE state END, updated_at = ? WHERE id = ?",
      ).run(w.start, w.end, now, recordId);
      if (state === "approved" || state === "delivered" || state === "review") reclassifyRecord(db, recordId, now);
    }
    const revision = Number(recordRow(db, recordId)?.revision ?? 1);
    return { recordId, created, added, revision };
  });
}
