// The SDK refuses a handler answer that does not match the manifest output schema (500 output_invalid). These tests check
// every op's answer against its schema on a database with rich data, and that the conformance fixture ids are valid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest, setClock } from "../src/app.ts";
import { realPort, setConnectFactory } from "../src/connect.ts";
import { runTick } from "../src/jobs.ts";
import { FakeConnect } from "./fake-connect.ts";
import { AGENT_A, ctxFor, FakeJobs, migratedDb, OWNER, start } from "./helpers.ts";
import { CONFORMANCE, seedConformance, seedDelivery, seedJob, seedMessage, seedRecord, seedSource } from "./seed.ts";

let db: Db;
const owner = (): OpContext => ctxFor(db, OWNER);
const agent = (): OpContext => ctxFor(db, AGENT_A);

function check(opId: keyof typeof handlers, input: unknown, output: unknown): void {
  const op = manifest.operations.find((o) => o.id === opId);
  assert.ok(op, opId);
  const inV = validateAgainstSchema(op.input as never, input as never);
  assert.equal(inV.ok, true, `${opId} input: ${JSON.stringify(inV)}`);
  const outV = validateAgainstSchema(op.output as never, output as never);
  assert.equal(outV.ok, true, `${opId} output: ${JSON.stringify(outV)}`);
}
async function call(opId: keyof typeof handlers, input: unknown, ctx: OpContext = owner()): Promise<any> {
  const out = await handlers[opId].run(input as never, ctx);
  check(opId, input, out);
  return out;
}

beforeEach(async () => {
  db = migratedDb();
  setClock(() => Date.UTC(2026, 9, 17, 12, 0, 0));
  setConnectFactory(null);
  await start(db);
});

describe("answers match the manifest schemas", () => {
  it("every agent op, on the conformance fixture", async () => {
    seedConformance(db);
    const status = await call("status", {}, agent());
    assert.ok(!JSON.stringify(status).includes("spans"), "agents never get spans");
    await call("job_pause", { jobId: CONFORMANCE.job }, agent());
    await call("flag", { recordId: CONFORMANCE.record, reason: "wrong" }, agent());
    assert.equal((await call("status", {}, agent())).review.waiting, 1);
  });
  it("every owner op on a database with a source, jobs, records, messages and deliveries", async () => {
    const src = seedSource(db);
    const live = seedJob(db, src, { kind: "live", state: "paused" });
    const hist = seedJob(db, src, { kind: "backfill", state: "failed", lastError: "rate_limited", retryAt: Date.UTC(2026, 9, 17, 13), sinceAt: Date.UTC(2026, 0, 1), maxMessages: 500, readCount: 20, createdAt: Date.UTC(2026, 9, 2) });
    const rec = seedRecord(db, src, { state: "review", pii: { email: 1 }, withText: true });
    seedMessage(db, src, { record: rec });
    const sent = seedRecord(db, src, { state: "approved" });
    const dlv = seedDelivery(db, sent, { status: "failed" });
    await call("status", {}, agent());
    await call("sources_available", {});
    await call("sources_list", {});
    await call("source_get", { id: src });
    await call("source_update", { id: src, label: "Renamed", liveIntervalS: 90, retentionDays: null, conversations: ["inbox"], exclude: { senders: ["x@y.example"] } });
    await call("jobs_list", {});
    await call("jobs_list", { source: src });
    await call("job_get", { id: hist });
    await call("job_control", { id: live, action: "start" });
    await call("rules_list", {});
    const rule = (await call("rule_put", { position: 1, match: { words: ["invoice"], minWords: 3, actionable: true }, action: { deliver: "knowledge", area: "ops" } })).rule;
    await call("rules_reorder", { ids: (await call("rules_list", {})).rules.map((r: { id: string }) => r.id) });
    await call("review_list", {});
    await call("review_get", { id: rec });
    await call("records_list", {});
    await call("records_list", { source: src, state: "delivered" });
    await call("record_get", { id: sent });
    await call("deliveries_list", {});
    await call("delivery_retry", { id: dlv });
    await call("privacy_get", {});
    await call("privacy_set", { textRetentionDays: 10 });
    await call("review_decide", { recordId: rec, decision: "deliver_redacted", destination: "kanban" });
    const flagged = seedRecord(db, src, { state: "review", withText: true });
    seedDelivery(db, flagged, { status: "sent", targetRef: "doc_k" });
    await call("review_decide", { recordId: flagged, decision: "keep" });
    await call("purge", { before: "2026-12-01T00:00:00Z" });
    await call("rule_delete", { id: rule.id });
    await call("source_remove", { id: src });
  });
  it("the Connect-dependent ops over the fake Connect (the real port) answer to schema as well, also after the jobs read", async () => {
    const fake = new FakeConnect();
    fake.addAccount({ id: "acc1", service: "telegram", label: "Front desk bot", conversations: [{ id: "inbox", name: "Inbox", type: "group" }] });
    fake.post("acc1", { conversation: "inbox", id: "m1", text: "hello", sentAt: Date.UTC(2026, 9, 17, 11) });
    const ctx = ctxFor(db, OWNER, { targets: ["connect", "knowledge"], callApp: fake.callApp, jobs: new FakeJobs() });
    const avail = await call("sources_available", {}, ctx);
    assert.deepEqual(avail.accounts, [{ id: "acc1", kind: "telegram", label: "Front desk bot" }], "the list: one call, no catalog");
    const picked = await call("sources_available", { account: "acc1" }, ctx);
    assert.deepEqual(picked.accounts, [{ id: "acc1", dataset: "messages", datasets: ["messages"], kind: "telegram", label: "Front desk bot", historyCapable: false, retentionDays: 30, conversations: [{ id: "inbox", title: "Inbox", estimate: 1 }] }]);
    const added = await call("source_add", { account: "acc1", conversations: ["inbox"], label: "Mail" }, ctx);
    const est = await call("backfill_estimate", { source: added.source.id, since: "2026-01-01T00:00:00Z" }, ctx);
    assert.deepEqual(est, { messages: 1, records: 1, durationS: 1, providerNote: "This source has no older history: Observer reads what Connect kept (up to 30 days)." });
    const hist = await call("backfill_start", { source: added.source.id, since: "2026-01-01T00:00:00Z", maxMessages: 100 }, ctx);
    await runTick(hist.job.id, { db, port: realPort({ callApp: fake.callApp as never }), checkpoint: (_s, w) => db.transaction(() => w(db)), paused: () => false });
    const got = await call("source_get", { id: added.source.id }, ctx);
    assert.deepEqual([got.source.history.state, got.source.history.done], ["done", 1]);
    await call("jobs_list", {}, ctx);
    await call("status", {}, agent());
  });
});

describe("the conformance fixture", () => {
  it("names ids that exist in the seed, and they match the manifest patterns", () => {
    const fx = JSON.parse(readFileSync(new URL("../tealbrick-conformance.json", import.meta.url), "utf8")) as { inputs: Record<string, any> };
    assert.equal(fx.inputs.job_pause.jobId, CONFORMANCE.job);
    assert.equal(fx.inputs.flag.recordId, CONFORMANCE.record);
    for (const id of ["status", "job_pause", "flag"] as const) {
      const op = manifest.operations.find((o) => o.id === id);
      assert.equal(validateAgainstSchema(op?.input as never, fx.inputs[id]).ok, true, id);
    }
  });
});
