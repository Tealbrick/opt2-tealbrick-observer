// Owner ops on sources and jobs, and the Connect-dependent ops (connect_unavailable until Connect offers data_pull).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, setClock } from "../src/app.ts";
import { CONNECT_UNAVAILABLE_MESSAGE, type ConnectPort, setConnectFactory } from "../src/connect.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { seedDelivery, seedJob, seedMessage, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string, status?: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => {
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });
const count = (db: Db, table: string): number => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c);

let db: Db;
let now: number;
const O = (opts = {}) => ctxFor(db, OWNER, opts);

beforeEach(async () => {
  db = migratedDb();
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  setConnectFactory(null);
  await start(db);
});
afterEach(() => setConnectFactory(null));

describe("Connect-dependent ops without Connect (R3 missing)", () => {
  const MSG = "Observer needs Connect with shared read access (data_pull). Connect does not offer it yet.";
  it("the refusal text is the agreed one", () => {
    assert.equal(CONNECT_UNAVAILABLE_MESSAGE, MSG);
  });
  it("sources_available answers an empty list with connectMissing instead of failing", async () => {
    assert.deepEqual(await run("sources_available", {}, O()), { accounts: [], connectMissing: true });
  });
  it("source_add, backfill_estimate and backfill_start answer connect_unavailable (409) and change nothing", async () => {
    const src = seedSource(db);
    const inputs: [keyof typeof handlers, unknown][] = [
      ["source_add", { account: "acc_gmail_1", conversations: ["inbox"], label: "Mail" }],
      ["backfill_estimate", { source: src, since: "2026-01-01T00:00:00Z" }],
      ["backfill_start", { source: src, since: "2026-01-01T00:00:00Z" }],
    ];
    for (const [opId, input] of inputs) {
      await assert.rejects(run(opId, input, O()), (e: { code?: string; httpStatus?: number; message?: string }) => {
        assert.deepEqual([e.code, e.httpStatus, e.message], ["connect_unavailable", 409, MSG], opId);
        return true;
      });
    }
    assert.equal(count(db, "obs_sources"), 1);
    assert.equal(count(db, "obs_jobs"), 0);
  });
  it("a slice that names Connect is not enough while the manifest has no Connect companion (both gates must hold)", async () => {
    const ctx = O({ targets: ["connect", "knowledge"] });
    assert.deepEqual(await run("sources_available", {}, ctx), { accounts: [], connectMissing: true });
    await rejects(run("source_add", { account: "a", conversations: ["c"], label: "x" }, ctx), "connect_unavailable", 409);
  });
});

/** A fake Connect for the path S2 will fill in: one Gmail account (history) and one Telegram bot (live only). */
const FAKE: ConnectPort = {
  async accounts() {
    return [
      { id: "acc_gmail_1", kind: "gmail", label: "work@example.com", historyCapable: true, conversations: [{ id: "inbox", title: "Inbox", estimate: 1200 }, { id: "projects", title: "Projects", estimate: 80 }] },
      { id: "acc_tg_1", kind: "telegram", label: "bot", historyCapable: false, conversations: [{ id: "grp1", title: "Team", estimate: null }] },
    ];
  },
  async estimate(q) {
    return { messages: q.conversations.length * 100, records: q.conversations.length * 10, durationS: 60, providerNote: null };
  },
};

