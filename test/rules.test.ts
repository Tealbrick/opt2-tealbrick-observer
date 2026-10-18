// Routing rules: rule 0 "never keep secrets" is created at start and locked; first match decides, so order is the contract.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, setClock } from "../src/app.ts";
import { MAX_RULES, RULE_ZERO_ID } from "../src/store.ts";
import { ctxFor, migratedDb, OWNER, start } from "./helpers.ts";

type Out = Record<string, any>;
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const rejects = async (p: Promise<unknown>, code: string, status?: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => {
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });

let db: Db;
let now: number;
const O = () => ctxFor(db, OWNER);
const ids = async (): Promise<string[]> => (await run("rules_list", {}, O())).rules.map((r: Out) => r.id);
const KB = { deliver: "knowledge" };
const put = (position: number, extra: Record<string, unknown> = {}) => run("rule_put", { position, match: { words: ["invoice"] }, action: KB, ...extra }, O());

beforeEach(async () => {
  db = migratedDb();
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  await start(db);
});

describe("rules_list targets", () => {
  it("lists the apps the slice reaches (none when the SDK cannot say), so the UI can grey a destination", async () => {
    assert.deepEqual((await run("rules_list", {}, O())).targets, []);
    assert.deepEqual((await run("rules_list", {}, ctxFor(db, OWNER, { targets: ["kanban", "knowledge", "unknown"] }))).targets, ["knowledge", "kanban"]);
  });
});

describe("rule 0", () => {
  it("onStart creates it: first, locked, drops secrets; starting again changes nothing", async () => {
    const before = (await run("rules_list", {}, O())).rules;
    assert.deepEqual(before, [{ id: RULE_ZERO_ID, position: 0, locked: true, match: { pii: ["secret"] }, action: { deliver: "drop", redact: false } }]);
    assert.equal(RULE_ZERO_ID, "rul_00000000000000000000000000");
    await start(db);
    assert.deepEqual((await run("rules_list", {}, O())).rules, before);
  });
  it("onStart puts back a rule 0 that was edited or moved in the database", async () => {
    await put(1);
    db.prepare("UPDATE obs_rules SET locked = 0, position = 5, action_json = '{\"deliver\":\"knowledge\"}' WHERE id = ?").run(RULE_ZERO_ID);
    await start(db);
    const rules = (await run("rules_list", {}, O())).rules;
    assert.deepEqual([rules[0].id, rules[0].locked, rules[0].action.deliver, rules[0].position], [RULE_ZERO_ID, true, "drop", 0]);
    assert.deepEqual(rules.map((r: Out) => r.position), [0, 1]);
  });
  it("cannot be deleted, edited or moved (rule_locked, 409), and nothing changes", async () => {
    await put(1);
    const order = await ids();
    await rejects(run("rule_delete", { id: RULE_ZERO_ID }, O()), "rule_locked", 409);
    await rejects(run("rule_put", { id: RULE_ZERO_ID, position: 0, match: {}, action: KB }, O()), "rule_locked", 409);
    await rejects(run("rule_put", { id: RULE_ZERO_ID, position: 3, match: { pii: ["secret"] }, action: { deliver: "drop" } }, O()), "rule_locked", 409);
    await rejects(run("rules_reorder", { ids: [...order].reverse() }, O()), "rule_locked", 409);
    assert.deepEqual(await ids(), order);
    assert.deepEqual((await run("rules_list", {}, O())).rules[0].action, { deliver: "drop", redact: false });
  });
  it("no other rule may take position 0", async () => {
    await rejects(put(0), "rule_locked", 409);
    assert.deepEqual(await ids(), [RULE_ZERO_ID]);
  });
});

