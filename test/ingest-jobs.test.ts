// S2 ingest end to end: the owner ops (source_add, job_control, backfill_start) and the job ticks run Observer's REAL Connect port
// over the contract-faithful fake Connect (fake-connect.ts) with the test clock (L39: nothing waits on the wall clock). Every
// alarm is checked quiet-on-good AND fire-on-bad (L34) with the exact outcome (L27).
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, JobContext, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, setClock } from "../src/app.ts";
import { plainError, realPort, setConnectFactory } from "../src/connect.ts";
import { CUT_MARKER } from "../src/ingest.ts";
import { BACKFILL_KIND, BACKOFF_CAP_MS, backoffMs, CallBudget, jobSpec, jobsAttention, LIVE_KIND, PAUSE_RECHECK_MS, reconcileJobs, runTick, type TickDeps } from "../src/jobs.ts";
import { jobRow } from "../src/store.ts";
import { FakeConnect } from "./fake-connect.ts";
import { ctxFor, FakeJobs, migratedDb, OWNER, start } from "./helpers.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const MIN = 60_000;

let db: Db;
let now: number;
let fake: FakeConnect;
let sdk: FakeJobs;
let budget: CallBudget;
const owner = (): OpContext => ctxFor(db, OWNER, { targets: ["connect", "knowledge"], callApp: fake.callApp, jobs: sdk });
const one = (sql: string, ...args: unknown[]): Out => ({ ...(db.prepare(sql).get(...args) ?? {}) });
const count = (sql: string, ...args: unknown[]): number => Number(db.prepare(sql).get(...args)?.c ?? 0);
const dump = (): string => JSON.stringify(["obs_messages", "obs_records", "obs_deliveries", "obs_jobs", "obs_sources", "obs_flags"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));

/** Tick deps: the real port over the fake Connect; checkpoint = one transaction on the test db (like the SDK's, unfenced). */
function deps(over: Partial<TickDeps> & { db?: Db } = {}): TickDeps {
  const d = over.db ?? db;
  return {
    db: d,
    port: realPort({ callApp: fake.callApp as never }),
    checkpoint: (_state, write) => d.transaction(() => write(d)),
    paused: () => false,
    budget,
    random: () => 0.5,
    ...over,
  };
}
/** A db whose N+1-th message INSERT throws: the process "dies" in the middle of a page. */
function dyingAfter(inserts: number): Db {
  let left = inserts;
  return {
    ...db,
    prepare(sql: string) {
      const st = db.prepare(sql);
      if (!sql.includes("INSERT INTO obs_messages")) return st;
      return {
        run: (...a: unknown[]) => {
          if (left-- <= 0) throw new Error("killed mid-page");
          return st.run(...(a as never[]));
        },
        get: (...a: unknown[]) => st.get(...(a as never[])),
        all: (...a: unknown[]) => st.all(...(a as never[])),
      };
    },
  } as unknown as Db;
}

const post = (id: string, text: string, at: number, extra: Partial<Parameters<FakeConnect["post"]>[1]> = {}) => fake.post("acc1", { conversation: "C1", id, text, sentAt: at, ...extra });
async function addSource(input: Out = {}): Promise<{ source: string; live: string }> {
  const out = await run("source_add", { account: "acc1", conversations: ["C1"], label: "Team", ...input }, owner());
  const live = String(one("SELECT id FROM obs_jobs WHERE source_id = ? AND kind = 'live'", out.source.id).id);
  return { source: out.source.id, live };
}
async function startLive(live: string): Promise<void> {
  await run("job_control", { id: live, action: "start" }, owner());
}
const ids = (source: string): string[] =>
  db
    .prepare("SELECT provider_msg_id AS id FROM obs_messages WHERE source_id = ? ORDER BY provider_msg_id")
    .all(source)
    .map((r) => String(r.id));

beforeEach(async () => {
  db = migratedDb();
  now = T0;
  setClock(() => now);
  setConnectFactory(null); // the REAL port, over ctx.callApp
  await start(db);
  fake = new FakeConnect();
  fake.addAccount({ id: "acc1", service: "slack", history: false, retentionDays: 30 });
  sdk = new FakeJobs();
  budget = new CallBudget();
});

