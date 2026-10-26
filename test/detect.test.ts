// Detectors (DESIGN §5.3): each one FIRES on valid values and stays QUIET on look-alikes (bad checksum, order numbers,
// timestamps, version strings, UUIDs), L34. Spans are checked as exact substrings of the text. Every quiet list comes with a
// control: a nearby valid value that the same detector DOES find, so a detector that finds nothing at all cannot pass.
// Secret-shaped fixtures are assembled at run time (no secret-shaped literal in the repo, so the secret scan stays clean).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAddresses } from "../src/detect/address.ts";
import { detectCards, knownIssuer, luhn } from "../src/detect/card.ts";
import { detectEmails } from "../src/detect/email.ts";
import { detectGovIds, steuerIdValid } from "../src/detect/govid.ts";
import { detectIbans, domesticAccountValid, IBAN_LENGTH, mod97 } from "../src/detect/iban.ts";
import { detectAll, redactText } from "../src/detect/index.ts";
import { detectNames } from "../src/detect/name.ts";
import { detectPhones, splitCallingCode } from "../src/detect/phone.ts";
import { detectSecrets, shannonEntropy } from "../src/detect/secret.ts";
import { detectSpecial } from "../src/detect/special.ts";
import type { Detection } from "../src/detect/types.ts";
import { invalidWordEntries, validWordEntry } from "../src/detect/words.ts";

const found = (text: string, d: Detection): string[] => d.spans.map((s) => text.slice(s.start, s.end));
/** every sample must produce exactly the expected matches (each value is its own whole match) */
function fires(detect: (t: string) => Detection, samples: [text: string, expected: string[]][]): void {
  for (const [text, expected] of samples) assert.deepEqual(found(text, detect(text)), expected, `should fire: ${JSON.stringify(text)}`);
}
/** quiet on every sample, and (the control) NOT quiet on a valid value of the same kind */
function quiet(detect: (t: string) => Detection, samples: string[], control: string): void {
  assert.ok(detect(control).count > 0, `control must fire: ${JSON.stringify(control)}`);
  for (const text of samples) assert.deepEqual(found(text, detect(text)), [], `should be quiet: ${JSON.stringify(text)}`);
}
const j = (...parts: string[]): string => parts.join("");
const rep = (s: string, n: number): string => s.repeat(n);
// token-shaped fakes built at run time
const GHP = j("ghp", "_", rep("aB3dE6", 6));
const SK = j("sk", "-", rep("Ab1Cd2", 5));
const AWS = j("AKIA", rep("Q7", 8));
const SLACK = j("xox", "b-", rep("1234567890", 2), "-", rep("aBcD", 6));
const GLPAT = j("glpat", "-", rep("x9Y8", 6));
const TB = j("tbo", "_", rep("k3Lm9Q", 5));
const WHSEC = j("whsec", "_", rep("Ab3dEf", 6));
const NPM = j("npm", "_", rep("aB3dE6", 6));
const HF = j("hf", "_", rep("aB3dE6", 6));
const SENDGRID = j("SG", ".", rep("aB3dE6", 4), ".", rep("xY7zW9", 4));
const XAPP = j("xapp", "-1-", rep("A0B1C2", 5), "-", rep("1234567890", 2));
const HOOK = j("https://hooks.slack", ".com/services/", "T0AAAAAAA/B0BBBBBBB/", rep("aB3dE6", 4));
const TELEGRAM = j("1234567890", ":", rep("aB3dE6", 5), "x-y_z");
const YA29 = j("ya29", ".", rep("aB3dE6", 6));
const GOOGLE = j("AIza", rep("Sy3dE6", 6).slice(0, 35));
const ACCOUNT_KEY = j("AccountKey", "=", rep("aB3dE6", 6), "==");
const SAS = j("https://store.example/blob?sv=2020&", "sig", "=", rep("aB3dE6", 4), "%3D");
const BASIC = j("Authorization", ": Basic ", "dXNlcjpwYXNzd29yZDEyMw==");
const JWT = [j("eyJhbGciOiJIUzI1Ni", "IsInR5cCI6IkpXVCJ9"), j("eyJzdWIiOiIxMjM0NTY3", "ODkwIiwibmFtZSI6IkpvaG4ifQ"), j("SflKxwRJSMeKKF2QT4fwpMeJf36P", "Ok6yJV_adQssw5c")].join(".");
const JWE = [j("eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0"), "", j("48V1_ALb6US04U3b"), j("5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A"), j("XFBoMYUZodetZdvTiFvSkQ")].join(".");
const PEM_HEAD = (kind: string) => `-----BEGIN ${kind} ${"PRIVATE"} KEY-----`;
const PEM_FOOT = (kind: string) => `-----END ${kind} ${"PRIVATE"} KEY-----`;
const B64_LINE = rep("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", 2); // 64 base64 characters