describe("rule_put", () => {
  it("adds rules at the given position and shifts the others; positions stay dense and rule 0 stays first", async () => {
    const a = (await put(1)).rule.id;
    const b = (await put(1)).rule.id;
    const c = (await put(2)).rule.id;
    const d = (await put(99)).rule.id; // beyond the end = last
    assert.deepEqual(await ids(), [RULE_ZERO_ID, b, c, a, d]);
    assert.deepEqual((await run("rules_list", {}, O())).rules.map((r: Out) => r.position), [0, 1, 2, 3, 4]);
    assert.match(a, /^rul_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("changes a rule and moves it; an unknown id is not_found (a rule is never created under a chosen id)", async () => {
    const a = (await put(1)).rule.id;
    const b = (await put(2)).rule.id;
    const out = await run("rule_put", { id: a, position: 2, match: { senders: ["boss@example.com"] }, action: { deliver: "inbox", priority: "high" } }, O());
    assert.deepEqual([out.rule.id, out.rule.position, out.rule.match, out.rule.action], [a, 2, { senders: ["boss@example.com"] }, { deliver: "inbox", priority: "high" }]);
    assert.deepEqual(await ids(), [RULE_ZERO_ID, b, a]);
    await rejects(run("rule_put", { id: "rul_01J00000000000000000000000", position: 1, match: {}, action: KB }, O()), "not_found", 404);
  });
  it("Knowledge deliveries are drafts unless the rule says published", async () => {
    assert.equal((await put(1)).rule.action.knowledgeStatus, "draft");
    assert.equal((await put(2, { action: { deliver: "knowledge", knowledgeStatus: "published" } })).rule.action.knowledgeStatus, "published");
    assert.equal((await put(3, { action: { deliver: "inbox" } })).rule.action.knowledgeStatus, undefined);
  });
  it("holds at most 200 rules (rules_limit); a change still works at the limit", async () => {
    for (let i = 1; i < MAX_RULES; i++) db.prepare("INSERT INTO obs_rules (id, position, locked, match_json, action_json, created_at, updated_at) VALUES (?, ?, 0, '{}', '{\"deliver\":\"inbox\"}', 1, 1)").run(`rul_x${i}`, i);
    assert.equal((await ids()).length, MAX_RULES);
    await rejects(put(1), "rules_limit", 409);
    assert.ok(await run("rule_put", { id: "rul_x5", position: 1, match: {}, action: KB }, O()));
  });
});

describe("rule_delete and rules_reorder", () => {
  it("deletes a rule and closes the gap; deleting a missing rule says deleted false", async () => {
    const a = (await put(1)).rule.id;
    const b = (await put(2)).rule.id;
    assert.deepEqual(await run("rule_delete", { id: a }, O()), { deleted: true });
    assert.deepEqual(await run("rule_delete", { id: a }, O()), { deleted: false });
    assert.deepEqual(await ids(), [RULE_ZERO_ID, b]);
    assert.deepEqual((await run("rules_list", {}, O())).rules.map((r: Out) => r.position), [0, 1]);
  });
  it("reorders: the full list, rule 0 first", async () => {
    const a = (await put(1)).rule.id;
    const b = (await put(2)).rule.id;
    const c = (await put(3)).rule.id;
    const out = await run("rules_reorder", { ids: [RULE_ZERO_ID, c, a, b] }, O());
    assert.deepEqual(out.rules.map((r: Out) => r.id), [RULE_ZERO_ID, c, a, b]);
    assert.deepEqual(await ids(), [RULE_ZERO_ID, c, a, b]);
  });
  it("refuses a list that misses a rule, repeats one or names an unknown one (rules_mismatch, 400)", async () => {
    const a = (await put(1)).rule.id;
    const b = (await put(2)).rule.id;
    const before = await ids();
    for (const bad of [[RULE_ZERO_ID, a], [RULE_ZERO_ID, a, a], [RULE_ZERO_ID, a, b, "rul_01J00000000000000000000000"], [RULE_ZERO_ID, a, "rul_01J00000000000000000000000"], []]) {
      await rejects(run("rules_reorder", { ids: bad }, O()), "rules_mismatch", 400);
    }
    assert.deepEqual(await ids(), before);
  });
});

describe("rule words", () => {
  it("rule_put refuses empty words, '*' and stems under 3 letters (rule_word_invalid, 400) and stores nothing", async () => {
    for (const bad of [[""], ["   "], ["*"], ["ab*"], ["ok", "*"], ["x*"], ["*ab"], ["fine", "co*"]]) {
      await rejects(run("rule_put", { position: 1, match: { words: bad }, action: KB }, O()), "rule_word_invalid", 400);
    }
    assert.deepEqual(await ids(), [RULE_ZERO_ID]);
  });
  it("quiet on good: words, stems of 3+ letters, phrases and suffixes are stored; a rule without words is fine", async () => {
    for (const words of [["invoice"], ["inv*"], ["sick leave"], ["*krebs"], ["a"], ["faktúr*", "platba"]]) {
      assert.ok((await run("rule_put", { position: 1, match: { words }, action: KB }, O())).rule.id, JSON.stringify(words));
    }
    assert.ok((await run("rule_put", { position: 1, match: {}, action: KB }, O())).rule.id);
  });
  it("a rule whose words are all unusable (stored before the check existed) matches nothing instead of everything", async () => {
    const { matches } = await import("../src/router.ts");
    const f = { source: "s", conversations: [], authors: [], text: "any text at all", classes: {}, secret: false, actionable: false, words: 4 };
    assert.equal(matches({ words: ["*"] }, f), false);
    assert.equal(matches({ words: ["ab*", ""] }, f), false);
    assert.equal(matches({ words: ["ab*", "text"] }, f), true, "the usable word still works");
  });
});
