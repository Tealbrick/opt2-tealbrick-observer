// Ingest details and record life cycle: quoted markers, thread / author cleaning, clamped times, late messages, edits that make a
// decided record riskier, secrets split over messages, and "PII class X → Review" end to end for every class.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { classifyText, SECRET_MARKER } from "../src/classify.ts";
import { sanitizeForStorage, sanitizeShort, storeMessage } from "../src/ingest.ts";
import { applyRouting } from "../src/pipeline.ts";
import { attachWindow, reclassifyRecord } from "../src/records.ts";
import { RULE_ZERO_ID } from "../src/store.ts";
import { liveWindows } from "../src/window.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { ingestRecord, seedSource } from "./seed.ts";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const j = (...p: string[]) => p.join("");
const GHP = j("ghp", "_", "aB3dE6".repeat(6));
let db: Db;
let src: string;
const O = (): OpContext => ctxFor(db, OWNER);
const rec = (id: string) => ({ ...db.prepare("SELECT * FROM obs_records WHERE id = ?").get(id) });
const put = (match: Record<string, unknown>, action: Record<string, unknown>) => handlers.rule_put.run({ position: 1, match, action } as never, O());
const msgs = (record: string) => db.prepare("SELECT * FROM obs_messages WHERE record_id = ? ORDER BY sent_at, provider_msg_id").all(record).map((r) => ({ ...r }));

beforeEach(async () => {
  db = migratedDb();
  setClock(() => NOW);
  await start(db);
  src = seedSource(db, { conversations: ["inbox"] });
});

describe("a message cannot carry the marker", () => {
  it("quoted markers (any case) are defanged, so only ingest's own marker is evidence of a secret", () => {
    for (const quoted of [SECRET_MARKER, "[SECRET REMOVED]", "[Secret Removed]"]) {
      const s = sanitizeForStorage(`hello ${quoted} world`);
      assert.ok(!s.text.includes(SECRET_MARKER), quoted);
      assert.equal(s.secrets, 0);
      assert.equal(classifyText(s.text).secret, false, "a quoted marker does not make a secret record");
    }
    const real = sanitizeForStorage(`quote ${SECRET_MARKER} and a real key ${GHP}`);
    assert.equal(real.secrets, 1);
    assert.equal(real.text.split(SECRET_MARKER).length - 1, 1, "exactly the marker ingest wrote");
    assert.equal(classifyText(real.text).secret, true);
  });
  it("through storeMessage: a user who types the marker does not turn their record into a secret record", () => {
    const record = ingestRecord(db, src, [`I wrote ${SECRET_MARKER} for fun, that is all`], NOW);
    assert.equal(applyRouting(db, record, NOW).route.kind, "review");
    assert.equal(rec(record).secret, 0);
  });
});

describe("thread and author text", () => {
  it("a secret in a thread subject or in the author handle is replaced with the same detector; both are bounded", () => {
    storeMessage(db, src, { conversation: "inbox", providerMsgId: "a", thread: "Re: password = hunter2222 for the VPN", sentAt: NOW, author: "slack:token=abcd1234", authorKind: "person", text: "x" }, NOW);
    const row = db.prepare("SELECT thread, author_ref, author_key FROM obs_messages").get();
    assert.ok(!JSON.stringify(row).includes("hunter2222") && !JSON.stringify(row).includes("abcd1234"));
    assert.ok(String(row?.thread).includes(SECRET_MARKER));
    assert.equal(sanitizeShort("x".repeat(1000), 300).length, 301);
    assert.equal(sanitizeShort("plain subject"), "plain subject");
  });
});

describe("times", () => {
  it("a sent time in the future counts as the arrival time; NaN, missing and edited times too", () => {
    const base = { conversation: "inbox", thread: "t", author: "email:anna@example.com", authorKind: "person" as const, text: "x" };
    storeMessage(db, src, { ...base, providerMsgId: "future", sentAt: NOW + 10 * 86_400_000, editedAt: NOW + 5 * 86_400_000 }, NOW);
    storeMessage(db, src, { ...base, providerMsgId: "nan", sentAt: Number.NaN }, NOW);
    storeMessage(db, src, { ...base, providerMsgId: "past", sentAt: NOW - 5000 }, NOW);
    const t = Object.fromEntries(db.prepare("SELECT provider_msg_id AS id, sent_at, edited_at FROM obs_messages").all().map((r) => [r.id, [r.sent_at, r.edited_at]]));
    assert.deepEqual(t, { future: [NOW, NOW], nan: [NOW, null], past: [NOW - 5000, null] });
  });
});

