// Redaction, classification of a text / record, the actionable scorer, and the 16 KiB time budget.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIONABLE_THRESHOLD, actionableScore, isActionable } from "../src/actionable.ts";
import { classifyRecord, classifyText, countWords, SECRET_MARKER } from "../src/classify.ts";
import { detectAddresses } from "../src/detect/address.ts";
import { detectCards } from "../src/detect/card.ts";
import { detectEmails } from "../src/detect/email.ts";
import { detectGovIds } from "../src/detect/govid.ts";
import { detectIbans } from "../src/detect/iban.ts";
import { detectAll, LABELS, mergeSpans, redactText } from "../src/detect/index.ts";
import { detectPhones } from "../src/detect/phone.ts";
import { detectSecrets } from "../src/detect/secret.ts";
import { detectSpecial } from "../src/detect/special.ts";

describe("redaction", () => {
  it("replaces each class with its label", () => {
    const text = "Mail a@b.example, call +421 911 123 456, IBAN DE89 3704 0044 0532 0130 00, card 4111 1111 1111 1111, RČ 850327/1007, 10 Downing Street, she has cancer.";
    assert.equal(
      redactText(text, detectAll(text)),
      "Mail [email], call [phone], IBAN [bank account], card [card], RČ [id], [address], she has [special category].",
    );
  });
  it("labels are the agreed ones", () => {
    assert.deepEqual([LABELS.email, LABELS.phone, LABELS.iban, LABELS.card, LABELS.id, LABELS.address, LABELS.special], ["[email]", "[phone]", "[bank account]", "[card]", "[id]", "[address]", "[special category]"]);
  });
  it("overlapping spans merge into one, the strongest class names it; touching spans stay apart", () => {
    const merged = mergeSpans([
      { class: "phone", count: 1, spans: [{ start: 5, end: 15 }] },
      { class: "iban", count: 1, spans: [{ start: 0, end: 20 }] },
      { class: "email", count: 1, spans: [{ start: 20, end: 30 }] },
    ]);
    assert.deepEqual(merged, [
      { start: 0, end: 20, class: "iban" },
      { start: 20, end: 30, class: "email" },
    ]);
    assert.equal(redactText("x".repeat(30), [{ class: "phone", count: 1, spans: [{ start: 0, end: 10 }] }, { class: "email", count: 1, spans: [{ start: 5, end: 15 }] }]), `${LABELS.email}${"x".repeat(15)}`);
  });
  it("a real overlap: an IBAN is ONE [bank account] even when the digits also look like a phone number or card", () => {
    const text = "DE89 3704 0044 0532 0130 00";
    assert.equal(redactText(text, detectAll(text)), "[bank account]");
  });
  it("`only` limits the classes that are replaced; an empty detection list changes nothing", () => {
    const text = "a@b.example and +421 911 123 456";
    assert.equal(redactText(text, detectAll(text), ["email"]), "[email] and +421 911 123 456");
    assert.equal(redactText(text, []), text);
  });
  it("offsets stay valid for text with non-ASCII characters before the match", () => {
    const text = "Žltý kôň: ärger@beispiel.de";
    const [d] = detectAll(text);
    assert.equal(text.slice(d?.spans[0]?.start, d?.spans[0]?.end), "ärger@beispiel.de");
  });
});

describe("classifyText and classifyRecord", () => {
  it("counts classes, never returns values, and merges the spans", () => {
    const text = "Contact anna@example.com or bob@example.com. The password is hunter2.";
    const f = classifyText(text);
    assert.deepEqual(f.classes, { secret: 1, email: 2 });
    assert.equal(f.secret, true);
    assert.deepEqual(
      f.spans.map((s) => [s.class, text.slice(s.start, s.end)]),
      [["email", "anna@example.com"], ["email", "bob@example.com"], ["secret", "password is hunter2"]],
    );
    assert.ok(!JSON.stringify(f).includes("hunter2") && !JSON.stringify(f).includes("anna@"));
  });
  it("a text that already had a secret cut out still counts as a secret (the marker)", () => {
    const f = classifyText(`please use ${SECRET_MARKER} for that`);
    assert.equal(f.secret, true);
    assert.deepEqual(f.classes, { secret: 1 });
  });
  it("quiet text has no classes, only words", () => {
    const f = classifyText("Lunch at noon on Tuesday?");
    assert.deepEqual([f.classes, f.secret, f.words, f.spans], [{}, false, 5, []]);
  });
  it("a record sums its messages, skips purged ones (null) and decides actionable over the whole text", () => {
    const f = classifyRecord(["mail a@b.example", null, "and c@d.example, please send me the file by Friday"]);
    assert.deepEqual(f.classes, { email: 2 });
    assert.equal(f.secret, false);
    assert.equal(f.actionable, true);
    assert.equal(classifyRecord([null, null]).words, 0);
    assert.equal(classifyRecord([`x ${SECRET_MARKER}`, "plain"]).secret, true);
  });
  it("government id countries and owner words come from the config", () => {
    assert.equal(classifyText("123-45-6789").classes.id, 1);
    assert.equal(classifyText("123-45-6789", { govCountries: ["SK"] }).classes.id, undefined);
    assert.equal(classifyRecord(["the quarterly budget"], {}).actionable, false);
    assert.equal(classifyRecord(["the quarterly budget"], { ownerWords: ["budget"] }).actionable, true);
  });
  it("counts words in any script", () => {
    assert.equal(countWords("Žltý kôň skáče, ärger-frei 123 a it's"), 7);
  });
});

