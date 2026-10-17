// Privacy page (src/ui/privacy.tsx): retention, what happens when a message is deleted in the source, delete stored text now.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alerts, assertWriteHeaders, callsOf, choose, click, compileUi, control, flush, h, lastCall, mount, openDialog, reset, stub, type } from "./ui-harness.ts";

const ui = compileUi("privacy");
type Privacy = typeof import("../src/ui/privacy.tsx");
const page = async () => (await ui<Privacy>("privacy.js")).PrivacyPage;
const triggers = (host: Element) => [...host.querySelectorAll('[role="combobox"]')];

describe("Privacy", () => {
  it("shows the saved retention and the source-delete switch", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Privacy");
    assert.deepEqual([...m.host.querySelectorAll(".tb-select-value")].map((v) => v.textContent), ["30 days", "90 days"]);
    assert.equal((m.host.querySelector('input[role="switch"]') as HTMLInputElement).checked, true);
    assert.match(m.host.textContent ?? "", /People in your sources did not agree to this: check your duty to inform them\./);
    assert.match(m.host.textContent ?? "", /Backups \(kept for 3 nights\) and exports contain the text that is still inside its retention time/);
    await m.unmount();
  });

  it("choosing another retention sends privacy_set with that field only, with the CSRF token and an idempotency key", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await choose(m.host, triggers(m.host)[0] as Element, "7 days");
    const c = lastCall("privacy_set");
    assert.deepEqual(c.input, { textRetentionDays: 7 });
    assertWriteHeaders(c);
    assert.match(m.host.textContent ?? "", /Saved\./);
    assert.deepEqual([...m.host.querySelectorAll(".tb-select-value")].map((v) => v.textContent)[0], "7 days");
    await choose(m.host, triggers(m.host)[1] as Element, "180 days");
    assert.deepEqual(lastCall("privacy_set").input, { reviewRetentionDays: 180 });
    await m.unmount();
  });

  it("the switch sends onSourceDelete keep / purge", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(m.host.querySelector('input[role="switch"]') as Element);
    await flush();
    assert.deepEqual(lastCall("privacy_set").input, { onSourceDelete: "keep" });
    await click(m.host.querySelector('input[role="switch"]') as Element);
    await flush();
    assert.deepEqual(lastCall("privacy_set").input, { onSourceDelete: "purge" });
    await m.unmount();
  });

  it("a refused change is a plain sentence", async () => {
    reset();
    stub.fail.privacy_set = { status: 500, code: "internal" };
    const m = await mount(h(await page(), {}));
    await choose(m.host, triggers(m.host)[0] as Element, "1 day");
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(m.host)[0] ?? "", /raw upstream/);
    assert.doesNotMatch(m.host.textContent ?? "", /Saved\./);
    await m.unmount();
  });

  it("a failed load is an error with Try again, not a page of defaults", async () => {
    reset();
    stub.fail.privacy_get = { status: 500, code: "internal" };
    const m = await mount(h(await page(), {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".cards"), null);
    stub.fail.privacy_get = undefined;
    await click(control(m.host, "Try again"));
    await flush();
    assert.equal(triggers(m.host).length, 2);
    await m.unmount();
  });

  it("Delete stored text… asks which source and which date, then sends purge and reports the count", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Delete stored text…"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /It cannot be undone\. Documents already delivered to Knowledge stay there\./);
    assert.equal(callsOf("purge").length, 0);
    await choose(dialog, dialog.querySelector('[role="combobox"]') as Element, "Clinic partners");
    await type(dialog.querySelector('input[name="before"]') as Element, "2026-01-01");
    await click(control(dialog, "Delete the text"));
    await flush();
    const c = lastCall("purge");
    assert.deepEqual(c.input, { source: "src_tg", before: "2026-01-01T00:00:00Z" });
    assertWriteHeaders(c);
    assert.match(dialog.textContent ?? "", /Observer deleted the stored text of 7 messages\./);
    await m.unmount();
  });

  it("a date that is not YYYY-MM-DD stops the delete and says so", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Delete stored text…"));
    const dialog = openDialog(m.host);
    await type(dialog.querySelector('input[name="before"]') as Element, "01/01/2026");
    assert.ok(control(dialog, "Delete the text").disabled);
    assert.match(dialog.textContent ?? "", /Write a date as YYYY-MM-DD, or leave it empty\./);
    await type(dialog.querySelector('input[name="before"]') as Element, "2026-13-45");
    assert.ok(control(dialog, "Delete the text").disabled, "a day that does not exist");
    assert.equal(callsOf("purge").length, 0);
    await m.unmount();
  });

  it("with nothing chosen Delete the text purges every source", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Delete stored text…"));
    await click(control(openDialog(m.host), "Delete the text"));
    await flush();
    assert.deepEqual(lastCall("purge").input, {});
    await m.unmount();
  });
});