describe("with a Connect port (the S2 path)", () => {
  beforeEach(() => setConnectFactory(() => FAKE));
  it("sources_available lists the shared accounts", async () => {
    const out = await run("sources_available", {}, O());
    assert.equal(out.connectMissing, false);
    assert.deepEqual(
      out.accounts.map((a: Out) => a.id),
      ["acc_gmail_1", "acc_tg_1"],
    );
  });
  it("source_add creates the source with its live job PAUSED (live watching is off until Start)", async () => {
    const out = await run("source_add", { account: "acc_gmail_1", conversations: ["inbox", "inbox", "projects"], label: " Work mail ", exclude: { domains: ["spam.example"] }, liveIntervalS: 120 }, O());
    assert.match(out.source.id, /^src_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(
      { label: out.source.label, kind: out.source.kind, account: out.source.account, conversations: out.source.conversations, live: out.source.live, history: out.source.history },
      { label: "Work mail", kind: "gmail", account: "acc_gmail_1", conversations: ["inbox", "projects"], live: { state: "paused", lastReadAt: null, nextAt: null }, history: { state: "none", done: 0, total: null, since: null } },
    );
    const job = db.prepare("SELECT kind, state, paused_by FROM obs_jobs WHERE source_id = ?").all(out.source.id).map((r) => ({ ...r }));
    assert.deepEqual(job, [{ kind: "live", state: "paused", paused_by: null }]);
    const row = db.prepare("SELECT live_interval_s, exclude_json, history_capable FROM obs_sources WHERE id = ?").get(out.source.id);
    assert.deepEqual([row?.live_interval_s, row?.exclude_json, row?.history_capable], [120, '{"senders":[],"domains":["spam.example"]}', 1]);
  });
  it("source_add refuses an account that is not shared, a conversation it does not have, an empty list and a blank label", async () => {
    await rejects(run("source_add", { account: "acc_other", conversations: ["inbox"], label: "x" }, O()), "account_not_shared", 404);
    await rejects(run("source_add", { account: "acc_gmail_1", conversations: ["inbox", "nope"], label: "x" }, O()), "conversation_unknown", 400);
    await rejects(run("source_add", { account: "acc_gmail_1", conversations: [], label: "x" }, O()), "conversations_empty", 400);
    await rejects(run("source_add", { account: "acc_gmail_1", conversations: ["inbox"], label: "  " }, O()), "label_empty", 400);
    assert.equal(count(db, "obs_sources"), 0);
  });
  it("backfill_estimate passes the source's conversations to Connect and checks the date range", async () => {
    const src = seedSource(db, { conversations: ["inbox", "projects"] });
    assert.deepEqual(await run("backfill_estimate", { source: src, since: "2026-01-01T00:00:00Z" }, O()), { messages: 200, records: 20, durationS: 60, providerNote: null });
    await rejects(run("backfill_estimate", { source: src, since: "2026-01-01T00:00:00Z", until: "2025-12-01T00:00:00Z" }, O()), "range_invalid", 400);
    await rejects(run("backfill_estimate", { source: src, since: "yesterday-ish" }, O()), "invalid_date", 400);
    await rejects(run("backfill_estimate", { source: "src_01J00000000000000000000000", since: "2026-01-01T00:00:00Z" }, O()), "not_found", 404);
  });
  it("backfill_start queues one history job with the default and the given message limit", async () => {
    const src = seedSource(db);
    const a = await run("backfill_start", { source: src, since: "2026-01-01T00:00:00Z" }, O());
    assert.deepEqual([a.job.kind, a.job.state, a.job.source], ["backfill", "queued", src]);
    assert.equal(db.prepare("SELECT max_messages AS m FROM obs_jobs WHERE id = ?").get(a.job.id)?.m, 50_000);
    await run("job_control", { id: a.job.id, action: "cancel" }, O());
    const b = await run("backfill_start", { source: src, since: "2026-01-01T00:00:00Z", maxMessages: 500 }, O());
    assert.equal(db.prepare("SELECT max_messages AS m FROM obs_jobs WHERE id = ?").get(b.job.id)?.m, 500);
  });
  it("backfill_start refuses: more than 3 years back, a live-only source, a second active history job, a bad range", async () => {
    const src = seedSource(db);
    await run("backfill_start", { source: src, since: "2023-10-17T12:00:00Z" }, O()); // exactly 3 years: fine
    await rejects(run("backfill_start", { source: src, since: "2023-10-17T11:59:59Z" }, O()), "since_too_old", 400);
    await rejects(run("backfill_start", { source: src, since: "2026-01-01T00:00:00Z" }, O()), "backfill_active", 409);
    const tg = seedSource(db, { kind: "telegram", historyCapable: false });
    await rejects(run("backfill_start", { source: tg, since: "2026-01-01T00:00:00Z" }, O()), "history_unsupported", 409);
    const other = seedSource(db);
    await rejects(run("backfill_start", { source: other, since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z" }, O()), "range_invalid", 400);
    assert.equal(count(db, "obs_jobs"), 1);
  });
});

describe("sources_list, source_get", () => {
  it("lists sources with live and history state, and source_get adds its jobs newest first", async () => {
    const src = seedSource(db, { id: "src_01J0000000000000000000AAAA", conversations: ["inbox"] });
    const live = seedJob(db, src, { kind: "live", state: "paused" });
    const hist = seedJob(db, src, { kind: "backfill", state: "failed", createdAt: Date.UTC(2026, 9, 5), failures: 5, lastError: "rate_limited", readCount: 42, recordCount: 4 });
    const list = await run("sources_list", {}, O());
    assert.equal(list.sources.length, 1);
    assert.deepEqual([list.sources[0].live.state, list.sources[0].history.state, list.sources[0].history.done], ["paused", "failed", 42]);
    const got = await run("source_get", { id: src }, O());
    assert.deepEqual(
      got.jobs.map((j: Out) => [j.id, j.kind, j.state]),
      [
        [hist, "backfill", "failed"],
        [live, "live", "paused"],
      ],
    );
    assert.deepEqual(got.jobs[0].counts, { read: 42, records: 4, failures: 5 });
    assert.equal(got.jobs[0].lastError, "rate_limited");
  });
  it("source_get answers not_found for a missing source", async () => {
    await rejects(run("source_get", { id: "src_01J00000000000000000000000" }, O()), "not_found", 404);
  });
});

describe("source_update", () => {
  it("changes label, interval and retention (null clears it); narrowing the conversations deletes their stored messages at once", async () => {
    const src = seedSource(db, { conversations: ["inbox", "projects"], retentionDays: 10 });
    seedMessage(db, src, { conversation: "inbox", id: "m1" });
    seedMessage(db, src, { conversation: "projects", id: "m2" });
    const out = await run("source_update", { id: src, label: "Renamed", liveIntervalS: 300, retentionDays: null, conversations: ["inbox"] }, O());
    assert.deepEqual([out.source.label, out.source.conversations], ["Renamed", ["inbox"]]);
    const row = db.prepare("SELECT live_interval_s, retention_days FROM obs_sources WHERE id = ?").get(src);
    assert.deepEqual([row?.live_interval_s, row?.retention_days], [300, null]);
    assert.deepEqual(
      db.prepare("SELECT provider_msg_id AS id FROM obs_messages WHERE source_id = ?").all(src).map((r) => r.id),
      ["m1"],
    );
  });
  it("widening or leaving the conversations alone deletes nothing", async () => {
    const src = seedSource(db, { conversations: ["inbox"] });
    seedMessage(db, src, { conversation: "inbox", id: "m1" });
    await run("source_update", { id: src, conversations: ["inbox", "projects"] }, O());
    await run("source_update", { id: src, label: "Same" }, O());
    assert.equal(count(db, "obs_messages"), 1);
  });
  it("new exclusions delete the stored messages of those senders and domains, and keep everyone else's", async () => {
    const src = seedSource(db);
    seedMessage(db, src, { id: "a", author: "email:Anna@Example.com" });
    seedMessage(db, src, { id: "b", author: "email:bob@spam.example" });
    seedMessage(db, src, { id: "c", author: "email:carol@fine.example" });
    seedMessage(db, src, { id: "d", author: "email:dan@notspam.example" });
    await run("source_update", { id: src, exclude: { senders: ["anna@example.com"], domains: ["spam.example"] } }, O());
    assert.deepEqual(
      db.prepare("SELECT provider_msg_id AS id FROM obs_messages ORDER BY 1").all().map((r) => r.id),
      ["c", "d"],
    );
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT exclude_json AS e FROM obs_sources WHERE id = ?").get(src)?.e)), { senders: ["anna@example.com"], domains: ["spam.example"] });
  });
  it("compares exclusions the JS way: ÄRGER@Beispiel.de is excluded by ärger@beispiel.de and by the domain BEISPIEL.DE, also in another Unicode form", async () => {
    const src = seedSource(db);
    seedMessage(db, src, { id: "upper", author: "email:ÄRGER@Beispiel.de" });
    seedMessage(db, src, { id: "decomposed", author: "email:A\u0308rger@beispiel.de" }); // A + combining diaeresis
    seedMessage(db, src, { id: "domain", author: "email:other@BEISPIEL.DE" });
    seedMessage(db, src, { id: "keep", author: "email:bob@beispiel.com" });
    seedMessage(db, src, { id: "keep2", author: "email:bob@sub.beispiel.de" });
    await run("source_update", { id: src, exclude: { senders: ["ärger@beispiel.de"], domains: ["BEISPIEL.DE"] } }, O());
    assert.deepEqual(
      db.prepare("SELECT provider_msg_id AS id FROM obs_messages ORDER BY 1").all().map((r) => r.id),
      ["keep", "keep2"],
    );
    // and the other direction: the owner types the capitals, the message is stored in lower case
    const src2 = seedSource(db);
    seedMessage(db, src2, { id: "lower", author: "email:ärger@beispiel.de" });
    await run("source_update", { id: src2, exclude: { senders: ["ÄRGER@Beispiel.de"] } }, O());
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages WHERE source_id = ?").get(src2)?.c, 0);
  });
  it("excluding an email also hides its '+tag' and dotted forms (and googlemail); another address or domain stays", async () => {
    const src = seedSource(db);
    for (const [id, who] of [["tag", "email:john.smith+news@gmail.com"], ["dots", "email:j.o.h.n.smith@googlemail.com"], ["plain", "email:johnsmith@gmail.com"], ["other", "email:john@gmail.com"], ["slack", "slack:johnsmith@gmail.com"]] as const) {
      seedMessage(db, src, { id, author: who });
    }
    await run("source_update", { id: src, exclude: { senders: ["johnsmith@gmail.com"], domains: [] } }, O());
    assert.deepEqual(
      db.prepare("SELECT provider_msg_id AS id FROM obs_messages ORDER BY 1").all().map((r) => r.id),
      ["other"],
      "a bare address fits every channel; only john@gmail.com is a different mailbox",
    );
  });
  it("no text of an excluded sender survives anywhere: messages, records, deliveries (unsent deleted, sent emptied), flags", async () => {
    const src = seedSource(db);
    const SECRET = "ANNA-PRIVATE-WORDS";
    const input = JSON.stringify({ title: "doc", body: `${SECRET} and bob's words` });
    // R1: only Anna → the record goes, with its deliveries and flag
    const r1 = seedRecord(db, src, { state: "approved", thread: `Re: ${SECRET}` });
    seedMessage(db, src, { id: "a1", author: "email:anna@example.com", text: SECRET, record: r1 });
    const d1 = seedDelivery(db, r1, { status: "pending" });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id = ?").run(input, d1);
    // R2: Anna and Bob → stays, new revision, unsent delivery gone, sent delivery keeps the ledger but not the input; approved → review
    const r2 = seedRecord(db, src, { state: "approved", revision: 1 });
    seedMessage(db, src, { id: "a2", author: "email:anna@example.com", text: SECRET, record: r2 });
    seedMessage(db, src, { id: "b2", author: "email:bob@example.com", text: "bob only", record: r2 });
    const d2 = seedDelivery(db, r2, { status: "failed", destination: "kanban" });
    const d3 = seedDelivery(db, r2, { status: "sent", destination: "knowledge", targetRef: "doc_2" });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id IN (?, ?)").run(input, d2, d3);
    // R3: only Bob → untouched
    const r3 = seedRecord(db, src, { state: "approved" });
    seedMessage(db, src, { id: "b3", author: "email:bob@example.com", text: "bob again", record: r3 });
    const d4 = seedDelivery(db, r3, { status: "pending" });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id = ?").run(input.replace(SECRET, "bob"), d4);
    db.prepare("INSERT INTO obs_flags (id, record_id, by_type, by_id, reason, created_at) VALUES ('flg_1', ?, 'agent', 'agt_x', ?, 1)").run(r1, `about ${SECRET}`);

    const ctx = O();
    await run("source_update", { id: src, exclude: { senders: ["Anna@example.com"] } }, ctx);
    assert.equal(ctx.statusChanges, 1);

    const dump = JSON.stringify(["obs_messages", "obs_records", "obs_deliveries", "obs_flags"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    assert.ok(!dump.includes(SECRET), "the excluded sender's text is gone from every table");
    assert.deepEqual(db.prepare("SELECT id FROM obs_records ORDER BY id").all().map((r) => r.id).sort(), [r2, r3].sort());
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_flags").get()?.c, 0);
    const rec2 = db.prepare("SELECT state, revision FROM obs_records WHERE id = ?").get(r2);
    assert.deepEqual([rec2?.state, rec2?.revision], ["review", 2]);
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(r3)?.state, "approved");
    const left = db.prepare("SELECT id, status, input_json FROM obs_deliveries ORDER BY id").all().map((r) => ({ ...r }));
    assert.deepEqual(left.map((d) => [d.id, d.status, d.input_json === "{}"]).sort(), [[d3, "sent", true], [d4, "pending", false]].sort());
    assert.deepEqual(db.prepare("SELECT provider_msg_id AS id FROM obs_messages ORDER BY 1").all().map((r) => r.id), ["b2", "b3"]);
  });
  it("narrowing the conversations does the same cleaning; widening or an unchanged list cleans nothing", async () => {
    const src = seedSource(db, { conversations: ["inbox", "hr"] });
    const rec = seedRecord(db, src, { state: "approved" });
    seedMessage(db, src, { id: "h1", conversation: "hr", record: rec, text: "HR-PRIVATE" });
    seedDelivery(db, rec, { status: "pending" });
    await run("source_update", { id: src, conversations: ["inbox", "hr", "ops"] }, O());
    await run("source_update", { id: src, label: "Same" }, O());
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 1);
    await run("source_update", { id: src, conversations: ["inbox"] }, O());
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_records").get()?.c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 0);
  });
  it("refuses an empty conversation list (conversations_empty, 400) and changes nothing", async () => {
    const src = seedSource(db, { conversations: ["inbox"] });
    seedMessage(db, src, { id: "m1" });
    await rejects(run("source_update", { id: src, conversations: [] }, O()), "conversations_empty", 400);
    assert.equal(db.prepare("SELECT conversations_json AS c FROM obs_sources WHERE id = ?").get(src)?.c, '["inbox"]');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 1);
    assert.deepEqual((await run("source_update", { id: src, conversations: ["inbox"] }, O())).source.conversations, ["inbox"], "a non-empty list works");
  });
  it("a FULL new exclude (both lists) replaces a damaged exclude_json; a partial one does not (it needs the stored one)", async () => {
    for (const bad of ["{not json", "[]", '{"senders":"anna","domains":[]}', '{"senders":[]}']) {
      const src = seedSource(db);
      db.prepare("UPDATE obs_sources SET exclude_json = ? WHERE id = ?").run(bad, src);
      await rejects(run("source_update", { id: src, exclude: { senders: ["a@b.example"] } }, O()), "exclude_corrupt", 500);
      await rejects(run("source_update", { id: src, exclude: { domains: ["b.example"] } }, O()), "exclude_corrupt", 500);
      await run("source_update", { id: src, exclude: { senders: ["a@b.example"], domains: [] } }, O());
      assert.equal(db.prepare("SELECT exclude_json AS e FROM obs_sources WHERE id = ?").get(src)?.e, '{"senders":["a@b.example"],"domains":[]}', bad);
      await run("source_update", { id: src, label: "readable again" }, O());
    }
  });
  it("normalises exclusions on write: trim, NFC + lower case, an @domain in senders becomes a domain, no empties or duplicates", async () => {
    const src = seedSource(db);
    seedMessage(db, src, { id: "spam", author: "email:x@spam.example" });
    seedMessage(db, src, { id: "anna", author: "email:ärger@beispiel.de" });
    seedMessage(db, src, { id: "keep", author: "email:ok@fine.example" });
    await run("source_update", { id: src, exclude: { senders: ["  ÄRGER@Beispiel.DE ", "@Spam.Example", "", "   ", "ärger@beispiel.de"], domains: [" @Foo.COM ", "foo.com", "A\u0308.example"] } }, O());
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT exclude_json AS e FROM obs_sources WHERE id = ?").get(src)?.e)), {
      senders: ["ärger@beispiel.de"],
      domains: ["spam.example", "foo.com", "ä.example"],
    });
    assert.deepEqual(db.prepare("SELECT provider_msg_id AS id FROM obs_messages").all().map((r) => r.id), ["keep"], "the moved @domain and the capitals both took effect");
    // a partial update keeps the stored (normalised) other list
    await run("source_update", { id: src, exclude: { domains: ["Other.Example"] } }, O());
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT exclude_json AS e FROM obs_sources WHERE id = ?").get(src)?.e)), { senders: ["ärger@beispiel.de"], domains: ["other.example"] });
  });
  it("source_add stores normalised exclusions too", async () => {
    setConnectFactory(() => FAKE);
    const out = await run("source_add", { account: "acc_gmail_1", conversations: ["inbox"], label: "Mail", exclude: { senders: [" Boss@X.COM", "@Ads.Example"], domains: ["News.Example "] } }, O());
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT exclude_json AS e FROM obs_sources WHERE id = ?").get(out.source.id)?.e)), { senders: ["boss@x.com"], domains: ["ads.example", "news.example"] });
  });
  it("narrowing nulls the thread subject of every record that lost a message (and only those)", async () => {
    const src = seedSource(db);
    const touched = seedRecord(db, src, { state: "review", thread: "Re: salary of Anna" });
    seedMessage(db, src, { id: "a", author: "email:anna@example.com", record: touched, thread: "Re: salary of Anna" });
    seedMessage(db, src, { id: "b", author: "email:bob@example.com", record: touched, thread: "Re: salary of Anna" });
    const untouched = seedRecord(db, src, { state: "review", thread: "lunch plans" });
    seedMessage(db, src, { id: "c", author: "email:bob@example.com", record: untouched, thread: "lunch plans" });
    await run("source_update", { id: src, exclude: { senders: ["anna@example.com"], domains: [] } }, O());
    assert.equal(db.prepare("SELECT thread FROM obs_records WHERE id = ?").get(touched)?.thread, null);
    assert.equal(db.prepare("SELECT thread FROM obs_records WHERE id = ?").get(untouched)?.thread, "lunch plans");
  });
  it("a damaged exclude_json fails closed (exclude_corrupt, 500) instead of meaning 'exclude nobody'", async () => {
    for (const bad of ["{not json", "[]", "null", '{"senders":"anna","domains":[]}', '{"senders":[],"domains":[1]}', '{"senders":[]}']) {
      const src = seedSource(db);
      db.prepare("UPDATE obs_sources SET exclude_json = ? WHERE id = ?").run(bad, src);
      await rejects(run("source_update", { id: src, label: "x" }, O()), "exclude_corrupt", 500);
      assert.notEqual(db.prepare("SELECT label FROM obs_sources WHERE id = ?").get(src)?.label, "x", `${bad} changed nothing`);
    }
  });
  it("answers not_found for a missing source and label_empty for a blank label", async () => {
    await rejects(run("source_update", { id: "src_01J00000000000000000000000", label: "x" }, O()), "not_found", 404);
    const src = seedSource(db);
    await rejects(run("source_update", { id: src, label: "  " }, O()), "label_empty", 400);
  });
});

describe("source_remove", () => {
  it("deletes stored text and message ids, records, deliveries, flags and jobs of that source only, and returns the count", async () => {
    const a = seedSource(db);
    const b = seedSource(db);
    seedJob(db, a, { state: "running" });
    seedJob(db, a, { kind: "backfill", state: "queued" });
    const jb = seedJob(db, b, { state: "running" });
    const ra = seedRecord(db, a, { state: "delivered" });
    seedDelivery(db, ra, { status: "sent", targetRef: "doc_a" });
    db.prepare("INSERT INTO obs_flags (id, record_id, by_type, by_id, reason, created_at) VALUES ('flg_x', ?, 'agent', 'agt_x', 'r', 1)").run(ra);
    const rb = seedRecord(db, b, { state: "review" });
    seedMessage(db, a, { id: "a1", record: ra });
    seedMessage(db, a, { id: "a2" });
    seedMessage(db, b, { id: "b1", record: rb });
    const ctx = O();
    assert.deepEqual(await run("source_remove", { id: a }, ctx), { removed: true, messagesPurged: 2 });
    assert.equal(ctx.statusChanges, 1);
    for (const t of ["obs_jobs", "obs_messages", "obs_records", "obs_deliveries", "obs_flags"]) {
      const n = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c);
      assert.equal(n, t === "obs_flags" || t === "obs_deliveries" ? 0 : 1, t);
    }
    assert.equal(db.prepare("SELECT id FROM obs_sources").all().length, 1);
    assert.equal(db.prepare("SELECT state FROM obs_jobs WHERE id = ?").get(jb)?.state, "running", "the other source is untouched");
    assert.equal(await definition.pendingCount?.(db), 1);
  });
  it("cancels the jobs inside the same transaction (a failure after the cancel leaves them as they were)", async () => {
    const a = seedSource(db);
    const job = seedJob(db, a, { state: "running" });
    // make the last statement fail: a trigger that refuses to delete the source
    db.exec("CREATE TRIGGER no_delete BEFORE DELETE ON obs_sources BEGIN SELECT RAISE(ABORT, 'nope'); END");
    await assert.rejects(run("source_remove", { id: a }, O()));
    assert.equal(db.prepare("SELECT state FROM obs_jobs WHERE id = ?").get(job)?.state, "running");
  });
  it("answers not_found for a missing source and changes nothing", async () => {
    seedSource(db);
    await rejects(run("source_remove", { id: "src_01J00000000000000000000000" }, O()), "not_found", 404);
    assert.equal(count(db, "obs_sources"), 1);
  });
  it("the hold text names the source and how many messages go", async () => {
    const a = seedSource(db, { label: "Work mail" });
    seedMessage(db, a, { id: "a1" });
    assert.match(String(handlers.source_remove.holdView?.({ id: a } as never)), /Work mail.*delete 1 stored message/);
  });
});