describe("anchor first (source_add, backfill_start)", () => {
  it("source_add captures Connect's head BEFORE the job exists; the live job reads only what came after it, also when started later", async () => {
    post("old", "sent before the source was added", T0 - 60 * MIN);
    const { source, live } = await addSource();
    const anchorCall = fake.calls.find((c) => c.op === "data_pull");
    assert.deepEqual(anchorCall?.input, { account: "acc1", dataset: "messages", direction: "forward", limit: 1 }, "a no-cursor pull");
    const job = one("SELECT state, cursor, anchor, anchor_at FROM obs_jobs WHERE id = ?", live);
    assert.equal(job.state, "paused");
    assert.ok(typeof job.anchor === "string" && job.anchor.length > 0);
    assert.deepEqual([job.cursor, job.anchor_at], [job.anchor, T0]);
    now += 5 * MIN;
    post("after", "sent after the add, before Start", now);
    now += 5 * MIN;
    await startLive(live);
    assert.deepEqual(await runTick(live, deps()), { status: "again", afterMs: 60_000 });
    assert.deepEqual(ids(source), ["after"], "the message before the anchor is not read live; the one after it is, though Start came later");
    assert.equal(fake.calls.filter((c) => c.op === "data_pull").at(-1)?.input.cursor, job.anchor);
  });
  it("an empty log has no anchor: the live job starts at Connect's start (nothing can be missed)", async () => {
    const { live } = await addSource();
    assert.deepEqual(one("SELECT cursor, anchor FROM obs_jobs WHERE id = ?", live), { cursor: null, anchor: null });
  });
  it("backfill_start captures its anchor first and ends the history read there (history false: forward through what Connect kept)", async () => {
    const { source } = await addSource();
    now += 10 * MIN;
    const out = await run("backfill_start", { source, since: new Date(T0 - 24 * 60 * MIN).toISOString(), until: new Date(T0 + 60 * MIN).toISOString() }, owner());
    const job = one("SELECT state, cursor, since_at, until_at, anchor_at, sdk_job_id FROM obs_jobs WHERE id = ?", out.job.id);
    assert.deepEqual(job, { state: "queued", cursor: null, since_at: T0 - 24 * 60 * MIN, until_at: T0 + 10 * MIN, anchor_at: T0 + 10 * MIN, sdk_job_id: "sdkjob1" }, "until is never later than the anchor time");
    assert.deepEqual(fake.calls.filter((c) => c.op === "data_pull").at(-1)?.input, { account: "acc1", dataset: "messages", direction: "forward", limit: 1 });
    assert.deepEqual(sdk.log, [`enqueue ${BACKFILL_KIND} {"job":"${out.job.id}"}`]);
  });
  it("a refusal of the anchor read refuses the op in plain words and makes nothing", async () => {
    fake.callerProduct = null;
    await assert.rejects(run("source_add", { account: "acc1", conversations: ["C1"], label: "x" }, owner()), { code: "caller_unverified", httpStatus: 403 });
    fake.callerProduct = "observer";
    fake.fail("data_pull", "not_found", 404);
    await assert.rejects(run("source_add", { account: "acc1", conversations: ["C1"], label: "x" }, owner()), { code: "account_not_shared", httpStatus: 404 });
    (fake.accounts.get("acc1") as { level: string }).level = "available";
    await assert.rejects(run("source_add", { account: "acc1", conversations: ["C1"], label: "x" }, owner()), { code: "account_not_shared", httpStatus: 404 }, "a catalog-only share is not listed for reading");
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_sources"), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_jobs"), 0);
  });
});

