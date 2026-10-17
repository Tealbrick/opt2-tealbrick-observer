// A record held as a possible secret (suspect_secret): its thread subject and author handle never reach an answer (they can carry the
// token itself), and delivering it AS IT IS needs the owner's explicit `acknowledged: true` on the server, not only a UI tick.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { seedDelivery, seedMessage, seedRecord, seedSource } from "./seed.ts";

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
