// Review page (src/ui/review.tsx): the list, the record with its marked text, the decisions, the possible-secret gate.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { alerts, assertWriteHeaders, callsOf, choose, click, compileUi, control, detailOf, flush, h, lastCall, looksLikeKey, mount, REC_BANK, REC_KEY, reset, stub, within } from "./ui-harness.ts";

const ui = compileUi("review");
type Review = typeof import("../src/ui/review.tsx");

/** The page with the selection kept the way the app keeps it (the address): the test sees what the page asks for. */
async function mountReview(start: string | null = null) {
  const { ReviewPage } = await ui<Review>("review.js");
  const opened: (string | null)[] = [];
  const counts: number[] = [];
  const Wrapper = () => {
    const [id, setId] = useState<string | null>(start);
    return h(ReviewPage, {
      recordId: id,
      onOpen: (x: string | null) => {
        opened.push(x);
        setId(x);
      },
      hrefOf: (x: string) => `./review/${x}`,
      onCount: (n: number) => counts.push(n),
    });
  };
  const m = await mount(h(Wrapper, {}));
  return { ...m, opened, counts };
}
const DESTINATIONS = ["Knowledge", "Task Board", "Operator Inbox"];
const rows = (host: Element) => [...within(host, "Records waiting").querySelectorAll("a")];
const detail = (host: Element) => within(host, "Record");