describe("one page = one transaction", () => {
  it("killed mid-page: nothing of the page is kept, the cursor stays; the resumed job reads it again: no duplicate, no gap", async () => {
    const { source, live } = await addSource();
    await startLive(live);
    for (let i = 1; i <= 5; i++) post(`m${i}`, `message ${i}`, T0 + i * 1000);
    const anchor = one("SELECT cursor FROM obs_jobs WHERE id = ?", live).cursor;
    // page 1 (2 rows) commits; the process dies in the middle of page 2
    const outcome = await runTick(live, deps({ db: dyingAfter(3), pageLimit: 2 }));
    assert.equal(outcome.status, "again");
    assert.deepEqual(ids(source), ["m1", "m2"], "page 1 is whole, nothing of page 2");
    const mid = one("SELECT cursor, read_count, consecutive_failures, state FROM obs_jobs WHERE id = ?", live);
    assert.notEqual(mid.cursor, anchor);
    assert.deepEqual([mid.read_count, mid.consecutive_failures, mid.state], [2, 1, "waiting"]);
    now = Number(one("SELECT retry_at FROM obs_jobs WHERE id = ?", live).retry_at);
    await runTick(live, deps({ pageLimit: 2 }));
    assert.deepEqual(ids(source), ["m1", "m2", "m3", "m4", "m5"]);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages"), 5, "each message once");
    assert.deepEqual(one("SELECT read_count, consecutive_failures, state FROM obs_jobs WHERE id = ?", live), { read_count: 5, consecutive_failures: 0, state: "waiting" });
  });
  it("a job paused while its page is on the way stores nothing of it", async () => {
    const { source, live } = await addSource();
    await startLive(live);
    post("m1", "hello", T0 + 1000);
    const cursor = one("SELECT cursor FROM obs_jobs WHERE id = ?", live).cursor;
    fake.onTheWire = () => {
      db.prepare("UPDATE obs_jobs SET state = 'paused', paused_by = ? WHERE id = ?").run(OWNER.id, live);
    };
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    assert.deepEqual([ids(source), one("SELECT cursor FROM obs_jobs WHERE id = ?", live).cursor], [[], cursor]);
  });
  it("live and backfill overlap: each message is stored once", async () => {
    post("m0", "kept by Connect before the add", T0 - 30 * MIN);
    const { source, live } = await addSource();
    now += MIN;
    post("m1", "after the add", now);
    now += MIN;
    await startLive(live);
    const hist = (await run("backfill_start", { source, since: new Date(T0 - 60 * MIN).toISOString() }, owner())).job.id;
    await runTick(live, deps());
    assert.deepEqual(await runTick(hist, deps()), { status: "done" });
    assert.deepEqual(ids(source), ["m0", "m1"]);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages WHERE provider_msg_id = 'm1'"), 1);
    assert.deepEqual(
      [one("SELECT read_count AS n FROM obs_jobs WHERE id = ?", live).n, one("SELECT read_count AS n, state FROM obs_jobs WHERE id = ?", hist)],
      [1, { n: 1, state: "done" }],
      "the history read stored only m0: m1 was already there",
    );
  });
});

