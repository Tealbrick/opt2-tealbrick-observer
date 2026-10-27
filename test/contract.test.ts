// Contract messages/1 (C230 R3): the frozen files are the byte copies named in PROVENANCE.md, the fixtures run through the shared
// validator, the fake Connect cannot drift (a page that breaks the contract makes it throw), Observer's reader skips and counts a
// row that does not conform (the same through the real port and a job tick: ingest-jobs.test.ts), and the row → message mapping
// keeps only what storeMessage needs. L1, L24, L27, L34.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { type MessageRow, PAGE_SCHEMA, readPage, rowConforms, toIncoming } from "../src/contract.ts";
import { FakeConnect } from "./fake-connect.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const file = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const FIXTURES = JSON.parse(file("./contracts/messages.1.json").toString()) as { valid: Json[]; invalid: { why: string; doc: Json }[] };
const SCHEMA_SHA = "9a627953cac9b7bb20a2bed14a807a2db334b776aa34f051495794a4b1302a24";

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: "m1",
  conversation: "C1",
  sentAt: "2026-10-17T10:00:00Z",
  author: { kind: "person", handle: "slack:U0ANNA" },
  text: "hello",
  attachments: [],
  untrusted: true,
  ...over,
});

describe("the vendored contract files", () => {
  it("are the byte copies named in PROVENANCE.md (quiet on good, fires on a changed byte); the runtime copy is the same bytes", () => {
    const prov = file("./contracts/PROVENANCE.md").toString();
    for (const f of ["./contracts/messages.1.schema.json", "./contracts/messages.1.json", "../src/contracts/messages.1.schema.json"]) {
      const bytes = file(f);
      assert.ok(prov.includes(sha256(bytes)), `${f} does not match the sha256 in PROVENANCE.md`);
      assert.ok(!prov.includes(sha256(Buffer.concat([bytes, Buffer.from(" ")]))), "a changed file would not match");
    }
    assert.equal(sha256(file("./contracts/messages.1.schema.json")), SCHEMA_SHA, "the schema is the spec-v0.1.42 file");
    assert.ok(file("./contracts/messages.1.schema.json").equals(file("../src/contracts/messages.1.schema.json")));
    assert.ok(prov.includes("spec-v0.1.42"));
  });
  it("fixtures: every valid page validates, every invalid page fails (the schema check is live)", () => {
    assert.ok(FIXTURES.valid.length >= 2 && FIXTURES.invalid.length >= 6);
    for (const doc of FIXTURES.valid) assert.deepEqual(validateAgainstSchema(PAGE_SCHEMA, doc), { ok: true });
    for (const { why, doc } of FIXTURES.invalid) assert.equal(validateAgainstSchema(PAGE_SCHEMA, doc).ok, false, why);
  });
});

describe("the fake Connect cannot drift", () => {
  it("serves pages that conform; a page broken BEFORE its check makes the fake throw (the test fails, the fake is not trusted)", async () => {
    const fake = new FakeConnect();
    fake.addAccount({ id: "acc1" });
    fake.post("acc1", { conversation: "C1", id: "m1", text: "hi", sentAt: Date.UTC(2026, 9, 17) });
    const ok = await fake.callApp("connect", "data_pull", { account: "acc1", dataset: "messages" });
    assert.equal(validateAgainstSchema(PAGE_SCHEMA, ok.output).ok, true, "quiet on good");
    for (const breakIt of [
      (p: Record<string, any>) => {
        p.rows[0].untrusted = false;
      },
      (p: Record<string, any>) => {
        p.rows[0].sentAt = "2026-10-17T10:00:00+02:00";
      },
      (p: Record<string, any>) => {
        delete p.exhausted;
      },
      (p: Record<string, any>) => {
        p.rows[0].author.handle = "U0ANNA";
      },
    ]) {
      fake.drift = breakIt;
      await assert.rejects(fake.callApp("connect", "data_pull", { account: "acc1", dataset: "messages" }), /fake Connect drifted from messages\/1/);
    }
  });
});

describe("Observer's reader (strict envelope, tolerant rows)", () => {
  it("skips and counts every row that does not conform; the good rows are used", () => {
    const page = readPage({
      rows: [row(), row({ id: "", text: "x" }), { ...row({ id: "m3" }), untrusted: false }, row({ id: "m4", deleted: true, text: "still here" }), row({ id: "m5", sentAt: "yesterday" }), "not a row", row({ id: "m6" })],
      nextCursor: "c2",
      exhausted: false,
      quarantined: 2,
      schema: "messages/1",
      untrusted: true,
      somethingNew: { readers: "tolerate" },
    });
    assert.deepEqual(
      page.rows.map((r) => r.id),
      ["m1", "m6"],
    );
    assert.deepEqual([page.invalid, page.quarantined, page.nextCursor, page.exhausted, page.anchor, page.retryAfterS], [5, 2, "c2", false, null, null]);
  });
  it("refuses a page whose envelope it would act on wrongly (connect_contract, 502)", () => {
    for (const bad of [null, [], { rows: {}, nextCursor: null, exhausted: true }, { rows: [], exhausted: true }, { rows: [], nextCursor: "", exhausted: true }, { rows: [], nextCursor: null }, { rows: [], nextCursor: null, exhausted: true, retryAfterS: 0 }, { rows: [], nextCursor: null, exhausted: true, anchor: 5 }]) {
      assert.throws(() => readPage(bad), { code: "connect_contract", httpStatus: 502 }, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => readPage({ rows: [], nextCursor: null, exhausted: true, retryAfterS: 3600, anchor: "a" }), "quiet on good");
  });
});

describe("messages/1 row → IncomingMessage", () => {
  it("maps id, times, author handle and kind, text and deletion; never display or attachments", () => {
    const r = row({ thread: "T1", editedAt: "2026-10-17T10:05:00.250Z", author: { kind: "bot", handle: "telegram:42", display: "Anna Private" }, attachments: [{ name: "salary.pdf", mime: "application/pdf", bytes: 9 }] });
    assert.ok(rowConforms(r));
    const m = toIncoming(r);
    assert.deepEqual(m, { conversation: "C1", providerMsgId: "m1", thread: "T1", sentAt: Date.UTC(2026, 9, 17, 10), editedAt: Date.UTC(2026, 9, 17, 10, 5, 0, 250), deleted: false, author: "telegram:42", authorKind: "bot", text: "hello" });
    assert.ok(!JSON.stringify(m).includes("Anna Private") && !JSON.stringify(m).includes("salary.pdf"));
    assert.deepEqual(toIncoming(row({ deleted: true, text: "" })), { conversation: "C1", providerMsgId: "m1", thread: null, sentAt: Date.UTC(2026, 9, 17, 10), editedAt: null, deleted: true, author: "slack:U0ANNA", authorKind: "person", text: "" });
  });
});