describe("secrets", () => {
  it("fires on PEM blocks (also an unterminated one: to the end), JWT/JWS and JWE with an empty part", () => {
    const pem = `${PEM_HEAD("RSA")}\nMIIEowIBAAKCAQEA7\nabc==\n${PEM_FOOT("RSA")}`;
    fires(detectSecrets, [
      [`see below:\n${pem}\nthanks`, [pem]],
      [`${PEM_HEAD("OPENSSH")}\nb3BlbnNzaC1rZXk`, [`${PEM_HEAD("OPENSSH")}\nb3BlbnNzaC1rZXk`]],
      [`token ${JWT} end`, [JWT]],
      [`jwe ${JWE} end`, [JWE]],
    ]);
  });
  it("fires on a PEM body without its header: three or more lines of 60+ base64 characters", () => {
    const body = rep(`${B64_LINE}\n`, 4);
    fires(detectSecrets, [[`here:\n${body}done`, [`${body.trimEnd()}\n`].map((x) => x)]]);
    assert.equal(detectSecrets(`${rep(`${B64_LINE}\n`, 3)}done`).count, 1, "three lines are enough");
    assert.equal(detectSecrets(`${rep(`${B64_LINE}\n`, 2)}done`).count, 0, "two lines are not");
    assert.equal(detectSecrets(rep("this is an ordinary sentence of prose that is long enough to wrap around the line\n", 6)).count, 0, "prose has spaces");
  });
  it("fires on key formats: sk-, GitHub, AWS, Slack (xox, xapp, webhook), GitLab, Tealbrick, Stripe webhook, npm, Hugging Face, SendGrid, Google, Telegram", () => {
    fires(
      detectSecrets,
      [GHP, SK, AWS, SLACK, GLPAT, TB, WHSEC, NPM, HF, SENDGRID, XAPP, HOOK, TELEGRAM, YA29, GOOGLE, j("gho", "_", rep("Zz1", 12))].map((s): [string, string[]] => [`use ${s} now`, [s]]),
    );
  });
  it("fires on Basic and Bearer credentials (any token of 8+ characters), URL credentials and Azure keys / SAS signatures", () => {
    fires(detectSecrets, [
      [BASIC, [BASIC]],
      ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789", ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"]],
      ["send Bearer abcdefghijklmnopqrstuvwxyz0123456789 now", ["Bearer abcdefghijklmnopqrstuvwxyz0123456789"]],
      ["curl -H 'Bearer abcd1234'", ["Bearer abcd1234"]],
      [j("postgres://admin:s3cretpw", "@db.example.com/app"), [j("postgres://admin:s3cretpw", "@")]],
      [`Server=x;${ACCOUNT_KEY};EndpointSuffix=core`, [ACCOUNT_KEY]],
      [`Endpoint=sb://x/;${j("SharedAccessKey", "=", rep("aB3dE6", 4))}`, [j("SharedAccessKey", "=", rep("aB3dE6", 4))]],
      [`open ${SAS} now`, [j("sig", "=", rep("aB3dE6", 4), "%3D")]],
    ]);
  });
  it("fires on identifier-style keys: DB_PASSWORD=, MY_API_KEY=, AZURE_CLIENT_SECRET=, aws_secret_access_key=, access_token, secret_key:, dbPassword:, clientSecret:", () => {
    fires(detectSecrets, [
      ["DB_PASSWORD=hunter22", ["DB_PASSWORD=hunter22"]],
      ["MY_API_KEY=abcd", ["MY_API_KEY=abcd"]],
      ["AZURE_CLIENT_SECRET=Q8~xyz", ["AZURE_CLIENT_SECRET=Q8~xyz"]],
      ["aws_secret_access_key = abc123", ["aws_secret_access_key = abc123"]],
      ['{"access_token":"abc def ghi."}', ['access_token":"abc def ghi."']],
      ["secret_key: changeme", ["secret_key: changeme"]],
      ["dbPassword: Summer2026!", ["dbPassword: Summer2026!"]],
      ["clientSecret=abcd1234", ["clientSecret=abcd1234"]],
      ["my.api-key = 'x y z w'", ["my.api-key = 'x y z w'"]],
      ["API key: abcd-efgh-ijkl-mnop", ["API key: abcd-efgh-ijkl-mnop"]],
      ["heslo: Kvet123", ["heslo: Kvet123"]],
      ["Passwort = Geheim#2026", ["Passwort = Geheim#2026"]],
    ]);
  });
  it("in a URL the value of ?access_token= stops at & or a space; elsewhere it runs to the end of the line, or to the closing quote", () => {
    fires(detectSecrets, [
      ["GET /cb?access_token=abc123&state=1 HTTP/1.1", ["access_token=abc123"]],
      ["see https://x.test/?code=1&token=zzzz9999 please", ["token=zzzz9999"]],
      ["password: abc, thanks.\nnext line", ["password: abc, thanks."]],
      ['password = "my pass phrase here" and more', ['password = "my pass phrase here"']],
      ['{"user":"bob","password":"x y 1","role":"admin"}', ['password":"x y 1"']],
      ["token: line one\nplain second line", ["token: line one"]],
      ["password:\nhunter2222", ["password:\nhunter2222"]],
    ]);
  });
  it("after an explicit separator any value of 4+ characters is a secret (changeme is one); only boolean / null words and short values are not", () => {
    for (const v of ["changeme", "admin", "1234", "expired", "required", "x=y&z", "pass word"]) assert.equal(detectSecrets(`password: ${v}`).count, 1, v);
    for (const v of ["true", "false", "null", "none", "nil", "undefined", "redacted", "ab", "abc", ""]) assert.equal(detectSecrets(`password: ${v}`).count, 0, `[${v}]`);
    assert.equal(detectSecrets("PASSWORD: NULL").count, 0, "any case");
  });
  it("the sentence form needs the length / charset heuristic: 'the password is hunter2' fires, prose words do not", () => {
    fires(detectSecrets, [
      ["the password is hunter2 ok", ["password is hunter2"]],
      ["heslo je Kvet123", ["heslo je Kvet123"]],
      ["the password is hunter2.", ["password is hunter2"]],
    ]);
    quiet(detectSecrets, ["the password is required", "the token is expired", "the secret is practice", "your password is wrong", "heslo je povinné"], "the password is hunter2");
  });
  it("fires on a high-entropy value (20+ characters, 3.5+ bits per character) after = or : whatever the key is called", () => {
    const rnd = "f9Gk2LmQx7PzVb3TnYc8WsDu";
    assert.ok(shannonEntropy(rnd) >= 3.5);
    fires(detectSecrets, [
      [`data: ${rnd}`, [rnd]],
      [`x-trace=${rnd}`, [rnd]],
    ]);
  });
  it("finds a keyword written with look-alike letters (Cyrillic а) or zero-width characters, and the span covers the ORIGINAL characters", () => {
    const cyr = "pаssword: hunter22"; // Cyrillic а
    const zw = "pass​word = hunter22"; // zero-width space
    const bidi = "to‎k⁠en=hunter22";
    fires(detectSecrets, [
      [cyr, [cyr]],
      [zw, [zw]],
      [bidi, [bidi]],
      [`Passwоrd: hunter22`, [`Passwоrd: hunter22`]],
    ]);
    const key = `${GHP.slice(0, 3)}​${GHP.slice(3)}`;
    assert.equal(redactText(`k ${key} z`, detectAll(`k ${key} z`)), "k [secret removed] z", "a zero-width character inside a key does not hide it");
  });
  it("is quiet on look-alikes: words about passwords, short values, slugs, identifiers, hashes, UUIDs, timestamps, paths, versions", () => {
    quiet(
      detectSecrets,
      [
        "Please reset your password tomorrow",
        "the token expired yesterday",
        "compass: north-east and bypass: yes",
        "secretary: Anna Smith",
        "tokenizer: wordpiece",
        "password_policy: strong",
        "passenger: John Smith",
        "token: ab",
        "task-force-with-a-very-long-slug-name-here",
        "ask-for-help-with-this-long-slug-please",
        "tb_holds_pending and tb_receipts_list_all_items",
        "eyJ is how base64 JSON starts",
        "version = 1.2.3 and build 20261017",
        "id: 123e4567-e89b-12d3-a456-426614174000",
        "sha: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "created: 2026-10-17T12:30:45.123Z",
        "path: /usr/local/share/applications/some/file",
        "ratio: 3.14159265358979323846",
        "link: https://example.com/some/long/path/here",
        "AKIA is a prefix",
        "sk-short",
        "xoxb is a Slack prefix",
        "see https://example.com/path and ftp://files.example.com",
        "the -----BEGIN marker is explained here",
        "Basic information about the Bearer of bad news",
        "hf_ and npm_ are prefixes, whsec_ too",
      ],
      "DB_PASSWORD=hunter22",
    );
  });
});

