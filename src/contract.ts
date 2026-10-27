// The contract Observer reads: messages/1, one page of Connect's `messages` dataset (data_pull). The schema is a byte copy of
// `Tealbrick/opt2-tealbrick-specs` tag spec-v0.1.42 (`src/contracts/messages.1.schema.json`, provenance and sha256 in
// test/contracts/PROVENANCE.md), checked with the same validator Connect uses (validateAgainstSchema from
// @opt2-tealbrick/manifest), so producer, consumer and the test fake share ONE rule (L1).
//
// Readers tolerate (L24): every row is checked on its own. A row that does not conform is skipped and counted, never stored, and
// the rest of the page is used. The envelope fields Observer acts on (nextCursor, exhausted, retryAfterS, anchor) must be right,
// or the whole page is refused (`connect_contract`): acting on a wrong cursor could skip or repeat messages.
//
// The mapping keeps only what storeMessage needs. `author.display` and `attachments` are never stored (no PII path that the
// privacy rules do not cover; Observer 0.1 has no attachment column). `truncated` needs nothing here: Connect cuts at 64 K
// characters, which is always more than the 16 KiB storeMessage keeps, so storeMessage adds its own cut marker.
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import docSchema from "./contracts/documents.1.schema.json" with { type: "json" };
import schema from "./contracts/messages.1.schema.json" with { type: "json" };
import type { IncomingMessage } from "./ingest.ts";

export const MESSAGES_CONTRACT = "messages/1";
export const MESSAGES_DATASET = "messages";

type Schema = Parameters<typeof validateAgainstSchema>[0];
/** The whole page schema (the frozen file as it is). */
export const PAGE_SCHEMA = schema as unknown as Schema;
/** One row: the same file, pointed at its `row` definition. */
export const ROW_SCHEMA = { $schema: schema.$schema, $defs: schema.$defs, $ref: "#/$defs/row" } as unknown as Schema;

export interface MessageRow {
  id: string;
  conversation: string;
  thread?: string;
  sentAt: string;
  editedAt?: string;
  deleted?: boolean;
  author: { kind: "person" | "bot" | "self"; handle: string; display?: string };
  text: string;
  attachments: { name: string; mime: string; bytes: number }[];
  untrusted: true;
  truncated?: boolean;
  attachmentsTruncated?: boolean;
}

/** A page as Observer uses it: the rows that conform, and how many did not. */
export interface Page {
  rows: MessageRow[];
  /** rows Observer skipped because they did not conform to messages/1 */
  invalid: number;
  /** rows Connect itself skipped (its `quarantined` count) */
  quarantined: number;
  nextCursor: string | null;
  anchor: string | null;
  exhausted: boolean;
  retryAfterS: number | null;
}

