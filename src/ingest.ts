// What S2's ingestion calls for every message it reads (DESIGN §4.1, §5.3). Two rules are enforced HERE, so no caller can skip them:
//  1. a secret is replaced BEFORE the text is stored: obs_messages.text never holds one (rule 0, "never keep secrets")
//  2. a message by an excluded sender, or outside the source's conversations, is never stored at all
// The text is at most 16 KiB (UTF-8); a longer one is cut with a marker. Secrets are searched in the part that is read (the first
// 64 K characters), BEFORE the cut, so a secret that straddles the 16 KiB boundary is replaced, not cut in half.

import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { SECRET_MARKER } from "./classify.ts";
import { now as clockNow } from "./clock.ts";
import { redactText } from "./detect/redact.ts";
import { detectSecrets } from "./detect/secret.ts";
import { digestOf } from "./digest.ts";
import { reclassifyRecord } from "./records.ts";
import { authorKey, conversationsOf, excludeOf, isExcluded, sourceRow } from "./store.ts";

export const MAX_TEXT_BYTES = 16 * 1024;
export const CUT_MARKER = " […cut]";
const DETECT_CHARS = 64 * 1024;
const RESERVE_BYTES = 64; // room for the cut marker and a secret marker

export interface Sanitized {
  text: string;
  /** how many secrets were replaced */
  secrets: number;
  cut: boolean;
}

function cutToBytes(text: string, max: number): string {
  return Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�+$/u, "");
}

/** The marker is how a later step knows a secret was here, so a message must not be able to carry one: quoted markers are defanged. */
const QUOTED_MARKER = /\[secret removed\]/gi;
const defang = (t: string): string => t.replace(QUOTED_MARKER, "[secret removed -]");

export function sanitizeForStorage(text: string): Sanitized {
  const clean = defang(text);
  const head = clean.length > DETECT_CHARS ? clean.slice(0, DETECT_CHARS) : clean;
  const found = detectSecrets(head);
  let t = found.count > 0 ? redactText(head, [found]) : head;
  let cut = clean.length > head.length;
  if (Buffer.byteLength(t, "utf8") > MAX_TEXT_BYTES - RESERVE_BYTES) {
    cut = true;
    t = cutToBytes(t, MAX_TEXT_BYTES - RESERVE_BYTES);
  }
  if (cut) t += CUT_MARKER;
  // the marker is what tells the classifier later that this text had a secret: make sure the cut did not take it away
  if (found.count > 0 && !t.includes(SECRET_MARKER)) t += ` ${SECRET_MARKER}`;
  return { text: t, secrets: found.count, cut };
}

/** Thread subjects and author handles are text too: a secret in them is replaced with the same detector, and they are bounded. */
export function sanitizeShort(value: string, max = 300): string {
  const s = sanitizeForStorage(value).text;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface IncomingMessage {
  conversation: string;
  providerMsgId: string;
  thread?: string | null;
  sentAt: number;
  editedAt?: number | null;
  deleted?: boolean;
  /** canonical handle "<channel>:<value>" */
  author: string;
  authorKind: "person" | "bot" | "self";
  text: string;
}
export interface StoreResult {
  status: "inserted" | "updated" | "unchanged" | "excluded" | "out_of_scope";
  /** secrets replaced in this message (the record that holds it is a secret record) */
  secrets: number;
  /** an edit sent an already decided record back to Review */
  reopened?: boolean;
}

/**
 * Store one message: idempotent per (source, conversation, provider message id). A second copy is ignored; an EDIT (a newer
 * edited_at) replaces text and digest; a provider deletion removes the text. Refuses (throws digest_key_*) when the digest key
 * is not available, so a message never lands without its keyed digest.
 */
export function storeMessage(db: Db, sourceId: string, m: IncomingMessage, arrivedAt: number = clockNow()): StoreResult {
  const src = sourceRow(db, sourceId);
  if (!src || !conversationsOf(src).includes(m.conversation)) return { status: "out_of_scope", secrets: 0 };
  // exclusions are checked on the handle as it came (and on the cleaned one below)
  const exclude = excludeOf(src);
  if (isExcluded(authorKey(m.author), exclude)) return { status: "excluded", secrets: 0 };
  const author = sanitizeShort(m.author, 200);
  const key = authorKey(author);
  if (isExcluded(key, exclude)) return { status: "excluded", secrets: 0 };
  const thread = m.thread == null ? null : sanitizeShort(m.thread);
  // a sent time in the future counts as the arrival time; a missing / NaN one IS the arrival time
  const sentAt = Number.isFinite(m.sentAt) ? Math.min(m.sentAt, arrivedAt) : arrivedAt;
  const editedAt = m.editedAt == null || !Number.isFinite(m.editedAt) ? null : Math.min(m.editedAt, arrivedAt);
  const clean = m.deleted ? { text: "", secrets: 0 } : sanitizeForStorage(m.text);
  const digest = digestOf(clean.text);
  const text = m.deleted ? null : clean.text;
  return db.transaction(() => {
    const old = db.prepare("SELECT edited_at, deleted, record_id FROM obs_messages WHERE source_id = ? AND conversation = ? AND provider_msg_id = ?").get(sourceId, m.conversation, m.providerMsgId);
    if (!old) {
      db.prepare(
        `INSERT INTO obs_messages (source_id, conversation, provider_msg_id, thread, sent_at, edited_at, deleted, author_ref, author_key, author_kind, text, text_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sourceId, m.conversation, m.providerMsgId, thread, sentAt, editedAt, m.deleted ? 1 : 0, author, key, m.authorKind, text, digest);
      return { status: "inserted" as const, secrets: clean.secrets };
    }
    const newer = editedAt !== null && (old.edited_at === null || editedAt > Number(old.edited_at));
    const nowDeleted = m.deleted === true && Number(old.deleted) === 0;
    if (!newer && !nowDeleted) return { status: "unchanged" as const, secrets: 0 };
    db.prepare("UPDATE obs_messages SET text = ?, text_digest = ?, edited_at = ?, deleted = ? WHERE source_id = ? AND conversation = ? AND provider_msg_id = ?").run(
      text,
      digest,
      editedAt ?? (old.edited_at === null ? null : Number(old.edited_at)),
      m.deleted ? 1 : Number(old.deleted),
      sourceId,
      m.conversation,
      m.providerMsgId,
    );
    // an edit changes what the record holds: look again, and send a decided record back to Review if it now holds more
    const reopened = old.record_id != null && !m.deleted ? reclassifyRecord(db, String(old.record_id), arrivedAt) : false;
    return { status: "updated" as const, secrets: clean.secrets, reopened };
  });
}
