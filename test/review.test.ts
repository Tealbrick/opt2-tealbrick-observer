// Review, records and deliveries (DESIGN §3.2, §4.1, §5.3). Delivery SENDING is S4: here deciding only writes the outbox row.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, setClock } from "../src/app.ts";
import { decideRecord, PAGE_SIZE, RULE_ZERO_ID, routeRecord } from "../src/store.ts";
import { AGENT_A, ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { seedDelivery, seedMessage, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string, status?: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => {
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });
const row = (db: Db, sql: string, ...a: unknown[]) => {
  const r = db.prepare(sql).get(...a);
  return r ? { ...r } : undefined;
};

let db: Db;
let now: number;
let src: string;
const O = () => ctxFor(db, OWNER);
const DAY = 86_400_000;

beforeEach(async () => {
  db = migratedDb();
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  await start(db);
  src = seedSource(db);
});

describe("review_list, review_get, records_list, record_get", () => {
  it("review_list shows only records in review, newest first, with no message text", async () => {
    const old = seedRecord(db, src, { state: "review", updatedAt: Date.UTC(2026, 9, 1), pii: { email: 2 } });
    const fresh = seedRecord(db, src, { state: "review", updatedAt: Date.UTC(2026, 9, 5) });
    seedRecord(db, src, { state: "delivered" });
    seedMessage(db, src, { record: old, text: "call me on +49 170 1234567" });
    const out = await run("review_list", {}, O());
    assert.deepEqual(out.items.map((r: Out) => r.id), [fresh, old]);
    assert.equal(out.nextCursor, null);
    assert.deepEqual(out.items[1].pii, { email: 2 });
    assert.ok(!JSON.stringify(out).includes("1234567"));
    assert.equal(await definition.pendingCount?.(db), 2);
  });
  it("pages by cursor: 50 per page, no gap, no repeat, ties on the time broken by id", async () => {
    const made: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 5; i++) made.push(seedRecord(db, src, { state: "review", updatedAt: Date.UTC(2026, 9, 1) + Math.floor(i / 2) }));
    const p1 = await run("review_list", {}, O());
    assert.equal(p1.items.length, PAGE_SIZE);
    assert.ok(p1.nextCursor);
    const p2 = await run("review_list", { cursor: p1.nextCursor }, O());
    assert.equal(p2.items.length, 5);
    assert.equal(p2.nextCursor, null);
    const seen = [...p1.items, ...p2.items].map((r: Out) => r.id);
    assert.equal(new Set(seen).size, PAGE_SIZE + 5);
    assert.deepEqual([...seen].sort(), [...made].sort());
    await rejects(run("review_list", { cursor: "garbage" }, O()), "cursor_invalid", 400);
  });
  it("review_get shows the messages with their text and an empty span list (S3 fills the spans); only for a record in review", async () => {
    const rec = seedRecord(db, src, { state: "review", pii: { email: 1 } });
    seedMessage(db, src, { record: rec, id: "m2", sentAt: Date.UTC(2026, 9, 2, 11), text: "second" });
    seedMessage(db, src, { record: rec, id: "m1", sentAt: Date.UTC(2026, 9, 2, 10), text: "first mail me at a@b.example", author: "email:a@b.example" });
    const out = (await run("review_get", { id: rec }, O())).record;
    assert.deepEqual(out.messages.map((m: Out) => [m.id, m.text]), [["m1", "first mail me at a@b.example"], ["m2", "second"]]);
    assert.deepEqual(out.spans, []);
    assert.equal(out.state, "review");
    const done = seedRecord(db, src, { state: "delivered" });
    await rejects(run("review_get", { id: done }, O()), "not_found", 404);
    await rejects(run("review_get", { id: "rec_01J00000000000000000000000" }, O()), "not_found", 404);
  });
  it("text shows only inside the retention: a purged text, a text past its purge time and a provider-deleted message read as null", async () => {
    const rec = seedRecord(db, src, { state: "delivered", textPurgeAt: now + DAY });
    seedMessage(db, src, { record: rec, id: "kept", text: "still here" });
    seedMessage(db, src, { record: rec, id: "purged", text: null });
    seedMessage(db, src, { record: rec, id: "gone", text: "deleted at the source", deleted: true });
    const texts = async () => Object.fromEntries((await run("record_get", { id: rec }, O())).record.messages.map((m: Out) => [m.id, m.text]));
    assert.deepEqual(await texts(), { gone: null, kept: "still here", purged: null });
    now += DAY; // the purge time has come (a purge job may not have run yet: the text is hidden at once)
    assert.deepEqual(await texts(), { gone: null, kept: null, purged: null });
  });
  it("records_list filters by source and state, rejects an unknown state; record_get returns any state or not_found", async () => {
    const other = seedSource(db);
    const a = seedRecord(db, src, { state: "delivered" });
    seedRecord(db, src, { state: "review" });
    seedRecord(db, other, { state: "delivered" });
    assert.equal((await run("records_list", {}, O())).items.length, 3);
    assert.deepEqual((await run("records_list", { source: src, state: "delivered" }, O())).items.map((r: Out) => r.id), [a]);
    await rejects(run("records_list", { state: "bogus" }, O()), "state_invalid", 400);
    assert.equal((await run("record_get", { id: a }, O())).record.id, a);
    await rejects(run("record_get", { id: "rec_01J00000000000000000000000" }, O()), "not_found", 404);
  });
});

