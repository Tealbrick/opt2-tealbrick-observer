// Privacy settings and purge (DESIGN §5.5): defaults 30 / 90 / purge; purge deletes stored text now and keeps ids and digests.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { definition, handlers, setClock } from "../src/app.ts";
import { ctxFor, migratedDb, OWNER } from "./helpers.ts";
import { seedMessage, seedSource } from "./seed.ts";

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
  await definition.onStart?.({ db } as never);
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
