// Activity page (src/ui/activity.tsx): deliveries with their status, held and superseded included; retry.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alerts, assertWriteHeaders, callsOf, choose, click, compileUi, control, flush, h, lastCall, mount, reset, stub, within } from "./ui-harness.ts";

const ui = compileUi("activity");
type Activity = typeof import("../src/ui/activity.tsx");
const page = async () => (await ui<Activity>("activity.js")).ActivityPage;
const rows = (host: Element) => [...host.querySelectorAll("tbody tr")];
const cells = (tr: Element) => [...tr.querySelectorAll("td")].map((c) => c.textContent?.replace(/\s+/g, " ").trim());

describe("Activity", () => {
  it("lists every delivery with its record, destination and status, held and superseded included", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Activity");
    assert.deepEqual([...m.host.querySelectorAll("thead th")].map((t) => t.textContent), ["When", "Record", "Destination", "Status"]);
    const r = rows(m.host);
    assert.equal(r.length, 5);
    const status = (i: number) => [...(r[i]?.querySelectorAll("td:last-child .tb-tag") ?? [])].map((t) => t.textContent);
    assert.deepEqual(status(0), ["Delivered"]);
    assert.deepEqual(status(1), ["Waiting to send"]);
    assert.deepEqual(status(2), ["Held: waits for your approval"]);
    assert.deepEqual(status(3), ["Failed · retry in 40 min"]);
    assert.deepEqual(status(4), ["Superseded: will not be sent"]);
    assert.match(cells(r[0] as Element)[1] ?? "", /^Invoice question from M\. Horak/);
    assert.match(cells(r[0] as Element)[2] ?? "", /Knowledge/);
    assert.match(cells(r[1] as Element)[2] ?? "", /Task Board/);
    assert.match(cells(r[2] as Element)[2] ?? "", /Operator Inbox/);
    assert.match(cells(r[3] as Element)[1] ?? "", /May duplicate an earlier copy\./);
    assert.match(cells(r[2] as Element)[1] ?? "", /^Messages in Work inbox/, "a possible secret has no subject: its title is the source");
    assert.match(m.host.textContent ?? "", /Delivery starts in a later version/);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream text must never show/);
    assert.match(cells(r[1] as Element)[1] ?? "", /A record that is no longer listed|Messages in/);
    await m.unmount();
  });

  it("only a failed delivery that is still current offers Retry", async () => {
    reset();
    stub.deliveries = [...(stub.deliveries as object[]), { ...(stub.deliveries as { id: string }[])[3], id: "dlv_failed_old", superseded: true }];
    const m = await mount(h(await page(), {}));
    const retries = [...m.host.querySelectorAll("button")].filter((b) => b.textContent === "Retry");
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.closest("tr"), rows(m.host)[3], "on the failed row that is current");
    await m.unmount();
  });

  it("Retry sends delivery_retry with the CSRF token and an idempotency key", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Retry"));
    await flush();
    const c = lastCall("delivery_retry");
    assert.deepEqual(c.input, { id: "dlv_failed" });
    assertWriteHeaders(c);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("a refused retry is a plain sentence", async () => {
    reset();
    stub.fail.delivery_retry = { status: 409, code: "delivery_state_invalid" };
    const m = await mount(h(await page(), {}));
    await click(control(m.host, "Retry"));
    await flush();
    assert.deepEqual(alerts(m.host), ["This delivery is not from your last decision on the record. Decide the record in Review."]);
    await m.unmount();
  });

  it("the filter asks deliveries_list for that status", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.deepEqual(callsOf("deliveries_list")[0]?.input, {});
    await choose(m.host, within(m.host, "Deliveries").ownerDocument.querySelector('[role="combobox"]') as Element, "Failed");
    assert.deepEqual(lastCall("deliveries_list").input, { status: "failed" });
    assert.equal(rows(m.host).length, 1);
    await m.unmount();
  });

  it("empty states say what appears here; a failed load is an error with Try again", async () => {
    reset();
    stub.deliveries = [];
    const m = await mount(h(await page(), {}));
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /Nothing here yet/);
    await m.unmount();
    reset();
    stub.fail.deliveries_list = { status: 500, code: "internal" };
    const bad = await mount(h(await page(), {}));
    assert.match(alerts(bad.host)[0] ?? "", /Something went wrong/);
    assert.equal(bad.host.querySelector(".tb-empty"), null);
    assert.equal(bad.host.querySelector("table"), null);
    await bad.unmount();
  });
});