describe("jobs and the job state machine", () => {
  const states = ["queued", "running", "waiting", "paused", "done", "failed", "cancelled"] as const;
  const allowed: Record<string, readonly string[]> = {
    start: ["paused:never"],
    resume: ["paused:by", "failed"],
    pause: ["queued", "running", "waiting", "paused:by", "paused:never"],
    cancel: ["queued", "running", "waiting", "paused:by", "paused:never", "failed", "cancelled"],
  };
  const target: Record<string, string> = { start: "queued", resume: "queued", pause: "paused", cancel: "cancelled" };

  it("every action from every state: allowed ones move to the right state, the rest answer job_state_invalid (409) and change nothing", async () => {
    const src = seedSource(db);
    for (const action of ["start", "pause", "resume", "cancel"] as const) {
      for (const state of states) {
        for (const pausedBy of state === "paused" ? [null, OWNER.id] : [null]) {
          const tag = state === "paused" ? `paused:${pausedBy ? "by" : "never"}` : state;
          const id = seedJob(db, src, { state, pausedBy, failures: state === "failed" ? 5 : 0, lastError: state === "failed" ? "boom" : null, kind: "backfill" });
          const call = run("job_control", { id, action }, O());
          if (allowed[action]?.includes(tag)) {
            const out = await call;
            assert.equal(out.job.state, target[action], `${action} from ${tag}`);
          } else {
            await rejects(call, "job_state_invalid", 409);
            assert.equal(db.prepare("SELECT state FROM obs_jobs WHERE id = ?").get(id)?.state, state, `${action} from ${tag} changed nothing`);
          }
        }
      }
    }
  });
  it("Start moves a new (never paused) live job to queued; Pause by the owner is remembered so Resume works; Start is not Resume", async () => {
    const src = seedSource(db);
    const id = seedJob(db, src, { state: "paused" });
    await rejects(run("job_control", { id, action: "resume" }, O()), "job_state_invalid", 409);
    assert.equal((await run("job_control", { id, action: "start" }, O())).job.state, "queued");
    assert.equal((await run("job_control", { id, action: "pause" }, O())).job.state, "paused");
    assert.equal(db.prepare("SELECT paused_by FROM obs_jobs WHERE id = ?").get(id)?.paused_by, OWNER.id);
    await rejects(run("job_control", { id, action: "start" }, O()), "job_state_invalid", 409);
    const out = await run("job_control", { id, action: "resume" }, O());
    assert.equal(out.job.state, "queued");
    assert.equal(db.prepare("SELECT paused_by FROM obs_jobs WHERE id = ?").get(id)?.paused_by, null);
  });
  it("Resume of a failed job clears the failure count, the error and the retry time", async () => {
    const id = seedJob(db, seedSource(db), { state: "failed", failures: 5, lastError: "rate_limited", retryAt: now + 1000 });
    const out = await run("job_control", { id, action: "resume" }, O());
    assert.deepEqual([out.job.state, out.job.counts.failures, out.job.lastError, out.job.retryAt], ["queued", 0, null, null]);
  });
  it("pause and cancel repeated are quiet no-ops (no status push)", async () => {
    const id = seedJob(db, seedSource(db), { state: "cancelled" });
    const ctx = O();
    assert.equal((await run("job_control", { id, action: "cancel" }, ctx)).job.state, "cancelled");
    assert.equal(ctx.statusChanges, 0);
  });
  it("jobs_list filters by source; job_get returns one job with counts, a clipped last error and the retry time; missing → not_found", async () => {
    const a = seedSource(db);
    const b = seedSource(db);
    seedJob(db, a);
    const jb = seedJob(db, b, { state: "waiting", lastError: "x".repeat(400), retryAt: Date.UTC(2026, 9, 17, 13, 0, 0) });
    assert.equal((await run("jobs_list", {}, O())).jobs.length, 2);
    assert.deepEqual(
      (await run("jobs_list", { source: b }, O())).jobs.map((j: Out) => j.id),
      [jb],
    );
    const job = (await run("job_get", { id: jb }, O())).job;
    assert.equal(job.lastError.length, 280);
    assert.equal(job.retryAt, "2026-10-17T13:00:00.000Z");
    await rejects(run("job_get", { id: "job_nope" }, O()), "not_found", 404);
    await rejects(run("job_control", { id: "job_nope", action: "pause" }, O()), "not_found", 404);
  });
});