describe("review_decide", () => {
  const key = (rec: string, rev: number, dest: string) => `obs_${createHash("sha256").update(JSON.stringify([rec, rev, dest])).digest("hex").slice(0, 40)}`;

  it("deliver and deliver_redacted approve the record and write ONE pending outbox row with the key and the exact decide input", async () => {
    const r1 = seedRecord(db, src, { state: "review", withText: true, revision: 3 });
    const r2 = seedRecord(db, src, { state: "review", withText: true });
    const in1 = { recordId: r1, decision: "deliver", destination: "knowledge" };
    const in2 = { recordId: r2, decision: "deliver_redacted", destination: "inbox" };
    const out = await run("review_decide", in1, O());
    await run("review_decide", in2, O());
    assert.deepEqual([out.record.state, out.record.decidedBy], ["approved", OWNER.id]);
    const d1 = row(db, "SELECT * FROM obs_deliveries WHERE record_id = ?", r1);
    assert.match(String(d1?.id), /^dlv_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(
      [d1?.revision, d1?.destination, d1?.status, d1?.attempts, d1?.idem_key, d1?.input_json, d1?.target_ref],
      [3, "knowledge", "pending", 0, key(r1, 3, "knowledge"), JSON.stringify(in1), null],
    );
    assert.match(String(d1?.idem_key), /^obs_[0-9a-f]{40}$/);
    assert.equal(row(db, "SELECT input_json AS j FROM obs_deliveries WHERE record_id = ?", r2)?.j, JSON.stringify(in2));
    assert.notEqual(key(r1, 3, "knowledge"), key(r1, 4, "knowledge"), "another revision, another key");
    assert.notEqual(key(r1, 3, "knowledge"), key(r1, 3, "kanban"), "another destination, another key");
    assert.equal(await definition.pendingCount?.(db), 0);
  });
  it("drop ends the record, writes no delivery, and sets the text purge time from the retention setting", async () => {
    await run("privacy_set", { textRetentionDays: 7 }, O());
    const rec = seedRecord(db, src, { state: "review", withText: true });
    const out = await run("review_decide", { recordId: rec, decision: "drop" }, O());
    assert.deepEqual([out.record.state, out.record.textPurgeAt], ["dropped", new Date(now + 7 * DAY).toISOString()]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    const rec2 = seedRecord(db, src, { state: "review", withText: true });
    await run("review_decide", { recordId: rec2, decision: "drop", destination: "drop" }, O());
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec2)?.state, "dropped");
  });
  it("a record with a secret can only be dropped (secret_drop_only, 409): deliver and deliver_redacted fail, nothing is written, drop works", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true, secret: true });
    for (const decision of ["deliver", "deliver_redacted"]) {
      await rejects(run("review_decide", { recordId: rec, decision, destination: "knowledge" }, O()), "secret_drop_only", 409);
    }
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec)?.state, "review");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    assert.equal((await run("review_decide", { recordId: rec, decision: "drop" }, O())).record.state, "dropped");
  });
  it("needs a real destination to deliver and no other destination to drop (destination_required / destination_invalid, 400)", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    await rejects(run("review_decide", { recordId: rec, decision: "deliver" }, O()), "destination_required", 400);
    await rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "drop" }, O()), "destination_invalid", 400);
    await rejects(run("review_decide", { recordId: rec, decision: "drop", destination: "knowledge" }, O()), "destination_invalid", 400);
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec)?.state, "review");
  });
  it("answers not_found for a missing record and record_not_waiting (409) for a record that is not in review", async () => {
    await rejects(run("review_decide", { recordId: "rec_01J00000000000000000000000", decision: "drop" }, O()), "not_found", 404);
    for (const state of ["open", "classified", "approved", "delivered", "dropped"]) {
      const rec = seedRecord(db, src, { state });
      await rejects(run("review_decide", { recordId: rec, decision: "drop" }, O()), "record_not_waiting", 409);
    }
  });
  it("one outbox row per (record, revision, destination): deciding again reuses the row whatever its key, a sent row is already_delivered", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    const dlv = seedDelivery(db, rec, { status: "failed", key: "obs_rotated_key_not_the_derived_one" });
    await run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O());
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE record_id = ?").get(rec)?.c, 1, "no second row, although the stored key is not the derived one");
    assert.equal(row(db, "SELECT id FROM obs_deliveries WHERE record_id = ?", rec)?.id, dlv);
    db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(rec);
    db.prepare("UPDATE obs_deliveries SET status = 'sent' WHERE id = ?").run(dlv);
    await rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O()), "already_delivered", 409);
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec)?.state, "review", "the refused decision changed nothing");
    assert.equal((await run("review_decide", { recordId: rec, decision: "deliver", destination: "kanban" }, O())).record.state, "approved", "another destination is a new delivery");
  });
  it("the database refuses a second outbox row for the same (record, revision, destination)", () => {
    const rec = seedRecord(db, src, { state: "approved" });
    seedDelivery(db, rec, { destination: "knowledge", status: "pending" });
    assert.throws(() => seedDelivery(db, rec, { destination: "knowledge", status: "failed" }), /UNIQUE/);
    assert.ok(seedDelivery(db, rec, { destination: "kanban" }), "another destination is fine");
    assert.ok(seedDelivery(db, rec, { destination: "knowledge", revision: 2 }), "another revision is fine");
  });
  it("a new decision wins over a failed one: deliver → fail → deliver_redacted → retry replays the REDACTED input", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    const first = { recordId: rec, decision: "deliver", destination: "knowledge" };
    const second = { recordId: rec, decision: "deliver_redacted", destination: "knowledge" };
    await run("review_decide", first, O());
    const id = String(row(db, "SELECT id FROM obs_deliveries WHERE record_id = ?", rec)?.id);
    db.prepare("UPDATE obs_deliveries SET status = 'failed', attempts = 3, hold_id = 'hld_1', next_at = 99, first_attempt_at = ?, last_error = 'boom', warning = 'may_duplicate: x' WHERE id = ?").run(now - 1000, id);
    db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(rec); // S4 puts a failed record back into Review
    await run("review_decide", second, O());
    const d = row(db, "SELECT * FROM obs_deliveries WHERE id = ?", id);
    assert.deepEqual(
      [d?.input_json, d?.status, d?.attempts, d?.hold_id, d?.next_at, d?.first_attempt_at, d?.last_error, d?.warning],
      [JSON.stringify(second), "pending", 0, null, null, null, null, d?.warning],
    );
    assert.match(String(d?.warning), /^may_duplicate/, "an attempt was made before, so the destination may hold a copy");
    assert.notEqual(d?.idem_key, key(rec, 1, "knowledge"), "an earlier attempt may have reached the destination with the old input: new key");
    db.prepare("UPDATE obs_deliveries SET status = 'failed', first_attempt_at = ? WHERE id = ?").run(now, id);
    await run("delivery_retry", { id }, O());
    assert.equal(row(db, "SELECT input_json AS j FROM obs_deliveries WHERE id = ?", id)?.j, JSON.stringify(second), "the retry sends the redacted decision");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE record_id = ?").get(rec)?.c, 1);
  });
  it("a row that was never attempted keeps its key when the decision changes", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    await run("review_decide", { recordId: rec, decision: "deliver", destination: "inbox" }, O());
    db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(rec);
    await run("review_decide", { recordId: rec, decision: "deliver_redacted", destination: "inbox" }, O());
    assert.equal(row(db, "SELECT idem_key AS k FROM obs_deliveries WHERE record_id = ?", rec)?.k, key(rec, 1, "inbox"));
    assert.equal(row(db, "SELECT warning AS w FROM obs_deliveries WHERE record_id = ?", rec)?.w, null, "no attempt, no warning");
  });
  it("keep: a flagged record goes back to delivered with no new delivery; it needs a record that was delivered, and no destination", async () => {
    const rec = seedRecord(db, src, { state: "delivered", withText: true });
    seedDelivery(db, rec, { status: "sent", targetRef: "doc_1" });
    db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(rec); // flagged
    await rejects(run("review_decide", { recordId: rec, decision: "keep", destination: "knowledge" }, O()), "destination_invalid", 400);
    const out = await run("review_decide", { recordId: rec, decision: "keep" }, O());
    assert.deepEqual([out.record.state, out.record.decidedBy], ["delivered", OWNER.id]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE record_id = ?").get(rec)?.c, 1);
    await rejects(run("review_decide", { recordId: rec, decision: "keep" }, O()), "record_not_waiting", 409);
    const never = seedRecord(db, src, { state: "review", withText: true });
    await rejects(run("review_decide", { recordId: never, decision: "keep" }, O()), "nothing_to_keep", 409);
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", never)?.state, "review");
  });
  it("keep on a secret record is refused too (secret_drop_only)", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true, secret: true });
    seedDelivery(db, rec, { status: "sent" });
    await rejects(run("review_decide", { recordId: rec, decision: "keep" }, O()), "secret_drop_only", 409);
  });
  it("a secret is found by the column OR by a `secret` class in pii_json: only drop works", async () => {
    const byPii = seedRecord(db, src, { state: "review", withText: true, pii: { secret: 1, email: 2 } });
    for (const decision of ["deliver", "deliver_redacted"]) await rejects(run("review_decide", { recordId: byPii, decision, destination: "knowledge" }, O()), "secret_drop_only", 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    const quiet = seedRecord(db, src, { state: "review", withText: true, pii: { secret: 0, email: 2 } });
    assert.equal((await run("review_decide", { recordId: quiet, decision: "deliver", destination: "knowledge" }, O())).record.state, "approved", "a zero count is no secret");
    assert.equal((await run("review_decide", { recordId: byPii, decision: "drop" }, O())).record.state, "dropped");
  });
});

