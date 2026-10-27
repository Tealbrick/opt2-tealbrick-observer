// A contract-faithful fake of Connect 0.6.0's data ops (C230 R3: src/data/messages.ts, src/app.ts data_* of
// Tealbrick/opt2-tealbrick-connect at connect#14 c191c63), served through `ctx.callApp("connect", op, input)` so the tests drive
// Observer's REAL port (src/connect.ts) over it.
//
// L1: the fake comes from the shared rule, not from the side under test. EVERY page it serves is validated against the vendored
// byte copy of messages/1 (test/contracts/messages.1.schema.json, sha256 in PROVENANCE.md) with the validator Connect uses
// (validateAgainstSchema from @opt2-tealbrick/manifest). A page that does not conform makes the fake THROW: the fake cannot drift.
//
// Shapes mirrored: per-ACCOUNT pull in `rev` order (all conversations); an edit or a deletion gives the message a later rev.
// Two models of that, and Observer must end the same under both: `inplace` (Connect's own: the SAME log row is updated and moves
// to the next rev, channels/service.ts markEdited / markDeleted) and `append` (a NEW row with the same (conversation, id)); `deleted: true` rows have empty text and no attachments; the cursor is opaque; a forward page
// keeps its cursor when exhausted; backward without a history reader answers { rows: [], exhausted: true }; `anchor` (head) only
// on a call without a cursor; a rate limit answers empty rows, the same cursor and `retryAfterS`; a stored row that does not
// conform is quarantined (skipped, counted). Refusals keyed on the VERIFIED caller product: caller_unverified 403, not_found 404
// (not shared), scope_denied 403 (catalog level only), cursor_invalid 400.
import { readFileSync } from "node:fs";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";

