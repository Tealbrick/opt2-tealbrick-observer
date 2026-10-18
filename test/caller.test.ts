// Caller identity (SDK-CALLER-PRODUCT, SDK 0.1.27): an app caller is keyed on the VERIFIED product (`ctx.caller.product`), never on
// its name. Observer serves no op to apps today (the guards test pins that); these tests pin what happens if one ever calls an op
// that records or decides: the attribution is `app:<product>`, two apps with the same name stay apart, an app without a verified product is keyed on its instance id.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { callerKey, handlers, setClock } from "../src/app.ts";
import { ctxFor, type FakeCaller, migratedDb, OWNER, start } from "./helpers.ts";
import { seedDelivery, seedJob, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const app = (name: string, product: string | undefined, id = "ins_01J0000000000000000000APP1"): FakeCaller => ({ type: "app", id, name, ...(product !== undefined ? { product } : {}) });

let db: Db;
beforeEach(async () => {
  db = migratedDb();
  setClock(() => Date.UTC(2026, 9, 17, 12, 0, 0));
  await start(db);
});

describe("callerKey", () => {
  it("keys an app on its verified product, not on its name or its instance id; agents and persons keep their id", () => {
    assert.equal(callerKey(ctxFor(db, app("Knowledge", "kanban"))), "app:kanban");
    assert.equal(callerKey(ctxFor(db, app("kanban", "knowledge"))), "app:knowledge", "a name that looks like another product changes nothing");
    assert.equal(callerKey(ctxFor(db, OWNER)), OWNER.id);
    assert.equal(callerKey(ctxFor(db, { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout", product: "kanban" })), "agt_01J0000000000000000000000A", "only an app has a product");
  });
  it("an app whose slice entry has no product is keyed on its verified instance id, still never on its name", () => {
    for (const c of [app("Knowledge", undefined), app("Knowledge", "")]) assert.equal(callerKey(ctxFor(db, c)), "ins:ins_01J0000000000000000000APP1");
    assert.notEqual(callerKey(ctxFor(db, app("A", undefined, "ins_01J0000000000000000000APP1"))), callerKey(ctxFor(db, app("A", undefined, "ins_01J0000000000000000000APP2"))));
  });
});

describe("an app caller on the ops that record", () => {
  it("flag is attributed to app:<product>; a second app with the same name is a different caller", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "delivered" });
    seedDelivery(db, rec, { status: "sent", targetRef: "doc_x" });
    const first = app("Same name", "kanban", "ins_01J0000000000000000000APP1");
    const second = app("Same name", "inbox", "ins_01J0000000000000000000APP2");
    const f1 = await run("flag", { recordId: rec, reason: "wrong" }, ctxFor(db, first));
    assert.deepEqual({ ...db.prepare("SELECT by_type, by_id FROM obs_flags WHERE id = ?").get(f1.flagId) }, { by_type: "app", by_id: "app:kanban" });
    // the same product again: the open flag comes back, nothing new
    assert.equal((await run("flag", { recordId: rec, reason: "again" }, ctxFor(db, first))).flagId, f1.flagId);
    // the record went back to Review, so the second app finds nothing delivered: it is a different caller, the answer is the shared not_found
    await assert.rejects(run("flag", { recordId: rec, reason: "x" }, ctxFor(db, second)), (e: { code?: string }) => e.code === "not_found");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_flags").get()?.c, 1);
  });
  it("an app without a product is recorded under its instance id, never under its name", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "delivered" });
    seedDelivery(db, rec, { status: "sent", targetRef: "doc_x" });
    const f = await run("flag", { recordId: rec, reason: "x" }, ctxFor(db, app("Knowledge", undefined)));
    assert.equal(db.prepare("SELECT by_id FROM obs_flags WHERE id = ?").get(f.flagId)?.by_id, "ins:ins_01J0000000000000000000APP1");
  });
  it("job_pause by an app is recorded as app:<product> in paused_by", async () => {
    const src = seedSource(db);
    const job = seedJob(db, src, { kind: "live", state: "running" });
    await run("job_pause", { jobId: job }, ctxFor(db, app("Knowledge", "kanban")));
    assert.equal(db.prepare("SELECT paused_by FROM obs_jobs WHERE id = ?").get(job)?.paused_by, "app:kanban");
  });
});