describe("superseded deliveries stay dead", () => {
  const rows = (rec: string) => db.prepare("SELECT destination, status, revision FROM obs_deliveries WHERE record_id = ? ORDER BY destination, revision").all(rec).map((r) => ({ ...r }));
  const decide = (input: Record<string, unknown>) => run("review_decide", input, O());
  const backToReview = (rec: string) => db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(rec);

  it("repro 1: deliver_redacted to ANOTHER destination deletes the old failed row; a copy of it cannot be retried", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    await decide({ recordId: rec, decision: "deliver", destination: "knowledge" });
    db.prepare("UPDATE obs_deliveries SET status = 'failed', first_attempt_at = ? WHERE record_id = ?").run(now, rec);
    backToReview(rec);
    await decide({ recordId: rec, decision: "deliver_redacted", destination: "kanban" });
    assert.deepEqual(rows(rec), [{ destination: "kanban", status: "pending", revision: 1 }]);
    const revived = seedDelivery(db, rec, { destination: "knowledge", status: "failed" });
    await rejects(run("delivery_retry", { id: revived }, O()), "delivery_state_invalid", 409);
    assert.equal(row(db, "SELECT status FROM obs_deliveries WHERE id = ?", revived)?.status, "failed", "nothing changed");
    // the row of the last decision can be retried
    db.prepare("UPDATE obs_deliveries SET status = 'failed' WHERE record_id = ? AND destination = 'kanban'").run(rec);
    const kanban = String(row(db, "SELECT id FROM obs_deliveries WHERE record_id = ? AND destination = 'kanban'", rec)?.id);
    assert.equal((await run("delivery_retry", { id: kanban }, O())).delivery.status, "pending");
  });
  it("repro 2: drop deletes every unsent row; a failed row that is put back cannot be retried (the record is dropped)", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    await decide({ recordId: rec, decision: "deliver", destination: "inbox" });
    db.prepare("UPDATE obs_deliveries SET status = 'failed' WHERE record_id = ?").run(rec);
    backToReview(rec);
    await decide({ recordId: rec, decision: "drop" });
    assert.deepEqual(rows(rec), []);
    const revived = seedDelivery(db, rec, { destination: "inbox", status: "failed" });
    await rejects(run("delivery_retry", { id: revived }, O()), "delivery_state_invalid", 409);
  });
  it("keep deletes unsent rows too and leaves the sent one", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    seedDelivery(db, rec, { destination: "knowledge", status: "sent", targetRef: "doc" });
    seedDelivery(db, rec, { destination: "kanban", status: "failed" });
    await decide({ recordId: rec, decision: "keep" });
    assert.deepEqual(rows(rec), [{ destination: "knowledge", status: "sent", revision: 1 }]);
  });
  it("a retry needs: record approved, same revision, same decided destination; each missing piece answers delivery_state_invalid (409)", async () => {
    const make = () => {
      const rec = seedRecord(db, src, { state: "approved", destination: "knowledge" });
      return { rec, id: seedDelivery(db, rec, { destination: "knowledge", status: "failed" }) };
    };
    const ok = make();
    assert.equal((await run("delivery_retry", { id: ok.id }, O())).delivery.status, "pending");
    const bad: [string, (m: { rec: string }) => void][] = [
      ["record in review", (m) => backToReview(m.rec)],
      ["record dropped", (m) => db.prepare("UPDATE obs_records SET state = 'dropped' WHERE id = ?").run(m.rec)],
      ["record delivered", (m) => db.prepare("UPDATE obs_records SET state = 'delivered' WHERE id = ?").run(m.rec)],
      ["other revision", (m) => db.prepare("UPDATE obs_records SET revision = 2 WHERE id = ?").run(m.rec)],
      ["other destination", (m) => db.prepare("UPDATE obs_records SET decided_destination = 'kanban' WHERE id = ?").run(m.rec)],
      ["no destination", (m) => db.prepare("UPDATE obs_records SET decided_destination = NULL WHERE id = ?").run(m.rec)],
    ];
    for (const [name, mutate] of bad) {
      const m = make();
      mutate(m);
      await rejects(run("delivery_retry", { id: m.id }, O()), "delivery_state_invalid", 409);
      assert.equal(row(db, "SELECT status FROM obs_deliveries WHERE id = ?", m.id)?.status, "failed", name);
    }
  });
});