describe("edits, deletions, windows and routing", () => {
  it("records close after 30 quiet minutes and are routed: plain text waits in Review, a secret is dropped by rule 0", async () => {
    const { source, live } = await addSource();
    await startLive(live);
    const secret = ["ghp", "_", "aB3dE6".repeat(6)].join(""); // built at run time: no secret-shaped literal in the repo
    post("m1", "lunch at noon?", T0 + 1000, { thread: "T1" });
    post("m2", `the deploy key is ${secret}`, T0 + 2000, { thread: "T2" });
    await runTick(live, deps());
    assert.deepEqual(db.prepare("SELECT state FROM obs_records ORDER BY thread").all().map((r) => r.state), ["open", "open"], "quiet on good: still open");
    now += 31 * MIN;
    await runTick(live, deps());
    const states = db.prepare("SELECT r.state, m.provider_msg_id AS id FROM obs_records r JOIN obs_messages m ON m.record_id = r.id ORDER BY m.provider_msg_id").all().map((r) => [r.id, r.state]);
    assert.deepEqual(states, [["m1", "review"], ["m2", "dropped"]]);
    assert.equal(one("SELECT record_count AS n FROM obs_jobs WHERE id = ?", live).n, 2);
    assert.ok(!dump().includes(secret.slice(4, 24)), "the secret never reached a table");
    assert.equal(ids(source).length, 2);
  });
  it("an edit row (same id, later rev, newer editedAt) replaces the text and re-classifies; a deletion row removes the text", async () => {
    const { live } = await addSource();
    await startLive(live);
    post("m1", "see you tomorrow", T0 + 1000);
    await runTick(live, deps());
    now += 31 * MIN;
    await runTick(live, deps());
    const rec = String(one("SELECT record_id FROM obs_messages WHERE provider_msg_id = 'm1'").record_id);
    db.prepare("UPDATE obs_records SET state = 'delivered' WHERE id = ?").run(rec);
    const before = one("SELECT revision, pii_json FROM obs_records WHERE id = ?", rec);
    fake.edit("acc1", "C1", "m1", "see you tomorrow, write to anna.k@example.com", now);
    now += MIN;
    await runTick(live, deps());
    assert.equal(one("SELECT text FROM obs_messages WHERE provider_msg_id = 'm1'").text, "see you tomorrow, write to anna.k@example.com");
    const after = one("SELECT state, revision, pii_json FROM obs_records WHERE id = ?", rec);
    assert.deepEqual([after.state, after.revision, JSON.parse(String(after.pii_json)).email], ["review", Number(before.revision) + 1, 1], "a delivered record that now holds an email goes back to Review");
    fake.remove("acc1", "C1", "m1", now);
    now += MIN;
    await runTick(live, deps());
    assert.deepEqual(one("SELECT text, deleted FROM obs_messages WHERE provider_msg_id = 'm1'"), { text: null, deleted: 1 });
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages"), 1);
  });
  it("a truncated row keeps the cut marker; display names and attachment names are never stored", async () => {
    const { live } = await addSource();
    await startLive(live);
    post("long", "word ".repeat(13_108).slice(0, 65_536), T0 + 1000, { truncated: true, display: "Anna Hidden-Name", attachments: [{ name: "payslip-anna.pdf", mime: "application/pdf", bytes: 10 }] });
    await runTick(live, deps());
    assert.ok(String(one("SELECT text FROM obs_messages WHERE provider_msg_id = 'long'").text).endsWith(CUT_MARKER));
    assert.ok(!dump().includes("Anna Hidden-Name") && !dump().includes("payslip-anna"));
  });
});

describe("what is never stored", () => {
  it("rows of other conversations of the account and rows by an excluded sender are never stored; a secret never reaches obs_messages", async () => {
    const { source, live } = await addSource({ exclude: { senders: ["slack:U0SPAM"] } });
    await startLive(live);
    const token = ["xoxb", "1234567890".repeat(2), "aBcD".repeat(6)].join("-"); // built at run time
    post("in", "fine words", T0 + 1000);
    fake.post("acc1", { conversation: "C2", id: "other", text: "a conversation the owner did not choose", sentAt: T0 + 2000 });
    post("spam", "buy now", T0 + 3000, { author: "slack:U0SPAM" });
    post("sec", `token ${token} here`, T0 + 4000);
    await runTick(live, deps());
    assert.deepEqual(ids(source), ["in", "sec"]);
    assert.ok(!dump().includes("did not choose") && !dump().includes("buy now"));
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM obs_messages").all()).includes(token.slice(5, 25)), "the token is gone before storage");
    assert.equal(one("SELECT read_count AS n FROM obs_jobs WHERE id = ?", live).n, 2, "read counts only what was stored");
  });
  it("a row that does not conform to messages/1 is skipped and counted (never stored); Connect's quarantined rows are counted too", async () => {
    const { source, live } = await addSource();
    await startLive(live);
    post("good", "fine", T0 + 1000);
    post("bad", "this row goes bad on the wire", T0 + 2000);
    post("broken", "Connect quarantines this one", T0 + 3000, { broken: true });
    fake.onTheWire = (out) => {
      for (const r of out.rows as Record<string, any>[]) if (r.id === "bad") r.untrusted = false;
    };
    await runTick(live, deps());
    assert.deepEqual(ids(source), ["good"]);
    assert.ok(!dump().includes("goes bad on the wire"));
    const job = (await run("job_get", { id: live }, owner())).job;
    assert.deepEqual(job.counts, { read: 1, records: 1, failures: 0, skipped: 2 });
  });
});

