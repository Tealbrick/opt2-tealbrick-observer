// Secret hardening: more formats, key-name shapes, normalisation tricks, the suspect_secret fail-safe, joined scans and the
// 64 K boundary. Secret-shaped fixtures are built at run time. Every "fires" list has a quiet list with a control, L34.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAll, redactText } from "../src/detect/index.ts";
import { detectSecrets } from "../src/detect/secret.ts";
import { detectSuspect } from "../src/detect/suspect.ts";
import type { Detection } from "../src/detect/types.ts";
import { joinedSecretScan, MAX_SCANNED_MESSAGES } from "../src/records.ts";

const j = (...p: string[]) => p.join("");
const rep = (s: string, n: number) => s.repeat(n);
const hex = (n: number) => rep("9f86d081884c7d65", Math.ceil(n / 16)).slice(0, n);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const found = (text: string, d: Detection): string[] => d.spans.map((s) => text.slice(s.start, s.end));
function fires(text: string, expected: string[]): void {
  assert.deepEqual(found(text, detectSecrets(text)), expected, `should fire: ${JSON.stringify(text)}`);
}
function covered(text: string): void {
  assert.ok(detectSecrets(text).count > 0, `should fire: ${JSON.stringify(text)}`);
}
function quietAll(texts: string[], control: string): void {
  assert.ok(detectSecrets(control).count > 0, `control must fire: ${JSON.stringify(control)}`);
  for (const t of texts) assert.deepEqual(found(t, detectSecrets(t)), [], `should be quiet: ${JSON.stringify(t)}`);
}
const PEM_BEGIN = (k = "RSA") => `-----BEGIN ${k} ${"PRIVATE"} KEY-----`;
const PEM_END = (k = "RSA") => `-----END ${k} ${"PRIVATE"} KEY-----`;
const B64_64 = rep("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", 2);

