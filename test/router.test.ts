// The router (pure) and applyRouting (on the database). Rule 0 first; the owner's rules in order, the first match decides;
// no match → Review; PII without redact:true → Review.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { SECRET_MARKER } from "../src/classify.ts";
import { applyRouting } from "../src/pipeline.ts";
import { matches, type RouteFacts, routeFacts } from "../src/router.ts";
import { RULE_ZERO_ID, type RuleView } from "../src/store.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";
import { seedMessage, seedRecord, seedSource } from "./seed.ts";

const facts = (extra: Partial<RouteFacts> = {}): RouteFacts => ({ source: "src_a", conversations: ["inbox"], authors: ["email:anna@example.com"], text: "please pay the invoice", classes: {}, secret: false, actionable: false, words: 4, ...extra });
let rn = 0;
const rule = (match: Record<string, unknown>, action: Record<string, unknown>, position = ++rn): RuleView => ({ id: `rul_x${position}_${rn}`, position, locked: false, match, action });
const ZERO: RuleView = { id: RULE_ZERO_ID, position: 0, locked: true, match: { pii: ["secret"] }, action: { deliver: "drop", redact: false } };
const KB = { deliver: "knowledge" };

describe("rule matching: every field fires on a fit and stays quiet on a miss", () => {
  it("an empty match fits everything", () => {
    assert.equal(matches({}, facts()), true);
  });
  it("sources", () => {
    assert.equal(matches({ sources: ["src_a", "src_b"] }, facts()), true);
    assert.equal(matches({ sources: ["src_b"] }, facts()), false);
    assert.equal(matches({ sources: [] }, facts()), false, "an empty list matches nothing");
  });
  it("conversations (any of the record's conversations)", () => {
    assert.equal(matches({ conversations: ["inbox"] }, facts()), true);
    assert.equal(matches({ conversations: ["other", "inbox"] }, facts({ conversations: ["x", "inbox"] })), true);
    assert.equal(matches({ conversations: ["other"] }, facts()), false);
  });
  it("senders by canonical handle, bare value, case, Unicode form, or @domain", () => {
    const f = facts({ authors: ["email:ärger@beispiel.de"] });
    for (const s of ["email:ärger@beispiel.de", "ärger@beispiel.de", "ÄRGER@Beispiel.DE", " ärger@beispiel.de ", "@beispiel.de", "@BEISPIEL.DE"]) assert.equal(matches({ senders: [s] }, f), true, s);
    for (const s of ["other@beispiel.de", "@beispiel.com", "@eispiel.de", "slack:ärger@beispiel.de"]) assert.equal(matches({ senders: [s] }, f), false, s);
  });
  it("words: whole words only, any case, Unicode, stems and phrases of the list entry syntax", () => {
    const f = facts({ text: "Pay the Invoice, faktúra č. 5 and a sick leave note" });
    assert.equal(matches({ words: ["invoice"] }, f), true);
    assert.equal(matches({ words: ["INVOICE"] }, f), true);
    assert.equal(matches({ words: ["faktúra"] }, f), true);
    assert.equal(matches({ words: ["sick leave"] }, f), true);
    assert.equal(matches({ words: ["invoices"] }, f), false);
    assert.equal(matches({ words: ["voice"] }, f), false, "not inside a word");
    assert.equal(matches({ words: ["faktúr*"] }, facts({ text: "dve faktúry" })), true);
    assert.equal(matches({ words: ["tuna", "invoice"] }, f), true, "any of the words");
    assert.equal(matches({ words: [] }, f), false);
  });
  it("pii classes: any listed class that the record holds", () => {
    const f = facts({ classes: { email: 2 } });
    assert.equal(matches({ pii: ["email"] }, f), true);
    assert.equal(matches({ pii: ["phone", "email"] }, f), true);
    assert.equal(matches({ pii: ["phone"] }, f), false);
    assert.equal(matches({ pii: ["bogus"] }, f), false);
  });
  it("actionable and minWords", () => {
    assert.equal(matches({ actionable: true }, facts({ actionable: true })), true);
    assert.equal(matches({ actionable: true }, facts()), false);
    assert.equal(matches({ actionable: false }, facts()), true);
    assert.equal(matches({ minWords: 4 }, facts()), true);
    assert.equal(matches({ minWords: 5 }, facts()), false);
    assert.equal(matches({ minWords: 0 }, facts({ words: 0 })), true);
  });
  it("all fields must fit together (AND)", () => {
    const m = { sources: ["src_a"], words: ["invoice"], minWords: 3, actionable: true };
    assert.equal(matches(m, facts({ actionable: true })), true);
    for (const miss of [{ source: "src_z" }, { text: "hello there you" }, { words: 2 }, { actionable: false }] as Partial<RouteFacts>[]) assert.equal(matches(m, facts({ actionable: true, ...miss })), false, JSON.stringify(miss));
  });
});

