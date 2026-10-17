// Routing page (src/ui/routing.tsx): the ordered rules, rule 0 locked, add / edit / move / delete.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alerts, assertWriteHeaders, callsOf, click, compileUi, control, flush, h, lastCall, mount, openDialog, RULE_ZERO, reset, stub, type, within } from "./ui-harness.ts";

const ui = compileUi("routing");
type Routing = typeof import("../src/ui/routing.tsx");
const page = async () => (await ui<Routing>("routing.js")).RoutingPage;
const items = (host: Element) => [...within(host, "Rules").querySelectorAll(".item")];
const item = (host: Element, position: number) => {
  const found = items(host).find((i) => i.querySelector("h3")?.textContent?.startsWith(`${position}.`));
  assert.ok(found, `rule ${position}`);
  return found;
};

describe("Routing", () => {
  it("lists the rules in order; rule 0 is shown locked and offers no edit, move or delete", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Routing");
    assert.deepEqual(items(m.host).map((i) => i.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim()), ["0. Remove the secrets Observer recognises locked", "1. To Knowledge", "2. To Task Board", "3. Drop"]);
    const zero = item(m.host, 0);
    assert.deepEqual([...zero.querySelectorAll(".tb-tag")].map((t) => t.textContent), ["locked"]);
    assert.equal(zero.querySelectorAll("button").length, 0);
    assert.match(zero.textContent ?? "", /removed before anything is stored/);
    assert.match(zero.textContent ?? "", /Records with a possible secret are held for your review\./);
    assert.match(zero.textContent ?? "", /It cannot be changed, moved or deleted\./);
    assert.match(item(m.host, 1).querySelector("p")?.textContent ?? "", /Work inbox; mentions “invoice” → .*Knowledge · area Clients · as draft · deliver redacted/);
    assert.match(item(m.host, 2).querySelector("p")?.textContent ?? "", /Clinic partners; asks for an action → .*Task Board · project Observer intake/);
    assert.match(item(m.host, 3).querySelector("p")?.textContent ?? "", /at least 1 word → drop, keep no text/);
    await m.unmount();
  });

  it("never says Observer keeps no secrets or removes all of them", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.doesNotMatch(m.host.textContent ?? "", /never keeps? secrets|all (the )?secrets|every secret|no secret/i);
    await m.unmount();
  });

  it("shows an empty state when there are no rules and an error with Try again when the load fails", async () => {
    reset();
    stub.rules = [];
    const m = await mount(h(await page(), {}));
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /No rules/);
    await m.unmount();
    reset();
    stub.fail.rules_list = { status: 500, code: "internal" };
    const bad = await mount(h(await page(), {}));
    assert.match(alerts(bad.host)[0] ?? "", /Something went wrong/);
    assert.equal(bad.host.querySelector(".tb-empty"), null);
    await bad.unmount();
  });

  it("a destination Observer cannot reach is said on the rule; the dialog greys it", async () => {
    reset();
    stub.targets = ["connect", "knowledge"];
    const m = await mount(h(await page(), {}));
    assert.match(item(m.host, 2).textContent ?? "", /Task Board is not available now: matching records wait in Review\./);
    assert.doesNotMatch(item(m.host, 1).textContent ?? "", /not available now/);
    await click(control(m.host, "New rule"));
    const dialog = openDialog(m.host);
    const choice = (title: string) => [...dialog.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.startsWith(title)) as Element;
    assert.equal(choice("Knowledge").getAttribute("aria-disabled"), null);
    assert.equal(choice("Task Board").getAttribute("aria-disabled"), "true");
    assert.equal(choice("Operator Inbox").getAttribute("aria-disabled"), "true");
    assert.match(choice("Task Board").textContent ?? "", /Not available now\./);
    assert.equal(choice("Drop").getAttribute("aria-disabled"), null);
    await m.unmount();
  });

  it("New rule sends rule_put at the end of the list with the match and action the form describes", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "New rule"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /With no condition the rule matches every record/);
    const areas = [...dialog.querySelectorAll("textarea")];
    await type(areas[0] as Element, "invoice*\nrefund");
    await click([...dialog.querySelectorAll(".tb-check")].find((c) => c.textContent?.startsWith("email address"))?.querySelector("input") as Element);
    await click([...dialog.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.startsWith("Task Board")) as Element);
    const project = [...dialog.querySelectorAll("input:not([type=checkbox])")].find((i) => i.closest("label")?.textContent?.startsWith("Task Board project")) as Element;
    await type(project, "Intake");
    await click(control(dialog, "Add the rule"));
    await flush();
    const c = lastCall("rule_put");
    assert.deepEqual(c.input, { position: 4, match: { words: ["invoice*", "refund"], pii: ["email"] }, action: { deliver: "kanban", redact: false, project: "Intake" } });
    assertWriteHeaders(c);
    assert.ok(callsOf("rules_list").length >= 2, "the list reloads");
    await m.unmount();
  });

  it("Edit starts from the rule, keeps the id and position, and keeps conditions the form does not show", async () => {
    reset();
    stub.rules = [...(stub.rules as { id: string }[])];
    const clients = (stub.rules as { id: string; match: Record<string, unknown> }[])[1];
    if (clients) clients.match.conversations = ["clients"];
    const m = await mount(h(await page(), {}));
    await click(control(item(m.host, 1), "Edit"));
    const dialog = openDialog(m.host);
    assert.equal((dialog.querySelector("textarea") as HTMLTextAreaElement).value, "invoice");
    const sw = dialog.querySelector('input[role="switch"]') as HTMLInputElement;
    assert.equal(sw.checked, true, "redact is on");
    await click(sw);
    await click(control(dialog, "Save the rule"));
    await flush();
    const c = lastCall("rule_put");
    assert.deepEqual(c.input, { id: "rul_clients", position: 1, match: { conversations: ["clients"], sources: ["src_gmail"], words: ["invoice"] }, action: { deliver: "knowledge", redact: false, area: "Clients", knowledgeStatus: "draft" } });
    assertWriteHeaders(c);
    await m.unmount();
  });

  it("a refused rule stays in the dialog with a plain sentence", async () => {
    reset();
    stub.fail.rule_put = { status: 400, code: "rule_word_invalid" };
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "New rule"));
    const dialog = openDialog(m.host);
    await type(dialog.querySelector("textarea") as Element, "ab*");
    await click(control(dialog, "Add the rule"));
    await flush();
    assert.deepEqual(alerts(dialog), ["A word in the rule is not usable. Use words of at least 3 letters, none empty, none just *."]);
    assert.ok(openDialog(m.host));
    await m.unmount();
  });

  it("Down sends rules_reorder with rule 0 still first; the first rule cannot go above rule 0", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.ok(control(item(m.host, 1), "Up").disabled);
    assert.ok(control(item(m.host, 3), "Down").disabled);
    await click(control(item(m.host, 1), "Down"));
    await flush();
    const c = lastCall("rules_reorder");
    assert.deepEqual(c.input, { ids: [RULE_ZERO, "rul_support", "rul_clients", "rul_small"] });
    assertWriteHeaders(c);
    await m.unmount();
  });

  it("Delete asks first, then sends rule_delete", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(item(m.host, 3), "Delete"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /Records that matched it will match the next rule, or wait in Review\./);
    assert.equal(callsOf("rule_delete").length, 0);
    await click(control(dialog, "Delete the rule"));
    await flush();
    const c = lastCall("rule_delete");
    assert.deepEqual(c.input, { id: "rul_small" });
    assertWriteHeaders(c);
    await m.unmount();
  });

  it("a refused move shows the sentence and the list stays", async () => {
    reset();
    stub.fail.rules_reorder = { status: 400, code: "rules_mismatch" };
    const m = await mount(h(await page(), {}));
    await click(control(item(m.host, 1), "Down"));
    await flush();
    assert.deepEqual(alerts(m.host), ["The rules changed in the meantime. Reload the page and try again."]);
    assert.equal(items(m.host).length, 4);
    await m.unmount();
  });
});

describe("ruleOf", () => {
  it("drops the keys that do not apply to the destination", async () => {
    const { ruleOf } = await ui<Routing>("routing.js");
    const form = { sources: [], words: "", senders: "", pii: [], actionable: "any", minWords: "", deliver: "drop", area: "x", project: "y", assignee: "z", priority: "high", redact: true, status: "published" } as never;
    assert.deepEqual(ruleOf(form, null), { match: {}, action: { deliver: "drop" } });
    assert.deepEqual(ruleOf({ ...(form as object), deliver: "inbox" } as never, null).action, { deliver: "inbox", redact: true, priority: "high" });
  });
});