describe("pause, waits and failures", () => {
  it("slice pause: no pull within the tick; the owner's pause: the run ends without a pull", async () => {
    const { live } = await addSource();
    await startLive(live);
    post("m1", "x", T0 + 1000);
    const pulls = fake.pulls();
    assert.deepEqual(await runTick(live, deps({ paused: () => true })), { status: "again", afterMs: PAUSE_RECHECK_MS });
    assert.equal(fake.pulls(), pulls, "no pull while the slice pauses the app");
    await run("job_control", { id: live, action: "pause" }, owner());
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    assert.equal(fake.pulls(), pulls);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages"), 0);
    // quiet on good: resumed, it reads
    await run("job_control", { id: live, action: "resume" }, owner());
    await runTick(live, deps());
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages"), 1);
  });
  it("retryAfterS is honoured to the millisecond and is not a failure", async () => {
    const { live } = await addSource();
    await startLive(live);
    post("m1", "x", T0 + 1000);
    fake.rateLimit(42);
    assert.deepEqual(await runTick(live, deps()), { status: "again", afterMs: 42_000 });
    assert.deepEqual(one("SELECT state, retry_at, consecutive_failures FROM obs_jobs WHERE id = ?", live), { state: "waiting", retry_at: T0 + 42_000, consecutive_failures: 0 });
    const pulls = fake.pulls();
    now = T0 + 41_000;
    assert.deepEqual(await runTick(live, deps()), { status: "again", afterMs: 1000 });
    assert.equal(fake.pulls(), pulls, "no pull before the wait is over");
    now = T0 + 42_000;
    await runTick(live, deps());
    assert.equal(fake.pulls(), pulls + 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM obs_messages"), 1);
  });
  it("other failures back off exponentially with jitter (cap 15 min); the 5th in a row fails the job and raises attention", async () => {
    const { live } = await addSource();
    await startLive(live);
    assert.equal(jobsAttention(db), null, "quiet on good");
    assert.equal(await definition.attention?.(db), null);
    fake.fail("data_pull", "upstream_unavailable", 503, 5);
    const waits: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const o = await runTick(live, deps());
      assert.equal(o.status, "again");
      waits.push((o as { afterMs: number }).afterMs);
      const j = one("SELECT state, consecutive_failures, retry_at, error_code FROM obs_jobs WHERE id = ?", live);
      assert.deepEqual([j.state, j.consecutive_failures, j.retry_at, j.error_code], ["waiting", i, now + (waits[i - 1] as number), "upstream_unavailable"]);
      now = Number(j.retry_at);
    }
    assert.deepEqual(waits, [11_250, 22_500, 45_000, 90_000], "half to all of 15 s · 2^(n-1); random = 0.5");
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    const j = one("SELECT state, consecutive_failures, last_error FROM obs_jobs WHERE id = ?", live);
    assert.deepEqual([j.state, j.consecutive_failures, j.last_error], ["failed", 5, plainError("upstream_unavailable")]);
    assert.deepEqual(await definition.attention?.(db), { code: "jobs_failed", reason: "1 Observer job stopped after repeated failures. Open Sources to see why and try again." });
    assert.equal(fake.pulls(), 6, "the anchor read and 5 tries; nothing more");
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    assert.equal(fake.pulls(), 6);
    assert.equal(backoffMs(30, () => 1), BACKOFF_CAP_MS);
    assert.equal(backoffMs(30, () => 0), BACKOFF_CAP_MS / 2);
  });
  it("cursor_invalid fails the job at once with a plain error (not a loop); Try again reads from Connect's start, nothing twice", async () => {
    const { source, live } = await addSource();
    await startLive(live);
    post("m1", "x", T0 + 1000);
    await runTick(live, deps());
    db.prepare("UPDATE obs_jobs SET cursor = ? WHERE id = ?").run("bm90LWEtY3Vyc29y", live);
    now += 60_000; // the live interval is over
    const pulls = fake.pulls();
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    assert.deepEqual(one("SELECT state, error_code, last_error, consecutive_failures FROM obs_jobs WHERE id = ?", live), { state: "failed", error_code: "cursor_invalid", last_error: plainError("cursor_invalid"), consecutive_failures: 1 });
    assert.equal(fake.pulls(), pulls + 1);
    assert.deepEqual(await runTick(live, deps()), { status: "done" });
    assert.equal(fake.pulls(), pulls + 1, "no second try by itself");
    await run("job_control", { id: live, action: "resume" }, owner());
    assert.deepEqual(one("SELECT state, cursor, error_code, last_error FROM obs_jobs WHERE id = ?", live), { state: "queued", cursor: null, error_code: null, last_error: null });
    post("m2", "y", now);
    await runTick(live, deps());
    assert.deepEqual(ids(source), ["m1", "m2"]);
  });
  it("caller_unverified or not_found from Connect: the source shows a plain error, after ONE call (no retry storm)", async () => {
    for (const [setup, code] of [
      [() => (fake.callerProduct = null), "caller_unverified"],
      [() => (fake.sharedWith = "knowledge"), "not_found"],
    ] as const) {
      fake.callerProduct = "observer";
      fake.sharedWith = "observer";
      const { source, live } = await addSource({ label: code });
      await startLive(live);
      setup();
      const pulls = fake.pulls();
      assert.deepEqual(await runTick(live, deps()), { status: "done" });
      assert.deepEqual(await runTick(live, deps()), { status: "done" });
      assert.equal(fake.pulls(), pulls + 1, code);
      const view = (await run("source_get", { id: source }, owner())).jobs.find((j: Out) => j.kind === "live");
      assert.deepEqual([view.state, view.lastError], ["failed", plainError(code)]);
      assert.ok(!/fake/.test(view.lastError), "never Connect's own message");
    }
  });
});

