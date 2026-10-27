// QA-OBS11 delta regression suite (adopted from the QA repro qa-20261027-observer11d-Lb2u/qa-delta.test.ts, which asserts instead of
// printing here). Producer model written from connect feat/c373-documents-dataset 795256a pullMcpDocuments, NOT from test/fake-connect.ts:
//  - state scan over ONE list, cursor = {o, c(collection tag)}, refused on another collection
//  - collection filter skips other collections; tombstones ONLY when collection === null (full unfiltered scan), after the list end
//  - tombstone: title "", text "", deleted:true, new rev, collection = the stored one
//  - retryAfterS may come WITH rows and an advanced cursor; extras skipped / failedCollections / partial
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { realPort, setConnectFactory } from "../src/connect.ts";
import { drainOutbox } from "../src/deliver.ts";
import { CallBudget, DOC_MIN_INTERVAL_MS, runTick, sharedBudget } from "../src/jobs.ts";
import { setPrivacy } from "../src/store.ts";
import { FakeConnect } from "./fake-connect.ts";
import { FakeKnowledge } from "./fake-knowledge.ts";
import { ctxFor, FakeJobs, migratedDb, OWNER, start } from "./helpers.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);
const SCAN = DOC_MIN_INTERVAL_MS;
const ACME = "acc_acme_mcp";
interface PDoc { id: string; collection: string; title: string; text: string; version: number; updatedAt: number; path?: string; url?: string }
let db: Db; let now: number; let connect: FakeConnect; let knowledge: FakeKnowledge; let sdk: FakeJobs; let budget: CallBudget;
let list: PDoc[] = []; // the source's current state
const delivered = new Map<string, { collection: string; version: number; deleted: boolean; updatedAt: number }>(); // connect_doc_versions
let pageSize = 2; let rateWithRows: number | null = null; let extras = false;
const pulls: Record<string, any>[] = [];
const enc = (st: object, c: string | null) => Buffer.from(`d1:${ACME}:${JSON.stringify({ ...st, c })}`).toString("base64url");
const dec = (cur: string, c: string | null): any => {
  const m = /^d1:([^:]+):(\{.*\})$/s.exec(Buffer.from(cur, "base64url").toString());
  const s = m ? JSON.parse(m[2]!) : null;
  if (!s || (s.c ?? null) !== c) throw Object.assign(new Error("cursor_invalid"), { code: "cursor_invalid" });
  return s;
};
const rowOf = (d: PDoc) => ({ id: d.id, collection: d.collection, title: d.title, ...(d.path ? { path: d.path } : {}), ...(d.url ? { url: d.url } : {}), mime: "text/markdown", updatedAt: new Date(d.updatedAt).toISOString(), rev: `v${d.version}-x`, kind: "document", text: d.text, untrusted: true });
function produce(i: Record<string, any>): Json {
  const collection: string | null = typeof i.collection === "string" ? i.collection : null;
  const st = i.cursor ? dec(i.cursor, collection) : {};
  let o = st.o ?? 0; const rows: any[] = []; let rk = st.rk;
  const limit = Math.min(i.limit ?? 50, 50, pageSize);
  const env = (p: Record<string, any>) => ({ ...p, ...(extras ? { skipped: 2, failedCollections: ["broken"], ...(p.exhausted ? { partial: true } : {}) } : {}), schema: "documents/1", untrusted: true });
  if (rk === undefined) {
    for (; o < list.length; o += 1) {
      if (rows.length >= limit) return env({ rows, nextCursor: enc({ o }, collection), exhausted: false, ...(rateWithRows !== null && !i.cursor ? { retryAfterS: rateWithRows } : {}) });
      const d = list[o]!;
      if (collection !== null && d.collection !== collection) continue;
      delivered.set(d.id, { collection: d.collection, version: d.version, deleted: false, updatedAt: d.updatedAt });
      rows.push(rowOf(d));
    }
    if (rateWithRows !== null && rows.length > 0 && !i.cursor) return env({ rows, nextCursor: enc({ o: list.length - 1 }, collection), exhausted: false, retryAfterS: rateWithRows });
    if (collection !== null) return env({ rows, nextCursor: null, exhausted: true });
    rk = 0;
  }
  // reaping phase (unfiltered full scan only)
  const alive = new Set(list.map((d) => d.id));
  for (const [id, v] of delivered) {
    if (v.deleted || alive.has(id)) continue;
    if (rows.length >= limit) return env({ rows, nextCursor: enc({ rk: 0 }, collection), exhausted: false });
    v.deleted = true; v.version += 1;
    rows.push({ id, collection: v.collection, title: "", mime: "text/plain", updatedAt: new Date(Math.max(v.updatedAt, now)).toISOString(), rev: `v${v.version}-del`, deleted: true, text: "", untrusted: true });
  }
  return env({ rows, nextCursor: null, exhausted: true });
}
const callApp = async (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => {
  if (product === "knowledge") return knowledge.callApp(product, op, input, opts);
  const i = input as Record<string, any>;
  if (op === "data_pull" && i.dataset === "documents") {
    pulls.push(structuredClone(i));
    try { return { status: "ok", output: produce(i) }; } catch (e: any) { if (e.code === "cursor_invalid") { const { TbError } = await import("@opt2-tealbrick/miniapp-sdk"); throw new TbError("cursor_invalid", "cursor refused", 400); } throw e; }
  }
  return connect.callApp(product, op, input);
};
const owner = (): OpContext => ctxFor(db, OWNER, { targets: ["connect", "knowledge"], callApp: callApp as never, jobs: sdk });
const tick = () => ({ db, port: realPort({ callApp: callApp as never }, budget), checkpoint: <T>(_s: Json, w: (d: Db) => T) => db.transaction(() => w(db)), paused: () => false, random: () => 0.5 });
const drain = () => ({ db, callApp: callApp as never, targets: () => ["connect", "knowledge"], write: (fn: (d: Db) => void) => db.transaction(() => fn(db)), random: () => 0.5 });
const one = (sql: string, ...a: unknown[]): Out => ({ ...(db.prepare(sql).get(...a) ?? {}) });
const mk = (id: string, text: string, extra: Partial<PDoc> = {}): PDoc => ({ id, collection: "finance", title: `Doc ${id}`, text, version: 1, updatedAt: now, ...extra });

beforeEach(async () => {
  db = migratedDb(); now = T0; setClock(() => now); setConnectFactory(null); await start(db);
  connect = new FakeConnect();
  connect.addAccount({ id: ACME, service: "mcp", label: "Acme", datasets: ["documents"], collections: [{ id: "finance", name: "Finance" }, { id: "legal", name: "Legal" }] });
  knowledge = new FakeKnowledge(); sdk = new FakeJobs(); budget = new CallBudget(); sharedBudget.reset();
  list = []; delivered.clear(); pageSize = 2; rateWithRows = null; extras = false; pulls.length = 0;
});
async function addDocs(conversations: string[]) {
  const out = await run("source_add", { account: ACME, dataset: "documents", conversations, label: "Acme", liveIntervalS: 300 }, owner());
  const live = String(one("SELECT id FROM obs_jobs WHERE source_id = ? AND kind='live'", out.source.id).id);
  await run("job_control", { id: live, action: "start" }, owner());
  return { source: out.source.id as string, live };
}
const textOf = (source: string, id: string) => one("SELECT text FROM obs_messages WHERE source_id=? AND provider_msg_id=?", source, `${id}#0000`).text;
const edit = (id: string, patch: Partial<PDoc>) => { const i = list.findIndex((d) => d.id === id); list[i] = { ...list[i]!, ...patch, version: list[i]!.version + 1, updatedAt: now }; };

describe("delta", () => {
  for (const conv of [["finance"], ["finance", "legal"]]) {
    it(`A [${conv.length} collection(s)]: edit after first full scan is seen; cursor NULL after scan`, async () => {
      const { source, live } = await addDocs(conv);
      list = [mk("a", "alpha v1"), mk("b", "b"), mk("c", "c"), mk("d", "d"), mk("e", "e")];
      await runTick(live, tick());
      assert.equal(one("SELECT cursor FROM obs_jobs WHERE id=?", live).cursor, null);
      now += SCAN + 1000; edit("a", { text: "alpha v2" });
      await runTick(live, tick());
      assert.equal(textOf(source, "a"), "alpha v2");
      assert.equal(pulls.filter((p) => p.collection !== undefined).length, 0, "Observer NEVER passes collection to data_pull (tombstones come only on a full scan)");
    });
    it(`B [${conv.length} collection(s)]: deletion at the source`, async () => {
      const { source, live } = await addDocs(conv);
      list = [mk("a", "alpha"), mk("b", "beta"), mk("c", "c")];
      await runTick(live, tick());
      list = list.filter((d) => d.id !== "a");
      now += SCAN + 1000; await runTick(live, tick()); now += SCAN + 1000; await runTick(live, tick());
      const d = one("SELECT deleted, record_id FROM obs_documents WHERE source_id=? AND doc_id='a'", source);
      assert.equal(pulls.filter((p) => p.collection !== undefined).length, 0);
      assert.equal(d.deleted, 1, "deleted tombstone seen");
      assert.equal(textOf(source, "a"), undefined);
    });
  }
  it("B2: unfiltered 2-collection source: tombstone of doc in a collection ALSO in scope gets purged + retraction archives Knowledge copy", async () => {
    const { live } = await addDocs(["finance", "legal"]);
    await run("rule_put", { position: 1, match: {}, action: { deliver: "knowledge", knowledgeStatus: "published" } }, owner());
    list = [mk("a", "alpha body"), mk("l", "legal body", { collection: "legal" })];
    await runTick(live, tick());
    await drainOutbox(drain() as never);
    assert.equal(knowledge.docs.size, 2);
    list = list.filter((d) => d.id !== "l");
    now += SCAN + 1000; await runTick(live, tick());
    await drainOutbox(drain() as never);
    const docs = [...knowledge.docs.values()];
    assert.equal(docs.filter((d) => d.status === "archived").length, 1);
    const archived = docs.find((d) => d.status === "archived")!;
    assert.ok(archived.tags.includes("source-deleted") && !archived.body.includes("legal body"));
    assert.equal(docs.find((d) => d.status !== "archived")?.body, "alpha body", "the other copy is untouched");
    assert.equal(count("SELECT COUNT(*) c FROM obs_deliveries WHERE payload_json IS NOT NULL"), 0);
  });
  it("C: persistent 429-with-rows makes progress", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    list = [mk("a", "alpha"), mk("b", "beta"), mk("c", "gamma"), mk("d", "d")];
    rateWithRows = 30;
    for (let i = 0; i < 3; i++) { await runTick(live, tick()); now += 40_000; }
    assert.equal(one("SELECT COUNT(*) c FROM obs_documents WHERE source_id=?", source).c, 4, "a persistent 429 with rows still makes progress");
  });
  it("G: extras skipped / failedCollections / partial are tolerated", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    list = [mk("a", "alpha"), mk("b", "beta"), mk("c", "gamma")]; extras = true;
    await runTick(live, tick());
    assert.equal(one("SELECT error_code FROM obs_jobs WHERE id=?", live).error_code, null);
    assert.equal(one("SELECT COUNT(*) c FROM obs_documents WHERE source_id=?", source).c, 3);
  });
  it("H: source narrowed 2 -> 1 collection while a scan cursor is stored (mid-scan wait) -> cursor_invalid?", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    list = [mk("a", "alpha"), mk("b", "beta"), mk("c", "gamma"), mk("d", "d", { collection: "legal" })];
    rateWithRows = 30;
    await runTick(live, tick());
    assert.equal(one("SELECT cursor IS NOT NULL AS has FROM obs_jobs WHERE id=?", live).has, 1, "a mid-scan cursor is stored");
    await run("source_update", { id: source, conversations: ["finance"] }, owner());
    assert.equal(one("SELECT cursor FROM obs_jobs WHERE id=?", live).cursor, null, "a changed collection list restarts the scan");
    now += 40_000; rateWithRows = null;
    await runTick(live, tick());
    const job = one("SELECT state, error_code FROM obs_jobs WHERE id=?", live);
    assert.notEqual(job.state, "failed", `no cursor_invalid after narrowing: ${JSON.stringify(job)}`);
    assert.equal(job.error_code, null);
    assert.equal(one("SELECT COUNT(*) c FROM obs_documents WHERE source_id=?", source).c, 3, "only the finance documents are kept");
  });
  it("I: tombstone for a doc delivered under a source with exclusion/author left out: no crash; tombstone with empty title accepted", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    list = [mk("a", "alpha"), mk("b", "b")];
    await runTick(live, tick());
    list = [mk("b", "b")];
    now += SCAN + 1000; await runTick(live, tick());
    assert.equal(one("SELECT state FROM obs_jobs WHERE id=?", live).state, "waiting");
    assert.equal(one("SELECT deleted FROM obs_documents WHERE source_id=? AND doc_id='a'", source).deleted, 1);
  });
});

