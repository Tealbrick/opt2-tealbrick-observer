// The filter of the Review list and of the conversation list of Add source (C382 batch 4).
// Review: a filter by text, source and reason over the records loaded so far (review_list has no filter and is paged), each record
// stays its own decision, and the records that wait for a decision and a filter hides are counted. Add source: a filter ONLY, no
// "select all"; a conversation that is picked and hidden by the filter stays picked and counted.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { alerts, callsOf, click, compileUi, control, flush, h, mount, openDialog, reset, stub, type, win } from "./ui-harness.ts";

Object.defineProperty(globalThis, "localStorage", { value: win.localStorage, configurable: true, writable: true });
Object.defineProperty(globalThis, "HTMLInputElement", { value: win.HTMLInputElement, configurable: true, writable: true });

const ui = compileUi("lists-filter");
type Review = typeof import("../src/ui/review.tsx");
type AddSource = typeof import("../src/ui/addsource.tsx");

const mounted: { unmount: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount().catch(() => {});
});
const track = async <T extends { unmount: () => Promise<void> }>(p: Promise<T>): Promise<T> => {
  const m = await p;
  mounted.push(m);
  return m;
};

const text = (host: Element) => (host.textContent ?? "").replace(/\s+/g, " ");
const input = (host: Element) => host.querySelector("input[type=text], input:not([type])") as HTMLInputElement;
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const KEY = "tb-filter:observer:";
const remember = (screen: string, v: string) => localStorage.setItem(`${KEY}${screen}`, v);
const alertText = (host: Element) => alerts(host).join(" ");

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const record = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `rec_${n}`,
  source: n % 2 ? "src_gmail" : "src_tg",
  thread: `Thread number ${n}`,
  windowStart: iso(NOW - 3 * 3_600_000),
  windowEnd: iso(NOW - 2 * 3_600_000),
  revision: 1,
  state: "review",
  pii: n % 3 === 0 ? { email: 1 } : {},
  secret: false,
  possibleSecret: false,
  problem: null,
  ruleId: null,
  actionable: false,
  decidedBy: null,
  decidedAt: null,
  textPurgeAt: iso(NOW + 30 * 86_400_000),
  createdAt: iso(NOW - 3 * 3_600_000),
  updatedAt: iso(NOW - 2 * 3_600_000),
  ...extra,
});

async function mountReview() {
  const { ReviewPage } = await ui<Review>("review.js");
  const Wrapper = () => {
    const [id, setId] = useState<string | null>(null);
    return h(ReviewPage, { recordId: id, onOpen: setId, hrefOf: (x: string) => `./review/${x}`, onCount: () => {} });
  };
  return track(mount(h(Wrapper, {})));
}
const rowsOf = (host: Element) => host.querySelectorAll('nav[aria-label="Records waiting"] a.ob-row');
const setup = (n: number) => {
  reset();
  localStorage.clear();
  stub.review = Array.from({ length: n }, (_, i) => record(i + 1));
  stub.out.review_get = (i: Record<string, unknown>) => ({ record: { ...(stub.review.find((x) => (x as { id: string }).id === i.id) as object), messages: [] } });
};

