// A record held as a possible secret (suspect_secret): its thread subject and author handle never reach an answer (they can carry the
// token itself), and delivering it AS IT IS needs the owner's explicit `acknowledged: true` on the server, not only a UI tick.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { classifyMeta } from "../src/classify.ts";
import { applyRouting } from "../src/pipeline.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { ingestRecord, seedDelivery, seedMessage, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
/** A string that LOOKS like a key, made at run time: no secret-shaped literal sits in this file. */
const looksLikeKey = (): string => ["Zq8", "Lm4Vx7", "Rt1Yb6", "Wp2KhN9"].join("");

let db: Db;
const O = () => ctxFor(db, OWNER);
beforeEach(async () => {
  db = migratedDb();
  setClock(() => Date.UTC(2026, 9, 17, 12, 0, 0));
  await start(db);
});

/** A held record whose subject, author handle and message thread carry the token; the message text does not. */
function held(extra: { thread?: string | null } = {}): { src: string; rec: string; token: string } {
  const token = looksLikeKey();
  const src = seedSource(db);
  const rec = seedRecord(db, src, { state: "review", thread: extra.thread === undefined ? `Re: key ${token}` : extra.thread, pii: { suspect_secret: 1 } });
  seedMessage(db, src, { record: rec, text: "please rotate it next week", author: `slack:${token}`, thread: `Re: key ${token}` });
  return { src, rec, token };
}

describe("subject and author of a possible secret", () => {
  it("never appear in an answer the UI reads: review_list, review_get, records_list, record_get, deliveries_list", async () => {
    const { rec, token } = held();
    const done = seedRecord(db, seedSource(db), { state: "approved" });
    seedDelivery(db, done, { status: "sent" });
    const answers = [await run("review_list", {}, O()), await run("review_get", { id: rec }, O()), await run("records_list", {}, O()), await run("record_get", { id: rec }, O()), await run("deliveries_list", {}, O())];
    for (const a of answers) assert.ok(!JSON.stringify(a).includes(token), "the token is not in the answer");
    const detail = (await run("review_get", { id: rec }, O())).record;
    assert.equal(detail.thread, null);
    assert.deepEqual([detail.messages[0].thread, detail.messages[0].author, detail.messages[0].authorKind], [null, "", "person"]);
    assert.equal(detail.messages[0].text, "please rotate it next week", "the text itself is still shown to the owner");
    assert.equal(detail.possibleSecret, true);
  });
  it("a record that is not a possible secret keeps its subject and author", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "review", thread: "Invoice question", pii: { email: 1 } });
    seedMessage(db, src, { record: rec, text: "hi", author: "email:anna@example.com", thread: "Invoice question" });
    const detail = (await run("review_get", { id: rec }, O())).record;
    assert.deepEqual([detail.thread, detail.messages[0].author, detail.messages[0].thread], ["Invoice question", "email:anna@example.com", "Invoice question"]);
  });
});

describe("review_decide acknowledged", () => {
  const decide = (rec: string, extra: Record<string, unknown>) => run("review_decide", { recordId: rec, destination: "knowledge", ...extra }, O());
  const refusal = (e: { code?: string; httpStatus?: number }) => e.code === "acknowledgement_required" && e.httpStatus === 400;

  it("refuses deliver as is without it (or with false) and changes nothing", async () => {
    const { rec } = held();
    await assert.rejects(decide(rec, { decision: "deliver" }), refusal);
    await assert.rejects(decide(rec, { decision: "deliver", acknowledged: false }), refusal);
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "review");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
  });
  it("delivers as is with acknowledged: true", async () => {
    const { rec } = held();
    await decide(rec, { decision: "deliver", acknowledged: true });
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "approved");
  });
  it("deliver redacted, drop and keep need no acknowledgement", async () => {
    const a = held();
    await decide(a.rec, { decision: "deliver_redacted" });
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(a.rec)?.state, "approved");
    const b = held();
    await run("review_decide", { recordId: b.rec, decision: "drop" }, O());
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(b.rec)?.state, "dropped");
  });
  it("a record that is not a possible secret needs no acknowledgement", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "review", pii: { email: 1 }, withText: true });
    await decide(rec, { decision: "deliver" });
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "approved");
  });
  it("a recognised secret is still drop only, whatever the acknowledgement says", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "review", secret: true, pii: { secret: 1, suspect_secret: 1 }, withText: true });
    await assert.rejects(decide(rec, { decision: "deliver", acknowledged: true }), (e: { code?: string }) => e.code === "secret_drop_only");
  });
});