describe("actionable scorer", () => {
  it("fires on requests in English, Slovak and German, with deadlines and questions", () => {
    for (const t of [
      "Please send me the invoice by Friday",
      "Can you approve this? It is urgent",
      "Prosím pošli mi faktúru do piatku",
      "Bitte schick mir die Rechnung bis morgen",
      "TODO: follow up with the client",
      "Potrebujem to dnes. Môžeš pomôcť?",
    ]) assert.ok(isActionable(t), t);
  });
  it("is quiet on plain talk, single weak signals and look-alikes", () => {
    for (const t of ["Lunch at noon on Tuesday?", "Thanks, see you there", "The forwarder arrived", "Great work on the release", "Ďakujem, dobrú noc", "Danke, bis bald"]) {
      assert.ok(!isActionable(t), `${t} (${actionableScore(t)})`);
    }
    assert.equal(ACTIONABLE_THRESHOLD, 3);
  });
  it("owner keywords add to the score on whole words only, any case", () => {
    assert.ok(!isActionable("the renewal is next month"));
    assert.ok(isActionable("the Renewal is next month", ["renewal"]));
    assert.ok(!isActionable("renewals are boring", ["renewal"]), "'renewals' is not the word 'renewal'");
    assert.ok(isActionable("obnovenie zmluvy", ["obnovenie"]));
  });
  it("the score is capped, so one long text cannot buy actionable with filler", () => {
    assert.equal(actionableScore("?".repeat(100)), 2);
  });
});

describe("time budget", () => {
  const prose =
    "Hi team, please send me the report by Friday. Anna (anna@example.com, +421 911 123 456) said the meeting at 10 Downing Street moved to 2026-10-17 12:30. Order 12345678 shipped; invoice 2026-0001234. The password is hunter2 and she has cancer. Costs: DE89 3704 0044 0532 0130 00, card 4111 1111 1111 1111, SSN 123-45-6789. Version 1.2.3.4 build 20261017 uuid 123e4567-e89b-12d3-a456-426614174000. ";
  const fill = (seed: string) => seed.repeat(Math.ceil(16384 / seed.length)).slice(0, 16384);
  const median = (f: () => unknown, runs = 50): number => {
    const t: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      f();
      t.push(performance.now() - s);
    }
    return t.sort((a, b) => a - b)[Math.floor(runs / 2)] as number;
  };
  // shapes made to hurt a regex or a quadratic loop: long runs, nested repeats, many candidates, many separators, non-ASCII, format characters
  const SHAPES = [
    prose, "1234 5678 90 ", "12-34-56-78 ", "a@", "a.b@c.d ", "a@a@a@a@", "a.", "abcdefghij", "-----BEGIN X-----", "eyJabcdefgh.", "DE89 AB12 ", "lorem ipsum dolor sit amet cancer ",
    "12 Foo Bar ", "((", "1/2/3/", "password: ", "key=value&", "=", ":a", "k=v\n", "0 0 0 0 ", "9 4111 1111 1111 1111 ", "Hlavná 1 Hlavná 1 ", "A A A A ", "Aaaaaaaaaaaaaaaaaaaaaaaaaaaa1 ",
    "Ünïcödé wörds äöü ", "ЖЖЖЖ ", "ab\u200bcd", "４１１１ ", "\n\n\n", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n", "00 421 00 421 ", "ul. Hlavná ul. Hlavná ", "1-1-1-1-1-", "…", "+4", "SSN 1", "XX99 ",
  ];
  const DETECTORS: [string, (t: string) => unknown][] = [
    ["secrets", detectSecrets], ["email", detectEmails], ["phone", detectPhones], ["iban", detectIbans], ["card", detectCards], ["govid", detectGovIds], ["address", detectAddresses], ["special", detectSpecial],
  ];
  it("each detector handles 16 KiB of hostile text in under 20 ms (median of 25 runs)", () => {
    for (const shape of SHAPES) {
      const text = fill(shape);
      assert.equal(text.length, 16384);
      for (const [name, detect] of DETECTORS) {
        const m = median(() => detect(text), 25);
        assert.ok(m < 20, `${name} on ${JSON.stringify(shape.slice(0, 24))}: median ${m.toFixed(2)} ms`);
      }
    }
  });
  it("classifying a 16 KiB message takes under 20 ms (median of 50 runs), on every shape", () => {
    assert.equal(fill(prose).length, 16384);
    for (const s of SHAPES) {
      const m = median(() => classifyText(fill(s)), 50);
      assert.ok(m < 20, `${JSON.stringify(s.slice(0, 20))}: median ${m.toFixed(2)} ms`);
    }
  });
  it("the whole pipeline for a 16 KiB message (clean, classify, route) stays under 40 ms", () => {
    assert.ok(median(() => classifyRecord([fill(prose)]), 50) < 40);
  });
});