describe("email", () => {
  it("fires on addresses (plus tags, subdomains, Unicode, NFD, underscore hosts, SRS), and the span stops before trailing punctuation", () => {
    const srs = "user+SRS0=ab12=XY=example.com=bob@forwarder.example";
    fires(detectEmails, [
      ["write to anna@example.com.", ["anna@example.com"]],
      ["a.b+tag@mail.sub.example.co.uk, thanks", ["a.b+tag@mail.sub.example.co.uk"]],
      ["<ärger@beispiel.de>", ["ärger@beispiel.de"]],
      ["<ärger@beispiel.de>", ["ärger@beispiel.de"]], // NFD: a + combining diaeresis
      ["x@y.io and z@w.org", ["x@y.io", "z@w.org"]],
      ["e-mail: o'brien@example.ie;", ["o'brien@example.ie"]],
      ["mail x@my_host.example.com now", ["x@my_host.example.com"]],
      [`forwarded from ${srs} today`, [srs]],
    ]);
  });
  it("is quiet on @mentions, versions, hosts without a dot, one-letter top levels and broken domains", () => {
    quiet(detectEmails, ["@mention in chat", "name@1.2", "user@localhost", "a@b", "x@-bad.com", "foo@bar..com", "foo@.com", "price @ 5 EUR", "@", "user@host.c"], "write to anna@example.com");
  });
});