describe("a flag lets the owner replace the delivered document", () => {
  it("flag raises the revision, so deliver and deliver_redacted to the SAME destination make a new row; the old sent row stays", async () => {
    const rec = seedRecord(db, src, { state: "delivered", withText: true });
    seedDelivery(db, rec, { destination: "knowledge", status: "sent", targetRef: "doc_old" });
    await handlers.flag.run({ recordId: rec, reason: "contains a phone number" } as never, ctxFor(db, AGENT_A));
    assert.deepEqual({ ...row(db, "SELECT state, revision FROM obs_records WHERE id = ?", rec) }, { state: "review", revision: 2 });
    const out = await run("review_decide", { recordId: rec, decision: "deliver_redacted", destination: "knowledge" }, O());
    assert.equal(out.record.state, "approved");
    assert.deepEqual(
      db.prepare("SELECT revision, status, target_ref FROM obs_deliveries WHERE record_id = ? ORDER BY revision").all(rec).map((r) => ({ ...r })),
      [
        { revision: 1, status: "sent", target_ref: "doc_old" },
        { revision: 2, status: "pending", target_ref: null },
      ],
    );
    assert.notEqual(
      row(db, "SELECT idem_key AS k FROM obs_deliveries WHERE revision = 2")?.k,
      row(db, "SELECT idem_key AS k FROM obs_deliveries WHERE revision = 1")?.k,
      "a new revision is a new key",
    );
  });
  it("keep after a flag still works (any sent row of the record counts)", async () => {
    const rec = seedRecord(db, src, { state: "delivered", withText: true });
    seedDelivery(db, rec, { status: "sent", targetRef: "doc" });
    await handlers.flag.run({ recordId: rec, reason: "x" } as never, ctxFor(db, AGENT_A));
    assert.equal((await run("review_decide", { recordId: rec, decision: "keep" }, O())).record.state, "delivered");
  });
});

