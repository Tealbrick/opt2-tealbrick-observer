// Ingest helper (S2 calls it for every message): a secret never reaches obs_messages.text, excluded senders are never stored,
// the text is cut at 16 KiB, the digest is keyed.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { SECRET_MARKER } from "../src/classify.ts";
import { digestOf } from "../src/digest.ts";
import { CUT_MARKER, type IncomingMessage, MAX_TEXT_BYTES, sanitizeForStorage, storeMessage } from "../src/ingest.ts";
import { fakeSecrets, migratedDb, start } from "./helpers.ts";
import { scaling } from "./perf.ts";
import { seedSource } from "./seed.ts";

const rep = (s: string, n: number) => s.repeat(n);
const SECRETS: Record<string, string> = {
  ghp: `ghp_${rep("aB3dE6", 6)}`,
  sk: `sk-${rep("Ab1Cd2", 5)}`,
  aws: `AKIA${rep("Q7", 8)}`,
  slack: `xoxb-${rep("1234567890", 2)}-${rep("aBcD", 6)}`,
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".") /* built at run time: no secret-shaped literal in the repo */,
  pem: `-----BEGIN ${"PRIVATE"} KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKgIBAAKCAQEA7vbqajDw4o6gJy06\n-----END ${"PRIVATE"} KEY-----` /* built at run time */,
  password: "Tr0ub4dor&3xyz",
  tb: `tbo_${rep("k3Lm9Q", 5)}`,
};

let db: Db;
let src: string;
const msg = (text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ conversation: "inbox", providerMsgId: `p${Math.random()}`, sentAt: Date.UTC(2026, 9, 17), author: "email:anna@example.com", authorKind: "person", text, ...extra });
const everything = () => JSON.stringify(["obs_messages", "obs_records", "obs_deliveries", "obs_flags", "obs_sources", "obs_jobs"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));

beforeEach(async () => {
  db = migratedDb();
  await start(db);
  src = seedSource(db, { conversations: ["inbox"], exclude: { senders: ["spam@bad.example"], domains: ["junk.example"] } });
});

describe("a secret never reaches obs_messages.text", () => {
  it("every kind of secret is replaced before the text is stored; nothing of it is left in any table", () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const key = name === "password" ? `the password is ${secret}` : secret;
      const r = storeMessage(db, src, msg(`before ${key} after`));
      assert.equal(r.status, "inserted");
      assert.equal(r.secrets, 1, name);
    }
    const dump = everything();
    for (const [name, secret] of Object.entries(SECRETS)) {
      for (const piece of [secret.slice(0, 20), secret.slice(-20), secret.split("\n")[1] ?? "~none~"]) assert.ok(!dump.includes(piece.replace(/\n/g, "\\n")) && !dump.includes(piece), `${name}: ${piece}`);
    }
    const texts = db.prepare("SELECT text FROM obs_messages").all().map((r) => String(r.text));
    assert.equal(texts.length, Object.keys(SECRETS).length);
    assert.ok(texts.every((t) => t.includes(SECRET_MARKER)), "the marker tells the classifier a secret was here");
    assert.ok(texts.includes(`before ${SECRET_MARKER} after`), "the text around the secret is kept");
  });
  it("the text around a secret is kept; a text without a secret is stored as it is", () => {
    storeMessage(db, src, msg(`call me on Tuesday, key ${SECRETS.ghp} thanks`, { providerMsgId: "a" }));
    storeMessage(db, src, msg("just words", { providerMsgId: "b" }));
    assert.equal(db.prepare("SELECT text FROM obs_messages WHERE provider_msg_id = 'a'").get()?.text, `call me on Tuesday, key ${SECRET_MARKER} thanks`);
    assert.equal(db.prepare("SELECT text FROM obs_messages WHERE provider_msg_id = 'b'").get()?.text, "just words");
    assert.equal(storeMessage(db, src, msg("just words", { providerMsgId: "c" })).secrets, 0);
  });
  it("a secret on the 16 KiB boundary is replaced, not cut in half; the stored text stays within 16 KiB", () => {
    for (const secret of [SECRETS.ghp as string, SECRETS.jwt as string, SECRETS.pem as string]) {
      for (const before of [MAX_TEXT_BYTES - 90, MAX_TEXT_BYTES - 70, MAX_TEXT_BYTES - 20, MAX_TEXT_BYTES + 100]) {
        const s = sanitizeForStorage(`${rep("a", before)} ${secret} tail`);
        assert.ok(Buffer.byteLength(s.text) <= MAX_TEXT_BYTES, `${before}: ${Buffer.byteLength(s.text)} bytes`);
        assert.ok(!s.text.includes(secret.slice(0, 12)) && !s.text.includes(secret.slice(-12)), "no piece of the secret");
        assert.ok(s.text.includes(SECRET_MARKER), "the marker survives the cut");
        assert.equal(s.secrets, 1);
      }
    }
  });
  it("a long text is cut at 16 KiB with a marker, on a character boundary", () => {
    const s = sanitizeForStorage(rep("žluťoučký kůň ", 3000));
    assert.equal(s.cut, true);
    assert.ok(s.text.endsWith(CUT_MARKER));
    assert.ok(Buffer.byteLength(s.text) <= MAX_TEXT_BYTES);
    assert.ok(!s.text.includes("�"));
    const short = sanitizeForStorage("short");
    assert.deepEqual(short, { text: "short", secrets: 0, cut: false });
  });
  it("only the head of a long text is read for secrets: 1.2 MB costs about what 300 KB costs (load-robust, test/perf.ts)", () => {
    const big = `${rep("lorem ipsum ", 100_000)} ${SECRETS.ghp}`;
    assert.equal(sanitizeForStorage(big).cut, true);
    // the detectors see at most 256 K characters of both: 4× the input must not cost ~4× (a full scan would)
    const r = scaling(sanitizeForStorage, big.slice(0, big.length / 4), big, { ceilingMs: 1000, runs: 5, ratioLimit: 2.5 });
    assert.ok(r.ok, r.why);
  });
});