describe("classifyMeta on a normalised copy (F1)", () => {
  const fullwidth = (s: string) => [...s].map((c) => (/[!-~]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
  const zeroWidth = (s: string) => [...s].join("​");
  const mixed = (s: string) => s.replace(/x/g, "х").replace(/p/g, "р").replace(/o/g, "о").replace(/a/g, "а");
  const subject = (t: string) => `Re: key ${t}`;

  it("finds the plain token (the baseline), and the same token in full-width, zero-width and mixed-script form", () => {
    const t = looksLikeKey();
    assert.ok(classifyMeta([subject(t)]).suspect > 0, "baseline");
    for (const [name, form] of [["full-width", fullwidth(t)], ["zero-width", zeroWidth(t)], ["mixed script", mixed(t)]] as const) {
      assert.ok(classifyMeta([subject(form)]).suspect > 0, `${name} subject`);
      assert.ok(classifyMeta([null, form]).suspect > 0, `${name} author handle`);
    }
  });
  it("does not fire on a plain subject, with or without the odd characters", () => {
    for (const v of ["Invoice question from M. Horak", fullwidth("Lunch on Friday?"), zeroWidth("Hello there"), "Re: opening hours"]) assert.equal(classifyMeta([v]).suspect, 0, v);
  });
  it("a record whose subject hides the token that way is held as a possible secret after routing", () => {
    const src = seedSource(db);
    const rec = ingestRecord(db, src, ["hello"], Date.UTC(2026, 9, 17, 11, 0, 0), { thread: `Re: key ${fullwidth(looksLikeKey())}` });
    applyRouting(db, rec, Date.UTC(2026, 9, 17, 11, 5, 0));
    const row = db.prepare("SELECT pii_json, state FROM obs_records WHERE id = ?").get(rec);
    assert.ok(Number(JSON.parse(String(row?.pii_json)).suspect_secret) > 0);
    assert.equal(row?.state, "review");
  });
});

describe("a record that is not routed yet shows no subject or author (F2)", () => {
  it("records_list and record_get right after storeMessage, BEFORE applyRouting, carry neither", async () => {
    const token = looksLikeKey();
    const src = seedSource(db);
    const rec = ingestRecord(db, src, ["see you"], Date.UTC(2026, 9, 17, 11, 0, 0), { thread: `Re: key ${token}`, author: `slack:${token}` });
    const state = String(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state);
    assert.ok(!["review", "approved", "delivered", "dropped"].includes(state), `not routed yet (${state})`);
    for (const a of [await run("records_list", {}, O()), await run("record_get", { id: rec }, O())]) assert.ok(!JSON.stringify(a).includes(token), "the token is not in the answer");
    const detail = (await run("record_get", { id: rec }, O())).record;
    assert.deepEqual([detail.thread, detail.messages[0].thread, detail.messages[0].author], [null, null, ""]);
    // once routed (a plain record) the subject shows again (the ingest helper puts every record in thread "t1")
    const plain = ingestRecord(db, src, ["hello"], Date.UTC(2026, 9, 17, 12, 0, 0));
    applyRouting(db, plain, Date.UTC(2026, 9, 17, 12, 5, 0));
    assert.equal((await run("record_get", { id: plain }, O())).record.thread, "t1");
  });
});

describe("review_decide revision (F4)", () => {
  it("a decision on an older revision answers 409 revision_changed and changes nothing; the current revision, or none, is accepted", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "review", pii: { email: 1 }, withText: true, revision: 1 });
    const read = (await run("review_get", { id: rec }, O())).record.revision;
    assert.equal(read, 1);
    // an edit lands between the read and the decision
    db.prepare("UPDATE obs_records SET revision = 2 WHERE id = ?").run(rec);
    await assert.rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge", revision: read }, O()), (e: { code?: string; httpStatus?: number }) => e.code === "revision_changed" && e.httpStatus === 409);
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "review");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    await run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge", revision: 2 }, O());
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "approved");
  });
  it("drop is refused on a stale revision too", async () => {
    const src = seedSource(db);
    const rec = seedRecord(db, src, { state: "review", revision: 3 });
    await assert.rejects(run("review_decide", { recordId: rec, decision: "drop", revision: 2 }, O()), (e: { code?: string }) => e.code === "revision_changed");
  });
});