describe("Review", () => {
  it("lists the waiting records with the reasons and opens the first with its marked text", async () => {
    reset();
    const m = await mountReview();
    assert.equal(m.host.querySelector("h1")?.textContent, "Review");
    assert.deepEqual(rows(m.host).map((r) => r.querySelector("b")?.textContent), ["Invoice question from M. Horak", "Messages in Work inbox", "Deploy notes", "Messages in Clinic partners"]);
    const tags = (a: Element) => [...a.querySelectorAll(".tb-tag")].map((t) => t.textContent);
    assert.deepEqual(tags(rows(m.host)[0] as Element), ["bank account", "email address", "phone number"]);
    assert.deepEqual(tags(rows(m.host)[1] as Element), ["possible secret"]);
    assert.deepEqual(tags(rows(m.host)[2] as Element), ["secret removed"]);
    assert.deepEqual(tags(rows(m.host)[3] as Element), ["no route"]);
    assert.equal(rows(m.host)[0]?.getAttribute("aria-current"), "true");
    const d = detail(m.host);
    assert.equal(d.querySelector("h2")?.textContent, "Invoice question from M. Horak");
    assert.deepEqual([...d.querySelectorAll("mark")].map((x) => x.firstChild?.textContent), ["CZ6508000000192000145399", "+420 123 456 789"]);
    assert.match(d.textContent ?? "", /Found.*bank account \(1\), email address \(2\), phone number \(1\)/);
    assert.match(d.textContent ?? "", /Route.*Rule 1: Work inbox; mentions “invoice” → Knowledge · area Clients · as draft · deliver redacted/);
    assert.match(d.textContent ?? "", /You:/, "an own message is shown as You");
    assert.deepEqual(m.counts.at(-1), 4);
    assert.deepEqual(callsOf("review_get").map((c) => c.input), [{ id: "rec_bank" }]);
    await m.unmount();
  });

  it("the redacted view shows the labels Deliver redacted writes", async () => {
    reset();
    const m = await mountReview();
    await click(control(m.host, "As delivered, redacted"));
    const marks = [...detail(m.host).querySelectorAll("mark")].map((x) => x.textContent);
    assert.deepEqual(marks, ["[bank account]", "[phone]"]);
    assert.doesNotMatch(detail(m.host).textContent ?? "", /CZ6508/);
    await m.unmount();
  });

  it("an empty queue says nothing waits; a failed load is an error with Try again", async () => {
    reset();
    stub.review = [];
    const m = await mountReview();
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /Nothing waits for you/);
    await m.unmount();
    reset();
    stub.fail.review_list = { status: 500, code: "internal" };
    const bad = await mountReview();
    assert.match(alerts(bad.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(bad.host)[0] ?? "", /raw upstream/);
    assert.equal(bad.host.querySelector(".tb-empty"), null);
    await bad.unmount();
  });

  it("Deliver redacted sends review_decide with the destination, the CSRF token and an idempotency key, then moves to the next record", async () => {
    reset();
    const m = await mountReview();
    await click(control(detail(m.host), "Deliver redacted"));
    await flush();
    const c = lastCall("review_decide");
    assert.deepEqual(c.input, { recordId: "rec_bank", revision: 1, decision: "deliver_redacted", destination: "knowledge" });
    assertWriteHeaders(c);
    assert.match(m.host.textContent ?? "", /Approved for Knowledge, redacted\. Delivery starts in a later version: the record waits on the Activity page\./);
    assert.deepEqual(rows(m.host).map((r) => r.querySelector("b")?.textContent?.slice(0, 8)), ["Messages", "Deploy n", "Messages"]);
    assert.deepEqual(m.opened.at(-1), "rec_key", "the next record is opened");
    await m.unmount();
  });

  it("Deliver as is sends decision deliver, to the destination the owner chose", async () => {
    reset();
    const m = await mountReview();
    const trigger = detail(m.host).querySelector('[role="combobox"]') as Element;
    await choose(m.host, trigger, "Operator Inbox");
    await click(control(detail(m.host), "Deliver as is"));
    await flush();
    assert.deepEqual(lastCall("review_decide").input, { recordId: "rec_bank", revision: 1, decision: "deliver", destination: "inbox" });
    await m.unmount();
  });

  it("a destination the slice does not reach is greyed, and the page says what is required", async () => {
    reset();
    stub.targets = ["connect", "knowledge"];
    const m = await mountReview();
    await click(detail(m.host).querySelector('[role="combobox"]') as Element);
    const options = [...m.host.querySelectorAll('[role="option"]')].map((o) => ({ greyed: o.getAttribute("aria-disabled") === "true", said: (o.textContent ?? "").includes("not available"), name: DESTINATIONS.find((d) => (o.textContent ?? "").startsWith(d)) }));
    assert.deepEqual(options, [
      { greyed: false, said: false, name: "Knowledge" },
      { greyed: true, said: true, name: "Task Board" },
      { greyed: true, said: true, name: "Operator Inbox" },
    ]);
    assert.doesNotMatch(m.host.textContent ?? "", /Observer needs Connect and Knowledge/, "both required apps are there");
    await m.unmount();
    reset();
    stub.targets = [];
    const none = await mountReview();
    assert.match(none.host.textContent ?? "", /Observer needs Connect and Knowledge to work\. Connect and Knowledge are not available to it now\. Task Board/);
    assert.match(detail(none.host).textContent ?? "", /Knowledge is not available to Observer, so nothing can be delivered now\. You can still drop the record\./);
    assert.ok(control(detail(none.host), "Deliver redacted").disabled);
    assert.ok(!control(detail(none.host), "Drop").disabled);
    await none.unmount();
  });

  it("a possible secret opens redacted, without subject or sender; the original is shown only on purpose", async () => {
    reset();
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    assert.equal(d.querySelector("h2")?.textContent, "Messages in Work inbox", "no thread subject in the heading");
    assert.match(d.textContent ?? "", /Possible secret: held for your review\./);
    assert.match(d.textContent ?? "", /Route.*Held for your review, whatever the rules say/);
    assert.match(d.textContent ?? "", /Sender hidden: New key for the booking system: \[possible secret\]/);
    assert.ok(!(m.host.textContent ?? "").includes(looksLikeKey()), "the token is not on the page");
    await click(control(d, "Show the original text"));
    assert.ok((d.textContent ?? "").includes(looksLikeKey()), "now the owner sees the original");
    await click(control(d, "Hide the original text"));
    assert.ok(!(d.textContent ?? "").includes(looksLikeKey()));
    await m.unmount();
  });

  it("Deliver redacted of a possible secret needs no tick and sends no acknowledgement", async () => {
    reset();
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    assert.ok(!control(d, "Deliver redacted").disabled);
    await click(control(d, "Deliver redacted"));
    await flush();
    assert.deepEqual(lastCall("review_decide").input, { recordId: "rec_key", revision: 1, decision: "deliver_redacted", destination: "knowledge" });
    await m.unmount();
  });

  it("Deliver as is of a possible secret needs the original shown, the tick, and then sends acknowledged: true", async () => {
    reset();
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    const tick = d.querySelector('.tb-check input[type="checkbox"]') as HTMLInputElement;
    assert.match(d.querySelector(".tb-check")?.textContent ?? "", /I read the original text above\. The marked part is not a secret\./);
    assert.ok(tick.disabled, "the tick is off while the original is hidden");
    assert.ok(control(d, "Deliver as is").disabled);
    await click(control(d, "Show the original text"));
    assert.ok(!tick.disabled);
    assert.ok(control(d, "Deliver as is").disabled, "showing it is not enough");
    await click(tick);
    assert.ok(!control(d, "Deliver as is").disabled);
    // hiding the original takes the tick back
    await click(control(d, "Hide the original text"));
    assert.ok(tick.disabled && control(d, "Deliver as is").disabled);
    await click(control(d, "Show the original text"));
    assert.ok(control(d, "Deliver as is").disabled, "the tick must be given again");
    await click(tick);
    await click(control(d, "Deliver as is"));
    await flush();
    const c = lastCall("review_decide");
    assert.deepEqual(c.input, { recordId: "rec_key", revision: 1, decision: "deliver", destination: "knowledge", acknowledged: true });
    assertWriteHeaders(c);
    await m.unmount();
  });

  it("a possible secret with no marked span is held as a whole: redacting replaces all of the text", async () => {
    reset();
    stub.out.review_get = (i: Record<string, unknown>) => {
      const d = detailOf(REC_KEY) as { messages: { spans: unknown[] }[] };
      d.messages.forEach((x) => {
        x.spans = [];
      });
      return { record: { ...d, id: i.id } };
    };
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    assert.match(d.textContent ?? "", /This record was held as a whole\./);
    assert.match(d.textContent ?? "", /all of the text is redacted\. Deliver redacted replaces all of it with \[possible secret\]\./);
    assert.deepEqual([...d.querySelectorAll(".ob-msgs mark")].map((x) => x.textContent), ["[possible secret]"]);
    assert.ok(!(d.textContent ?? "").includes(looksLikeKey()));
    assert.ok(!control(d, "Deliver redacted").disabled);
    await click(control(d, "Show the original text"));
    assert.ok((d.textContent ?? "").includes(looksLikeKey()));
    await m.unmount();
  });

  it("held as a whole works per message: a message with no marked span is fully redacted, one with a span only at the span", async () => {
    reset();
    stub.out.review_get = (i: Record<string, unknown>) => {
      const d = detailOf(REC_KEY) as { messages: Record<string, unknown>[] };
      const split = `the second half of it is ${looksLikeKey().slice(8)}`; // a token split over messages: no span marks this part
      d.messages.push({ ...(d.messages[0] as object), id: "m_split", text: split, spans: [] });
      return { record: { ...d, id: i.id } };
    };
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    const marks = [...d.querySelectorAll(".ob-msgs mark")].map((x) => x.textContent);
    assert.deepEqual(marks, ["[possible secret]", "[possible secret]"]);
    const lines = [...d.querySelectorAll(".ob-msgs p")].map((p) => p.textContent);
    assert.match(lines[0] ?? "", /^Sender hidden: New key for the booking system: \[possible secret\]$/, "the marked message is redacted at the span only");
    assert.equal(lines[1], "Sender hidden: [possible secret]", "the other message is redacted whole");
    assert.ok(!(d.textContent ?? "").includes(looksLikeKey().slice(8)));
    await click(control(d, "Show the original text"));
    assert.ok((d.textContent ?? "").includes(looksLikeKey().slice(8)), "the owner can still read it on purpose");
    await m.unmount();
  });

  it("an edit between read and decide: revision_changed refreshes the record, takes the tick back and tells the owner", async () => {
    reset();
    stub.out.review_get = () => ({ record: detailOf(REC_KEY) });
    const m = await mountReview("rec_key");
    const d = detail(m.host);
    await click(control(d, "Show the original text"));
    await click(d.querySelector('.tb-check input[type="checkbox"]') as Element);
    assert.ok(!control(d, "Deliver as is").disabled);
    stub.fail.review_decide = { status: 409, code: "revision_changed" };
    const reads = callsOf("review_get").length;
    await click(control(d, "Deliver as is"));
    await flush();
    assert.equal(lastCall("review_decide").input.revision, 1, "the revision the owner read went out");
    assert.deepEqual(alerts(m.host), ["This record changed after you opened it. It is shown again as it is now. Read it again before you decide."]);
    assert.ok(callsOf("review_get").length > reads, "the record is read again");
    assert.ok(control(d, "Show the original text"), "the original is hidden again");
    assert.ok(control(d, "Deliver as is").disabled, "the tick is gone");
    assert.equal(rows(m.host).length, 4, "nothing was decided");
    await m.unmount();
  });

  it("Deliver is off while Knowledge, a required app, is missing, even when another destination is there", async () => {
    reset();
    stub.targets = ["connect", "kanban"];
    const m = await mountReview();
    const d = detail(m.host);
    assert.match(d.textContent ?? "", /Knowledge is not available to Observer, so nothing can be delivered now\./);
    assert.ok(control(d, "Deliver redacted").disabled);
    assert.ok(control(d, "Deliver as is").disabled);
    assert.ok(!control(d, "Drop").disabled);
    await click(control(d, "Deliver redacted"));
    assert.equal(callsOf("review_decide").length, 0);
    await m.unmount();
  });

  it("says that delivery starts in a later version, and promises none now", async () => {
    reset();
    const m = await mountReview();
    assert.match(m.host.textContent ?? "", /Delivery to Knowledge, Task Board and Inbox starts in a later version\./);
    assert.doesNotMatch(m.host.textContent ?? "", /Nothing reaches Knowledge/);
    await m.unmount();
  });

  it("a record that held a recognised secret can only be dropped", async () => {
    reset();
    const m = await mountReview("rec_secret");
    const d = detail(m.host);
    assert.match(d.textContent ?? "", /A secret was removed from this record\./);
    assert.deepEqual([...d.querySelectorAll(".tb-ctas button")].map((b) => b.textContent), ["Drop"]);
    assert.equal(d.querySelector('[role="combobox"]'), null, "no destination to pick");
    await m.unmount();
  });

  it("Drop needs a second click, then sends review_decide drop without a destination", async () => {
    reset();
    const m = await mountReview();
    await click(control(detail(m.host), "Drop"));
    assert.equal(callsOf("review_decide").length, 0);
    await click(control(detail(m.host), "Confirm: drop"));
    await flush();
    const c = lastCall("review_decide");
    assert.deepEqual(c.input, { recordId: "rec_bank", revision: 1, decision: "drop" });
    assertWriteHeaders(c);
    assert.match(m.host.textContent ?? "", /Dropped\./);
    await m.unmount();
  });

  it("Keep appears only for a record that came back (version 2 or later) and sends decision keep", async () => {
    reset();
    const m = await mountReview();
    assert.ok(![...detail(m.host).querySelectorAll("button")].some((b) => b.textContent === "Keep the delivered version"));
    await m.unmount();
    reset();
    stub.review = [{ ...REC_BANK, revision: 2 }];
    const back = await mountReview();
    await click(control(detail(back.host), "Keep the delivered version"));
    await flush();
    assert.deepEqual(lastCall("review_decide").input, { recordId: "rec_bank", revision: 2, decision: "keep" });
    await back.unmount();
  });

  it("a refused decision is a plain sentence and the record stays", async () => {
    reset();
    stub.fail.review_decide = { status: 409, code: "delivery_held" };
    const m = await mountReview();
    await click(control(detail(m.host), "Deliver redacted"));
    await flush();
    assert.deepEqual(alerts(m.host), ["A delivery of this record waits for your approval. Decide it in Holds first."]);
    assert.equal(rows(m.host).length, 4);
    await m.unmount();
  });

  it("clicking another record opens it; a text that is gone leaves only Drop", async () => {
    reset();
    const m = await mountReview();
    await click(rows(m.host)[3] as Element);
    await flush();
    assert.deepEqual(m.opened.at(-1), "rec_plain");
    assert.equal(detail(m.host).querySelector("h2")?.textContent, "Messages in Clinic partners");
    stub.out.review_get = (i: Record<string, unknown>) => ({ record: { ...REC_BANK, id: i.id, messages: [{ conversation: "c", id: "m", thread: null, sentAt: null, editedAt: null, deleted: false, author: "x", authorKind: "person", text: null, spans: [] }] } });
    await click(rows(m.host)[0] as Element);
    await flush();
    assert.match(detail(m.host).textContent ?? "", /The text is gone\./);
    assert.deepEqual([...detail(m.host).querySelectorAll(".tb-ctas button")].map((b) => b.textContent), ["Drop"]);
    await m.unmount();
  });

  it("a record that is no longer waiting is an error with Try again, not an empty view", async () => {
    reset();
    const m = await mountReview("rec_gone");
    assert.match(alerts(m.host)[0] ?? "", /That item is gone\./);
    await m.unmount();
  });
});

describe("pieces", () => {
  it("cuts the text at the spans, merges overlaps and clips to the text", async () => {
    const { pieces } = await ui<Review>("review.js");
    assert.deepEqual(pieces("ab cd ef", [{ class: "phone", start: 3, end: 5 }]), [
      { text: "ab ", cls: null },
      { text: "cd", cls: "phone" },
      { text: " ef", cls: null },
    ]);
    assert.deepEqual(pieces("abcdef", [{ class: "phone", start: 0, end: 4 }, { class: "iban", start: 2, end: 99 }]), [{ text: "abcdef", cls: "iban" }]);
    assert.deepEqual(pieces("abc", []), [{ text: "abc", cls: null }]);
  });
});
