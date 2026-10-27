// C373: documents sources (documents/1 over the fake Connect, Observer's REAL port) and deliveries to Knowledge (the outbox drain
// over the fake Knowledge). Test clock only (nothing waits on the wall clock). Every alarm quiet-on-good AND fire-on-bad.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { DOCUMENTS_NO_HISTORY, handlers, manifest, setClock } from "../src/app.ts";
import { realPort, setConnectFactory } from "../src/connect.ts";
import { cleanText, readDocPage } from "../src/contract.ts";
import {
  COMPANY_AREA,
  DELIVER_KIND,
  type DrainDeps,
  drainOutbox,
  ensureDrainJob,
  escapeCsvFormulas,
  HELD_RECHECK_MS,
  KNOWLEDGE_MISSING,
  MAX_DELIVERY_ATTEMPTS,
  ONLY_KNOWLEDGE,
  tagsFor,
} from "../src/deliver.ts";
import { chunkId, chunkText } from "../src/documents.ts";
import { CallBudget, DOC_MIN_INTERVAL_MS, runTick, sharedBudget, type TickDeps } from "../src/jobs.ts";
import { setPrivacy } from "../src/store.ts";
import { FakeConnect } from "./fake-connect.ts";
import { FakeKnowledge } from "./fake-knowledge.ts";
import { ctxFor, FakeJobs, migratedDb, OWNER, start } from "./helpers.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);
const MIN = 60_000;
/** a documents scan never runs more often than this (jobs.ts DOC_MIN_INTERVAL_MS) */
const SCAN = DOC_MIN_INTERVAL_MS;
const ACME = "acc_acme_mcp";