describe("budget and history limits", () => {
  it("at most 100 pulls a minute across jobs, 25 kept for live reads", () => {
    const b = new CallBudget();
    for (let i = 0; i < 75; i++) assert.equal(b.take("backfill", T0 + i), 0);
    assert.equal(b.take("backfill", T0 + 100), 60_000 - 100, "a history read waits until the oldest call leaves the minute");
    for (let i = 0; i < 25; i++) assert.equal(b.take("live", T0 + 200), 0, "live still has its reserve");
    assert.ok(b.take("live", T0 + 300) > 0);
    assert.equal(b.used, 100);
    assert.ok(b.take("backfill", T0 + 60_000) > 0, "one call left the minute: the history share is still used up");
    assert.equal(b.take("backfill", T0 + 60_100), 0, "the window slides");
  });
  it("a tick over the budget waits without a pull", async () => {
    const { live } = await addSource();
    await startLive(live);
    const full = new CallBudget(1, 0);
    full.take("live", now);
    const pulls = fake.pulls();
    assert.deepEqual(await runTick(live, deps({ budget: full })), { status: "again", afterMs: 60_000 });
    assert.equal(fake.pulls(), pulls);
  });
  it("a history read stops at maxMessages; history true reads backward from the newest row down to since", async () => {
    fake.addAccount({ id: "acc2", service: "gmail", history: true });
    for (let i = 1; i <= 6; i++) fake.post("acc2", { conversation: "C1", id: `h${i}`, text: `old ${i}`, sentAt: T0 - (7 - i) * 60 * MIN });
    const src = (await run("source_add", { account: "acc2", conversations: ["C1"], label: "Mail" }, owner())).source.id;
    const hist = (await run("backfill_start", { source: src, since: new Date(T0 - 4.5 * 60 * MIN).toISOString(), maxMessages: 3 }, owner())).job.id;
    const t1 = await runTick(hist, deps({ pageLimit: 2 }));
    assert.deepEqual(t1, { status: "done" });
    const pull = fake.calls.filter((c) => c.op === "data_pull").at(-1)?.input;
    assert.equal(pull?.direction, "backward");
    assert.deepEqual(ids(src), ["h3", "h4", "h5", "h6"], "newest first, two pages of two, then the limit of 3 was passed");
    assert.deepEqual(one("SELECT state, read_count FROM obs_jobs WHERE id = ?", hist), { state: "done", read_count: 4 });
    // without a limit it ends at `since` (h1, h2 are older) and when Connect says exhausted
    const src2 = (await run("source_add", { account: "acc2", conversations: ["C1"], label: "Mail 2" }, owner())).source.id;
    const hist2 = (await run("backfill_start", { source: src2, since: new Date(T0 - 4.5 * 60 * MIN).toISOString() }, owner())).job.id;
    assert.deepEqual(await runTick(hist2, deps()), { status: "done" });
    assert.deepEqual(ids(src2), ["h3", "h4", "h5", "h6"]);
  });
});

