// Sources page (src/ui/sources.tsx, addsource.tsx, history.tsx) against the real SDK client and the stub server.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alerts, assertWriteHeaders, callsOf, choose, click, compileUi, control, flush, h, lastCall, mount, openDialog, reset, SRC_NEW, stub, type } from "./ui-harness.ts";

const ui = compileUi("sources");
type Sources = typeof import("../src/ui/sources.tsx");
type AddSource = typeof import("../src/ui/addsource.tsx");
const page = async () => (await ui<Sources>("sources.js")).SourcesPage;
const card = (host: Element, label: string) => {
  const found = host.querySelector(`article[aria-label="${label}"]`);
  assert.ok(found, `card ${label}`);
  return found;
};

describe("Sources", () => {
  it("renders a card per source with the live tag, the history progress and the right buttons", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Sources");
    assert.deepEqual([...m.host.querySelectorAll("article.tb-card h3")].map((x) => x.textContent), ["Work inbox", "Clinic partners"]);
    const gmail = card(m.host, "Work inbox");
    assert.deepEqual([...gmail.querySelectorAll(".tb-tag")].map((t) => t.textContent), ["Watching"]);
    assert.match(gmail.textContent ?? "", /Gmail · 2 conversations/);
    assert.match(gmail.textContent ?? "", /History: 18,240 of up to 50,000 messages · since 1 Jan 2026 · reading/);
    assert.equal(gmail.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "36");
    for (const b of ["Pause live", "Pause history", "Stop history", "Remove"]) control(gmail, b);
    const tg = card(m.host, "Clinic partners");
    assert.deepEqual([...tg.querySelectorAll(".tb-tag")].map((t) => t.textContent), ["Waiting"]);
    assert.match(tg.textContent ?? "", /No history: Telegram bots see only messages sent after they join\./);
    assert.ok(![...tg.querySelectorAll("button")].some((b) => b.textContent === "Read history…"), "a Telegram source offers no history");
    await m.unmount();
  });

  it("while Connect gives no data access it says so and Add source is off (the honest state)", async () => {
    reset();
    stub.connectMissing = true;
    stub.sources = [];
    stub.jobs = [];
    const m = await mount(h(await page(), {}));
    assert.match(m.host.querySelector(".tb-notice")?.textContent ?? "", /Connect does not give Observer data access yet\. Sources start when it does\./);
    assert.ok(control(m.host, "Add source").disabled);
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /No sources yet/);
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /Nothing is read/);
    await m.unmount();
  });

  it("says that Connect and Knowledge are required when one is missing", async () => {
    reset();
    stub.targets = ["connect"];
    const m = await mount(h(await page(), {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Observer needs Connect and Knowledge to work\./);
    assert.match(text, /Knowledge is not available to it now\./);
    assert.doesNotMatch(text, /Connect is not available/);
    await m.unmount();
  });

  it("an empty list with Connect ready invites to add a source", async () => {
    reset();
    stub.sources = [];
    stub.jobs = [];
    const m = await mount(h(await page(), {}));
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /Add a source to start\./);
    assert.ok(!control(m.host, "Add source").disabled);
    await m.unmount();
  });

  it("a failed load is an error with Try again, not an empty list", async () => {
    reset();
    stub.fail.sources_list = { status: 500, code: "internal" };
    const m = await mount(h(await page(), {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(m.host)[0] ?? "", /raw upstream/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.sources_list = undefined;
    await click(control(m.host, "Try again"));
    await flush();
    assert.equal(m.host.querySelectorAll("article.tb-card").length, 2);
    await m.unmount();
  });

  it("Pause live sends job_control pause for the live job, with the CSRF token and an idempotency key", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(card(m.host, "Work inbox"), "Pause live"));
    await flush();
    const c = lastCall("job_control");
    assert.deepEqual(c.input, { id: "job_gmail_live", action: "pause" });
    assertWriteHeaders(c);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("Pause history and Stop history (two clicks) address the history job", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(card(m.host, "Work inbox"), "Pause history"));
    await flush();
    assert.deepEqual(lastCall("job_control").input, { id: "job_gmail_hist", action: "pause" });
    await click(control(card(m.host, "Work inbox"), "Stop history"));
    assert.equal(callsOf("job_control").length, 1, "the first click only asks");
    await click(control(card(m.host, "Work inbox"), "Confirm: stop history"));
    await flush();
    assert.deepEqual(lastCall("job_control").input, { id: "job_gmail_hist", action: "cancel" });
    await m.unmount();
  });

  it("Start live on a source nobody paused starts it; on one somebody paused it falls back to resume", async () => {
    reset();
    stub.sources = [SRC_NEW];
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Start live"));
    await flush();
    assert.deepEqual(callsOf("job_control").map((c) => c.input), [{ id: "job_new_live", action: "start" }]);
    stub.out.job_control = (i: Record<string, any>) => {
      if (i.action === "start") throw Object.assign(new Error("x"), { status: 409, code: "job_state_invalid" });
      return { job: { id: i.id, state: "queued" } };
    };
    await click(control(m.host, "Start live"));
    await flush();
    assert.deepEqual(callsOf("job_control").map((c) => c.input.action), ["start", "start", "resume"]);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("a refused job change is a plain sentence, never the raw answer", async () => {
    reset();
    stub.fail.job_control = { status: 409, code: "job_state_invalid" };
    const m = await mount(h(await page(), {}));
    await click(control(card(m.host, "Work inbox"), "Pause live"));
    await flush();
    assert.deepEqual(alerts(m.host), ["That job cannot do this now. Reload the page and look again."]);
    await m.unmount();
  });

  it("C8: one call at a time; the buttons wait while a call runs", async () => {
    reset();
    let release = () => {};
    stub.gate.job_control = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(h(await page(), {}));
    const pause = control(card(m.host, "Work inbox"), "Pause live");
    await click(pause);
    assert.ok(pause.disabled);
    assert.ok(control(card(m.host, "Clinic partners"), "Remove").disabled);
    await click(pause);
    assert.equal(callsOf("job_control").length, 1);
    release();
    await flush();
    await m.unmount();
  });

  it("Remove asks first, then calls source_remove for that source", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(card(m.host, "Clinic partners"), "Remove"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /Documents already delivered to Knowledge stay there/);
    assert.equal(callsOf("source_remove").length, 0);
    await click(control(dialog, "Remove the source"));
    await flush();
    const c = lastCall("source_remove");
    assert.deepEqual(c.input, { id: "src_tg" });
    assertWriteHeaders(c);
    await m.unmount();
  });

  it("Read history… estimates, then starts backfill_start with the date", async () => {
    reset();
    stub.sources = [SRC_NEW];
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Read history…"));
    const dialog = openDialog(m.host);
    const date = dialog.querySelector('input[name="since"]') as HTMLInputElement;
    await type(date, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    await click(control(dialog, "Estimate"));
    await flush();
    assert.match(dialog.textContent ?? "", /About 1,200 messages and 140 records, about 10 min\./);
    assert.match(lastCall("backfill_estimate").input.since, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    await click(control(dialog, "Read history"));
    await flush();
    const c = lastCall("backfill_start");
    assert.equal(c.input.source, "src_new");
    assert.match(c.input.since, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    assertWriteHeaders(c);
    await m.unmount();
  });
});

describe("Add source", () => {
  const mountFlow = async (onDone = () => {}, onClose = () => {}) => {
    const { AddSource } = await ui<AddSource>("addsource.js");
    return mount(h(AddSource, { open: true, accounts: stub.accounts as never, onClose, onDone }));
  };
  const step = (dialog: Element, n: number) => dialog.querySelector(`[data-step="${n}"]`) as Element;
  const next = async (dialog: Element, text = "Next") => {
    await click(control(dialog, text));
    await flush();
  };

  it("walks the four steps: the source is made on step 3 with every setting, history starts on step 4", async () => {
    reset();
    let done = 0;
    let closed = 0;
    const m = await mountFlow(
      () => done++,
      () => closed++,
    );
    const dialog = openDialog(m.host);
    assert.deepEqual([...dialog.querySelectorAll(".tb-stepflow-steps li")].map((x) => x.textContent?.replace(" ✓", "")), ["1-Account", "2-Conversations", "3-Details", "4-History"]);
    assert.ok(control(dialog, "Next").disabled, "an account is needed first");
    await click(dialog.querySelector('[role="radio"]') as Element);
    await next(dialog);
    // step 2: conversations (of the chosen account only) and who is never read
    assert.ok(control(dialog, "Next").disabled, "a conversation is needed");
    const boxes = [...step(dialog, 1).querySelectorAll('.tb-check input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(boxes.length, 3);
    assert.match(step(dialog, 1).textContent ?? "", /About 28,500 messages\./);
    assert.match(step(dialog, 1).textContent ?? "", /Connect cannot tell how many messages\./);
    await click(boxes[0] as Element);
    await type(step(dialog, 1).querySelector("textarea") as Element, "doctor@clinic.example\n@family.example\nclinic.example");
    await next(dialog);
    // step 3: details
    const label = step(dialog, 2).querySelector("input") as HTMLInputElement;
    assert.equal(label.value, "work@example.com", "the account name is the default name");
    await type(label, "Work inbox");
    await choose(dialog, step(dialog, 2).querySelectorAll('[role="combobox"]')[1] as Element, "30 days");
    assert.match(step(dialog, 2).textContent ?? "", /did not agree to this\. Check your duty to inform them\./);
    assert.equal(callsOf("source_add").length, 0, "nothing is made before the owner presses Add source");
    await next(dialog, "Add source");
    const add = lastCall("source_add");
    assert.deepEqual(add.input, { account: "acc_gmail", conversations: ["clients"], label: "Work inbox", exclude: { senders: ["doctor@clinic.example"], domains: ["family.example", "clinic.example"] }, liveIntervalS: 60, retentionDays: 30 });
    assertWriteHeaders(add);
    assert.equal(done, 1, "the list reloads");
    // step 4: history
    assert.match(step(dialog, 3).textContent ?? "", /Live watching is off until you press Start live/);
    await click(control(step(dialog, 3), "Estimate"));
    await flush();
    assert.match(step(dialog, 3).textContent ?? "", /About 1,200 messages and 140 records/);
    assert.equal(lastCall("backfill_estimate").input.source, "src_made");
    await next(dialog, "Read history");
    const start = lastCall("backfill_start");
    assert.equal(start.input.source, "src_made");
    assertWriteHeaders(start);
    assert.equal(closed, 1);
    await m.unmount();
  });

  it("Skip on step 4 adds the source without history", async () => {
    reset();
    let closed = 0;
    const m = await mountFlow(undefined, () => closed++);
    const dialog = openDialog(m.host);
    await click(dialog.querySelector('[role="radio"]') as Element);
    await next(dialog);
    await click(step(dialog, 1).querySelector('input[type="checkbox"]') as Element);
    await next(dialog);
    await next(dialog, "Add source");
    await next(dialog, "Skip, no history");
    assert.equal(callsOf("backfill_start").length, 0);
    assert.equal(callsOf("source_add").length, 1);
    assert.equal(closed, 1);
    await m.unmount();
  });

  it("a source that reads no history says so on step 4 and offers Done", async () => {
    reset();
    const m = await mountFlow();
    const dialog = openDialog(m.host);
    await click(dialog.querySelectorAll('[role="radio"]')[1] as Element);
    await next(dialog);
    await click(step(dialog, 1).querySelector('input[type="checkbox"]') as Element);
    await next(dialog);
    await next(dialog, "Add source");
    assert.match(step(dialog, 3).textContent ?? "", /No history: this source gives Observer only messages sent from now on\./);
    assert.equal(step(dialog, 3).querySelector('input[name="since"]'), null);
    await next(dialog, "Done");
    assert.equal(callsOf("backfill_start").length, 0);
    await m.unmount();
  });

  it("a refused source_add stays on step 3 with a plain sentence and makes nothing", async () => {
    reset();
    stub.fail.source_add = { status: 409, code: "connect_unavailable" };
    const m = await mountFlow();
    const dialog = openDialog(m.host);
    await click(dialog.querySelector('[role="radio"]') as Element);
    await next(dialog);
    await click(step(dialog, 1).querySelector('input[type="checkbox"]') as Element);
    await next(dialog);
    await next(dialog, "Add source");
    assert.deepEqual(alerts(dialog), ["Connect does not give Observer data access yet. Sources start when it does."]);
    assert.ok(control(dialog, "Add source"), "still on step 3");
    assert.equal(callsOf("backfill_start").length, 0);
    await m.unmount();
  });

  it("parseExclude sorts addresses, handles and domains", async () => {
    const { parseExclude } = await ui<AddSource>("addsource.js");
    assert.deepEqual(parseExclude("a@b.example\n@x.example\ny.example\nslack:U123\n\n a@b.example "), { senders: ["a@b.example", "slack:U123"], domains: ["x.example", "y.example"] });
  });
});

describe("idempotency keys", () => {
  it("the same call sent again after a network failure reuses its key; a refusal forgets it", async () => {
    reset();
    const { run } = await ui<typeof import("../src/ui/api.ts")>("api.js");
    // the TbProvider must have signed in (CSRF): mount something small first
    const m = await mount(h(await page(), {}));
    stub.calls.length = 0;
    stub.networkDown = true;
    await assert.rejects(run("purge", { source: "src_tg" }), (e: { code?: string }) => e.code === "network_error");
    stub.networkDown = false;
    await run("purge", { source: "src_tg" });
    const key = lastCall("purge").key;
    assert.ok(key);
    // the call that went through is settled: the next identical call is a new action with a new key
    await run("purge", { source: "src_tg" });
    assert.notEqual(callsOf("purge")[1]?.key, key);
    stub.fail.purge = { status: 409, code: "not_found" };
    await assert.rejects(run("purge", { source: "src_x" }));
    await assert.rejects(run("purge", { source: "src_x" }));
    assert.notEqual(callsOf("purge").at(-1)?.key, callsOf("purge").at(-2)?.key);
    await m.unmount();
  });
});