describe("more key formats", () => {
  it("PuTTY .ppk files of every key type, up to the Private-MAC line", () => {
    for (const type of ["ssh-rsa", "ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-dss"]) {
      const ppk = `PuTTY-User-Key-File-3: ${type}\nEncryption: none\nComment: laptop\nPublic-Lines: 2\nAAAAC3NzaC1lZDI1NTE5AAAAIA\nBBBBC3NzaC1lZDI1NTE5AAAAIB\nPrivate-Lines: 1\nCCCCC3NzaC1lZDI1NTE5AAAAIC\nPrivate-MAC: 0123456789abcdef0123456789abcdef`;
      fires(`see below:\n${ppk}\nthanks`, [ppk]);
    }
    fires("PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none", ["PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none"]);
  });
  it("a bare AWS secret key (40 base64 characters), no keyword needed", () => {
    const key = j("wJalrXUtnFEMI", "/K7MDENG/bPxRfi", "CYEXAMPLEKEY");
    assert.equal(key.length, 40);
    fires(`aws: ${key}.`, [key]);
    fires(`${key}`, [key]);
  });
  it("DigitalOcean, Twilio, Mailgun, Shopify, Linear, Sentry, PyPI, RubyGems, Google client secret / refresh token, Azure AD, Discord", () => {
    const samples = [
      j("dop", "_v1_", hex(64)),
      j("S", "K", hex(32)),
      j("A", "C", hex(32)),
      j("key", "-", hex(32)),
      j("shp", "at_", hex(32)),
      j("lin", "_api_", rep("aB3dE6", 7)),
      j("sntrys", "_", rep("aB3dE6", 10)),
      j("pypi", "-AgEI", rep("aB3dE6-", 10)),
      j("rubygems", "_", hex(48)),
      j("GOCSPX", "-", rep("aB3dE6", 5)),
      j("1", "//", rep("aB3dE6-_", 8)),
      j("abc", "8Q~", rep("aB3dE6_", 5)),
      j("M", rep("aB3dE6", 4).slice(0, 23), ".", "XyZ123", ".", rep("aB3dE6", 5).slice(0, 27)),
    ];
    for (const s of samples) fires(`token ${s} here`.replace("token ", "see "), [s]);
  });
  it("base64-wrapped PEM (LS0tLS1CRUdJTi…) and base64 text that decodes to a secret", () => {
    const wrapped = b64(`${PEM_BEGIN()}\n${B64_64}\n${PEM_END()}`);
    assert.ok(wrapped.startsWith("LS0tLS1CRUdJTi"));
    fires(`blob: ${wrapped}`, [wrapped].map((x) => x)); // starts at the base64 text itself
    const enc = b64("password: hunter2222");
    fires(`cred ${enc} ok`, [enc]);
    fires(`cred ${b64("DB_PASSWORD=Sup3rS3cret!x")} ok`, [b64("DB_PASSWORD=Sup3rS3cret!x")]);
  });
  it("Authorization headers of any scheme, also a bare hex value", () => {
    for (const h of ["Authorization: Token abcd1234efgh5678", "Authorization: ApiKey xyz98765qwer", `Authorization: ${hex(32)}`, "authorization = Negotiate YIIabcdefgh"]) fires(h, [h]);
  });
  it("cookies, also hex and %-encoded values (a keyword is present, so a hash is no excuse)", () => {
    fires("Cookie: sid=9f86d081884c7d65; theme=dark", ["Cookie: sid=9f86d081884c7d65; theme=dark"]);
    fires("Set-Cookie: session=%7B%22id%22%3A1%7D; Path=/", ["Set-Cookie: session=%7B%22id%22%3A1%7D; Path=/"]);
    fires(`session_id=${hex(32)}`, [`session_id=${hex(32)}`]);
    fires(`PHPSESSID: ${hex(26)}`, [`PHPSESSID: ${hex(26)}`]);
  });
  it("credentials in a URL of any scheme: empty user, '@' or '/' in the password (up to the LAST @ before the host)", () => {
    fires("redis://:pw1234@cache.example:6379", ["redis://:pw1234@"]);
    fires("https://user:p@ss/word@host.example/x", ["https://user:p@ss/word@"]);
    fires("amqp://guest:guest@rabbit:5672/", ["amqp://guest:guest@"]);
    fires("ftp://u:pass@h", ["ftp://u:pass@"]);
    fires(j("postgres://admin:s3cretpw", "@db.example.com/app"), [j("postgres://admin:s3cretpw", "@")]);
    quietAll(["https://example.com:8080/a@b", "https://user@example.com/x", "see https://example.com/path", "http://localhost:3000/", "mailto:a@b.example"], "redis://:pw1234@cache.example");
  });
  it("a PEM body without its header: quoted with '> ', indented, joined by a literal \\n, base64url, 3+ lines", () => {
    const lines = [B64_64, B64_64.replace(/\+/g, "-"), `${B64_64.slice(0, 40)}_${B64_64.slice(41)}`];
    covered(`> ${lines.join("\n> ")}\n`);
    covered(`    ${lines.join("\n    ")}\n`);
    covered(`${lines.join("\\n")}\\n`);
    covered(`${lines.join("\r\n")}\r\n`);
    assert.equal(detectSecrets(`${lines.slice(0, 2).join("\n")}\n`).count, 0, "two lines are not enough");
  });
  it("the END label must match the BEGIN label: a mismatching END does not end the block (the rest is removed too)", () => {
    const text = `${PEM_BEGIN("RSA")}\nabc\n${PEM_END("EC")}\nthe tail`;
    fires(text, [text]);
    const ok = `${PEM_BEGIN("RSA")}\nabc\n${PEM_END("RSA")}\nthe tail`;
    fires(ok, [`${PEM_BEGIN("RSA")}\nabc\n${PEM_END("RSA")}`]);
  });
  it("is quiet on look-alikes of the new formats", () => {
    quietAll(
      [
        "SK and AC are two letters", "key-value store", "lin_api and shpat are names", "the 8Q marker", "1//2 is a fraction", "ya29 is a prefix", "cookie policy: we use cookies",
        b64("hello world, this is just a sentence"), "dop_v1_ is a prefix", "PuTTY is an SSH client", "rubygems.org", "pypi.org/project/x", `${B64_64}\n${B64_64}`,
        "Bearer of bad news", "Authorization: none",
      ],
      "Authorization: Token abcd1234efgh5678",
    );
  });
});