describe("text_gone: nothing to deliver without text", () => {
  const delivered = (rec: string) => seedDelivery(db, rec, { status: "sent", targetRef: "doc" });
  it("deliver, deliver_redacted and keep answer text_gone (409) when no message has text; drop still works", async () => {
    const rec = seedRecord(db, src, { state: "review" });
    seedMessage(db, src, { record: rec, id: "purged", text: null });
    seedMessage(db, src, { record: rec, id: "gone", text: "deleted at the source", deleted: true });
    delivered(rec);
    for (const input of [
      { decision: "deliver", destination: "knowledge" },
      { decision: "deliver_redacted", destination: "kanban" },
      { decision: "keep" },
    ]) {
      await rejects(run("review_decide", { recordId: rec, ...input }, O()), "text_gone", 409);
    }
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec)?.state, "review");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE record_id = ?").get(rec)?.c, 1, "nothing written");
    assert.equal((await run("review_decide", { recordId: rec, decision: "drop" }, O())).record.state, "dropped");
  });
  it("a record with no message at all is text_gone as well", async () => {
    const rec = seedRecord(db, src, { state: "review" });
    await rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O()), "text_gone", 409);
  });
  it("text_purge_at in the past is text_gone even if the text is still stored; one message with text is enough while inside", async () => {
    const rec = seedRecord(db, src, { state: "review", textPurgeAt: now + 1000 });
    seedMessage(db, src, { record: rec, id: "m1", text: "still here" });
    seedMessage(db, src, { record: rec, id: "m2", text: null });
    now += 1000;
    await rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O()), "text_gone", 409);
    db.prepare("UPDATE obs_records SET text_purge_at = ? WHERE id = ?").run(now + 1, rec);
    assert.equal((await run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O())).record.state, "approved");
  });
});

