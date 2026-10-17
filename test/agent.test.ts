// Agent ops (DESIGN §3.1, §5.7): status shows labels and counts only, job_pause only pauses, flag only reaches records
// Observer delivered and is capped. Each guard has a quiet-on-good and a fire-on-bad case (L27, L34).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, setClock } from "../src/app.ts";
import { AGENT_A, AGENT_B, ctxFor, migratedDb, OWNER } from "./helpers.ts";
import { seedDelivery, seedJob, seedMessage, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string, status?: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => {
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });

let db: Db;
let now: number;
const A = (opts = {}) => ctxFor(db, AGENT_A, opts);
const B = () => ctxFor(db, AGENT_B);

beforeEach(async () => {
  db = migratedDb();
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  await definition.onStart?.({ db } as never);
});

describe("status", () => {
  it("returns labels and counts only: the exact object, with text, senders and conversation titles in the database", async () => {
    const s1 = seedSource(db, { id: "src_01J0000000000000000000AAAA", label: "Work mail", kind: "gmail", conversations: ["Secret project: layoffs", "inbox"] });
    const s2 = seedSource(db, { id: "src_01J0000000000000000000BBBB", label: "Team chat", kind: "slack", conversations: ["#ceo-private"], createdAt: Date.UTC(2026, 9, 2) });
    seedJob(db, s1, { kind: "live", state: "waiting", readCount: 12, retryAt: Date.UTC(2026, 9, 17, 12, 5, 0), lastError: "boom: anna@example.com wrote the password hunter2" });
    seedJob(db, s1, { kind: "backfill", state: "running", readCount: 300, maxMessages: 1000, createdAt: Date.UTC(2026, 9, 2), sinceAt: Date.UTC(2026, 0, 1) });
    seedJob(db, s2, { kind: "live", state: "paused" });
    const rec = seedRecord(db, s1, { state: "review", thread: "Re: salary of Bob" });
    seedRecord(db, s1, { state: "delivered" });
    seedMessage(db, s1, { record: rec, text: "The password is hunter2, call +49 170 1234567", author: "email:anna@example.com", conversation: "Secret project: layoffs", thread: "Re: salary of Bob" });
    assert.deepEqual(await run("status", {}, A()), {
      sources: [
        {
          id: "src_01J0000000000000000000AAAA",
          label: "Work mail",
          kind: "gmail",
          live: { state: "waiting", lastReadAt: null, nextAt: "2026-10-17T12:05:00.000Z" },
          history: { state: "running", done: 300, total: 1000, since: "2026-01-01T00:00:00.000Z" },
        },
        {
          id: "src_01J0000000000000000000BBBB",
          label: "Team chat",
          kind: "slack",
          live: { state: "paused", lastReadAt: null, nextAt: null },
          history: { state: "none", done: 0, total: null, since: null },
        },
      ],
      review: { waiting: 1 },
    });
    const text = JSON.stringify(await run("status", {}, A()));
    for (const secret of ["hunter2", "anna@example.com", "layoffs", "ceo-private", "salary", "+49"]) assert.ok(!text.includes(secret), `status leaks ${secret}`);
  });
  it("an empty app answers no sources and nothing waiting", async () => {
    assert.deepEqual(await run("status", {}, A()), { sources: [], review: { waiting: 0 } });
  });
  it("a Rules narrowing with v 1 is ignored; any other shape fails closed (narrowing_unsupported)", async () => {
    seedSource(db);
    const plain = await run("status", {}, A());
    assert.deepEqual(await run("status", {}, A({ context: { "rules.narrowing": { v: 1, memoryTags: ["x"], ruleId: "rul_x" } } })), plain);
    await rejects(run("status", {}, A({ context: { "rules.narrowing": { v: 2 } } })), "narrowing_unsupported", 409);
    await rejects(run("status", {}, A({ context: { "rules.narrowing": "tags" } })), "narrowing_unsupported", 409);
  });
});

describe("job_pause", () => {
  it("pauses a queued, running or waiting job and records who paused it", async () => {
    const src = seedSource(db);
    for (const state of ["queued", "running", "waiting"]) {
      const id = seedJob(db, src, { state, kind: "backfill" });
      const ctx = A();
      assert.deepEqual(await run("job_pause", { jobId: id }, ctx), { job: { id, state: "paused" } });
      assert.equal(db.prepare("SELECT paused_by FROM obs_jobs WHERE id = ?").get(id)?.paused_by, AGENT_A.id);
      assert.equal(ctx.statusChanges, 1);
    }
  });
  it("pausing a paused job is a quiet no-op; the pauser stays the first one", async () => {
    const id = seedJob(db, seedSource(db), { state: "running" });
    await run("job_pause", { jobId: id }, A());
    const ctx = B();
    assert.deepEqual(await run("job_pause", { jobId: id }, ctx), { job: { id, state: "paused" } });
    assert.equal(db.prepare("SELECT paused_by FROM obs_jobs WHERE id = ?").get(id)?.paused_by, AGENT_A.id);
    assert.equal(ctx.statusChanges, 0);
  });
  it("answers not_found for a missing job and job_state_invalid for a finished one", async () => {
    const src = seedSource(db);
    await rejects(run("job_pause", { jobId: "job_nope" }, A()), "not_found", 404);
    for (const state of ["done", "failed", "cancelled"]) {
      const id = seedJob(db, src, { state, kind: "backfill" });
      await rejects(run("job_pause", { jobId: id }, A()), "job_state_invalid", 409);
      assert.equal(db.prepare("SELECT state FROM obs_jobs WHERE id = ?").get(id)?.state, state, "the job did not change");
    }
  });
  it("an agent cannot start, resume or cancel: the manifest gives agents job_pause only, and job_control is a person op", async () => {
    const m = (await import("../src/app.ts")).manifest;
    const agentOps = m.operations.filter((o) => o.audience === "agent").map((o) => o.id);
    assert.deepEqual(agentOps.sort(), ["flag", "job_pause", "status"]);
    assert.equal(m.operations.find((o) => o.id === "job_control")?.audience, "person");
    // and job_pause never moves a paused job back
    const id = seedJob(db, seedSource(db), { state: "paused", pausedBy: OWNER.id });
    await run("job_pause", { jobId: id }, A());
    assert.equal(db.prepare("SELECT state FROM obs_jobs WHERE id = ?").get(id)?.state, "paused");
  });
});

