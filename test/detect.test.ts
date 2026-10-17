// Detectors (DESIGN §5.3): each one FIRES on valid values and stays QUIET on look-alikes (bad checksum, order numbers,
// timestamps, version strings, UUIDs), L34. Spans are checked as exact substrings of the text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAddresses } from "../src/detect/address.ts";
import { detectCards, knownIssuer, luhn } from "../src/detect/card.ts";
import { detectEmails } from "../src/detect/email.ts";
import { detectGovIds, steuerIdValid } from "../src/detect/govid.ts";
import { detectIbans, mod97 } from "../src/detect/iban.ts";
import { detectPhones } from "../src/detect/phone.ts";
import { detectSecrets } from "../src/detect/secret.ts";
import { detectSpecial } from "../src/detect/special.ts";
import type { Detection } from "../src/detect/types.ts";

const found = (text: string, d: Detection): string[] => d.spans.map((s) => text.slice(s.start, s.end));
/** every sample must produce exactly the expected matches (each value is its own whole match) */
function fires(detect: (t: string) => Detection, samples: [text: string, expected: string[]][]): void {
  for (const [text, expected] of samples) assert.deepEqual(found(text, detect(text)), expected, `should fire: ${JSON.stringify(text)}`);
}
function quiet(detect: (t: string) => Detection, samples: string[]): void {
  for (const text of samples) assert.deepEqual(found(text, detect(text)), [], `should be quiet: ${JSON.stringify(text)}`);
}
// token-shaped fakes built at run time, so no full token sits in the source
const rep = (s: string, n: number) => s.repeat(n);
const GHP = `ghp_${rep("aB3dE6", 6)}`; // 36 chars
const SK = `sk-${rep("Ab1Cd2", 5)}`;
const AWS = `AKIA${rep("Q7", 8)}`;
const SLACK = `xoxb-${rep("1234567890", 2)}-${rep("aBcD", 6)}`;
const GLPAT = `glpat-${rep("x9Y8", 6)}`;
const TB = `tbo_${rep("k3Lm9Q", 5)}`;
const JWT = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".") /* built at run time */;

describe("secrets", () => {
  it("fires on PEM blocks (also an unterminated one: to the end), JWT/JWS, key prefixes, bearer tokens and URL credentials", () => {
    const pem = `-----BEGIN RSA ${"PRIVATE"} KEY-----\nMIIEowIBAAKCAQEA7\nabc==\n-----END RSA ${"PRIVATE"} KEY-----` /* built at run time */;
    fires(detectSecrets, [
      [`key:\n${pem}\nthanks`, [pem]],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk", ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk"]],
      [`token ${JWT} end`, [JWT]],
      [`use ${GHP} now`, [GHP]],
      [`use ${SK}.`, [SK]],
      [`aws ${AWS} x`, [AWS]],
      [`slack ${SLACK} x`, [SLACK]],
      [`gitlab ${GLPAT} x`, [GLPAT]],
      [`ours ${TB} x`, [TB]],
      [`gho_${rep("Zz1", 12)}`, [`gho_${rep("Zz1", 12)}`]],
      ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789", ["Bearer abcdefghijklmnopqrstuvwxyz0123456789"]],
      ["postgres://admin:s3cretpw@db.example.com/app", ["postgres://admin:s3cretpw@"]],
    ]);
  });
  it("fires on password / token / api key / secret with a value, in English, Slovak and German", () => {
    fires(detectSecrets, [
      ["the password is hunter2 ok", ["password is hunter2"]],
      ["API key: abcd-efgh-ijkl-mnop", ["API key: abcd-efgh-ijkl-mnop"]],
      ["token=abc123def", ["token=abc123def"]],
      ['{"password": "Tr0ub4dor&3"}', ['password": "Tr0ub4dor&3']],
      ["heslo je Kvet123", ["heslo je Kvet123"]],
      ["Passwort: Geheim#2026", ["Passwort: Geheim#2026"]],
      ["client_secret = AbCdEfGh1", ["client_secret = AbCdEfGh1"]],
      ["password: correcthorsebattery", ["password: correcthorsebattery"]],
    ]);
  });
  it("is quiet on look-alikes: words about passwords, short or plain values, slugs, identifiers, version strings, UUIDs", () => {
    quiet(detectSecrets, [
      "Please reset your password tomorrow",
      "the token expired yesterday",
      "password is required",
      "password: invalid",
      "the secret is practice",
      "token: ab",
      "task-force-with-a-very-long-slug-name-here",
      "ask-for-help-with-this-long-slug-please",
      "tb_holds_pending and tb_receipts_list_all_items",
      "eyJ is how base64 JSON starts",
      "version 1.2.3 and build 20261017",
      "123e4567-e89b-12d3-a456-426614174000",
      "AKIA is a prefix",
      "sk-short",
      "xoxb is a Slack prefix",
      "see https://example.com/path and ftp://files.example.com",
      "the -----BEGIN marker is explained here",
    ]);
  });
});