describe("a held delivery blocks every decision (delivery_held)", () => {
  it("deliver (same or another destination), deliver_redacted, drop and keep are refused and change nothing; a released row lets the owner go on", async () => {
    const rec = seedRecord(db, src, { state: "review", withText: true });
    seedDelivery(db, rec, { destination: "knowledge", status: "sent", targetRef: "doc" });
    const held = seedDelivery(db, rec, { destination: "kanban", status: "held" });
    db.prepare("UPDATE obs_deliveries SET hold_id = 'hld_1' WHERE id = ?").run(held);
    for (const input of [
      { decision: "deliver", destination: "kanban" },
      { decision: "deliver", destination: "inbox" },
      { decision: "deliver_redacted", destination: "kanban" },
      { decision: "drop" },
      { decision: "keep" },
    ]) {
      await rejects(run("review_decide", { recordId: rec, ...input }, O()), "delivery_held", 409);
    }
    assert.deepEqual({ ...row(db, "SELECT status, hold_id FROM obs_deliveries WHERE id = ?", held) }, { status: "held", hold_id: "hld_1" });
    assert.equal(row(db, "SELECT state FROM obs_records WHERE id = ?", rec)?.state, "review");
    db.prepare("UPDATE obs_deliveries SET status = 'failed', hold_id = NULL WHERE id = ?").run(held);
    assert.equal((await run("review_decide", { recordId: rec, decision: "drop" }, O())).record.state, "dropped");
  });
});