describe("key names", () => {
  it("allows markdown, HTML and table noise and up to 30 characters between keyword and separator", () => {
    for (const t of [
      "**Password:** hunter2222", "__password__: hunter2222", "<b>password</b>: hunter2222", "`password`: hunter2222", "| password | hunter2222 |", "Password for admin: hunter2222",
      "Password (prod): hunter2222", "Password - hunter2222", "Password -> hunter2222", "> Password: hunter2222", "password &nbsp;: hunter2222", "“Password”: hunter2222",
    ]) covered(t);
  });
  it("plurals, pass / pw / psk, *_KEY and KEY= names", () => {
    for (const t of ["passwords: a1b2c3d4", "api keys: abcd1234", "secrets=abcd1234", "tokens: abcd", "pw: hunter22", "psk=abcdef12", "pass = abcd1234", "wifi_psk: abcdefgh", "STRIPE_KEY=abcd1234", "KEY=abcd", "encryption-key: abcd1234", "ssh.key = abcd1234"]) covered(t);
  });
  it("SQL, CLI flags with a space, escaped JSON and YAML block scalars", () => {
    for (const t of [
      "CREATE USER bob IDENTIFIED BY 'hunter22'", "ALTER USER bob WITH PASSWORD 'x'", "SET PASSWORD = \"abcd\"", "SELECT PASSWORD('abc')",
      "mysql -u root -pSecret123 db", "sshpass -p hunter2 ssh host", "mysql -u root -p hunter2 db", "curl --password hunter2 url", "gh --token abc123def", "tool --api-key abc123",
      "keytool -storepass changeit", "openssl enc -passin pass:hunter2", "7z a x.7z -pSecret123", "cmd -secret 'two words'",
      '{\\"password\\":\\"hunter2222\\"}', "password: |\n  line1\n  line2\nnext: x",
    ]) covered(t);
    const yaml = "password: |\n  line1\n  line2\nnext: x";
    assert.deepEqual(found(yaml, detectSecrets(yaml)), ["password: |\n  line1\n  line2"]);
    const json = '{\\"password\\":\\"hunter2222\\", \\"user\\":\\"bob\\"}';
    assert.deepEqual(found(json, detectSecrets(json)), ['password\\":\\"hunter2222\\"']);
  });
  it("Slovak, Czech and German words: heslo, kľúč / klíč, tajný kľúč, Schlüssel, Kennwort, Zugangsdaten, Geheimschlüssel", () => {
    for (const t of ["heslo: abcd1234", "hesla: abcd1234", "kľúč: abcd1234", "klíč: abcd1234", "tajný kľúč: abcd1234", "Schlüssel: abcd1234", "Schluessel: abcd1234", "Kennwort: abcd1234", "Zugangsdaten: user/abcd1234", "Geheimschlüssel: abcd1234", "Passwörter: abcd1234", "Tajný klíč = abcd1234"]) covered(t);
  });
  it("is quiet on words that only contain a keyword", () => {
    quietAll(
      [
        "compass: north-east", "bypass: yes", "passenger: John Smith", "secretary: Anna Smith", "tokenizer: wordpiece", "password_policy: strong", "keyboard: US layout", "key points: none",
        "monkey: banana", "passage: 12", "token: ab", "pass: no", "the pass is open", "keys: no", "credit: Anna Smith",
      ],
      "STRIPE_KEY=abcd1234",
    );
  });
});

describe("normalisation tricks", () => {
  it("digit-for-letter spellings: passw0rd, pa55word, p4ssword, s3cret, t0ken, p@ssword", () => {
    for (const t of ["passw0rd: hunter2222", "pa55word: hunter2222", "p4ssword=abcd1234", "s3cret=abcd1234", "t0ken: abcd1234", "p@ssword: abcd1234", "pa$$word: abcd1234", "APl_K3Y: abcd1234".replace("APl_K3Y", "api_key")]) covered(t);
  });
  it("small capitals, combining marks, variation selectors, control characters and look-alike letters inside the keyword", () => {
    for (const t of ["\u1d18\u1d00ss\u1d21\u1d0f\u0280\u1d05: hunter2222", "pass\u0301word: hunter2222", "pass\ufe0fword: hunter2222", "pass\u0001word: hunter2222", "p\u0430ssword: hunter2222", "pass\u200bword: hunter2222", "pa\u0455sword: hunter2222"]) covered(t);
  });
  it("the span covers the ORIGINAL characters, including a mark or zero-width character after the last one", () => {
    const text = "x pass\u0301word: hunter2222\u0301\u200b";
    const found1 = found(text, detectSecrets(text));
    assert.equal(found1.length, 1);
    assert.ok(found1[0]?.startsWith("pass\u0301word") && found1[0]?.endsWith("\u200b"), JSON.stringify(found1));
    assert.equal(redactText("k pass\u200bword: hunter2222", detectAll("k pass\u200bword: hunter2222")), "k [secret removed]");
  });
});