describe("email", () => {
  it("fires on addresses (plus tags, subdomains, Unicode), and the span stops before trailing punctuation", () => {
    fires(detectEmails, [
      ["write to anna@example.com.", ["anna@example.com"]],
      ["a.b+tag@mail.sub.example.co.uk, thanks", ["a.b+tag@mail.sub.example.co.uk"]],
      ["<ärger@beispiel.de>", ["ärger@beispiel.de"]],
      ["x@y.io and z@w.org", ["x@y.io", "z@w.org"]],
      ["e-mail: o'brien@example.ie;", ["o'brien@example.ie"]],
    ]);
  });
  it("is quiet on @mentions, versions, hosts without a dot, one-letter top levels and broken domains", () => {
    quiet(detectEmails, ["@mention in chat", "name@1.2", "user@localhost", "a@b", "x@-bad.com", "foo@bar..com", "foo@.com", "price @ 5 EUR", "@", "user@host.c"]);
  });
});

describe("phone", () => {
  it("fires on international, national-with-separators and US numbers", () => {
    fires(detectPhones, [
      ["call +421 911 123 456 today", ["+421 911 123 456"]],
      ["+49 30 12345678.", ["+49 30 12345678"]],
      ["0911 123 456", ["0911 123 456"]],
      ["02/123 456 78", ["02/123 456 78"]],
      ["(030) 1234567", ["(030) 1234567"]],
      ["+1 (555) 123-4567", ["+1 (555) 123-4567"]],
      ["(555) 123-4567", ["(555) 123-4567"]],
      ["555-123-4567", ["555-123-4567"]],
      ["00421 911 123 456", ["00421 911 123 456"]],
      ["0049 30 12345678", ["0049 30 12345678"]],
      ["+420777123456", ["+420777123456"]],
    ]);
  });
  it("is quiet on order numbers, dates, timestamps, versions, IPs, UUIDs, card and IBAN digit groups", () => {
    quiet(detectPhones, [
      "order 12345678 shipped",
      "invoice 2026-0001234",
      "2026-10-17 12:30:45",
      "17.10.2026",
      "17/10/2026",
      "12:30:45",
      "10.0.0.1 and 192.168.100.200",
      "v1.2.3.4",
      "1697500000000",
      "1697500000",
      "0012345678",
      "000123456789",
      "123e4567-e89b-12d3-a456-426614174000",
      "4111 1111 1111 1111",
      "3782 822463 10005",
      "DE89 3704 0044 0532 0130 00",
      "SK31 1200 0000 1987 4263 7541",
      "(555) 123",
      "+12",
      "page 1234 of 5678",
    ]);
  });
});