describe("Review filter", () => {
  it("a short list shows no filter bar", async () => {
    setup(3);
    const m = await mountReview();
    assert.equal(rowsOf(m.host).length, 3);
    assert.equal(m.host.querySelector('input[type="text"], input:not([type])'), null);
  });

  it("a long list: text filter shows N of M, counts the records that wait for a decision and it hides, Clear restores", async () => {
    setup(10);
    const m = await mountReview();
    assert.equal(rowsOf(m.host).length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await type(input(m.host), "number 7");
    assert.equal(rowsOf(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 10 records\./);
    assert.match(alertText(m.host), /9 records that wait for your decision are hidden by the filter\./);
    await click(control(m.host, "Clear filter"));
    await flush();
    assert.equal(rowsOf(m.host).length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
  });

  it("typing a filter never swaps the open record: it stays while shown; when the filter hides it, no record is open", async () => {
    setup(10);
    const m = await mountReview();
    const open = () => m.host.querySelector('[aria-label="Record"] h2')?.textContent ?? null;
    assert.equal(open(), "Thread number 1");
    const loads = () => callsOf("review_get").map((c) => c.input.id);
    await type(input(m.host), "number 1");
    assert.deepEqual([...rowsOf(m.host)].map((r) => r.querySelector("b")?.textContent), ["Thread number 1", "Thread number 10"]);
    assert.equal(open(), "Thread number 1", "still the same record while it is shown");
    await type(input(m.host), "number 7");
    await flush();
    assert.equal(open(), null, "the filter hides the open record: none is open");
    assert.match(text(m.host), /Pick a record\./);
    assert.ok(!loads().includes("rec_7"), "no other record was opened for the owner");
    assert.equal(buttons(m.host, "Drop").length, 0, "no decision buttons of another record");
    await click(control(m.host, "Clear filter"));
    await flush();
    assert.equal(open(), "Thread number 1");
  });

  it("filters by source and by reason; each record keeps its own decision buttons and there is no bulk action", async () => {
    setup(10);
    stub.sources = [
      { id: "src_gmail", label: "Work inbox" },
      { id: "src_tg", label: "Clinic partners" },
    ];
    const m = await mountReview();
    remember("review:source", "src_tg");
    await m.unmount();
    mounted.length = 0;
    const again = await mountReview();
    assert.equal(rowsOf(again.host).length, 5, "even records are from the Clinic source");
    assert.match(text(again.host), /Showing 5 of 10 records\./);
    assert.match(alertText(again.host), /5 records that wait for your decision are hidden by the filter\./);
    remember("review:reason", "pii:email");
    await again.unmount();
    mounted.length = 0;
    const third = await mountReview();
    assert.deepEqual(
      [...rowsOf(third.host)].map((r) => r.querySelector("b")?.textContent),
      ["Thread number 6"],
      "even and with an email address: 6",
    );
    const all = text(third.host);
    assert.doesNotMatch(all, /Approve all|Deliver all|Drop all|Select all/);
    assert.ok(buttons(third.host, "Drop").length >= 1, "the open record has its own Drop");
    await click(control(third.host, "Clear filter"));
    await flush();
    assert.equal(localStorage.getItem(`${KEY}review:source`), "");
    assert.equal(localStorage.getItem(`${KEY}review:reason`), "");
    assert.equal(rowsOf(third.host).length, 10);
  });

  it("a remembered filter is on after a reload: the bar shows the text, N of M and the hidden count even for a short list", async () => {
    setup(3);
    remember("review", "number 2");
    const m = await mountReview();
    assert.equal(input(m.host).value, "number 2");
    assert.match(text(m.host), /Showing 1 of 3 records\./);
    assert.match(alertText(m.host), /2 records that wait for your decision are hidden by the filter\./);
  });

  it("a paged list: no match says only the loaded records were read and Show more is in reach; Show more finds the older record", async () => {
    setup(0);
    const all = Array.from({ length: 60 }, (_, i) => record(i + 1));
    stub.out.review_list = (i: Record<string, unknown>) => (i.cursor ? { items: all.slice(50), nextCursor: null } : { items: all.slice(0, 50), nextCursor: "c1" });
    stub.out.review_get = (i: Record<string, unknown>) => ({ record: { ...(all.find((x) => x.id === i.id) as object), messages: [] } });
    remember("review", "number 58\\b");
    const m = await mountReview();
    assert.equal(rowsOf(m.host).length, 0);
    assert.match(text(m.host), /No loaded record matches\./);
    assert.match(text(m.host), /The filter searches only the 50 records loaded so far\./);
    assert.match(text(m.host), /Showing 0 of 50 loaded records\./);
    assert.ok(buttons(m.host, "Show more").length >= 1, "Show more is in reach");
    await click(buttons(m.host, "Show more")[0] as Element);
    await flush();
    assert.deepEqual(callsOf("review_list").at(-1)?.input, { cursor: "c1" });
    assert.equal(rowsOf(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 60 records\./);
    assert.doesNotMatch(text(m.host), /loaded so far/);
  });

  it("a complete list with no match says all records were searched", async () => {
    setup(3);
    remember("review", "zzz");
    const m = await mountReview();
    assert.match(text(m.host), /No record matches\. The filter searched all 3 records\./);
  });
});

describe("Add source: conversation filter", () => {
  const MANY = Array.from({ length: 12 }, (_, i) => ({ id: `conv_${i}`, title: `Label “Team ${i}”`, estimate: 10 + i }));
  const mountFlow = async () => {
    reset();
    localStorage.clear();
    stub.accounts = [{ id: "acc_gmail", kind: "gmail", label: "work@example.com", historyCapable: true, retentionDays: null, conversations: MANY }] as never;
    const { AddSource } = await ui<AddSource>("addsource.js");
    const m = await track(mount(h(AddSource, { open: true, accounts: stub.accounts as never, onClose: () => {}, onDone: () => {} })));
    const dialog = openDialog(m.host);
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(control(dialog, "Next"));
    await flush();
    return { m, dialog, step: dialog.querySelector('[data-step="1"]') as Element };
  };
  const boxes = (step: Element) => [...step.querySelectorAll('.tb-check input[type="checkbox"]')] as HTMLInputElement[];
  const filterInput = (step: Element) => step.querySelector('input[type="text"], input:not([type]):not([type=checkbox])') as HTMLInputElement;

  it("a long list has a filter, and it has no Select all", async () => {
    const { step } = await mountFlow();
    assert.equal(boxes(step).length, 12);
    assert.doesNotMatch(text(step), /Select all|Choose all|All shown/i);
    await type(filterInput(step), "Team 7");
    assert.equal(boxes(step).length, 1);
    assert.match(text(step), /Showing 1 of 12 conversations\./);
    await click(control(step, "Clear filter"));
    await flush();
    assert.equal(boxes(step).length, 12);
    assert.equal(boxes(step).filter((b) => b.checked).length, 0, "the filter picked nothing");
  });

  it("a conversation that is picked and hidden by the filter stays picked and counted", async () => {
    const { dialog, step } = await mountFlow();
    await click(boxes(step)[2] as Element);
    assert.match(text(step), /1 chosen\./);
    await type(filterInput(step), "Team 7");
    assert.equal(boxes(step).length, 1);
    assert.match(text(step), /1 chosen, 1 hidden by the filter\./);
    assert.ok(!control(dialog, "Next").disabled, "the hidden pick still counts: Next stays on");
    await click(boxes(step)[0] as Element);
    assert.match(text(step), /2 chosen, 1 hidden by the filter\./);
    await click(control(step, "Clear filter"));
    await flush();
    const checked = boxes(step).filter((b) => b.checked);
    assert.equal(checked.length, 2, "both picks are shown again");
    assert.doesNotMatch(text(step), /hidden by the filter/);
  });

  it("the picks are sent as they are: the hidden one goes to source_add", async () => {
    const { dialog, step } = await mountFlow();
    await click(boxes(step)[2] as Element);
    await type(filterInput(step), "Team 7");
    await click(control(dialog, "Next"));
    await flush();
    const label = dialog.querySelector('[data-step="2"] input') as HTMLInputElement;
    await type(label, "Work");
    await click(control(dialog, "Add source"));
    await flush();
    assert.deepEqual(callsOf("source_add").at(-1)?.input.conversations, ["conv_2"]);
  });

  it("no match says all conversations were searched; a remembered filter shows after a reload", async () => {
    reset();
    localStorage.clear();
    remember("addsource", "zzz");
    stub.accounts = [{ id: "acc_gmail", kind: "gmail", label: "work@example.com", historyCapable: true, retentionDays: null, conversations: MANY }] as never;
    const { AddSource } = await ui<AddSource>("addsource.js");
    const m = await track(mount(h(AddSource, { open: true, accounts: stub.accounts as never, onClose: () => {}, onDone: () => {} })));
    const dialog = openDialog(m.host);
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(control(dialog, "Next"));
    await flush();
    const step = dialog.querySelector('[data-step="1"]') as Element;
    assert.equal(filterInput(step).value, "zzz");
    assert.match(text(step), /No conversation matches\. The filter searched all 12 conversations\./);
  });

  it("a short list shows no filter bar", async () => {
    reset();
    localStorage.clear();
    const { AddSource } = await ui<AddSource>("addsource.js");
    const m = await track(mount(h(AddSource, { open: true, accounts: stub.accounts as never, onClose: () => {}, onDone: () => {} })));
    const dialog = openDialog(m.host);
    await click(dialog.querySelector('[role="radio"]') as Element);
    await click(control(dialog, "Next"));
    await flush();
    const step = dialog.querySelector('[data-step="1"]') as Element;
    assert.equal(boxes(step).length, 3);
    assert.equal(step.querySelector('input[type="text"], input:not([type]):not([type=checkbox])'), null);
  });
});