export function rowConforms(row: unknown): row is MessageRow {
  return validateAgainstSchema(ROW_SCHEMA, row as Json).ok;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const contract = (what: string): TbError => new TbError("connect_contract", `Connect answered a page Observer cannot use (${what}).`, 502);

/** Read a data_pull answer: strict on the envelope, tolerant per row. */
export function readPage(out: unknown): Page {
  if (!isObj(out)) throw contract("not an object");
  if (!Array.isArray(out.rows)) throw contract("rows");
  const next = out.nextCursor;
  if (!(next === null || (typeof next === "string" && next.length >= 1 && next.length <= 512))) throw contract("nextCursor");
  if (typeof out.exhausted !== "boolean") throw contract("exhausted");
  const anchor = out.anchor;
  if (anchor !== undefined && !(typeof anchor === "string" && anchor.length >= 1 && anchor.length <= 512)) throw contract("anchor");
  const retry = out.retryAfterS;
  if (retry !== undefined && !(Number.isInteger(retry) && (retry as number) >= 1 && (retry as number) <= 3600)) throw contract("retryAfterS");
  const rows: MessageRow[] = [];
  let invalid = 0;
  for (const r of out.rows) {
    if (rowConforms(r)) rows.push(r);
    else invalid += 1;
  }
  const q = out.quarantined;
  return {
    rows,
    invalid,
    quarantined: Number.isInteger(q) && (q as number) >= 0 ? (q as number) : 0,
    nextCursor: next as string | null,
    anchor: typeof anchor === "string" ? anchor : null,
    exhausted: out.exhausted,
    retryAfterS: typeof retry === "number" ? retry : null,
  };
}

/** messages/1 row → the message storeMessage takes. Only for a row that conforms (rowConforms). */
export function toIncoming(row: MessageRow): IncomingMessage {
  const deleted = row.deleted === true;
  return {
    conversation: row.conversation,
    providerMsgId: row.id,
    thread: row.thread ?? null,
    sentAt: Date.parse(row.sentAt),
    editedAt: row.editedAt === undefined ? null : Date.parse(row.editedAt),
    deleted,
    author: row.author.handle,
    authorKind: row.author.kind,
    text: deleted ? "" : row.text,
  };
}

// ───────────────────────────────────────────────────────────────────────── documents/1 (DRAFT, C373)
// One page of Connect's `documents` dataset: MCP resources and database table pages (CSV), one row per document. The byte copy and
// its source are in test/contracts/PROVENANCE.md. Same reader rules as messages/1: strict on the envelope, tolerant per row. A row
// carries no account (the account is the source's own). Consumers strip control, bidi and zero-width characters before display or
// indexing: `cleanText` does that before Observer stores anything.
export const DOCUMENTS_CONTRACT = "documents/1";
export const DOCUMENTS_DATASET = "documents";
export const DATASETS = [MESSAGES_DATASET, DOCUMENTS_DATASET] as const;
export type Dataset = (typeof DATASETS)[number];
export const isDataset = (v: unknown): v is Dataset => v === MESSAGES_DATASET || v === DOCUMENTS_DATASET;

export const DOC_ROW_SCHEMA = { $schema: docSchema.$schema, $defs: docSchema.$defs, $ref: "#/$defs/row" } as unknown as Schema;
export const DOC_PAGE_SCHEMA = docSchema as unknown as Schema;
/** documents/1 allows at most 50 rows per page */
export const DOC_PAGE_MAX = 50;

export interface DocumentRow {
  id: string;
  collection: string;
  title: string;
  path?: string;
  url?: string;
  mime: "text/plain" | "text/markdown" | "text/csv";
  updatedAt: string;
  rev: string;
  deleted?: boolean;
  author?: { handle: string; raw?: boolean; display?: string };
  kind?: "document" | "chat_transcript" | "table" | "report" | "record";
  text: string;
  untrusted: true;
  truncated?: boolean;
}
export interface DocPage {
  rows: DocumentRow[];
  invalid: number;
  quarantined: number;
  nextCursor: string | null;
  anchor: string | null;
  exhausted: boolean;
  retryAfterS: number | null;
}

export function docRowConforms(row: unknown): row is DocumentRow {
  return validateAgainstSchema(DOC_ROW_SCHEMA, row as Json).ok;
}

/** Read a data_pull answer of the documents dataset: the same envelope rules as readPage, rows checked against documents/1. */
export function readDocPage(out: unknown): DocPage {
  if (!isObj(out) || !Array.isArray(out.rows)) throw contract("rows");
  const env = readPage({ ...out, rows: [] });
  const rows: DocumentRow[] = [];
  let invalid = 0;
  for (const r of (out as { rows: unknown[] }).rows) {
    if (docRowConforms(r)) rows.push(r);
    else invalid += 1;
  }
  return { rows, invalid, quarantined: env.quarantined, nextCursor: env.nextCursor, anchor: env.anchor, exhausted: env.exhausted, retryAfterS: env.retryAfterS };
}

/** Control characters (except tab, line feed, carriage return) and format characters (bidi controls, zero-width marks) removed:
 *  what the contract asks consumers to do before display or indexing. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const KEPT = new Set(["\t", "\n", "\r"]);
export function cleanText(v: string): string {
  return v.replace(INVISIBLE, (c) => (KEPT.has(c) ? c : ""));
}