describe("iban", () => {
  it("fires on valid IBANs, grouped or not, any case, and does not swallow the word after it", () => {
    fires(detectIbans, [
      ["pay DE89 3704 0044 0532 0130 00 please", ["DE89 3704 0044 0532 0130 00"]],
      ["DE89370400440532013000", ["DE89370400440532013000"]],
      ["SK31 1200 0000 1987 4263 7541", ["SK31 1200 0000 1987 4263 7541"]],
      ["CZ65 0800 0000 1920 0014 5399.", ["CZ65 0800 0000 1920 0014 5399"]],
      ["GB82 WEST 1234 5698 7654 32", ["GB82 WEST 1234 5698 7654 32"]],
      ["de89 3704 0044 0532 0130 00", ["de89 3704 0044 0532 0130 00"]],
      ["DE89 3704 0044 0532 0130 00 THANKS", ["DE89 3704 0044 0532 0130 00"]],
    ]);
    assert.equal(mod97("DE89370400440532013000"), 1);
  });
  it("is quiet on a bad checksum, the wrong length, an unknown country and order-number shapes", () => {
    quiet(detectIbans, ["DE89 3704 0044 0532 0130 01", "SK31 1200 0000 1987 4263 7542", "DE89 3704 0044 0532 013", "XX00 0000 0000 0000 0000", "AB12 3456", "order AB12 3456 7890", "GB82WEST12345698765433", "ref DE12"]);
  });
});

describe("card", () => {
  const withCheck = (p: string) => {
    for (let c = 0; c < 10; c++) if (luhn(p + c)) return p + c;
    throw new Error("no check digit");
  };
  it("fires on Luhn-valid numbers with a known issuer: Visa, Mastercard, Amex, Discover, with spaces, dashes or none", () => {
    fires(detectCards, [
      ["card 4111 1111 1111 1111 exp", ["4111 1111 1111 1111"]],
      ["4111-1111-1111-1111", ["4111-1111-1111-1111"]],
      ["4111111111111111", ["4111111111111111"]],
      ["5500 0000 0000 0004", ["5500 0000 0000 0004"]],
      ["3782 822463 10005", ["3782 822463 10005"]],
      ["6011 1111 1111 1117", ["6011 1111 1111 1117"]],
      ["2221 0000 0000 0009", ["2221 0000 0000 0009"]],
    ]);
  });
  it("is quiet on a bad Luhn sum, an unknown issuer (valid Luhn), timestamps, order numbers, short and long digit chains", () => {
    assert.ok(luhn(withCheck("100000000000000")) && !knownIssuer(withCheck("100000000000000")), "fixture: Luhn-valid but no issuer");
    quiet(detectCards, [
      "4111 1111 1111 1112",
      withCheck("100000000000000"),
      withCheck("200000000000000"),
      "1697500000000",
      "order 2026101712345678",
      "1234 5678 9012 3456",
      "4111 1111 111",
      "1234 5678 9012 3456 7890 1234",
      "4111 1111 1111 1111 1111 1111",
    ]);
  });
});

describe("government ids", () => {
  it("fires on SK/CZ rodné číslo (10 digits divisible by 11; the 9-digit form only with a slash), also written without the slash", () => {
    fires(detectGovIds, [
      ["RČ 850327/1007 prosím", ["850327/1007"]],
      ["8503271007", ["8503271007"]],
      ["916105/1009", ["916105/1009"]], // woman: month + 50
      ["030228/1001", ["030228/1001"]],
    ]);
    assert.equal(detectGovIds("540101/123").count, 0, "9 digits with year 54 or later: not a valid 9-digit number");
    assert.equal(detectGovIds("531231/123").count, 1, "9-digit form (born before 1954) with the slash");
    assert.equal(detectGovIds("531231123").count, 0, "…but not without the slash");
  });
  it("fires on German Steuer-ID (11 digits, mod 11/10, frequency rule), grouped or not", () => {
    fires(detectGovIds, [
      ["Steuer-ID 10841975314", ["10841975314"]],
      ["Steuer-ID 10 841 975 314", ["10 841 975 314"]],
      ["13520987667", ["13520987667"]],
    ]);
    assert.ok(steuerIdValid("14209876551"));
  });
  it("fires on US SSN with the area rules", () => {
    fires(detectGovIds, [
      ["ssn 123-45-6789", ["123-45-6789"]],
      ["123 45 6789", ["123 45 6789"]],
      ["899-45-6789", ["899-45-6789"]],
    ]);
  });
  it("is quiet on a bad checksum, an impossible date, a bad area/group/serial, order numbers and phone-like digits", () => {
    quiet(detectGovIds, [
      "850327/1008", // checksum
      "851327/1007", // month 13
      "850232/1007", // 32nd day
      "10841975315", // Steuer check digit
      "00841975314", // starts with 0
      "11111111111", // frequency rule
      "10 841 975 315",
      "000-12-3456",
      "666-12-3456",
      "900-12-3456",
      "123-00-4567",
      "123-45-0000",
      "order 1234567",
      "+421 911 123 456",
      "2026-10-17",
      "1697500000000",
    ]);
  });
  it("looks only at the configured countries (one table)", () => {
    const text = "850327/1007 and 123-45-6789 and 10841975314";
    assert.equal(detectGovIds(text).count, 3);
    assert.equal(detectGovIds(text, ["US"]).count, 1);
    assert.equal(detectGovIds(text, ["sk"]).count, 1, "country codes are not case sensitive");
    assert.equal(detectGovIds(text, ["SK", "CZ"]).count, 1, "SK and CZ share the format: found once");
    assert.equal(detectGovIds(text, []).count, 0);
    assert.equal(detectGovIds(text, ["XX"]).count, 0, "an unknown country is ignored");
  });
});

