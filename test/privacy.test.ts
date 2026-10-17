// Privacy settings and purge (DESIGN §5.5): defaults 30 / 90 / purge; purge deletes stored text now and keeps ids and digests.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { digestOf, textDigest } from "../src/store.ts";
import { ctxFor, fakeSecrets, migratedDb, OWNER, start } from "./helpers.ts";
import { seedDelivery, seedMessage, seedRecord, seedSource } from "./seed.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string, status?: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => {
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });

let db: Db;
const O = () => ctxFor(db, OWNER);

beforeEach(async () => {
  db = migratedDb();
  setClock(() => Date.UTC(2026, 9, 17, 12, 0, 0));
  await start(db);
});

describe("privacy_get, privacy_set", () => {
  it("answers the defaults before anything is set", async () => {
    assert.deepEqual(await run("privacy_get", {}, O()), { textRetentionDays: 30, reviewRetentionDays: 90, onSourceDelete: "purge" });
  });
  it("changes only the given fields and keeps them", async () => {
    assert.deepEqual(await run("privacy_set", { textRetentionDays: 7 }, O()), { textRetentionDays: 7, reviewRetentionDays: 90, onSourceDelete: "purge" });
    assert.deepEqual(await run("privacy_set", { onSourceDelete: "keep", reviewRetentionDays: 14 }, O()), { textRetentionDays: 7, reviewRetentionDays: 14, onSourceDelete: "keep" });
    assert.deepEqual(await run("privacy_get", {}, O()), { textRetentionDays: 7, reviewRetentionDays: 14, onSourceDelete: "keep" });
    assert.deepEqual(await run("privacy_set", {}, O()), { textRetentionDays: 7, reviewRetentionDays: 14, onSourceDelete: "keep" });
  });
  it("a stored value outside the allowed range falls back to the default (a damaged row never widens the retention)", async () => {
    db.prepare("INSERT INTO obs_settings (key, value) VALUES ('text_retention_days', '9999'), ('review_retention_days', 'abc'), ('on_source_delete', 'whatever')").run();
    assert.deepEqual(await run("privacy_get", {}, O()), { textRetentionDays: 30, reviewRetentionDays: 90, onSourceDelete: "purge" });
  });
});