describe("phone", () => {
  it("fires on international, national-with-separators, bare national and US numbers", () => {
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
      ["0911123456", ["0911123456"]],
      ["tel 00421911123456 pls", ["00421911123456"]],
    ]);
  });
  it("splits a list on '/', ',' and ';' and finds each number", () => {
    fires(detectPhones, [
      ["0911 123 456/0912 111 222", ["0911 123 456", "0912 111 222"]],
      ["+421 911 123 456, +421 912 111 222; 0905 333 444", ["+421 911 123 456", "+421 912 111 222", "0905 333 444"]],
      ["02/123 456 78 or 0911 123 456", ["02/123 456 78", "0911 123 456"]],
    ]);
  });
  it("00CC needs a real country calling code and a plausible length: 0012345678 is an order number", () => {
    assert.deepEqual(splitCallingCode("421911123456"), ["421", "911123456"]);
    assert.deepEqual(splitCallingCode("49301234567"), ["49", "301234567"]);
    assert.equal(splitCallingCode("0123456789"), null);
    assert.equal(splitCallingCode("999123"), null);
  });
  it("is quiet on order numbers, dates, timestamps, versions, IPs, UUID parts, card and IBAN digit groups", () => {
    quiet(
      detectPhones,
      [
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
        "0000000000",
        "123e4567-e89b-12d3-a456-426614174000",
        "4111 1111 1111 1111",
        "3782 822463 10005",
        "DE89 3704 0044 0532 0130 00",
        "SK31 1200 0000 1987 4263 7541",
        "(555) 123",
        "+12",
        "page 1234 of 5678",
      ],
      "call +421 911 123 456",
    );
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
  it("knows every SEPA country and Brazil from one table", () => {
    const valid = [
      "BR1800360305000010009795493C1", "AD1200012030200359100100", "GI75NWBK000000007099453", "IE29AIBK93115212345678", "NL91ABNA0417164300",
      "FR1420041010050500013M02606", "PL61109010140000071219812874", "ES9121000418450200051332", "IT60X0542811101000000123456",
      "HU42117730161111101800000000", "AT611904300234573201", "LU280019400644750000", "CH9300762011623852957",
    ];
    for (const iban of valid) {
      assert.equal(IBAN_LENGTH[iban.slice(0, 2)], iban.length, iban);
      assert.equal(detectIbans(`iban ${iban} ok`).count, 1, iban);
    }
    for (const cc of ["AD", "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GI", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK", "SM", "VA", "BR"]) {
      assert.ok(IBAN_LENGTH[cc], `${cc} is in the table`);
    }
  });
  it("fires on Slovak / Czech domestic account numbers with the mod-11 check, with or without a prefix", () => {
    fires(detectIbans, [
      ["účet 19-2000145399/0800 prosím", ["19-2000145399/0800"]],
      ["účet 27-1234665421/1100", ["27-1234665421/1100"]],
      ["1234665421/1100", ["1234665421/1100"]],
    ]);
    assert.equal(domesticAccountValid("19", "2000145399"), true);
    assert.equal(domesticAccountValid(undefined, "1234665421"), true);
  });
  it("is quiet on a bad checksum, the wrong length, an unknown country and order-number shapes; domestic: bad check digit, short numbers, dates, fractions", () => {
    quiet(
      detectIbans,
      [
        "DE89 3704 0044 0532 0130 01", "SK31 1200 0000 1987 4263 7542", "DE89 3704 0044 0532 013", "XX00 0000 0000 0000 0000", "AB12 3456",
        "order AB12 3456 7890", "GB82WEST12345698765433", "ref DE12",
        "19-2000145398/0800", "1234665422/1100", "12/3456", "17/10/2026", "5/2026", "see 1234/5678 in the report", "20-123456/0800",
      ],
      "DE89 3704 0044 0532 0130 00",
    );
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
  it("finds the card when digits touch it: an expiry, a CVV, a prefix, text on both sides", () => {
    fires(detectCards, [
      ["4111 1111 1111 1111 12/26", ["4111 1111 1111 1111"]],
      ["4111 1111 1111 1111 123", ["4111 1111 1111 1111"]],
      ["4111 1111 1111 1111 12 26 123", ["4111 1111 1111 1111"]],
      ["9 4111 1111 1111 1111", ["4111 1111 1111 1111"]],
      ["order 77 4111-1111-1111-1111 cvv 123", ["4111-1111-1111-1111"]],
    ]);
  });
  it("finds two cards in one text", () => {
    fires(detectCards, [["4111 1111 1111 1111 and 5500 0000 0000 0004", ["4111 1111 1111 1111", "5500 0000 0000 0004"]]]);
  });
  it("is quiet on a bad Luhn sum, an unknown issuer (valid Luhn), timestamps, order numbers and short digit runs", () => {
    assert.ok(luhn(withCheck("100000000000000")) && !knownIssuer(withCheck("100000000000000")), "fixture: Luhn-valid but no issuer");
    quiet(
      detectCards,
      ["4111 1111 1111 1112", withCheck("100000000000000"), withCheck("200000000000000"), "1697500000000", "order 2026101712345678", "4111 1111 111", "12 34 56 78"],
      "card 4111 1111 1111 1111",
    );
  });
});

describe("government ids", () => {
  it("fires on SK/CZ rodné číslo (10 digits divisible by 11; the 9-digit form only with a slash), with a slash, a space, or none", () => {
    fires(detectGovIds, [
      ["RČ 850327/1007 prosím", ["850327/1007"]],
      ["8503271007", ["8503271007"]],
      ["850327 1007", ["850327 1007"]],
      ["916105/1009", ["916105/1009"]], // woman: month + 50
      ["030228/1001", ["030228/1001"]],
    ]);
    assert.equal(detectGovIds("531231/123").count, 1, "9-digit form (born before 1954) with the slash");
    assert.equal(detectGovIds("531231123").count, 0, "…but not without the slash");
    assert.equal(detectGovIds("540101/123").count, 0, "9 digits with year 54 or later: not a valid 9-digit number");
  });
  it("fires on German Steuer-ID (11 digits, mod 11/10, frequency rule), grouped or not", () => {
    fires(detectGovIds, [
      ["Steuer-ID 10841975314", ["10841975314"]],
      ["Steuer-ID 10 841 975 314", ["10 841 975 314"]],
      ["13520987667", ["13520987667"]],
    ]);
    assert.ok(steuerIdValid("14209876551"));
  });
  it("fires on US SSN with the area rules; nine digits without separators only next to 'SSN' or 'social security'", () => {
    fires(detectGovIds, [
      ["ssn 123-45-6789", ["123-45-6789"]],
      ["123 45 6789", ["123 45 6789"]],
      ["899-45-6789", ["899-45-6789"]],
      ["my SSN 123456789 thanks", ["123456789"]],
      ["Social Security Number: 123456789", ["123456789"]],
      ["social security no. 123456789", ["123456789"]],
    ]);
  });
  it("is quiet on a bad checksum, an impossible date, a bad area/group/serial, order numbers, phone-like digits, and nine bare digits", () => {
    quiet(
      detectGovIds,
      [
        "850327/1008", // checksum
        "851327/1007", // month 13
        "850232/1007", // 32nd day
        "10841975315", // Steuer check digit
        "00841975314", // starts with 0
        "11111111111", // frequency rule
        "10 841 975 315",
        "000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000",
        "ssn 000123456", "SSN 666123456", "ssn 123450000",
        "order 123456789", "invoice 987654321 paid",
        "order 1234567",
        "+421 911 123 456",
        "2026-10-17",
        "1697500000000",
      ],
      "RČ 850327/1007",
    );
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

// Synthetic names only (invented people, the German sample names Erika Mustermann / Max Mustermann, the Czech sample name Jan Novák).
describe("names", () => {
  it("fires on a known given name and the capitalised words after it (EN, SK/CZ, DE)", () => {
    fires(detectNames, [
      ["Hello, this is Jana Testová from Example Ltd.", ["Jana Testová"]],
      ["Peter Example told me about it.", ["Peter Example"]],
      ["Ask Erika Mustermann in Berlin.", ["Erika Mustermann"]],
      ["Zavolaj Jánovi, Ján Novák to vie.", ["Ján Novák"]],
      ["Mia sent it yesterday.", ["Mia"]],
      ["Anna-Lena Beispiel und Max Mustermann kommen.", ["Anna-Lena Beispiel", "Max Mustermann"]],
    ]);
  });
  it("fires on any capitalised word after a title or a greeting, but not on the title or greeting itself", () => {
    fires(detectNames, [
      ["Sehr geehrte Frau Musterfrau,", ["Musterfrau"]],
      ["Dobrý deň, pán Novák, posielam faktúru.", ["Novák"]],
      ["Dear Mr. Example, thank you.", ["Example"]],
      ["Ahoj Zuzka, vďaka!", ["Zuzka"]],
      ["Liebe Kerstin, danke.", ["Kerstin"]],
    ]);
  });
  it("fires on the writer's name after a sign-off, on the next line or after the comma", () => {
    fires(detectNames, [
      ["Thanks,\nAlex", ["Alex"]],
      ["Best regards, Jan Novák", ["Jan Novák"]],
      ["S pozdravom\r\nZuzana Príkladová\r\n", ["Zuzana Príkladová"]],
      ["Viele Grüße\nBernadette Beispiel", ["Bernadette Beispiel"]],
    ]);
  });
  it("is quiet on given names that are also words, without a surname or cue; on months, days, teams, capital nouns and email addresses", () => {
    quiet(
      detectNames,
      [
        "Will you mark the bill in May?",
        "Grace period ends Friday.",
        "Die Rechnung kommt am Montag.",
        "Hello Team, the Q4 Summary is ready.",
        "Hi, Hope you are well.",
        "Liebe Grüße\nDein Team",
        "Write to anna.testova@example.com or Anna.Testova@example.com today.",
        "See https://example.com/Peter/Page for it.",
        "JANA NOVAKOVA called.",
        "Can you send the Q4 summary to the team by Friday?",
        "Hallo zusammen, Danke für alles.",
      ],
      "Hi Anna, can you send it?",
    );
  });
  it("a name is personal data: detectAll reports it, and redaction writes [name]", () => {
    const text = "Peter Example: call me";
    assert.ok(detectAll(text).some((d) => d.class === "name"));
    assert.equal(redactText(text, detectAll(text)), "[name]: call me");
  });
  it("stays linear: a 64 KiB text of capitalised words classifies quickly", () => {
    const text = rep("Anna Beispiel Example Word ", 2500);
    const t0 = performance.now();
    detectNames(text);
    assert.ok(performance.now() - t0 < 1000);
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
  it("fires on Slovak and Czech addresses without 'ul.' (low confidence): an adjective-like street name, or 'ulica', then the number", () => {
    fires(detectAddresses, [
      ["bývam na Hlavná 12, 811 01 Bratislava", ["Hlavná 12, 811 01 Bratislava"]],
      ["Štúrova 5", ["Štúrova 5"]],
      ["Mlynská 3/A", ["Mlynská 3/A"]],
      ["Zahradní 15, 110 00 Praha", ["Zahradní 15, 110 00 Praha"]],
      ["Kvetná ulica 8", ["Kvetná ulica 8"]],
    ]);
  });
  it("is quiet on a street without a number, a bare postal code or city, and look-alikes", () => {
    quiet(
      detectAddresses,
      ["Main Street", "I live on Elm Street", "811 01 Bratislava", "order 10115 Berlin", "5 apples", "3 items Street", "version 12 released", "Straße", "ulica", "Hlavná ulica", "Hlavná"],
      "I live at 10 Downing Street",
    );
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
  it("matches hyphenated tokens (HIV-positive), text without diacritics (Slovak typed on a plain keyboard) and German compounds", () => {
    fires(detectSpecial, [
      ["he is HIV-positive", ["HIV"]],
      ["follow-up for her sick-leave", ["sick-leave"]],
      ["ma rakovinu a je tehotna", ["rakovinu", "tehotna"]],
      ["je v praceneschopnosti", ["praceneschopnosti"]],
      ["zidovsky a katolicky", ["zidovsky", "katolicky"]],
      ["Er hat Lungenkrebs und eine Herzerkrankung", ["Lungenkrebs", "Herzerkrankung"]],
      ["Autoimmunerkrankung", ["Autoimmunerkrankung"]],
    ]);
  });
  it("is quiet on names, general words and look-alikes: Christian, Christoph, European Union, race condition, odborný, prediagnosis", () => {
    quiet(
      detectSpecial,
      [
        "Christian wrote this", "Christoph and Christina", "the European Union and a union of two sets", "a race condition in the code", "odborný posudok",
        "prediagnosis form", "cancel the meeting", "teaching aids", "Rome in spring", "er sucht einen Termin", "operation Overlord", "faith in the process",
        "Tuesday at noon",
      ],
      "she has cancer",
    );
  });
  it("matches Unicode word boundaries: not inside a longer word, also after non-ASCII letters", () => {
    quiet(detectSpecial, ["übercancer", "cancerous"], "(cancer)");
    assert.equal(detectSpecial("rakovina, tehotenstvo").count, 2);
  });
  it("rule word lists: empty, '*' and stems under 3 letters are not usable", () => {
    for (const bad of ["", "   ", "*", "**", "ab*", "a*", "*ab", "x y*", "co*", "*"]) assert.equal(validWordEntry(bad), false, JSON.stringify(bad));
    for (const good of ["abc*", "invoice", "sick leave", "trade union*", "*krebs", "a", "faktúr*", "to-do"]) assert.equal(validWordEntry(good), true, good);
    assert.deepEqual(invalidWordEntries(["ok", "*", "ab*", "fine*"]), ["*", "ab*"]);
  });
});

describe("normalised detection (detectAll)", () => {
  it("finds a card typed with full-width digits or zero-width characters and redacts the original characters", () => {
    const fullWidth = "４１１１ １１１１ １１１１ １１１１";
    const zw = "4111​ 1111​ 1111 1111";
    assert.equal(redactText(`card ${fullWidth} ok`, detectAll(`card ${fullWidth} ok`)), "card [card] ok");
    assert.equal(redactText(`card ${zw} ok`, detectAll(`card ${zw} ok`)), "card [card] ok");
  });
  it("finds an email with a zero-width character inside and redacts all of it", () => {
    const text = "write to an​na@exam​ple.com now";
    assert.equal(redactText(text, detectAll(text)), "write to [email] now");
  });
  it("quiet text stays untouched, also when it holds format characters", () => {
    const text = "hello​ world — nothing here";
    assert.deepEqual(detectAll(text), []);
    assert.equal(redactText(text, detectAll(text)), text);
  });
});