let db: Db;
let now: number;
let connect: FakeConnect;
let knowledge: FakeKnowledge;
let sdk: FakeJobs;
let budget: CallBudget;
let targets: string[];
const callApp = (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => (product === "knowledge" ? knowledge.callApp(product, op, input, opts) : connect.callApp(product, op, input));
const owner = (): OpContext => ctxFor(db, OWNER, { targets, callApp: callApp as never, jobs: sdk });
const one = (sql: string, ...args: unknown[]): Out => ({ ...(db.prepare(sql).get(...args) ?? {}) });
const all = (sql: string, ...args: unknown[]): Out[] => db.prepare(sql).all(...args).map((r) => ({ ...r }));
const count = (sql: string, ...args: unknown[]): number => Number(db.prepare(sql).get(...args)?.c ?? 0);

function tick(over: Partial<TickDeps> = {}): TickDeps {
  return { db, port: realPort({ callApp: callApp as never }, budget), checkpoint: (_s, w) => db.transaction(() => w(db)), paused: () => false, random: () => 0.5, ...over };
}
function drain(over: Partial<DrainDeps> = {}): DrainDeps {
  return { db, callApp: callApp as never, targets: () => targets, write: (fn) => db.transaction(() => fn(db)), random: () => 0.5, ...over };
}
async function addDocs(input: Out = {}): Promise<{ source: string; live: string }> {
  const out = await run("source_add", { account: ACME, dataset: "documents", conversations: ["finance"], label: "Acme drive", liveIntervalS: 300, ...input }, owner());
  const live = String(one("SELECT id FROM obs_jobs WHERE source_id = ? AND kind = 'live'", out.source.id).id);
  await run("job_control", { id: live, action: "start" }, owner());
  return { source: out.source.id, live };
}
const put = (id: string, text: string, extra: Partial<Parameters<FakeConnect["putDoc"]>[1]> = {}) => connect.putDoc(ACME, { collection: "finance", id, title: `Doc ${id}`, text, updatedAt: now, ...extra });
const recordOf = (source: string, docId: string): Out => one("SELECT r.* FROM obs_documents d JOIN obs_records r ON r.id = d.record_id WHERE d.source_id = ? AND d.doc_id = ?", source, docId);

beforeEach(async () => {
  db = migratedDb();
  now = T0;
  setClock(() => now);
  setConnectFactory(null);
  await start(db);
  connect = new FakeConnect();
  connect.addAccount({ id: ACME, service: "mcp", label: "Acme LLC mock sources", datasets: ["documents"], collections: [{ id: "finance", name: "Finance" }, { id: "orders", name: "public.orders" }] });
  knowledge = new FakeKnowledge();
  sdk = new FakeJobs();
  budget = new CallBudget();
  sharedBudget.reset();
  targets = ["connect", "knowledge"];
});

describe("the Connect port, documents dataset", () => {
  it("lists the account, gives its collections on request, and pulls validated pages (a row that does not conform is skipped and counted)", async () => {
    const port = realPort({ callApp: callApp as never }, budget);
    assert.deepEqual(await port.accounts(), [{ id: ACME, kind: "mcp", label: "Acme LLC mock sources" }]);
    const acc = await port.account(ACME, "documents");
    assert.deepEqual(acc && { dataset: acc.dataset, datasets: acc.datasets, conversations: acc.conversations }, {
      dataset: "documents",
      datasets: ["documents"],
      conversations: [
        { id: "finance", title: "Finance", estimate: 0 },
        { id: "orders", title: "public.orders", estimate: 0 },
      ],
    });
    assert.equal(await port.account(ACME, "messages"), null, "an account without a messages dataset has none to pick");
    put("d1", "hello");
    connect.putDoc(ACME, { collection: "finance", id: "bad", title: "x", text: "y", updatedAt: now, broken: true });
    const page = await port.pullDocuments({ account: ACME, cursor: null });
    assert.deepEqual([page.rows.map((r) => r.id), page.quarantined, page.invalid, page.exhausted], [["d1"], 1, 0, true]);
    assert.deepEqual(connect.calls.at(-1)?.input, { account: ACME, dataset: "documents", direction: "forward", limit: 50 });
    // Observer's own check: a row that breaks documents/1 on the wire is skipped and counted, the envelope must be right
    const wire = readDocPage({ rows: [{ id: "x", collection: "c", title: "t", mime: "text/html", updatedAt: "2026-10-27T09:00:00Z", rev: "1", text: "", untrusted: true }], nextCursor: null, exhausted: true });
    assert.deepEqual([wire.rows.length, wire.invalid], [0, 1]);
    assert.throws(() => readDocPage({ rows: [], nextCursor: 5, exhausted: true }), { code: "connect_contract" });
    assert.throws(() => readDocPage({ nextCursor: null, exhausted: true }), { code: "connect_contract" });
  });
  it("cleanText strips control, bidi and zero-width characters and keeps tabs and line ends", () => {
    const bidi = String.fromCharCode(0x202e);
    const zw = String.fromCharCode(0x200b);
    const nul = String.fromCharCode(0);
    assert.equal(cleanText(`a${bidi}b${zw}c${nul}d\te\nf`), "abcd\te\nf");
    assert.equal(cleanText("plain"), "plain");
  });
});

describe("source_add and the history ops for documents", () => {
  it("adds a documents source without an anchor read; one collection is read by one source only; history is answered honestly", async () => {
    const out = await run("source_add", { account: ACME, dataset: "documents", conversations: ["finance"], label: "Acme drive" }, owner());
    assert.deepEqual([out.source.dataset, out.source.conversations], ["documents", ["finance"]]);
    assert.equal(connect.pulls(), 0, "no anchor: the job reads every document from Connect's start");
    assert.deepEqual(one("SELECT state, cursor, anchor FROM obs_jobs WHERE source_id = ?", out.source.id), { state: "paused", cursor: null, anchor: null });
    await assert.rejects(run("source_add", { account: ACME, dataset: "documents", conversations: ["finance", "orders"], label: "again" }, owner()), { code: "collection_taken" });
    const other = await run("source_add", { account: ACME, dataset: "documents", conversations: ["orders"], label: "Orders" }, owner());
    assert.equal(other.source.dataset, "documents", "quiet on good: another collection is fine");
    await assert.rejects(run("source_update", { id: other.source.id, conversations: ["orders", "finance"] }, owner()), { code: "collection_taken" });
    await assert.rejects(run("source_add", { account: ACME, dataset: "documents", conversations: ["nope"], label: "x" }, owner()), { code: "conversation_unknown" });
    await assert.rejects(run("source_add", { account: ACME, conversations: ["finance"], label: "x" }, owner()), { code: "account_not_shared" }, "the messages dataset of this account does not exist");
    await assert.rejects(run("backfill_start", { source: out.source.id, since: new Date(T0 - 86_400_000).toISOString() }, owner()), { code: "history_not_needed", message: DOCUMENTS_NO_HISTORY });
    put("d1", "x");
    const est = await run("backfill_estimate", { source: out.source.id, since: new Date(T0 - 86_400_000).toISOString() }, owner());
    assert.deepEqual(est, { messages: 1, records: 1, durationS: 1, providerNote: "Observer reads every document of the chosen collections when you start the source." });
    const v = manifest.operations.find((o) => o.id === "source_add")?.output as never;
    assert.equal(validateAgainstSchema(v, out as Json).ok, true, "the answer fits the manifest schema");
  });
});

describe("documents ingest: one record per document", () => {
  it("reads every document from the start, one record each, routed at once; the cursor moves; counts are honest", async () => {
    const { source, live } = await addDocs();
    put("d1", "Q3 board memo: revenue grew.");
    put("d2", "Invoice reminder for anna.novak@example.com", { author: { handle: "email:cfo@example.com" } });
    connect.putDoc(ACME, { collection: "orders", id: "o1", title: "not chosen", text: "x", updatedAt: now });
    assert.deepEqual(await runTick(live, tick()), { status: "again", afterMs: SCAN });
    assert.deepEqual(
      all("SELECT doc_id, rev, deleted FROM obs_documents WHERE source_id = ? ORDER BY doc_id", source),
      [
        { doc_id: "d1", rev: "r1", deleted: 0 },
        { doc_id: "d2", rev: "r2", deleted: 0 },
      ],
      "a collection the source did not choose is not stored",
    );
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_records WHERE source_id = ?", source), 2);
    assert.equal(recordOf(source, "d1").state, "review", "no rule: Review");
    assert.equal(recordOf(source, "d1").thread, "Doc d1", "the title is the record subject");
    assert.deepEqual(JSON.parse(recordOf(source, "d2").pii_json), { email: 1 }, "PII found");
    const job = one("SELECT state, cursor, read_count, record_count, skipped_count FROM obs_jobs WHERE id = ?", live);
    assert.deepEqual([job.state, job.read_count, job.record_count, job.skipped_count], ["waiting", 2, 2, 0]);
    assert.equal(job.cursor, null, "a documents scan ends with NO stored cursor: the next run scans again from the start");
    // the next run scans from the start again: the revisions Observer has are skipped, nothing is doubled
    now += SCAN;
    await runTick(live, tick());
    assert.equal(connect.calls.at(-1)?.input.cursor, undefined);
    assert.equal(connect.calls.at(-1)?.input.collection, "finance", "a source of ONE collection asks for that collection only");
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_records WHERE source_id = ?", source), 2);
  });
  it("a long document is chunked under the message cap into ONE record, in order (the joined text is the document)", async () => {
    const { source, live } = await addDocs();
    const line = (n: number) => `Line ${String(n).padStart(5, "0")} of the Acme LLC handbook. `.padEnd(79, ".");
    const text = Array.from({ length: 2600 }, (_, n) => line(n)).join("\n");
    put("big", text);
    await runTick(live, tick());
    const rec = recordOf(source, "big");
    const parts = all("SELECT provider_msg_id, text FROM obs_messages WHERE record_id = ? ORDER BY sent_at, provider_msg_id", String(rec.id));
    assert.ok(parts.length >= 14, `chunks: ${parts.length}`);
    assert.deepEqual(parts.map((p) => p.provider_msg_id).slice(0, 2), [chunkId("big", 0), chunkId("big", 1)]);
    assert.equal(parts.map((p) => p.text).join(""), text, "the chunks join to the document, in order");
    for (const p of parts) assert.ok(Buffer.byteLength(String(p.text)) <= 16 * 1024);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_records WHERE source_id = ?", source), 1);
    // chunkText: never inside a character, no text lost
    const mixed = `é😀\n`.repeat(5000);
    const pieces = chunkText(mixed, 1000);
    assert.equal(pieces.join(""), mixed);
    assert.ok(pieces.every((p) => Buffer.byteLength(p) <= 1000));
  });
  it("dedupe on (account, collection, id): the same rev is skipped, an older one ignored, a newer one replaces the record", async () => {
    const { source, live } = await addDocs();
    put("d1", "version one");
    await runTick(live, tick());
    const first = recordOf(source, "d1");
    // the same content again (Connect re-sends it after a restart from its start)
    db.prepare("UPDATE obs_jobs SET cursor = NULL WHERE id = ?").run(live);
    now += SCAN;
    await runTick(live, tick());
    assert.equal(recordOf(source, "d1").id, first.id, "the same rev is unchanged: no new record");
    // an older revision arriving late is ignored
    connect.putDoc(ACME, { collection: "finance", id: "d1", title: "Doc d1", text: "stale", updatedAt: T0 - 60 * MIN });
    now += SCAN;
    await runTick(live, tick());
    assert.equal(recordOf(source, "d1").id, first.id);
    // a newer revision: a new record; the old one (never delivered) is gone with its text
    now += SCAN;
    put("d1", "version two");
    now += SCAN;
    await runTick(live, tick());
    const second = recordOf(source, "d1");
    assert.notEqual(second.id, first.id);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_records WHERE id = ?", String(first.id)), 0);
    assert.deepEqual(
      all("SELECT text FROM obs_messages WHERE source_id = ?", source).map((r) => r.text),
      ["version two"],
    );
    // equal updatedAt, a different rev: the row received later wins
    connect.putDoc(ACME, { collection: "finance", id: "d1", title: "Doc d1", text: "version three", updatedAt: Date.parse(String(one("SELECT updated_at FROM obs_documents WHERE doc_id = 'd1'").updated_at)) || now - MIN });
    db.prepare("UPDATE obs_documents SET updated_at = ? WHERE doc_id = 'd1'").run(now - MIN);
    connect.putDoc(ACME, { collection: "finance", id: "d1", title: "Doc d1", text: "version four", updatedAt: now - MIN });
    now += SCAN;
    await runTick(live, tick());
    assert.deepEqual(
      all("SELECT text FROM obs_messages WHERE source_id = ?", source).map((r) => r.text),
      ["version four"],
    );
  });
  it("deleted: true follows onSourceDelete: purge removes the record now, keep leaves it until the retention", async () => {
    const { source, live } = await addDocs();
    put("d1", "one");
    put("d2", "two");
    await runTick(live, tick());
    now += SCAN;
    connect.deleteDoc(ACME, "finance", "d1", now);
    now += SCAN;
    await runTick(live, tick());
    assert.deepEqual(one("SELECT deleted, record_id FROM obs_documents WHERE doc_id = 'd1'"), { deleted: 1, record_id: null });
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages WHERE source_id = ? AND conversation = 'finance' AND provider_msg_id LIKE 'd1#%'", source), 0);
    setPrivacy(db, { onSourceDelete: "keep" });
    const kept = recordOf(source, "d2").id;
    now += SCAN;
    connect.deleteDoc(ACME, "finance", "d2", now);
    now += SCAN;
    await runTick(live, tick());
    assert.deepEqual(one("SELECT deleted, record_id FROM obs_documents WHERE doc_id = 'd2'"), { deleted: 1, record_id: kept });
    assert.equal(one("SELECT text FROM obs_messages WHERE record_id = ?", kept).text, "two", "keep: the text stays until the retention");
  });
  it("rule 0, exclusions and PII review hold for documents; a document without an author is fine; text is cleaned before storage", async () => {
    const { source, live } = await addDocs({ exclude: { senders: ["email:hr@example.com"] } });
    put("secret", "Deploy notes: AWS key AKIAIOSFODNN7EXAMPLE and aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    put("hr", "Salary review for the team", { author: { handle: "email:hr@example.com" } });
    put("anon", `Pay${String.fromCharCode(0x200b)}ment terms: 30 days${String.fromCharCode(0x202e)}.`);
    put("pii", "Call Jana at +421 900 123 456");
    await runTick(live, tick());
    const sec = recordOf(source, "secret");
    assert.deepEqual([sec.state, sec.secret, sec.rule_id], ["dropped", 1, "rul_00000000000000000000000000"], "rule 0 drops it");
    assert.ok(!all("SELECT text FROM obs_messages WHERE source_id = ?", source).some((r) => String(r.text).includes("AKIAIOSFODNN7EXAMPLE")), "the secret was never stored");
    assert.deepEqual(one("SELECT record_id FROM obs_documents WHERE doc_id = 'hr'"), { record_id: null }, "excluded author: nothing stored");
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages WHERE author_key = 'email:hr@example.com'"), 0);
    assert.equal(one("SELECT m.text FROM obs_messages m JOIN obs_documents d ON d.record_id = m.record_id WHERE d.doc_id = 'anon'").text, "Payment terms: 30 days.");
    assert.equal(one("SELECT m.author_ref FROM obs_messages m JOIN obs_documents d ON d.record_id = m.record_id WHERE d.doc_id = 'anon'").author_ref, "");
    assert.equal(recordOf(source, "pii").state, "review");
    assert.ok((JSON.parse(recordOf(source, "pii").pii_json).phone ?? 0) > 0);
  });
  it("a document Observer cannot store is skipped and counted; Connect's quarantine is counted too; retryAfterS is honoured", async () => {
    const { live } = await addDocs();
    connect.putDoc(ACME, { collection: "finance", id: "bad", title: "x", text: "y", updatedAt: now, broken: true });
    put("ok", "fine");
    await runTick(live, tick());
    assert.equal(one("SELECT skipped_count FROM obs_jobs WHERE id = ?", live).skipped_count, 1);
    now += 2 * SCAN;
    connect.rateLimit(90);
    assert.deepEqual(await runTick(live, tick()), { status: "again", afterMs: 90_000 });
    assert.deepEqual(one("SELECT state, retry_at, consecutive_failures FROM obs_jobs WHERE id = ?", live), { state: "waiting", retry_at: now + 90_000, consecutive_failures: 0 });
  });
  it("cursor_invalid on a documents job: Try again reads the collections from the start (no gap note, nothing doubled)", async () => {
    const { source, live } = await addDocs();
    put("d1", "one");
    await runTick(live, tick());
    now += 2 * SCAN;
    connect.fail("data_pull", "cursor_invalid", 400);
    await runTick(live, tick());
    assert.equal(one("SELECT state FROM obs_jobs WHERE id = ?", live).state, "failed");
    await run("job_control", { id: live, action: "resume" }, owner());
    assert.deepEqual(one("SELECT state, cursor, note FROM obs_jobs WHERE id = ?", live), { state: "queued", cursor: null, note: null });
    await runTick(live, tick());
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_records WHERE source_id = ?", source), 1);
  });
});

/** Approve a document's record (deliver or deliver_redacted to Knowledge). */
async function approve(source: string, docId: string, decision: "deliver" | "deliver_redacted" = "deliver"): Promise<string> {
  const rec = recordOf(source, docId);
  await run("review_decide", { recordId: rec.id, decision, destination: "knowledge" }, owner());
  return String(rec.id);
}
const delivery = (recordId: string): Out => one("SELECT * FROM obs_deliveries WHERE record_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", recordId);

describe("deliveries to Knowledge", () => {
  it("document_create in the company area with title, body, summary and tags; the record is delivered; the exact input is what Observer sends", async () => {
    const { source, live } = await addDocs();
    put("memo", "Q3 board memo: MRR is 41,200 EUR.", { kind: "report", path: "Acme LLC/Finance/Q3 board memo", url: "https://drive.example.com/q3" });
    await runTick(live, tick());
    const rec = await approve(source, "memo");
    assert.equal(sdk.list().filter((j) => j.kind === DELIVER_KIND).length, 1, "the decision makes sure the drain runs");
    const r = await drainOutbox(drain());
    assert.equal(r.sent, 1);
    const create = knowledge.calls.find((c) => c.op === "document_create");
    assert.deepEqual(create?.input, {
      area: COMPANY_AREA,
      title: "Doc memo",
      body: "Q3 board memo: MRR is 41,200 EUR.",
      summary: "From Acme drive (finance) through Observer. Path: Acme LLC/Finance/Q3 board memo. Original: https://drive.example.com/q3.",
      tags: ["observer", "untrusted", "source:finance", "kind:report"],
      status: "published",
    });
    assert.equal(create?.key, delivery(rec).idem_key, "the stored idempotency key");
    assert.deepEqual(knowledge.calls.map((c) => c.op), ["areas_list", "document_create"], "the area comes from areas_list (the shared one)");
    assert.deepEqual([delivery(rec).status, delivery(rec).target_ref], ["sent", "doc_0001"]);
    assert.equal(one("SELECT state FROM obs_records WHERE id = ?", rec).state, "delivered");
    const list = await run("deliveries_list", {}, owner());
    assert.deepEqual([list.items[0].status, list.items[0].targetRef, list.items[0].lastError], ["sent", "doc_0001", null], "Activity shows it");
  });
  it("idempotent: a lost answer is sent again with the same key and bytes (one document); a new rev updates the same document", async () => {
    const { source, live } = await addDocs();
    put("memo", "first");
    await runTick(live, tick());
    const rec = await approve(source, "memo");
    knowledge.fail("document_create", "upstream_error", 503, { afterApply: true });
    let r = await drainOutbox(drain());
    assert.deepEqual([r.sent, r.waiting], [0, 1]);
    const row = delivery(rec);
    assert.deepEqual([row.status, row.attempts], ["pending", 1]);
    assert.ok(Number(row.next_at) > now);
    now = Number(row.next_at);
    r = await drainOutbox(drain());
    assert.equal(r.sent, 1);
    const creates = knowledge.calls.filter((c) => c.op === "document_create");
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0], creates[1], "the same op, input and key");
    assert.equal(knowledge.docs.size, 1, "one document");
    // the source changes the document: a new record, approved, UPDATES the same Knowledge document
    now += SCAN;
    put("memo", "second", { kind: "table", mime: "text/csv" });
    now += SCAN;
    await runTick(live, tick());
    const rec2 = await approve(source, "memo");
    assert.notEqual(rec2, rec);
    await drainOutbox(drain());
    const update = knowledge.calls.find((c) => c.op === "document_update");
    assert.deepEqual(update?.input, { id: "doc_0001", expectedVersion: 1, title: "Doc memo", body: "second", summary: "From Acme drive (finance) through Observer.", tags: ["observer", "untrusted", "source:finance", "kind:table"], status: "published" });
    assert.equal(knowledge.docs.get("doc_0001")?.body, "second");
    assert.equal(knowledge.docs.size, 1);
    assert.equal(one("SELECT state FROM obs_records WHERE id = ?", rec).state, "delivered", "the old record stays as history");
    assert.deepEqual(one("SELECT target_ref, rev FROM obs_targets"), { target_ref: "doc_0001", rev: String(one("SELECT rev FROM obs_documents WHERE doc_id = 'memo'").rev) });
  });
  it("deliver_redacted sends labels instead of personal data; tags name the PII classes", async () => {
    const { source, live } = await addDocs();
    put("pii", "Contact anna.novak@example.com or +421 900 123 456 about invoice 77.");
    await runTick(live, tick());
    const rec = await approve(source, "pii", "deliver_redacted");
    await drainOutbox(drain());
    const input = knowledge.calls.find((c) => c.op === "document_create")?.input as Out;
    assert.equal(input.body, "Contact [email] or [phone] about invoice 77.");
    assert.ok(!JSON.stringify(input).includes("anna.novak"));
    assert.deepEqual(input.tags, ["observer", "untrusted", "source:finance", "pii:email", "pii:phone"]);
    assert.match(input.summary, /personal data redacted/);
    assert.equal(delivery(rec).status, "sent");
  });
  it("a rule delivers without a click: redacted, to the rule's area, as draft; a CSV table page is escaped and tagged kind:table", async () => {
    knowledge.areas.push({ id: "tables", label: "Tables", kind: "shared" });
    await run("rule_put", { position: 1, match: {}, action: { deliver: "knowledge", redact: true, area: "tables", knowledgeStatus: "draft" } }, owner());
    const { source, live } = await addDocs({ conversations: ["orders"], label: "Orders db" });
    connect.putDoc(ACME, { collection: "orders", id: "public.orders:1", title: "public.orders page 1", text: "id,customer,total\n1,=cmd,12\n2,anna@example.com,-3", updatedAt: now, kind: "table", mime: "text/csv" });
    await runTick(live, tick());
    const rec = recordOf(source, "public.orders:1");
    assert.equal(rec.state, "approved", "the rule approved it (PII + redact: true)");
    await drainOutbox(drain());
    const input = knowledge.calls.find((c) => c.op === "document_create")?.input as Out;
    assert.deepEqual([input.area, input.status, input.body], ["tables", "draft", "id,customer,total\n1,'=cmd,12\n2,[email],'-3"]);
    assert.deepEqual(input.tags, ["observer", "untrusted", "source:orders", "pii:email", "kind:table"]);
    assert.equal(delivery(String(rec.id)).status, "sent");
  });
  it("a CSV table document: formula cells are escaped and it is tagged kind:table", () => {
    assert.equal(escapeCsvFormulas('id,name,total\n1,=HYPERLINK("x"),+12\n2,"@SUM(A1)",-3\n3,plain,"=1+1"'), "id,name,total\n1,'=HYPERLINK(\"x\"),'+12\n2,\"'@SUM(A1)\",'-3\n3,plain,\"'=1+1\"");
    assert.equal(escapeCsvFormulas("a,b\n1,2"), "a,b\n1,2", "quiet on good");
    assert.deepEqual(tagsFor("public.orders", { email: 2, secret: 0 }, "table"), ["observer", "source:public.orders", "pii:email", "kind:table"]);
  });
  it("Knowledge refuses app callers (scope_denied): failed at once with a plain sentence, no retry storm; Retry after the fix sends it", async () => {
    knowledge.appWrites = "refused";
    const { source, live } = await addDocs();
    put("memo", "x");
    await runTick(live, tick());
    const rec = await approve(source, "memo");
    const r = await drainOutbox(drain());
    assert.equal(r.failed, 1);
    const row = delivery(rec);
    assert.equal(row.status, "failed");
    assert.match(String(row.last_error), /Observer may not write to this area/);
    assert.doesNotMatch(String(row.last_error), /fake|no create access/, "never Knowledge's own words");
    now += 60 * MIN;
    await drainOutbox(drain());
    assert.equal(knowledge.calls.filter((c) => c.op === "document_create").length, 1, "no retry by itself");
    knowledge.appWrites = "allowed";
    await run("delivery_retry", { id: row.id }, owner());
    await drainOutbox(drain());
    assert.equal(delivery(rec).status, "sent");
  });
  it("5xx answers back off and fail after 5 attempts; Knowledge missing waits without an attempt; kanban fails honestly; held waits for the owner", async () => {
    const { source, live } = await addDocs();
    put("a", "x");
    put("b", "y");
    put("c", "z");
    await runTick(live, tick());
    const a = await approve(source, "a");
    knowledge.fail("document_create", "upstream_error", 503, { times: MAX_DELIVERY_ATTEMPTS });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await drainOutbox(drain());
      now = Math.max(now, Number(delivery(a).next_at ?? now)) + 1;
    }
    assert.deepEqual([delivery(a).status, delivery(a).attempts], ["failed", MAX_DELIVERY_ATTEMPTS]);
    // Knowledge not in the slice: no call, no attempt, a sentence
    const b = await approve(source, "b");
    targets = ["connect"];
    const calls = knowledge.calls.length;
    await drainOutbox(drain());
    assert.equal(knowledge.calls.length, calls);
    assert.deepEqual([delivery(b).status, delivery(b).attempts, delivery(b).last_error], ["pending", 0, KNOWLEDGE_MISSING]);
    targets = ["connect", "knowledge"];
    now += 10 * MIN;
    await drainOutbox(drain());
    assert.equal(delivery(b).status, "sent", "quiet on good: it goes once Knowledge is there");
    // held: asked again with the same key until the owner decides
    const c = await approve(source, "c");
    knowledge.hold("document_create");
    await drainOutbox(drain());
    assert.deepEqual([delivery(c).status, Number(delivery(c).next_at) - now], ["held", HELD_RECHECK_MS]);
    const key = String(delivery(c).idem_key);
    knowledge.holds.set(`document_create\u0000${key}`, "approved");
    now += HELD_RECHECK_MS;
    await drainOutbox(drain());
    assert.equal(delivery(c).status, "sent");
    // Task Board is not a destination Observer sends to yet
    put("k", "w");
    now += SCAN;
    await runTick(live, tick());
    const rec = recordOf(source, "k");
    await run("review_decide", { recordId: rec.id, decision: "deliver", destination: "kanban" }, owner());
    await drainOutbox(drain());
    assert.deepEqual([delivery(String(rec.id)).status, delivery(String(rec.id)).last_error], ["failed", ONLY_KNOWLEDGE]);
  });
  it("an update whose Knowledge document is gone creates a new one; a record whose text is gone fails honestly", async () => {
    const { source, live } = await addDocs();
    put("memo", "one");
    await runTick(live, tick());
    await approve(source, "memo");
    await drainOutbox(drain());
    knowledge.docs.clear();
    now += SCAN;
    put("memo", "two");
    now += SCAN;
    await runTick(live, tick());
    const rec2 = await approve(source, "memo");
    await drainOutbox(drain());
    assert.equal(delivery(rec2).status, "pending", "the link is forgotten, the next attempt creates");
    await drainOutbox(drain());
    assert.deepEqual([delivery(rec2).status, delivery(rec2).target_ref], ["sent", "doc_0002"]);
    // text gone
    put("gone", "z");
    now += SCAN;
    await runTick(live, tick());
    const g = await approve(source, "gone");
    db.prepare("UPDATE obs_messages SET text = NULL WHERE record_id = ?").run(g);
    await drainOutbox(drain());
    assert.equal(delivery(g).status, "failed");
  });
  it("a message record is delivered too: title from the subject or the source, body with times and authors", async () => {
    connect.addAccount({ id: "slack1", service: "slack" });
    const out = await run("source_add", { account: "slack1", conversations: ["C1"], label: "Support" }, owner());
    const live = String(one("SELECT id FROM obs_jobs WHERE source_id = ? AND kind = 'live'", out.source.id).id);
    await run("job_control", { id: live, action: "start" }, owner());
    connect.post("slack1", { conversation: "C1", id: "m1", text: "Escalation: order 1182 is late", sentAt: now + 1000, author: "slack:U0ANNA" });
    now += SCAN;
    await runTick(live, tick());
    now += 40 * MIN;
    await runTick(live, tick());
    const rec = one("SELECT id FROM obs_records WHERE source_id = ?", out.source.id);
    await run("review_decide", { recordId: rec.id, decision: "deliver", destination: "knowledge" }, owner());
    await drainOutbox(drain());
    const input = knowledge.calls.find((c) => c.op === "document_create")?.input as Out;
    assert.equal(input.title, "Support · C1 · 2026-10-27 09:00 UTC");
    assert.equal(input.body, "2026-10-27 09:00 UTC · slack:U0ANNA\nEscalation: order 1182 is late");
    assert.deepEqual(input.tags, ["observer", "source:c1"]);
  });
  it("ensureDrainJob keeps exactly one drain job", () => {
    assert.equal(ensureDrainJob(null), null);
    const a = ensureDrainJob(sdk.api);
    const b = ensureDrainJob(sdk.api);
    assert.equal(a?.id, b?.id);
    assert.equal(sdk.list().filter((j) => j.kind === DELIVER_KIND).length, 1);
  });
});