describe("the SDK runner follows obs_jobs", () => {
  it("start enqueues, pause pauses, resume resumes, cancel cancels, source_remove cancels; the tick of a stopped job ends", async () => {
    const { source, live } = await addSource();
    assert.deepEqual(sdk.log, [], "a new source's live job is paused: nothing runs");
    await startLive(live);
    assert.deepEqual(sdk.log, [`enqueue ${LIVE_KIND} {"job":"${live}"}`]);
    assert.equal(one("SELECT sdk_job_id FROM obs_jobs WHERE id = ?", live).sdk_job_id, "sdkjob1");
    await run("job_pause", { jobId: live }, ctxFor(db, { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout" }, { jobs: sdk }));
    await run("job_control", { id: live, action: "resume" }, owner());
    const hist = (await run("backfill_start", { source, since: new Date(T0 - 60 * MIN).toISOString() }, owner())).job.id;
    await run("job_control", { id: hist, action: "cancel" }, owner());
    await run("source_remove", { id: source }, owner());
    assert.deepEqual(sdk.log, [`enqueue ${LIVE_KIND} {"job":"${live}"}`, "pause sdkjob1", "resume sdkjob1", `enqueue ${BACKFILL_KIND} {"job":"${hist}"}`, "cancel sdkjob2", "cancel sdkjob1"]);
    assert.deepEqual(await runTick(live, deps()), { status: "done" }, "the job is gone: the run ends");
  });
  it("after a restart every active job has an SDK job again; one the SDK gave up on is failed visibly", async () => {
    const { live } = await addSource();
    await startLive(live);
    const { live: other } = await addSource({ label: "Other" });
    await startLive(other);
    (sdk.jobs.get("sdkjob1") as { status: string }).status = "failed";
    sdk.jobs.delete("sdkjob2");
    reconcileJobs(sdk.api, db, now);
    assert.deepEqual(one("SELECT state, error_code FROM obs_jobs WHERE id = ?", live), { state: "failed", error_code: "job_crashed" });
    assert.equal(one("SELECT sdk_job_id FROM obs_jobs WHERE id = ?", other).sdk_job_id, "sdkjob3");
    assert.equal(jobRow(db, other)?.state, "queued");
  });
  it("the job spec runs a tick with the job ctx (callApp, checkpoint, slice pause)", async () => {
    const { live } = await addSource();
    await startLive(live);
    post("m1", "via the SDK ctx", T0 + 1000);
    let paused = true;
    const ctx = {
      db,
      callApp: fake.callApp,
      companionTargets: () => ["connect"],
      checkpoint: (_s: unknown, w: (d: Db) => unknown) => db.transaction(() => w(db)),
      paused: () => ({ workspace: false, instance: paused, agent: false }),
      signal: new AbortController().signal,
      statusChanged() {},
    } as unknown as JobContext;
    assert.deepEqual(await jobSpec.run({ job: live }, ctx), { status: "again", afterMs: PAUSE_RECHECK_MS });
    paused = false;
    assert.deepEqual(await jobSpec.run({ job: live }, ctx), { status: "again", afterMs: 60_000 });
    assert.equal(one("SELECT text FROM obs_messages WHERE provider_msg_id = 'm1'").text, "via the SDK ctx");
    assert.deepEqual(await jobSpec.run({ nope: true }, ctx), { status: "done" });
    assert.ok(definition.jobs?.[LIVE_KIND] === jobSpec && definition.jobs?.[BACKFILL_KIND] === jobSpec);
  });
});