describe("the guards live in decideRecord itself", () => {
  const call = (r: Record<string, unknown>, decision: "deliver" | "drop", destination?: string) => decideRecord(db, r, { decision, destination, input: {} }, OWNER.id, now, 30);
  it("a secret record is refused by decideRecord for anything but drop, called directly, with the column or the pii class", () => {
    for (const rec of [seedRecord(db, src, { state: "review", secret: true, withText: true }), seedRecord(db, src, { state: "review", pii: { secret: 3 }, withText: true })]) {
      const r = { ...(db.prepare("SELECT * FROM obs_records WHERE id = ?").get(rec) as Record<string, unknown>) };
      assert.throws(() => call(r, "deliver", "knowledge"), { code: "secret_drop_only" });
      assert.doesNotThrow(() => call(r, "drop"));
    }
  });
  it("fails closed: a pii_json that cannot be read counts as a secret (decide, retry), also '[]', 'null' and a non-number", async () => {
    for (const bad of ["{not json", "[]", "null", '"x"', '{"secret":"yes"}']) {
      const rec = seedRecord(db, src, { state: "review", withText: true });
      db.prepare("UPDATE obs_records SET pii_json = ? WHERE id = ?").run(bad, rec);
      await rejects(run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O()), "secret_drop_only", 409);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE record_id = ?").get(rec)?.c, 0, bad);
      const failedRow = seedRecord(db, src, { state: "approved", destination: "knowledge" });
      const id = seedDelivery(db, failedRow, { status: "failed" });
      db.prepare("UPDATE obs_records SET pii_json = ? WHERE id = ?").run(bad, failedRow);
      await rejects(run("delivery_retry", { id }, O()), "secret_drop_only", 409);
      assert.equal((await run("review_decide", { recordId: rec, decision: "drop" }, O())).record.state, "dropped", "drop still works");
    }
  });
  it("quiet on good: pii counts that are not secret (a zero, other classes) are fine", async () => {
    for (const pii of ['{"email":2}', '{"secret":0,"phone":1}', "{}"]) {
      const rec = seedRecord(db, src, { state: "review", withText: true });
      db.prepare("UPDATE obs_records SET pii_json = ? WHERE id = ?").run(pii, rec);
      assert.equal((await run("review_decide", { recordId: rec, decision: "deliver", destination: "knowledge" }, O())).record.state, "approved", pii);
    }
  });
  it("the state guard too: decideRecord on a record that is not in review throws record_not_waiting", () => {
    const rec = seedRecord(db, src, { state: "delivered", withText: true });
    const r = { ...(db.prepare("SELECT * FROM obs_records WHERE id = ?").get(rec) as Record<string, unknown>) };
    assert.throws(() => call(r, "drop"), { code: "record_not_waiting" });
  });
});