type Schema = Parameters<typeof validateAgainstSchema>[0];
const SCHEMA = JSON.parse(readFileSync(new URL("./contracts/messages.1.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const PAGE = SCHEMA as unknown as Schema;
const ROW = { $schema: SCHEMA.$schema, $defs: SCHEMA.$defs, $ref: "#/$defs/row" } as unknown as Schema;
const DOC_SCHEMA = JSON.parse(readFileSync(new URL("./contracts/documents.1.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const DOC_PAGE = DOC_SCHEMA as unknown as Schema;
const DOC_ROW = { $schema: DOC_SCHEMA.$schema, $defs: DOC_SCHEMA.$defs, $ref: "#/$defs/row" } as unknown as Schema;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

export interface FakeAccount {
  id: string;
  service: string;
  label: string;
  level: "available" | "shared";
  /** the provider can page backward (Connect 0.6.0: false for every provider) */
  history: boolean;
  retentionDays: number;
  conversations: { id: string; name: string; type: string }[];
  /** when the share began (epoch ms); pulls return only rows received at or after it unless includeHistory */
  setAt: number;
  includeHistory: boolean;
  /** the datasets the catalog lists (default: messages only) */
  datasets: ("messages" | "documents")[];
  /** the collections of the documents dataset */
  collections: { id: string; name: string }[];
}

/** One stored revision of a document (the documents log is append-only: a change is a new entry with the next rev). */
interface DocLogRow {
  seq: number;
  collection: string;
  id: string;
  title: string;
  text: string;
  rev: string;
  updatedAt: number;
  deleted: boolean;
  kind?: "document" | "chat_transcript" | "table" | "report" | "record";
  mime: "text/plain" | "text/markdown" | "text/csv";
  author?: { handle: string; raw?: boolean; display?: string };
  url?: string;
  path?: string;
  broken: boolean;
}
export interface DocPut {
  collection: string;
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  kind?: DocLogRow["kind"];
  mime?: DocLogRow["mime"];
  author?: DocLogRow["author"];
  url?: string;
  path?: string;
  /** a stored row Connect cannot turn into a conforming documents/1 row (quarantined) */
  broken?: boolean;
}

interface LogRow {
  rev: number;
  conversation: string;
  id: string;
  thread: string | null;
  author: { kind: "person" | "bot" | "self"; handle: string; display?: string };
  text: string;
  sentAt: number;
  receivedAt: number;
  editedAt: number | null;
  deleted: boolean;
  attachments: { name: string; mime: string; bytes: number }[];
  truncated: boolean;
  /** a stored row that cannot be turned into a conforming messages/1 row (Connect quarantines it) */
  broken: boolean;
}

export interface Post {
  conversation: string;
  id: string;
  text: string;
  sentAt: number;
  receivedAt?: number;
  thread?: string;
  author?: string;
  kind?: "person" | "bot" | "self";
  display?: string;
  attachments?: { name: string; mime: string; bytes: number }[];
  truncated?: boolean;
  broken?: boolean;
}

type Fault = { op: string; error: { code: string; status: number } } | { op: "data_pull"; retryAfterS: number };

const iso = (ms: number): string => new Date(ms).toISOString();
const enc = (account: string, rev: number): string => Buffer.from(`fake:${account}:${rev}`).toString("base64url");

export class FakeConnect {
  readonly accounts = new Map<string, FakeAccount>();
  readonly logs = new Map<string, LogRow[]>();
  readonly docLogs = new Map<string, DocLogRow[]>();
  /** the verified product of the caller as the SDK gives it (ctx.caller.product); null = an app without one */
  callerProduct: string | null = "observer";
  /** the product the owner shared the accounts with */
  sharedWith = "observer";
  readonly calls: { op: string; input: Record<string, unknown> }[] = [];
  readonly faults: Fault[] = [];
  /** mutates a page BEFORE the contract check (a drifted fake must fail the test) */
  drift: ((page: Record<string, unknown>) => void) | null = null;
  /** mutates the answer AFTER the check: a Connect that breaks its own contract (only to test Observer's reader) */
  onTheWire: ((out: Record<string, unknown>) => void) | null = null;
  /** how an edit or a deletion lands in the log (see the header) */
  changes: "inplace" | "append" = "inplace";
  readonly #rev = new Map<string, number>();

  addAccount(a: Partial<FakeAccount> & { id: string }): FakeAccount {
    const full: FakeAccount = {
      service: "slack",
      label: `${a.id} label`,
      level: "shared",
      history: false,
      retentionDays: 30,
      conversations: [
        { id: "C1", name: "general", type: "channel" },
        { id: "C2", name: "random", type: "channel" },
      ],
      setAt: 0,
      includeHistory: true,
      datasets: ["messages"],
      collections: [],
      ...a,
    };
    this.accounts.set(full.id, full);
    this.logs.set(full.id, this.logs.get(full.id) ?? []);
    this.docLogs.set(full.id, this.docLogs.get(full.id) ?? []);
    return full;
  }

  #nextRev(account: string): number {
    const rev = (this.#rev.get(account) ?? 0) + 1;
    this.#rev.set(account, rev);
    return rev;
  }
  #append(account: string, row: Omit<LogRow, "rev">): number {
    const rev = this.#nextRev(account);
    (this.logs.get(account) as LogRow[]).push({ ...row, rev });
    return rev;
  }
  /** an edit or a deletion: in place (the row takes the next rev) or as a new row */
  #change(account: string, old: LogRow, change: Partial<LogRow>): number {
    if (this.changes === "append") return this.#append(account, { ...old, ...change });
    Object.assign(old, change, { rev: this.#nextRev(account) });
    return old.rev;
  }

  /** a new message: the next rev */
  post(account: string, p: Post): number {
    return this.#append(account, {
      conversation: p.conversation,
      id: p.id,
      thread: p.thread ?? null,
      author: { kind: p.kind ?? "person", handle: p.author ?? "slack:U0ANNA", ...(p.display ? { display: p.display } : {}) },
      text: p.text,
      sentAt: p.sentAt,
      receivedAt: p.receivedAt ?? p.sentAt,
      editedAt: null,
      deleted: false,
      attachments: p.attachments ?? [],
      truncated: p.truncated ?? false,
      broken: p.broken ?? false,
    });
  }
  #last(account: string, conversation: string, id: string): LogRow {
    const r = [...(this.logs.get(account) ?? [])].reverse().find((x) => x.conversation === conversation && x.id === id);
    if (!r) throw new Error(`fake: no message ${conversation}/${id}`);
    return r;
  }
  /** an edit: a later rev with the new text and editedAt (Connect keeps receivedAt; the append model too) */
  edit(account: string, conversation: string, id: string, text: string, editedAt: number): number {
    const old = this.#last(account, conversation, id);
    return this.#change(account, old, { text, editedAt });
  }
  /** a provider deletion: a later rev, deleted, empty text, no attachments */
  remove(account: string, conversation: string, id: string, _at: number): number {
    const old = this.#last(account, conversation, id);
    return this.#change(account, old, { text: "", attachments: [], deleted: true });
  }
  /** a new document or a new revision of one (the next seq; rev changes with the text) */
  putDoc(account: string, d: DocPut): string {
    const seq = this.#nextRev(account);
    const rev = `r${seq}`;
    (this.docLogs.get(account) as DocLogRow[]).push({ seq, collection: d.collection, id: d.id, title: d.title, text: d.text, rev, updatedAt: d.updatedAt, deleted: false, mime: d.mime ?? "text/markdown", broken: d.broken ?? false, ...(d.kind ? { kind: d.kind } : {}), ...(d.author ? { author: d.author } : {}), ...(d.url ? { url: d.url } : {}), ...(d.path ? { path: d.path } : {}) });
    return rev;
  }
  /** a source deletion: a new entry, deleted, empty text, title "" */
  deleteDoc(account: string, collection: string, id: string, at: number): string {
    const seq = this.#nextRev(account);
    (this.docLogs.get(account) as DocLogRow[]).push({ seq, collection, id, title: "", text: "", rev: `r${seq}`, updatedAt: at, deleted: true, mime: "text/plain", broken: false });
    return `r${seq}`;
  }
  fail(op: string, code: string, status: number, times = 1): void {
    for (let i = 0; i < times; i++) this.faults.push({ op, error: { code, status } });
  }
  rateLimit(retryAfterS: number): void {
    this.faults.push({ op: "data_pull", retryAfterS });
  }
  pulls(): number {
    return this.calls.filter((c) => c.op === "data_pull").length;
  }

  /** What Observer's ctx.callApp gets: { status: "ok", output } or a thrown TbError (as the SDK does with a refusal). */
  callApp = async (product: string, op: string, input: Json): Promise<{ status: "ok"; output: Json }> => {
    if (product !== "connect") throw new TbError("companion_undeclared", `fake: not connect (${product})`, 500);
    const i = (input ?? {}) as Record<string, unknown>;
    this.calls.push({ op, input: structuredClone(i) });
    const fi = this.faults.findIndex((f) => f.op === op);
    const fault = fi >= 0 ? this.faults.splice(fi, 1)[0] : undefined;
    if (fault && "error" in fault) throw new TbError(fault.error.code, `fake ${fault.error.code}`, fault.error.status);
    let output: Record<string, unknown>;
    switch (op) {
      case "data_accounts_list":
        output = this.#accountsList();
        break;
      case "data_catalog":
        output = this.#catalog(i);
        break;
      case "data_pull":
        output = this.#pull(i, fault && "retryAfterS" in fault ? fault.retryAfterS : null);
        break;
      default:
        throw new TbError("unknown_tool", `fake: no op ${op}`, 404);
    }
    this.onTheWire?.(output);
    return { status: "ok", output: output as Json };
  };

  #caller(): string {
    if (this.callerProduct === null || this.callerProduct === "") throw new TbError("caller_unverified", "The calling app has no verified product, so it cannot use the data operations.", 403);
    return this.callerProduct;
  }
  #account(raw: unknown, need: "available" | "shared"): FakeAccount {
    const product = this.#caller();
    const a = typeof raw === "string" ? this.accounts.get(raw) : undefined;
    if (!a || product !== this.sharedWith) throw new TbError("not_found", "No such account.", 404);
    if (need === "shared" && a.level !== "shared") throw new TbError("scope_denied", "This account is shared with you for its catalog only.", 403);
    return a;
  }

  #accountsList(): Record<string, unknown> {
    const product = this.#caller();
    const accounts = product === this.sharedWith ? [...this.accounts.values()].map((a) => ({ account: a.id, service: a.service, label: a.label, kinds: a.datasets.map((d) => (d === "documents" ? "object" : d)), level: a.level })) : [];
    return { accounts };
  }

  #catalog(i: Record<string, unknown>): Record<string, unknown> {
    const a = this.#account(i.account, "available");
    const log = this.logs.get(a.id) ?? [];
    const latest = new Map<string, LogRow>();
    for (const r of log) latest.set(`${r.conversation}\u0000${r.id}`, r);
    const live = [...latest.values()].filter((r) => !r.deleted);
    const oldest = log.length ? Math.min(...log.map((r) => r.sentAt)) : null;
    return {
      account: a.id,
      service: a.service,
      label: a.label,
      level: a.level,
      datasets: [
        ...(a.datasets.includes("documents") ? [this.#docCatalog(a)] : []),
        {
          dataset: "messages",
          title: "Messages",
          kind: "messages",
          delivery: "pull",
          contract: "messages/1",
          approxRows: live.length,
          history: a.history,
          retentionDays: a.retentionDays,
          edits: true,
          deletions: true,
          ...(oldest !== null ? { oldestAt: iso(oldest) } : {}),
          conversations: a.conversations.map((c) => ({ ...c, approxRows: live.filter((r) => r.conversation === c.id).length })),
        },
      ].filter((d) => d.dataset !== "messages" || a.datasets.includes("messages")),
      untrusted: true,
    };
  }

  #decode(cursor: string, account: string): number {
    const m = /^fake:([^:]+):(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!m || m[1] !== account) throw new TbError("cursor_invalid", "cursor is not one data_pull returned for this account and dataset.", 400);
    return Number(m[2]);
  }
  #time(v: unknown, name: string): number | null {
    if (v === undefined) return null;
    if (typeof v !== "string" || !RFC3339.test(v)) throw new TbError(`${name}_invalid`, `${name} must be an RFC 3339 time`, 400);
    return Date.parse(v);
  }

  #row(r: LogRow): Record<string, unknown> {
    const base = {
      id: r.id,
      conversation: r.conversation,
      ...(r.thread ? { thread: r.thread } : {}),
      sentAt: iso(r.sentAt),
      ...(r.editedAt !== null ? { editedAt: iso(r.editedAt) } : {}),
      author: r.author,
      untrusted: true,
    };
    if (r.deleted) return { ...base, deleted: true, text: "", attachments: [] };
    return { ...base, text: r.text, attachments: r.attachments, ...(r.truncated ? { truncated: true } : {}) };
  }

  #docCatalog(a: FakeAccount): Record<string, unknown> {
    const latest = new Map<string, DocLogRow>();
    for (const r of this.docLogs.get(a.id) ?? []) latest.set(`${r.collection}\u0000${r.id}`, r);
    const live = [...latest.values()].filter((r) => !r.deleted);
    return {
      dataset: "documents",
      title: "Documents",
      kind: "object",
      delivery: "pull",
      contract: "documents/1",
      approxRows: live.length,
      history: false,
      collections: a.collections.map((c) => ({ ...c, approxRows: live.filter((r) => r.collection === c.id).length })),
    };
  }

  #docRow(r: DocLogRow): Record<string, unknown> {
    return {
      id: r.id,
      collection: r.collection,
      title: r.title,
      mime: r.mime,
      updatedAt: iso(r.updatedAt),
      rev: r.rev,
      ...(r.deleted ? { deleted: true } : {}),
      ...(r.author ? { author: r.author } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.path ? { path: r.path } : {}),
      text: r.text,
      untrusted: true,
      // a broken stored row: what Connect could not turn into a conforming row
      ...(r.broken ? { mime: "text/html" } : {}),
    };
  }

  /** documents: forward only, in seq order, at most 50 rows; the same cursor and envelope rules as messages */
  #pullDocs(a: FakeAccount, i: Record<string, unknown>, retryAfterS: number | null): Record<string, unknown> {
    const cursor = typeof i.cursor === "string" ? i.cursor : null;
    const at = cursor === null ? null : this.#decode(cursor, a.id);
    const limit = Math.max(1, Math.min(50, typeof i.limit === "number" ? Math.trunc(i.limit) : 50));
    let page: Record<string, unknown>;
    if (retryAfterS !== null) page = { rows: [], nextCursor: cursor, exhausted: false, retryAfterS };
    else {
      const fetched = (this.docLogs.get(a.id) ?? []).filter((r) => at === null || r.seq > at).slice(0, limit + 1);
      const taken = fetched.slice(0, limit);
      const rows: Record<string, unknown>[] = [];
      let quarantined = 0;
      let last: number | null = null;
      for (const r of taken) {
        const row = this.#docRow(r);
        if (r.broken || !validateAgainstSchema(DOC_ROW, row as Json).ok) quarantined += 1;
        else rows.push(row);
        last = r.seq;
      }
      page = { rows, nextCursor: last !== null ? enc(a.id, last) : cursor, exhausted: taken.length === fetched.length, ...(quarantined > 0 ? { quarantined } : {}) };
    }
    this.drift?.(page);
    const checked = validateAgainstSchema(DOC_PAGE, page as Json);
    if (!checked.ok) throw new Error(`fake Connect drifted from documents/1: ${JSON.stringify(checked.errors.slice(0, 3))}`);
    return { ...page, schema: "documents/1", untrusted: true };
  }

  #pull(i: Record<string, unknown>, retryAfterS: number | null): Record<string, unknown> {
    const a = this.#account(i.account, "shared");
    if (i.dataset === "documents" && a.datasets.includes("documents")) return this.#pullDocs(a, i, retryAfterS);
    if (i.dataset !== "messages") throw new TbError("not_found", "No such dataset on this account.", 404);
    const direction = i.direction === "backward" ? "backward" : "forward";
    const cursor = typeof i.cursor === "string" ? i.cursor : null;
    const at = cursor === null ? null : this.#decode(cursor, a.id);
    const since = this.#time(i.since, "since");
    const until = this.#time(i.until, "until");
    const limit = Math.max(1, Math.min(200, typeof i.limit === "number" ? Math.trunc(i.limit) : 100));
    const from = a.includeHistory ? null : a.setAt;
    const kept = (this.logs.get(a.id) ?? []).filter((r) => from === null || r.receivedAt >= from);
    const head = kept.length ? Math.max(...kept.map((r) => r.rev)) : null;
    const anchor = cursor === null && head !== null ? { anchor: enc(a.id, head) } : {};
    let page: Record<string, unknown>;
    if (direction === "backward" && !a.history) page = { rows: [], nextCursor: null, ...anchor, exhausted: true };
    else if (retryAfterS !== null) page = { rows: [], nextCursor: cursor, ...anchor, exhausted: false, retryAfterS };
    else {
      const fetched = kept
        .filter((r) => (at === null ? true : direction === "forward" ? r.rev > at : r.rev < at))
        .filter((r) => (since === null || r.sentAt >= since) && (until === null || r.sentAt < until))
        .sort((x, y) => (direction === "forward" ? x.rev - y.rev : y.rev - x.rev))
        .slice(0, limit + 1);
      const rows: Record<string, unknown>[] = [];
      let quarantined = 0;
      let last: number | null = null;
      const taken = fetched.slice(0, limit);
      for (const r of taken) {
        const row = this.#row(r);
        if (r.broken || !validateAgainstSchema(ROW, row as Json).ok) quarantined += 1;
        else rows.push(row);
        last = r.rev;
      }
      const exhausted = taken.length === fetched.length;
      const next = last !== null ? enc(a.id, last) : cursor;
      page = { rows, nextCursor: direction === "backward" && exhausted ? null : next, ...anchor, exhausted, ...(quarantined > 0 ? { quarantined } : {}) };
    }
    this.drift?.(page);
    const checked = validateAgainstSchema(PAGE, page as Json);
    if (!checked.ok) throw new Error(`fake Connect drifted from messages/1: ${JSON.stringify(checked.errors.slice(0, 3))}`);
    return { ...page, schema: "messages/1", untrusted: true };
  }
}