describe("delta: collections the source did not choose", () => {
  it("M: rows and tombstones of other collections are dropped locally (out_of_scope), nothing is stored for them", async () => {
    const { source, live } = await addDocs(["finance"]);
    list = [mk("a", "alpha"), mk("l", "legal text", { collection: "legal" })];
    await runTick(live, tick());
    assert.equal(textOf(source, "a"), "alpha");
    assert.equal(one("SELECT COUNT(*) c FROM obs_documents WHERE source_id=? AND doc_id='l'", source).c, 0);
    list = list.filter((d) => d.id !== "l");
    now += SCAN + 1000;
    await runTick(live, tick());
    assert.equal(one("SELECT COUNT(*) c FROM obs_documents WHERE source_id=? AND doc_id='l'", source).c, 0, "its tombstone is out_of_scope too");
    assert.equal(one("SELECT state FROM obs_jobs WHERE id=?", live).state, "waiting");
  });
});

describe("delta2", () => {
  it("J: a delivery that failed for good keeps no payload_json (whole body); Retry builds it again", async () => {
    const { live } = await addDocs(["finance", "legal"]);
    await run("rule_put", { position: 1, match: {}, action: { deliver: "knowledge", knowledgeStatus: "published" } }, owner());
    list = [mk("a", "SECRET-ISH board memo text")];
    await runTick(live, tick());
    knowledge.fail("document_create", "scope_denied", 403);
    await drainOutbox(drain() as never);
    const d = one("SELECT id, status, payload_json IS NOT NULL AS has_payload FROM obs_deliveries");
    assert.deepEqual([d.status, d.has_payload], ["failed", 0], "a delivery that failed for good keeps no stored call");
    // Retry builds the call again from the stored record
    knowledge.appWrites = "allowed";
    await run("delivery_retry", { id: d.id }, owner());
    await drainOutbox(drain() as never);
    assert.equal(one("SELECT status FROM obs_deliveries").status, "sent");
    assert.equal(knowledge.docs.size, 1);
    assert.match(knowledge.docs.get("doc_0001")?.body ?? "", /SECRET-ISH/);
  });
  it("J2: purge removes a failed delivery together with its text", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    await run("rule_put", { position: 1, match: {}, action: { deliver: "knowledge", knowledgeStatus: "published" } }, owner());
    list = [mk("a", "board memo text")];
    await runTick(live, tick());
    knowledge.fail("document_create", "scope_denied", 403);
    await drainOutbox(drain() as never);
    const id = String(one("SELECT id FROM obs_deliveries").id);
    await run("purge", { source }, owner());
    // purge removes the unsent rows with the text; a failed row of a record whose text was removed cannot be retried
    assert.equal(db.prepare("SELECT 1 FROM obs_deliveries WHERE id = ?").get(id), undefined);
  });
  it("K: tombstone while a create is unanswered (answer lost) in purge mode: settled, then archived", async () => {
    const { live } = await addDocs(["finance", "legal"]);
    await run("rule_put", { position: 1, match: {}, action: { deliver: "knowledge", knowledgeStatus: "published" } }, owner());
    list = [mk("a", "to be deleted body"), mk("b", "b")];
    await runTick(live, tick());
    knowledge.fail("document_create", "unavailable", 503, { afterApply: true, times: 1 });
    await drainOutbox(drain() as never);
    assert.equal(knowledge.docs.size, 2, "the lost-answer create was applied (and b was delivered)");
    list = list.filter((d) => d.id !== "a");
    now += SCAN + 1000; await runTick(live, tick());
    now += 10 * 60_000; await drainOutbox(drain() as never); await drainOutbox(drain() as never);
    const k = [...knowledge.docs.values()];
    assert.equal(k.length, 2, "one Knowledge document per document");
    const gone = k.filter((d) => d.status === "archived");
    assert.equal(gone.length, 1, "settled, then archived");
    assert.ok(!gone[0]?.body.includes("to be deleted body"));
    assert.equal(one("SELECT COUNT(*) c FROM obs_deliveries WHERE payload_json IS NOT NULL").c, 0);
  });
  it("L: keep mode: tombstone then back", async () => {
    const { source, live } = await addDocs(["finance", "legal"]);
    setPrivacy(db, { onSourceDelete: "keep" });
    list = [mk("a", "alpha"), mk("b", "b")];
    await runTick(live, tick());
    list = list.filter((d) => d.id !== "a");
    now += SCAN + 1000; await runTick(live, tick());
    assert.deepEqual(one("SELECT deleted, record_id IS NOT NULL AS rec FROM obs_documents WHERE doc_id='a'"), { deleted: 1, rec: 1 });
    assert.equal(textOf(source, "a"), "alpha", "keep: the text stays until the retention");
  });
});

const count = (sql: string, ...a: unknown[]): number => Number(db.prepare(sql).get(...a)?.c ?? 0);
void setPrivacy;
