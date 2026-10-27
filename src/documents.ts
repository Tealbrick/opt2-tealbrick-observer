// Documents (C373, contract documents/1 DRAFT): one record per document. What the documents job calls for every row it pulls.
//
//  - dedupe on (account, collection, id): a source has one account, and source_add refuses a second documents source of the same
//    account for a collection another source already reads, so (source, collection, id) is that key. `rev` is compared for
//    equality only: the same rev is the same content (skipped). Otherwise `updatedAt` orders: an older row is ignored, a newer one
//    wins, and with an equal `updatedAt` and a different rev the row received later wins. A deletion carries a new rev
//  - every string member is untrusted: Observer never renders HTML from it and never fetches anything it names (url, images)
//  - the text is cleaned first (control, bidi and zero-width characters go: the contract leaves that to consumers), then stored as
//    chunk messages of at most DOC_CHUNK_BYTES each (cut at a line end where one is near) through storeMessage, so every rule of
//    ingest.ts holds for documents too: secrets are replaced BEFORE storage, an excluded author is never stored, the keyed digest.
//    The chunks are ONE closed window, so ONE record, routed at once (records.ts joined scan + pipeline.ts applyRouting: rule 0,
//    the owner's rules, PII → Review). A document has no author when the source names none ("" never matches an exclusion)
//  - a new revision retires the old record: its stored text goes and so does every unsent delivery; a record that was delivered
//    (or has a delivery held in Holds) stays as history, the others are deleted. The new record's delivery UPDATES the Knowledge
//    document of the old one (obs_targets is keyed on the provenance, deliver.ts)
//  - deleted: true follows the privacy setting `onSourceDelete`: `purge` retires the record now (as above); `keep` leaves the
//    record and its text until the retention ends. A document already in Knowledge stays there (the owner deletes it there)
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { cleanText, type DocumentRow } from "./contract.ts";
import { sanitizeShort, storeMessage } from "./ingest.ts";
import { applyRouting } from "./pipeline.ts";
import { attachWindow } from "./records.ts";
import { conversationsOf, getPrivacy, hasSentDelivery, sourceRow, supersedeHeld } from "./store.ts";

/** A chunk stays well under the 16 KiB message cap (ingest.ts), with room for secret labels and markers. */
export const DOC_CHUNK_BYTES = 14 * 1024;

const str = (v: unknown): string => String(v);

/** Cut a text into pieces of at most `maxBytes` UTF-8 bytes, at a line end in the second half of a piece when there is one, never
 *  inside a character. An empty text is one empty piece. */
export function chunkText(text: string, maxBytes = DOC_CHUNK_BYTES): string[] {
  const out: string[] = [];
  let start = 0; // UTF-16 index where the current piece starts
  let bytes = 0;
  let lastNl = -1; // UTF-16 index just after the last line end in the current piece
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const units = cp > 0xffff ? 2 : 1;
    // a lone surrogate is written as 3 bytes (U+FFFD), like every other character of the BMP above U+07FF
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp > 0xffff ? 4 : 3;
    if (bytes + size > maxBytes && i > start) {
      const cut = lastNl > start && lastNl - start >= (i - start) / 2 ? lastNl : i;
      out.push(text.slice(start, cut));
      start = cut;
      bytes = Buffer.byteLength(text.slice(start, i), "utf8");
      lastNl = -1;
      continue;
    }
    bytes += size;
    i += units;
    if (cp === 10) lastNl = i;
  }
  out.push(text.slice(start));
  return out;
}

export interface DocResult {
  status: "inserted" | "updated" | "unchanged" | "stale" | "deleted" | "excluded" | "out_of_scope";
  /** the record the document's text now belongs to (null: none) */
  recordId: string | null;
}

/** The chunk message id of piece `n` of a document. Zero-padded: records order their messages by (sent time, id), and every
 *  chunk of a document has the same time, so "#010" must sort after "#009" (a 256 Ki-character document has at most ~75 chunks). */
export const chunkId = (docId: string, n: number): string => `${docId}#${String(n).padStart(4, "0")}`;

/**
 * The old record of a document goes away from Observer's working set: its messages (the stored text) are deleted, unsent
 * deliveries go (a held one is marked superseded and stays for Holds). A record with a sent or held delivery stays as history
 * (`delivered` stays delivered, anything else is `dropped`); any other record is deleted with its flags.
 */
