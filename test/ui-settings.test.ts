// Settings page (src/ui/settings.tsx): the connected apps (Connect and Knowledge required) and the words about secrets.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alerts, compileUi, h, mount, reset, stub } from "./ui-harness.ts";

const ui = compileUi("settings");
type Settings = typeof import("../src/ui/settings.tsx");
const page = async () => (await ui<Settings>("settings.js")).SettingsPage;
const app = (host: Element, name: string) => {
  const found = [...host.querySelectorAll(".ob-apps li")].find((l) => l.querySelector("strong")?.textContent === name);
  assert.ok(found, name);
  return [...found.querySelectorAll(".tb-tag")].map((t) => t.textContent);
};

describe("Settings", () => {
  it("lists the four apps: Connect and Knowledge required, Task Board and Operator Inbox optional", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Settings");
    assert.deepEqual(app(m.host, "Connect"), ["required", "available"]);
    assert.deepEqual(app(m.host, "Knowledge"), ["required", "available"]);
    assert.deepEqual(app(m.host, "Task Board"), ["optional", "available"]);
    assert.deepEqual(app(m.host, "Operator Inbox"), ["optional", "available"]);
    assert.equal(m.host.querySelector(".tb-notice"), null, "nothing is missing");
    await m.unmount();
  });

  it("says what is missing: a required app is flagged, an optional one is only 'not available'", async () => {
    reset();
    stub.targets = ["connect"];
    stub.connectMissing = true;
    const m = await mount(h(await page(), {}));
    assert.deepEqual(app(m.host, "Knowledge"), ["required", "not available"]);
    assert.deepEqual(app(m.host, "Task Board"), ["optional", "not available"]);
    const knowledge = [...m.host.querySelectorAll(".ob-apps li")][1]?.querySelectorAll(".tb-tag")[1] as Element;
    assert.ok(knowledge.className.includes("needs-you"));
    assert.ok(![...m.host.querySelectorAll(".ob-apps li")][2]?.querySelectorAll(".tb-tag")[1]?.className.includes("needs-you"));
    assert.match(m.host.querySelector(".tb-notice")?.textContent ?? "", /Observer needs Connect and Knowledge to work\. Knowledge is not available to it now\./);
    assert.match(m.host.textContent ?? "", /Connect does not give Observer data access yet\. Sources start when it does\./);
    await m.unmount();
  });

  it("states the secrets promise in the agreed words and never claims more", async () => {
    reset();
    const m = await mount(h(await page(), {}));
    const text = m.host.textContent ?? "";
    assert.match(text, /Observer removes the secrets it recognises and holds possible secrets for your review\./);
    assert.match(text, /It is not a complete secret scanner\./);
    assert.doesNotMatch(text, /never keeps? secrets|removes all|all (the )?secrets|every secret|no secret/i);
    await m.unmount();
  });

  it("a failed load is an error with Try again", async () => {
    reset();
    stub.fail.sources_available = { status: 500, code: "internal" };
    const m = await mount(h(await page(), {}));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    await m.unmount();
  });
});