describe("late messages join the existing record", () => {
  const win = (ids: string[], at: number) => liveWindows(ids.map((id, i) => ({ id, conversation: "inbox", thread: "t1", sentAt: at + i * 1000, chars: 5 })), at + 3_600_000)[0] as NonNullable<ReturnType<typeof liveWindows>[0]>;
  const store = (id: string, at: number, text = "words") => storeMessage(db, src, { conversation: "inbox", providerMsgId: id, thread: "t1", sentAt: at, author: "email:anna@example.com", authorKind: "person", text }, NOW);

  it("a window gets back the record its messages already belong to; only the new message is added, as a new revision", () => {
    const at = NOW - 3 * 3_600_000;
    store("m1", at);
    store("m2", at + 1000);
    const first = attachWindow(db, src, win(["m1", "m2"], at), NOW);
    assert.deepEqual([first.created, first.added, first.revision], [true, 2, 1]);
    store("m3", at + 2000, "a late answer");
    const second = attachWindow(db, src, win(["m1", "m2", "m3"], at), NOW);
    assert.deepEqual([second.recordId, second.created, second.added, second.revision], [first.recordId, false, 1, 2]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_records").get()?.c, 1);
    assert.equal(msgs(first.recordId).length, 3);
    const same = attachWindow(db, src, win(["m1", "m2", "m3"], at), NOW);
    assert.deepEqual([same.created, same.added, same.revision], [false, 0, 2], "attaching again changes nothing");
  });
  it("a record that was classified is open again for the new message; one waiting in Review stays there with fresh counts", () => {
    const at = NOW - 3 * 3_600_000;
    store("m1", at);
    const a = attachWindow(db, src, win(["m1"], at), NOW);
    db.prepare("UPDATE obs_records SET state = 'classified' WHERE id = ?").run(a.recordId);
    store("m2", at + 1000);
    attachWindow(db, src, win(["m1", "m2"], at), NOW);
    assert.equal(rec(a.recordId).state, "open");
    db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(a.recordId);
    store("m3", at + 2000, "mail me at anna@example.com");
    attachWindow(db, src, win(["m1", "m2", "m3"], at), NOW);
    assert.equal(rec(a.recordId).state, "review");
    assert.deepEqual(JSON.parse(String(rec(a.recordId).pii_json)), { email: 1 });
  });
  it("a late message that adds PII to an approved record sends it back to Review without its unsent delivery", async () => {
    await put({}, { deliver: "knowledge" });
    const at = NOW - 3 * 3_600_000;
    store("m1", at);
    const a = attachWindow(db, src, win(["m1"], at), NOW);
    applyRouting(db, a.recordId, NOW);
    assert.equal(rec(a.recordId).state, "approved");
    store("m2", at + 1000, "and my phone is +421 911 123 456");
    attachWindow(db, src, win(["m1", "m2"], at), NOW);
    assert.deepEqual([rec(a.recordId).state, rec(a.recordId).revision], ["review", 3]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
  });
  it("window keys with a '|' in thread or conversation names do not collide (the separator is NUL)", () => {
    const a = liveWindows([{ id: "x", conversation: "a|b", thread: "c", sentAt: NOW, chars: 1 }], NOW + 9e9)[0];
    const b = liveWindows([{ id: "x", conversation: "a", thread: "b|c", sentAt: NOW, chars: 1 }], NOW + 9e9)[0];
    assert.notEqual(a?.key, b?.key);
  });
});

describe("an edit looks at its record again", () => {
  const edit = (id: string, text: string, editedAt: number) =>
    storeMessage(db, src, { conversation: "inbox", providerMsgId: id, thread: "t1", sentAt: NOW - 5000, editedAt, author: "email:anna@example.com", authorKind: "person", text }, NOW);

  async function approved(text = "just words about lunch"): Promise<{ id: string; message: string }> {
    await put({}, { deliver: "knowledge" });
    const id = ingestRecord(db, src, [text], NOW);
    applyRouting(db, id, NOW);
    assert.equal(rec(id).state, "approved");
    const message = String(db.prepare("SELECT provider_msg_id AS id FROM obs_messages WHERE record_id = ?").get(id)?.id);
    return { id, message };
  }

  it("an approved record whose edit adds PII goes back to Review: new revision, unsent delivery cancelled", async () => {
    const { id, message } = await approved();
    const r = edit(message, "just words, mail me at anna@example.com", NOW - 1000);
    assert.equal(r.reopened, true);
    const after = rec(id);
    assert.deepEqual([after.state, after.revision, after.decided_destination, after.decided_by, JSON.parse(String(after.pii_json))], ["review", 2, null, null, { email: 1 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
  });
  it("an edit that adds a secret sets the secret flag, so only drop is allowed", async () => {
    const { id, message } = await approved();
    const r = edit(message, `now with a key ${GHP}`, NOW - 1000);
    assert.equal(r.reopened, true);
    assert.equal(rec(id).secret, 1);
    assert.equal(rec(id).state, "review");
    await assert.rejects(handlers.review_decide.run({ recordId: id, decision: "deliver", destination: "knowledge" } as never, O()), { code: "secret_drop_only" });
    assert.ok(!JSON.stringify(msgs(id)).includes(GHP.slice(0, 12)), "the key is not stored");
  });
  it("a delivered record goes back to Review only when the edit adds something sensitive; a harmless edit leaves it", async () => {
    const { id, message } = await approved();
    db.prepare("UPDATE obs_deliveries SET status = 'sent', target_ref = 'doc' WHERE record_id = ?").run(id);
    db.prepare("UPDATE obs_records SET state = 'delivered' WHERE id = ?").run(id);
    assert.equal(edit(message, "just words about dinner", NOW - 3000).reopened, false);
    assert.equal(rec(id).state, "delivered");
    assert.equal(edit(message, "call +421 911 123 456", NOW - 2000).reopened, true);
    assert.deepEqual([rec(id).state, rec(id).revision], ["review", 2]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries WHERE status = 'sent'").get()?.c, 1, "the delivered ledger row stays");
  });
  it("an approved record whose edit adds nothing sensitive still goes back (its unsent delivery would send the old text); open and dropped records are left alone", async () => {
    const { id, message } = await approved();
    assert.equal(edit(message, "completely different harmless words", NOW - 1000).reopened, true);
    assert.equal(rec(id).state, "review");
    const open = ingestRecord(db, src, ["draft words"], NOW + 1000);
    assert.equal(reclassifyRecord(db, open, NOW), false);
    db.prepare("UPDATE obs_records SET state = 'dropped' WHERE id = ?").run(open);
    assert.equal(reclassifyRecord(db, open, NOW), false);
    assert.equal(rec(open).state, "dropped");
  });
  it("a deletion by the provider removes the text and does not reopen anything", async () => {
    const { id, message } = await approved();
    const r = storeMessage(db, src, { conversation: "inbox", providerMsgId: message, thread: "t1", sentAt: NOW - 5000, deleted: true, author: "email:anna@example.com", authorKind: "person", text: "" }, NOW);
    assert.equal(r.status, "updated");
    assert.equal(r.reopened, false);
    assert.equal(db.prepare("SELECT text FROM obs_messages WHERE provider_msg_id = ?").get(message)?.text, null);
    assert.equal(rec(id).state, "approved");
  });
});

describe("a secret split over two messages", () => {
  it("is found in the joined text when the record closes: every message text of the record goes, ids / digests / the flag stay; rule 0 drops it", async () => {
    await put({}, { deliver: "knowledge" });
    const id = ingestRecord(db, src, ["the vpn login is below, password:", "hunter2222xyz", "thanks, see you at 10"], NOW);
    const before = msgs(id);
    assert.ok(before.every((m) => m.text !== null), "each message alone looked clean");
    const out = applyRouting(db, id, NOW);
    assert.deepEqual(out.route, { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" });
    const after = msgs(id);
    assert.ok(after.every((m) => m.text === null && m.thread === null), "no tail survives: all texts and thread subjects are gone");
    assert.deepEqual(after.map((m) => [m.provider_msg_id, m.text_digest]), before.map((m) => [m.provider_msg_id, m.text_digest]), "ids and digests stay");
    assert.deepEqual([rec(id).secret, rec(id).state], [1, "dropped"]);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM obs_messages").all()).includes("hunter2222xyz"));
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
  });
  it("a record without a split secret keeps its texts", () => {
    const id = ingestRecord(db, src, ["the vpn login is below", "see you at 10"], NOW);
    applyRouting(db, id, NOW);
    assert.ok(msgs(id).every((m) => m.text !== null));
  });
});

describe("every PII class sends a record to Review unless the rule redacts", () => {
  const samples: Record<string, string> = {
    email: "write to anna@example.com about it",
    phone: "call me on +421 911 123 456 tomorrow",
    iban: "pay to DE89 3704 0044 0532 0130 00 please",
    card: "my card is 4111 1111 1111 1111 ok",
    id: "my RČ is 850327/1007 ok",
    address: "I live at 10 Downing Street, London",
    special: "she was diagnosed with cancer last year",
  };
  for (const [cls, text] of Object.entries(samples)) {
    it(`${cls}: Review without redact, deliver_redacted with it`, async () => {
      const rule = (await put({}, { deliver: "knowledge" })) as { rule: { id: string } };
      const id = ingestRecord(db, src, [text], NOW);
      const out = applyRouting(db, id, NOW);
      assert.deepEqual(out.route, { kind: "review", ruleId: rule.rule.id, reason: "pii_needs_redact" }, cls);
      assert.equal(rec(id).state, "review");
      assert.ok((JSON.parse(String(rec(id).pii_json))[cls] ?? 0) >= 1, `${cls} counted`);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);

      await handlers.rule_put.run({ id: rule.rule.id, position: 1, match: {}, action: { deliver: "knowledge", redact: true } } as never, O());
      const id2 = ingestRecord(db, src, [text], NOW + 1000);
      const out2 = applyRouting(db, id2, NOW + 1000);
      assert.equal(out2.route.kind, "deliver", cls);
      assert.equal(JSON.parse(String(db.prepare("SELECT input_json FROM obs_deliveries WHERE record_id = ?").get(id2)?.input_json)).decision, "deliver_redacted");
    });
  }
  it("and a text with none of them is delivered as it is", async () => {
    await put({}, { deliver: "knowledge" });
    const id = ingestRecord(db, src, ["lunch at noon on tuesday works for me"], NOW);
    assert.equal(applyRouting(db, id, NOW).route.kind, "deliver");
    assert.equal(rec(id).state, "approved");
  });
});