describe("delivery target (Routing)", () => {
  it("lists the areas Knowledge shows Observer; the company area is the default; the owner picks another or goes back", async () => {
    const got = await run("delivery_target_get", {}, owner());
    assert.deepEqual(got, {
      area: null,
      effectiveArea: "company",
      areas: [
        { id: "company", label: "Company", kind: "shared", access: "read_write" },
        { id: "agt-scout", label: "Scout (own memory)", kind: "agent", access: "read" },
      ],
      knowledgeMissing: false,
      error: null,
      counts: { pending: 0, held: 0, sent: 0, failed: 0 },
    });
    const schema = manifest.operations.find((o) => o.id === "delivery_target_get")?.output as never;
    assert.equal(validateAgainstSchema(schema, got as Json).ok, true);
    assert.deepEqual(await run("delivery_target_set", { area: "agt-scout" }, owner()), { area: "agt-scout" });
    assert.equal((await run("delivery_target_get", {}, owner())).effectiveArea, "agt-scout");
    await assert.rejects(run("delivery_target_set", { area: "nope-area" }, owner()), { code: "area_unknown" });
    assert.deepEqual(await run("delivery_target_set", { area: null }, owner()), { area: null });
    targets = ["connect"];
    assert.deepEqual((await run("delivery_target_get", {}, owner())).knowledgeMissing, true);
    await assert.rejects(run("delivery_target_set", { area: "company" }, owner()), { code: "knowledge_unavailable" });
  });
  it("the picked area is where a new document goes", async () => {
    knowledge.areas.push({ id: "finance-docs", label: "Finance", kind: "shared" });
    await run("delivery_target_set", { area: "finance-docs" }, owner());
    const { source, live } = await addDocs();
    put("memo", "x");
    await runTick(live, tick());
    await approve(source, "memo");
    await drainOutbox(drain());
    assert.equal(knowledge.calls.find((c) => c.op === "document_create")?.input.area, "finance-docs");
    assert.deepEqual(
      knowledge.calls.map((c) => c.op).filter((o) => o === "areas_list"),
      ["areas_list"],
      "only the set op listed areas: the drain uses the stored pick",
    );
  });
});