describe("purge", () => {
  const stored = (id: string) => ({ ...db.prepare("SELECT text, text_digest, record_id FROM obs_messages WHERE provider_msg_id = ?").get(id) });

  it("deletes the text of every source now, counts the texts, and keeps the ids and digests", async () => {
    const a = seedSource(db);
    const b = seedSource(db);
    seedMessage(db, a, { id: "a1" });
    seedMessage(db, a, { id: "a2", text: null });
    seedMessage(db, b, { id: "b1" });
    assert.deepEqual(await run("purge", {}, O()), { purged: 2 });
    for (const id of ["a1", "a2", "b1"]) assert.equal(stored(id).text, null);
    assert.equal(stored("a1").text_digest, "sha256:a1");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 3, "the ids stay, so nothing is read twice");
    assert.deepEqual(await run("purge", {}, O()), { purged: 0 });
  });
  it("one source only", async () => {
    const a = seedSource(db);
    const b = seedSource(db);
    seedMessage(db, a, { id: "a1" });
    seedMessage(db, b, { id: "b1" });
    assert.deepEqual(await run("purge", { source: a }, O()), { purged: 1 });
    assert.equal(stored("a1").text, null);
    assert.equal(stored("b1").text, "hello there");
  });
  it("only text sent before the given date", async () => {
    const a = seedSource(db);
    seedMessage(db, a, { id: "old", sentAt: Date.UTC(2026, 8, 1) });
    seedMessage(db, a, { id: "edge", sentAt: Date.UTC(2026, 9, 1) });
    seedMessage(db, a, { id: "new", sentAt: Date.UTC(2026, 9, 10) });
    assert.deepEqual(await run("purge", { before: "2026-10-01T00:00:00Z" }, O()), { purged: 1 });
    assert.deepEqual([stored("old").text, stored("edge").text, stored("new").text], [null, "hello there", "hello there"]);
  });
  it("purge leaves no text in deliveries: unsent ones are deleted, sent ones keep the ledger but lose the stored input; thread subjects go", async () => {
    const a = seedSource(db);
    const SUBJECT = "Re: salary of Bob";
    const WORDS = "PRIVATE-BODY";
    const input = JSON.stringify({ body: WORDS });
    const rec = seedRecord(db, a, { state: "approved", thread: SUBJECT });
    seedMessage(db, a, { id: "m1", record: rec, text: WORDS, thread: SUBJECT, author: "email:anna@example.com" });
    const unsent = seedDelivery(db, rec, { status: "failed", destination: "kanban" });
    const sent = seedDelivery(db, rec, { status: "sent", destination: "knowledge", targetRef: "doc_1" });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id IN (?, ?)").run(input, unsent, sent);
    const other = seedSource(db);
    const rec2 = seedRecord(db, other, { state: "approved", thread: "other subject" });
    seedMessage(db, other, { id: "o1", record: rec2, text: "other words", thread: "other subject" });
    const keep = seedDelivery(db, rec2, { status: "pending" });
    db.prepare("UPDATE obs_deliveries SET input_json = ? WHERE id = ?").run(JSON.stringify({ body: "other words" }), keep);

    assert.deepEqual(await run("purge", { source: a }, O()), { purged: 1 });

    const dump = JSON.stringify(["obs_messages", "obs_records", "obs_deliveries"].map((t) => db.prepare(`SELECT * FROM ${t} WHERE ${t === "obs_records" ? "source_id" : t === "obs_messages" ? "source_id" : "record_id"} = ?`).all(t === "obs_deliveries" ? rec : a)));
    assert.ok(!dump.includes(WORDS) && !dump.includes(SUBJECT), "no body and no subject left for that source");
    assert.deepEqual(db.prepare("SELECT id, status, input_json FROM obs_deliveries WHERE record_id = ?").all(rec).map((r) => ({ ...r })), [{ id: sent, status: "sent", input_json: "{}" }]);
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec)?.state, "review", "an approved record whose text is gone goes back to Review");
    assert.deepEqual({ ...db.prepare("SELECT conversation, author_ref, text_digest, thread FROM obs_messages WHERE provider_msg_id = 'm1'").get() }, { conversation: "inbox", author_ref: "email:anna@example.com", text_digest: "sha256:m1", thread: null }, "ids, digest, author and conversation stay for the dedupe");
    // the other source is untouched
    assert.equal(db.prepare("SELECT input_json FROM obs_deliveries WHERE id = ?").get(keep)?.input_json, JSON.stringify({ body: "other words" }));
    assert.equal(db.prepare("SELECT thread FROM obs_messages WHERE provider_msg_id = 'o1'").get()?.thread, "other subject");
    assert.equal(db.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec2)?.state, "approved");
  });
  it("an unknown source is not_found and a bad date is invalid_date; nothing is deleted", async () => {
    const a = seedSource(db);
    seedMessage(db, a, { id: "a1" });
    await rejects(run("purge", { source: "src_01J00000000000000000000000" }, O()), "not_found", 404);
    await rejects(run("purge", { before: "not a date" }, O()), "invalid_date", 400);
    assert.equal(stored("a1").text, "hello there");
  });
  it("its hold text says what goes", () => {
    assert.match(String(handlers.purge.holdView?.({} as never)), /every source/);
    assert.match(String(handlers.purge.holdView?.({ source: "src_x", before: "2026-01-01" } as never)), /source src_x.*before 2026-01-01/);
  });
});

describe("message digests", () => {
  it("onStart creates the HMAC key once in the app secrets and reuses it on every start", async () => {
    const secrets = fakeSecrets();
    assert.equal(secrets.store.size, 0);
    await start(db, secrets);
    const key = secrets.store.get("obs_digest_key");
    assert.ok(key && Buffer.from(key, "base64").length === 32);
    const digest = digestOf("hello");
    await start(db, secrets);
    assert.equal(secrets.store.get("obs_digest_key"), key, "not made again");
    assert.equal(digestOf("hello"), digest);
    assert.equal(secrets.store.size, 1);
  });
  it("the digest is an HMAC: stable for the same text and key, different for another text or another key, never a plain sha256", () => {
    assert.match(textDigest("k1", "hello"), /^hmac-sha256:[0-9a-f]{64}$/);
    assert.equal(textDigest("k1", "hello"), textDigest("k1", "hello"));
    assert.notEqual(textDigest("k1", "hello"), textDigest("k1", "hello!"));
    assert.notEqual(textDigest("k1", "hello"), textDigest("k2", "hello"));
    assert.notEqual(textDigest("k1", "hello"), `hmac-sha256:${"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}`, "not sha256('hello')");
  });
});