describe("routing", () => {
  it("rule 0 first: a secret is dropped even when a catch-all rule would deliver it, and no owner rule is consulted", () => {
    const r = routeFacts(facts({ secret: true, classes: { secret: 1 } }), [ZERO, rule({}, KB)]);
    assert.deepEqual(r, { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" });
    assert.deepEqual(routeFacts(facts({ secret: true }), []), { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" }, "also when the rule list is empty");
  });
  it("the first matching rule decides, by position, whatever the order of the list", () => {
    const a = rule({ words: ["invoice"] }, { deliver: "kanban" }, 2);
    const b = rule({}, { deliver: "inbox" }, 3);
    for (const list of [[ZERO, a, b], [b, a, ZERO]]) assert.deepEqual(routeFacts(facts(), list), { kind: "deliver", ruleId: a.id, destination: "kanban", redact: false });
    assert.deepEqual(routeFacts(facts({ text: "hello" }), [ZERO, a, b]), { kind: "deliver", ruleId: b.id, destination: "inbox", redact: false }, "no match on the first: the next one");
  });
  it("no matching rule → Review", () => {
    assert.deepEqual(routeFacts(facts(), [ZERO]), { kind: "review", ruleId: null, reason: "no_rule" });
    assert.deepEqual(routeFacts(facts(), [ZERO, rule({ words: ["tuna"] }, KB)]), { kind: "review", ruleId: null, reason: "no_rule" });
  });
  it("PII without redact:true → Review (also from the first matching rule: it does not fall through to a later one)", () => {
    const first = rule({}, KB, 2);
    const later = rule({}, { deliver: "inbox", redact: true }, 3);
    for (const cls of ["email", "phone", "iban", "card", "id", "address", "special"]) {
      assert.deepEqual(routeFacts(facts({ classes: { [cls]: 1 } }), [ZERO, first, later]), { kind: "review", ruleId: first.id, reason: "pii_needs_redact" }, cls);
    }
    assert.deepEqual(routeFacts(facts({ classes: { email: 1 } }), [ZERO, rule({}, { deliver: "knowledge", redact: false })]).kind, "review");
  });
  it("PII with redact:true is delivered redacted; no PII is delivered as it is", () => {
    const r = rule({}, { deliver: "knowledge", redact: true });
    assert.deepEqual(routeFacts(facts({ classes: { email: 1, phone: 2 } }), [ZERO, r]), { kind: "deliver", ruleId: r.id, destination: "knowledge", redact: true });
    assert.deepEqual(routeFacts(facts(), [ZERO, r]), { kind: "deliver", ruleId: r.id, destination: "knowledge", redact: true });
    assert.deepEqual(routeFacts(facts(), [ZERO, rule({}, KB)]), { kind: "deliver", ruleId: `rul_x${rn}_${rn}`, destination: "knowledge", redact: false });
  });
  it("a drop rule drops (also a record with PII); an unknown destination goes to Review", () => {
    const drop = rule({ senders: ["@spam.example"] }, { deliver: "drop" });
    assert.deepEqual(routeFacts(facts({ authors: ["email:x@spam.example"], classes: { email: 1 } }), [ZERO, drop]), { kind: "drop", ruleId: drop.id, reason: "rule" });
    assert.equal(routeFacts(facts(), [ZERO, rule({}, { deliver: "carrier-pigeon" })]).kind, "review");
  });
  it("rule 0 is never matched as an owner rule: a record with PII but no secret ignores its match", () => {
    assert.equal(routeFacts(facts({ classes: { secret: 0 } }), [ZERO]).kind, "review");
  });
});

describe("applyRouting on the database", () => {
  let db: Db;
  let src: string;
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const O = (): OpContext => ctxFor(db, OWNER);
  const put = (match: Record<string, unknown>, action: Record<string, unknown>) => handlers.rule_put.run({ position: 1, match, action } as never, O());
  const record = (texts: string[], state = "open", author = "email:anna@example.com") => {
    const rec = seedRecord(db, src, { state });
    for (const [i, t] of texts.entries()) seedMessage(db, src, { id: `m${Math.random()}`, record: rec, text: t, author, sentAt: now - 1000 + i });
    return rec;
  };
  const row = (rec: string) => ({ ...db.prepare("SELECT * FROM obs_records WHERE id = ?").get(rec) });

  beforeEach(async () => {
    db = migratedDb();
    setClock(() => now);
    await start(db);
    src = seedSource(db, { conversations: ["inbox"] });
  });

  it("a secret record is dropped by rule 0 even with a catch-all rule above every other; the secret flag and class are stored", async () => {
    await put({}, KB);
    const rec = record([`the key is ${SECRET_MARKER} ok`]);
    const out = applyRouting(db, rec, now);
    assert.deepEqual(out.route, { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" });
    const r = row(rec);
    assert.deepEqual([r.state, r.secret, r.rule_id, r.decided_by, JSON.parse(String(r.pii_json))], ["dropped", 1, RULE_ZERO_ID, `rule:${RULE_ZERO_ID}`, { secret: 1 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);
    assert.equal(Number(r.text_purge_at), now + 30 * 86_400_000);
  });
  it("a plain record that a rule matches is approved with one pending outbox row for the rule's destination", async () => {
    const rule1 = (await put({ words: ["invoice"] }, { deliver: "kanban" })) as { rule: { id: string } };
    const rec = record(["please send me the invoice today"]);
    const out = applyRouting(db, rec, now);
    assert.deepEqual(out.route, { kind: "deliver", ruleId: rule1.rule.id, destination: "kanban", redact: false });
    const r = row(rec);
    assert.deepEqual([r.state, r.decided_destination, r.rule_id, r.decided_by, r.actionable], ["approved", "kanban", rule1.rule.id, `rule:${rule1.rule.id}`, 1]);
    const d = db.prepare("SELECT destination, status, input_json FROM obs_deliveries WHERE record_id = ?").all(rec).map((x) => ({ ...x }));
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]?.destination, d[0]?.status], ["kanban", "pending"]);
    assert.equal(JSON.parse(String(d[0]?.input_json)).decision, "deliver");
  });
  it("PII: without redact the record waits in Review and its classes are stored; with redact it is delivered as deliver_redacted", async () => {
    await put({ words: ["invoice"] }, KB);
    const rec = record(["invoice for anna@example.com, call +421 911 123 456"]);
    const out = applyRouting(db, rec, now);
    assert.equal(out.route.kind === "review" && out.route.reason, "pii_needs_redact");
    assert.deepEqual([row(rec).state, JSON.parse(String(row(rec).pii_json))], ["review", { email: 1, phone: 1 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_deliveries").get()?.c, 0);

    const db2 = migratedDb();
    await start(db2);
    const s2 = seedSource(db2, { conversations: ["inbox"] });
    await handlers.rule_put.run({ position: 1, match: { words: ["invoice"] }, action: { deliver: "knowledge", redact: true } } as never, ctxFor(db2, OWNER));
    const rec2 = seedRecord(db2, s2, { state: "open" });
    seedMessage(db2, s2, { record: rec2, text: "invoice for anna@example.com" });
    applyRouting(db2, rec2, now);
    const d = db2.prepare("SELECT input_json FROM obs_deliveries WHERE record_id = ?").get(rec2);
    assert.equal(JSON.parse(String(d?.input_json)).decision, "deliver_redacted");
    assert.equal(db2.prepare("SELECT state FROM obs_records WHERE id = ?").get(rec2)?.state, "approved");
  });
  it("no matching rule → Review with the classes; a drop rule drops; a record with no text → Review", async () => {
    const plain = record(["lunch at noon"]);
    assert.deepEqual(applyRouting(db, plain, now).route, { kind: "review", ruleId: null, reason: "no_rule" });
    assert.equal(row(plain).state, "review");
    await put({ senders: ["@spam.example"] }, { deliver: "drop" });
    const spam = record(["buy now"], "open", "email:x@spam.example");
    assert.equal(applyRouting(db, spam, now).route.kind, "drop");
    assert.equal(row(spam).state, "dropped");
    const empty = seedRecord(db, src, { state: "open" });
    seedMessage(db, src, { record: empty, text: null });
    assert.deepEqual(applyRouting(db, empty, now).route, { kind: "review", ruleId: null, reason: "no_text" });
  });
  it("owner keyword lists and the gov-id country list come from obs_settings", async () => {
    await put({ actionable: true }, { deliver: "inbox" });
    const t = record(["the renewal terms"]);
    assert.equal(applyRouting(db, t, now).route.kind, "review");
    db.prepare("INSERT INTO obs_settings (key, value) VALUES ('actionable_words', '[\"renewal\"]')").run();
    const t2 = record(["the renewal terms"]);
    assert.equal(applyRouting(db, t2, now).route.kind, "deliver");
    const ssn = record(["number 123-45-6789"]);
    applyRouting(db, ssn, now);
    assert.deepEqual(JSON.parse(String(row(ssn).pii_json)), { id: 1 });
    db.prepare("INSERT INTO obs_settings (key, value) VALUES ('gov_id_countries', '[\"SK\"]')").run();
    const ssn2 = record(["number 123-45-6789"]);
    applyRouting(db, ssn2, now);
    assert.deepEqual(JSON.parse(String(row(ssn2).pii_json)), {});
  });
  it("only a record that is open or classified can be routed (record_state_invalid, 409); a missing one is not_found", () => {
    for (const state of ["review", "approved", "delivered", "dropped"]) {
      const rec = record(["text"], state);
      assert.throws(() => applyRouting(db, rec, now), { code: "record_state_invalid" });
      assert.equal(row(rec).state, state);
    }
    assert.throws(() => applyRouting(db, "rec_01J00000000000000000000000", now), { code: "not_found" });
    assert.doesNotThrow(() => applyRouting(db, record(["text"], "classified"), now));
  });
  it("a secret flag already on the record (from ingest) is enough, even when no text is left", () => {
    const rec = seedRecord(db, src, { state: "open", secret: true });
    assert.equal(applyRouting(db, rec, now).route.kind, "drop");
  });
  it("the whole routing is one transaction: a failure leaves the record as it was", async () => {
    await put({}, KB);
    const rec = record(["hello there friend"]);
    db.exec("CREATE TRIGGER no_insert BEFORE INSERT ON obs_deliveries BEGIN SELECT RAISE(ABORT, 'nope'); END");
    assert.throws(() => applyRouting(db, rec, now));
    assert.deepEqual([row(rec).state, row(rec).rule_id], ["open", null]);
  });
});
