// The app (src/ui/App.tsx): nav order and badges, the launch page, the /review/<id> deep link, a page switch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { click, compileUi, flush, h, mount, reset, stub, win } from "./ui-harness.ts";

const ui = compileUi("app");
type AppModule = typeof import("../src/ui/App.tsx");
const nav = (host: Element) => [...host.querySelectorAll("nav a")].map((a) => a.textContent?.replace(/\d+$/, "").trim());
const at = (path: string) => win.history.pushState(null, "", `/a/observer/${path}`);

describe("App", () => {
  it("opens on Sources, in the nav order of the mockup, with the number of records waiting on Review", async () => {
    reset();
    at("");
    const { App } = await ui<AppModule>("App.js");
    const m = await mount(h(App, {}));
    assert.equal(m.host.querySelector(".app-page h1")?.textContent, "Sources");
    assert.deepEqual(nav(m.host).slice(0, 10), ["Sources", "Review", "Routing", "Activity", "Privacy", "Holds", "Receipts", "Agents & scopes", "Settings", "Backups & export"]);
    const review = [...m.host.querySelectorAll("nav a")].find((a) => a.textContent?.startsWith("Review"));
    assert.equal(review?.textContent, "Review4");
    await m.unmount();
  });

  it("/review/<id> (the Inbox link) opens that record on Review", async () => {
    reset();
    at("review/rec_key");
    const { App } = await ui<AppModule>("App.js");
    const m = await mount(h(App, {}));
    assert.equal(m.host.querySelector(".app-page h1")?.textContent, "Review");
    assert.equal(m.host.querySelector('[aria-label="Record"] h2')?.textContent, "Messages in Work inbox");
    await m.unmount();
    at("");
  });

  it("the nav moves between the pages and the standard pages keep their own words", async () => {
    reset();
    at("");
    const { App } = await ui<AppModule>("App.js");
    const m = await mount(h(App, {}));
    const go = async (label: string) => {
      await click([...m.host.querySelectorAll("nav a")].find((a) => a.textContent?.startsWith(label)) as Element);
      await flush();
    };
    for (const [label, heading] of [["Routing", "Routing"], ["Activity", "Activity"], ["Privacy", "Privacy"], ["Settings", "Settings"], ["Holds", "Holds"], ["Review", "Review"]] as const) {
      await go(label);
      assert.equal(m.host.querySelector(".app-page h1")?.textContent, heading);
    }
    await go("Holds");
    assert.match(m.host.textContent ?? "", /No calls to Observer wait for your approval\./);
    stub.review = [];
    await m.unmount();
    at("");
  });
});