describe("the router never lets a rule deliver a secret", () => {
  const rules = (ids: string[]) => ids.map((id, position) => ({ id, position, locked: id === RULE_ZERO_ID, match: {}, action: { deliver: "knowledge" } }));
  const catchAll = () => true;
  it("a secret record is dropped by rule 0 before any rule is looked at (the matcher is not even called)", () => {
    let calls = 0;
    const matcher = (_r: unknown, _rec: unknown) => {
      calls++;
      return catchAll();
    };
    for (const rec of [{ secret: 1, pii_json: "{}" }, { secret: 0, pii_json: '{"secret":2}' }]) {
      assert.deepEqual(routeRecord(rec, rules([RULE_ZERO_ID, "rul_a"]), matcher), { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" });
    }
    assert.equal(calls, 0);
  });
  it("quiet on good: a normal record goes to the first matching rule (never rule 0), else to Review", () => {
    assert.deepEqual(routeRecord({ secret: 0, pii_json: "{}" }, rules([RULE_ZERO_ID, "rul_a", "rul_b"]), (r) => r.id === "rul_b"), { kind: "rule", ruleId: "rul_b" });
    assert.deepEqual(routeRecord({ secret: 0, pii_json: "{}" }, rules([RULE_ZERO_ID, "rul_a"]), () => false), { kind: "review" });
    assert.deepEqual(routeRecord({ secret: 0, pii_json: "{}" }, rules([RULE_ZERO_ID, "rul_a"]), catchAll), { kind: "rule", ruleId: "rul_a" });
  });
});

describe("deliveries_list and delivery_retry", () => {
  it("lists the outbox rows newest first, filters by status, never shows the stored input", async () => {
    const rec = seedRecord(db, src, { state: "approved" });
    const a = seedDelivery(db, rec, { status: "sent", destination: "knowledge", targetRef: "doc_1", updatedAt: Date.UTC(2026, 9, 1) });
    const b = seedDelivery(db, rec, { status: "failed", destination: "kanban", updatedAt: Date.UTC(2026, 9, 2) });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id = ?").run(JSON.stringify({ text: "private words" }), b);
    const all = await run("deliveries_list", {}, O());
    assert.deepEqual(all.items.map((d: Out) => [d.id, d.status]), [[b, "failed"], [a, "sent"]]);
    assert.deepEqual((await run("deliveries_list", { status: "sent" }, O())).items.map((d: Out) => d.id), [a]);
    assert.ok(!JSON.stringify(all).includes("private words"));
    assert.equal(all.items[1].targetRef, "doc_1");
  });
  it("retry turns a failed row into pending with the SAME key inside 23 hours", async () => {
    const rec = seedRecord(db, src, { state: "approved" });
    const id = seedDelivery(db, rec, { status: "failed", key: "obs_same", firstAttemptAt: now - 22 * 3_600_000 });
    db.prepare("UPDATE obs_deliveries SET last_error = 'rate_limited', hold_id = 'hld_1' WHERE id = ?").run(id);
    const out = (await run("delivery_retry", { id }, O())).delivery;
    assert.deepEqual([out.status, out.warning, out.lastError, out.holdId], ["pending", null, null, null]);
    const r = row(db, "SELECT idem_key, first_attempt_at FROM obs_deliveries WHERE id = ?", id);
    assert.deepEqual([r?.idem_key, r?.first_attempt_at], ["obs_same", now - 22 * 3_600_000]);
  });
  it("after 23 hours the retry makes a NEW key and warns that it may duplicate", async () => {
    const rec = seedRecord(db, src, { state: "approved" });
    const id = seedDelivery(db, rec, { status: "failed", key: "obs_old", firstAttemptAt: now - 23 * 3_600_000 - 1 });
    const out = (await run("delivery_retry", { id }, O())).delivery;
    assert.equal(out.status, "pending");
    assert.match(out.warning, /^may_duplicate/);
    const r = row(db, "SELECT idem_key, first_attempt_at FROM obs_deliveries WHERE id = ?", id);
    assert.match(String(r?.idem_key), /^obs_[0-9a-f]{40}$/);
    assert.notEqual(r?.idem_key, "obs_old");
    assert.equal(r?.first_attempt_at, null);
    // the warning lives on the row: deliveries_list shows it later, and a quick second retry does not drop it
    const listed = (await run("deliveries_list", { status: "pending" }, O())).items.find((d: Out) => d.id === id);
    assert.match(listed.warning, /^may_duplicate/);
    db.prepare("UPDATE obs_deliveries SET status = 'failed', first_attempt_at = ? WHERE id = ?").run(now, id);
    assert.match((await run("delivery_retry", { id }, O())).delivery.warning, /^may_duplicate/);
  });
  it("a delivery that was never retried late shows no warning", async () => {
    const rec = seedRecord(db, src, { state: "approved" });
    seedDelivery(db, rec, { status: "failed", firstAttemptAt: now - 1000 });
    assert.equal((await run("deliveries_list", {}, O())).items[0].warning, null);
  });
  it("a retry of a delivery whose record holds a secret is refused (secret_drop_only), whatever the row says", async () => {
    for (const rec of [seedRecord(db, src, { state: "approved", secret: true }), seedRecord(db, src, { state: "approved", pii: { secret: 1 } })]) {
      const id = seedDelivery(db, rec, { status: "failed" });
      await rejects(run("delivery_retry", { id }, O()), "secret_drop_only", 409);
      assert.equal(row(db, "SELECT status FROM obs_deliveries WHERE id = ?", id)?.status, "failed");
    }
  });
  it("only a failed row can be retried (delivery_state_invalid, 409); a missing one is not_found", async () => {
    const rec = seedRecord(db, src, { state: "approved" });
    const dest = { pending: "knowledge", held: "kanban", sent: "inbox" } as const;
    for (const status of ["pending", "held", "sent"] as const) {
      const id = seedDelivery(db, rec, { status, destination: dest[status] });
      await rejects(run("delivery_retry", { id }, O()), "delivery_state_invalid", 409);
      assert.equal(row(db, "SELECT status FROM obs_deliveries WHERE id = ?", id)?.status, status);
    }
    await rejects(run("delivery_retry", { id: "dlv_01J00000000000000000000000" }, O()), "not_found", 404);
  });
});