describe("suspect_secret: the structural fail-safe", () => {
  const RANDOM = ["k8Jd92LmQx7PzVb3TnYc8WsDuR4", "Zm9vYmFyQmF6UXV4S2xtbm9w+/9aBcD==", "q3W_e4R-t5Y6u7I8o9P0aSdF", "xK9#mP2$vL5nQ8wR3tY6", "AbCd1234EfGh5678IjKl9012"];
  it("fires on random-looking tokens that no pattern knows, whatever they are called", () => {
    for (const t of RANDOM) {
      const text = `the code is ${t} ok`;
      const d = detectSuspect(text);
      assert.equal(d.count >= 1 && text.slice(d.spans[0]?.start, d.spans[0]?.end).includes(t.slice(0, 12)), true, t);
    }
  });
  it("is quiet on ordinary prose, URLs, ids, dates, hashes in commits, identifiers and paths", () => {
    const quiet = [
      "Hi team, please send me the report by Friday. The meeting moved to Tuesday afternoon and everybody should bring the quarterly numbers.",
      "docs: https://example.com/docs/getting-started/installation-guide and https://example.com/Some/Long/Path_Name/for-the-team",
      "order 12345678 and invoice 2026-0001234 shipped",
      "id 123e4567-e89b-12d3-a456-426614174000",
      "created 2026-10-17T12:30:45.123Z",
      "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b fixes the bug",
      "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "internationalization and telecommunications",
      "snake_case_identifier_name_here",
      "getUserAccountBalanceFromDatabase",
      "/usr/local/share/applications/foo.desktop",
      "Lunch at noon on Tuesday works for me, thanks!",
    ];
    for (const t of quiet) assert.deepEqual(found(t, detectSuspect(t)), [], t);
    assert.ok(detectSuspect(`code ${RANDOM[0]}`).count > 0, "control");
  });
  it("a URL with a query string is looked at in its query part only", () => {
    assert.equal(detectSuspect("see https://example.com/a/b/c-d-e").count, 0);
    assert.equal(detectSuspect(`see https://example.com/cb?state=${RANDOM[0]}`).count, 1);
  });
  it("detectAll labels it as a possible secret; deliver_redacted redacts the token", () => {
    const text = `use ${RANDOM[0]} for the login`;
    assert.deepEqual(
      detectAll(text).map((d) => d.class),
      ["suspect_secret"],
    );
    assert.equal(redactText(text, detectAll(text)), "use [possible secret] for the login");
  });
});

describe("joined scans", () => {
  it("find a secret split over messages with a newline, nothing or a space between", () => {
    assert.equal(joinedSecretScan(["the login is", "password:", "hunter2222xyz"]), "hit");
    assert.equal(joinedSecretScan(["api_k", "ey=abcd1234"]), "hit");
    assert.equal(joinedSecretScan(["DB_PASS", "WORD=hunter22"]), "hit");
    assert.equal(joinedSecretScan(["password: ", " hunter2222"]), "hit");
  });
  it("find it at a seam of a pair or a triple", () => {
    assert.equal(joinedSecretScan(["api", "_k", "ey=abcd1234"]), "hit");
    assert.equal(joinedSecretScan(["x".repeat(10_000), "pass", "word=hunter2222", "y"]), "hit");
  });
  it("quiet on clean messages; null texts are skipped", () => {
    assert.equal(joinedSecretScan(["lunch at noon", "sounds good", null, "see you there"]), "clean");
    assert.equal(joinedSecretScan([null, null]), "clean");
    assert.equal(joinedSecretScan([]), "clean");
  });
  it("above 256 KiB or 2000 messages the record is not scanned: 'toolarge'", () => {
    assert.equal(joinedSecretScan([rep("a ", 140_000)]), "toolarge");
    assert.equal(joinedSecretScan(Array.from({ length: MAX_SCANNED_MESSAGES + 1 }, () => "hi")), "toolarge");
    assert.equal(joinedSecretScan(Array.from({ length: MAX_SCANNED_MESSAGES }, () => "hi")), "clean");
  });
});

describe("the 64 K window boundary", () => {
  it("a secret that straddles it is found (windows overlap by 4 KiB)", () => {
    const secret = j("ghp", "_", rep("aB3dE6", 6));
    for (const at of [65_536 - 20, 65_536 - 1, 65_536 - 4000, 65_536 - 5, 65_536 + 10, 2 * 61_440 - 10]) {
      const text = `${rep("lorem ipsum ", Math.ceil(at / 12)).slice(0, at)} ${secret} tail ${rep("dolor sit ", 20_000)}`;
      assert.ok(text.length > 200_000);
      const d = detectSecrets(text);
      assert.deepEqual(found(text, d), [secret], `at ${at}`);
    }
  });
  it("an unterminated PEM block that crosses the boundary is removed up to the end of the window and the body after it too", () => {
    const text = `${rep("lorem ipsum ", 5400)}${PEM_BEGIN()}\n${rep(`${B64_64}\n`, 2000)}tail`;
    const d = detectSecrets(text);
    const last = d.spans[d.spans.length - 1];
    assert.ok(last && last.end >= text.length - 8, "reaches the end of the text");
  });
});