describe("flag", () => {
  function delivered(extra: { targetRef?: string } = {}): { rec: string; src: string } {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "delivered" });
    seedDelivery(db, rec, { status: "sent", targetRef: extra.targetRef ?? "doc_1" });
    return { rec, src };
  }
  it("flags a delivered record by record id or by document id, moves it back to review, and counts it in the badge", async () => {
    const a = delivered({ targetRef: "doc_a" });
    const b = delivered({ targetRef: "doc_b" });
    const f1 = await run("flag", { recordId: a.rec, reason: "wrong person" }, A());
    const f2 = await run("flag", { documentId: "doc_b", reason: "should not exist" }, A());
    assert.match(f1.flagId, /^flg_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(f1.flagId, f2.flagId);
    for (const r of [a.rec, b.rec]) assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(r)?.state, "review");
    assert.equal(db.prepare("SELECT reason, by_id, by_type FROM obs_flags WHERE id = ?").get(f1.flagId)?.reason, "wrong person");
    assert.equal(await definition.pendingCount?.(db), 2);
  });
  it("an unknown id, a record that was never delivered and a dropped record all answer not_found, the same as a missing one", async () => {
    const src = seedSource(db);
    const pendingRec = seedRecord(db, src, { state: "approved" });
    seedDelivery(db, pendingRec, { status: "pending" });
    const failedRec = seedRecord(db, src, { state: "approved" });
    seedDelivery(db, failedRec, { status: "failed" });
    const droppedRec = seedRecord(db, src, { state: "dropped" });
    const noDelivery = seedRecord(db, src, { state: "review" });
    const answers: unknown[] = [];
    for (const input of [
      { recordId: "rec_01J00000000000000000000000" },
      { recordId: pendingRec },
      { recordId: failedRec },
      { recordId: droppedRec },
      { recordId: noDelivery },
      { documentId: "doc_unknown" },
    ]) {
      await assert.rejects(run("flag", { ...input, reason: "x" }, A()), (e: { code?: string; httpStatus?: number; message?: string }) => {
        answers.push([e.code, e.httpStatus, e.message]);
        return true;
      });
    }
    assert.ok(answers.every((a) => JSON.stringify(a) === JSON.stringify(answers[0])), "every refusal is identical (no existence oracle)");
    assert.deepEqual((answers[0] as unknown[]).slice(0, 2), ["not_found", 404]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_flags").get()?.c, 0);
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(noDelivery)?.state, "review");
  });
  it("a record id and a document id that point at different records are refused (not_found)", async () => {
    const a = delivered({ targetRef: "doc_a" });
    delivered({ targetRef: "doc_b" });
    await rejects(run("flag", { recordId: a.rec, documentId: "doc_b", reason: "x" }, A()), "not_found");
    assert.ok(await run("flag", { recordId: a.rec, documentId: "doc_a", reason: "x" }, A()), "the matching pair works");
  });
  it("needs a target and a real reason", async () => {
    await rejects(run("flag", { reason: "x" }, A()), "flag_target_missing", 400);
    const { rec } = delivered();
    await rejects(run("flag", { recordId: rec, reason: "   " }, A()), "reason_empty", 400);
  });
  it("caps 50 flags per agent per day (flag_limit, 429): the 51st fails, another agent and the next day still work", async () => {
    const { rec } = delivered();
    for (let i = 0; i < 50; i++) await run("flag", { recordId: rec, reason: `r${i}` }, A());
    await rejects(run("flag", { recordId: rec, reason: "one too many" }, A()), "flag_limit", 429);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_flags WHERE by_id = ?").get(AGENT_A.id)?.c, 50);
    assert.ok(await run("flag", { recordId: rec, reason: "other agent" }, B()), "the cap is per agent");
    now += 24 * 3_600_000 + 1;
    assert.ok(await run("flag", { recordId: rec, reason: "next day" }, A()), "the window moves on");
  });
  it("a capped agent gets flag_limit even for unknown ids (the cap leaks nothing)", async () => {
    const { rec } = delivered();
    for (let i = 0; i < 50; i++) await run("flag", { recordId: rec, reason: `r${i}` }, A());
    await rejects(run("flag", { recordId: "rec_01J00000000000000000000000", reason: "x" }, A()), "flag_limit", 429);
  });
});