describe("storeMessage", () => {
  it("never stores a message by an excluded sender or domain, or outside the source's conversations", () => {
    assert.equal(storeMessage(db, src, msg("x", { author: "email:SPAM@bad.example" })).status, "excluded");
    assert.equal(storeMessage(db, src, msg("x", { author: "email:x@junk.example" })).status, "excluded");
    assert.equal(storeMessage(db, src, msg("x", { conversation: "private" })).status, "out_of_scope");
    assert.equal(storeMessage(db, "src_01J00000000000000000000000", msg("x")).status, "out_of_scope");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 0);
    assert.equal(storeMessage(db, src, msg("x", { author: "email:ok@fine.example" })).status, "inserted", "quiet on good");
  });
  it("is idempotent per message id; an edit replaces text and digest only when editedAt is newer; a deletion removes the text", () => {
    const base = msg("first", { providerMsgId: "p1" });
    assert.equal(storeMessage(db, src, base).status, "inserted");
    assert.equal(storeMessage(db, src, base).status, "unchanged");
    assert.equal(storeMessage(db, src, { ...base, text: "second", editedAt: 2000 }).status, "updated");
    assert.equal(storeMessage(db, src, { ...base, text: "older", editedAt: 1000 }).status, "unchanged");
    const row = db.prepare("SELECT text, text_digest, edited_at FROM obs_messages WHERE provider_msg_id = 'p1'").get();
    assert.deepEqual([row?.text, row?.edited_at, row?.text_digest], ["second", 2000, digestOf("second")]);
    assert.equal(storeMessage(db, src, { ...base, deleted: true }).status, "updated");
    const gone = db.prepare("SELECT text, deleted FROM obs_messages WHERE provider_msg_id = 'p1'").get();
    assert.deepEqual([gone?.text, gone?.deleted], [null, 1]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 1);
  });
  it("an edit that adds a secret is cleaned too", () => {
    const base = msg("clean", { providerMsgId: "p1" });
    storeMessage(db, src, base);
    const r = storeMessage(db, src, { ...base, text: `now ${SECRETS.sk}`, editedAt: 5 });
    assert.equal(r.secrets, 1);
    assert.ok(!everything().includes(String(SECRETS.sk).slice(0, 15)));
  });
  it("the digest is the keyed HMAC of the STORED text, not of the secret; the author key is the JS-normalised handle", () => {
    storeMessage(db, src, msg(`pw ${SECRETS.ghp}`, { providerMsgId: "p1", author: "email:ÄRGER@Beispiel.DE" }));
    const row = db.prepare("SELECT text, text_digest, author_key FROM obs_messages").get();
    assert.equal(row?.text_digest, digestOf(`pw ${SECRET_MARKER}`));
    assert.equal(row?.author_key, "email:ärger@beispiel.de");
  });
  it("refuses to store anything while the digest key is lost or unavailable (no message lands without its keyed digest)", async () => {
    const gone = migratedDb();
    await start(gone); // makes the key and the setting
    const s2 = seedSource(gone, { conversations: ["inbox"] });
    await start(gone, fakeSecrets()); // restored under another key: lost
    assert.throws(() => storeMessage(gone, s2, msg("hello")), { code: "digest_key_lost" });
    assert.equal(gone.prepare("SELECT COUNT(*) AS c FROM obs_messages").get()?.c, 0);
  });
});