describe("address", () => {
  it("fires on a street with a house number (EN, SK/CZ, DE) and takes a following postal code and city", () => {
    fires(detectAddresses, [
      ["I live at 10 Downing Street, London.", ["10 Downing Street"]],
      ["221 Baker Street", ["221 Baker Street"]],
      ["ul. Hlavná 12/3, 811 01 Bratislava", ["ul. Hlavná 12/3, 811 01 Bratislava"]],
      ["námestie SNP 15", ["námestie SNP 15"]],
      ["Musterstraße 5a, 10115 Berlin", ["Musterstraße 5a, 10115 Berlin"]],
      ["Hauptstr. 12", ["Hauptstr. 12"]],
    ]);
  });
  it("is quiet on a street without a number, a bare postal code or city, and look-alikes", () => {
    quiet(detectAddresses, ["Main Street", "I live on Elm Street", "811 01 Bratislava", "order 10115 Berlin", "5 apples", "3 items Street", "version 12 released", "Straße", "ulica"]);
  });
});

describe("special-category words", () => {
  it("fires on health, religion, union, sexuality and ethnicity words in English, Slovak and German (whole words, stems, phrases, any case)", () => {
    fires(detectSpecial, [
      ["She was diagnosed with cancer.", ["diagnosed", "cancer"]],
      ["he is a Muslim", ["Muslim"]],
      ["next trade union meeting", ["trade union"]],
      ["his sexual orientation", ["sexual orientation"]],
      ["on sick leave", ["sick leave"]],
      ["CANCER", ["CANCER"]],
      ["Alzheimers runs in the family", ["Alzheimers"]],
      ["má rakovinu a je tehotná", ["rakovinu", "tehotná"]],
      ["odborové združenie", ["odborové"]],
      ["Er ist schwul und in der Gewerkschaft", ["schwul", "Gewerkschaft"]],
      ["Krebs, Schwangerschaft, ethnische Herkunft", ["Krebs", "Schwangerschaft", "ethnische"]],
      ["sexuálna orientácia", ["sexuálna orientácia"]],
      ["the Roma and Sinti communities", ["Roma", "Sinti"]],
    ]);
  });
  it("is quiet on names, general words and look-alikes: Christian, Christoph, European Union, race condition, odborný, prediagnosis", () => {
    quiet(detectSpecial, [
      "Christian wrote this",
      "Christoph and Christina",
      "the European Union and a union of two sets",
      "a race condition in the code",
      "odborný posudok",
      "prediagnosis form",
      "cancel the meeting",
      "teaching aids",
      "Rome in spring",
      "er sucht einen Termin",
      "operation Overlord",
      "faith in the process",
      "Tuesday at noon",
    ]);
  });
  it("matches Unicode word boundaries: not inside a longer word, also after non-ASCII letters", () => {
    quiet(detectSpecial, ["übercancer", "cancerous"]);
    assert.equal(detectSpecial("(cancer)").count, 1);
    assert.equal(detectSpecial("rakovina, tehotenstvo").count, 2);
  });
});