export function retireRecord(db: Db, recordId: string, at: number): void {
  const held = !!db.prepare("SELECT 1 AS x FROM obs_deliveries WHERE record_id = ? AND status = 'held'").get(recordId);
  const sent = hasSentDelivery(db, recordId);
  db.prepare("DELETE FROM obs_messages WHERE record_id = ?").run(recordId);
  if (held || sent) {
    supersedeHeld(db, recordId);
    db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status IN ('pending', 'failed')").run(recordId);
    db.prepare(
      "UPDATE obs_records SET state = CASE WHEN state = 'delivered' THEN 'delivered' ELSE 'dropped' END, decided_by = COALESCE(decided_by, 'source:newer'), thread = NULL, updated_at = ? WHERE id = ?",
    ).run(at, recordId);
    return;
  }
  db.prepare("DELETE FROM obs_flags WHERE record_id = ?").run(recordId);
  db.prepare("DELETE FROM obs_deliveries WHERE record_id = ?").run(recordId);
  db.prepare("DELETE FROM obs_records WHERE id = ?").run(recordId);
}

/** Store one documents/1 row (it must conform: contract.ts docRowConforms). One transaction (a savepoint inside a page). */
export function storeDocument(db: Db, sourceId: string, row: DocumentRow, at: number): DocResult {
  const src = sourceRow(db, sourceId);
  if (!src || !conversationsOf(src).includes(row.collection)) return { status: "out_of_scope", recordId: null };
  const parsed = Date.parse(row.updatedAt);
  // a time in the future counts as now: one bad clock cannot pin a document against every later revision
  const updatedAt = Number.isFinite(parsed) ? Math.min(parsed, at) : at;
  const deleted = row.deleted === true;
  const old = db.prepare("SELECT * FROM obs_documents WHERE source_id = ? AND collection = ? AND doc_id = ?").get(sourceId, row.collection, row.id);
  if (old) {
    if (updatedAt < Number(old.updated_at)) return { status: "stale", recordId: old.record_id === null ? null : str(old.record_id) };
    if (row.rev === str(old.rev) && deleted === (Number(old.deleted) === 1)) return { status: "unchanged", recordId: old.record_id === null ? null : str(old.record_id) };
  }
  return db.transaction(() => {
    const oldRecord = old?.record_id === null || old?.record_id === undefined ? null : str(old.record_id);
    const upsert = (recordId: string | null): void => {
      db.prepare(
        `INSERT INTO obs_documents (source_id, collection, doc_id, rev, updated_at, kind, mime, url, path, deleted, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, collection, doc_id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, kind = excluded.kind, mime = excluded.mime, url = excluded.url,
           path = excluded.path, deleted = excluded.deleted, record_id = excluded.record_id`,
      ).run(
        sourceId,
        row.collection,
        row.id,
        row.rev,
        updatedAt,
        row.kind ?? null,
        row.mime,
        row.url === undefined ? null : sanitizeShort(cleanText(row.url), 2048),
        row.path === undefined ? null : sanitizeShort(cleanText(row.path), 1024),
        deleted ? 1 : 0,
        recordId,
      );
    };
    if (deleted) {
      // `keep`: the record and its text stay until the retention ends; `purge`: they go now
      const keep = getPrivacy(db).onSourceDelete === "keep";
      if (oldRecord !== null && !keep) retireRecord(db, oldRecord, at);
      upsert(keep ? oldRecord : null);
      return { status: "deleted" as const, recordId: keep ? oldRecord : null };
    }
    if (oldRecord !== null) retireRecord(db, oldRecord, at);
    const title = cleanText(row.title).trim() || row.id;
    const pieces = chunkText(cleanText(row.text));
    const ids: string[] = [];
    let chars = 0;
    for (const [n, piece] of pieces.entries()) {
      const id = chunkId(row.id, n);
      // the chunks of a retired record were deleted above, so every piece is a new message
      const r = storeMessage(db, sourceId, { conversation: row.collection, providerMsgId: id, thread: title, sentAt: updatedAt, author: row.author?.handle ?? "", authorKind: "person", text: piece }, at);
      if (r.status === "excluded" || r.status === "out_of_scope") {
        upsert(null);
        return { status: "excluded" as const, recordId: null };
      }
      ids.push(id);
      chars += piece.length;
    }
    // one closed window = one record; the thread subject is the (secret-free, bounded) title
    const a = attachWindow(db, sourceId, { key: `doc\u0000${row.collection}\u0000${row.id}`, conversation: row.collection, thread: sanitizeShort(title), start: updatedAt, end: updatedAt, messageIds: ids, chars, closed: true }, at);
    applyRouting(db, a.recordId, at);
    upsert(a.recordId);
    return { status: old ? ("updated" as const) : ("inserted" as const), recordId: a.recordId };
  });
}
