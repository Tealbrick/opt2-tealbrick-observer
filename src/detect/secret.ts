// Secrets (rule 0, ALWAYS). A secret is replaced before the text is stored (ingest.ts) and its record can only be dropped, so
// this detector leans to over-redaction: a missed secret is a leak, an extra redaction costs a few words.
//
// THIS IS NOT A COMPLETE SECRET SCANNER. Patterns always have gaps, so Observer has a second, structural net (suspect.ts): a record
// with a token that merely LOOKS like a secret is held for the owner's review and is never delivered automatically.
//
// What it finds:
//   - PEM blocks (the END label must match the BEGIN label; an unterminated block runs to the end), PEM bodies without a header (3+
//     lines of base64 / base64url, also quoted with "> ", indented or joined by a literal \n), base64-wrapped PEM, PuTTY .ppk files
//   - JWS/JWT and JWE (eyJ… with 1–4 more dot parts, parts may be empty)
//   - key formats: sk-, Stripe, GitHub, GitLab, Slack (xox, xapp, hooks), AWS (key id AND a bare 40-character secret key), Google
//     (AIza, ya29., GOCSPX-, 1//), npm, Hugging Face, SendGrid, DigitalOcean, Twilio, Mailgun, Shopify, Linear, Sentry, PyPI, RubyGems,
//     Azure AD (…8Q~…), Discord, Telegram, Tealbrick keys
//   - Authorization headers of any scheme, Bearer tokens, cookies, credentials in URLs of any scheme (an empty user, "@" or "/" in the
//     password: the userinfo ends at the LAST "@" before the host), Azure connection strings and SAS signatures
//   - KEYWORD = VALUE for identifier-style keys (DB_PASSWORD, aws_secret_access_key, "access_token", dbPassword, clientSecret, *_KEY),
//     markdown / HTML / table noise and up to 30 characters between key and separator ("**Password:**", "<b>password</b>:", "Password
//     for admin:", "Password (prod) -", "| password | x |"), plurals, escaped JSON, YAML block scalars, SQL (PASSWORD 'x', IDENTIFIED BY
//     'x'), CLI flags (--password x, -p x, -storepass x, -passin pass:x, 7z -px). After an explicit ":" / "=" ANY value of 4+ characters
//     is a secret (only boolean/null words are not); it runs to the end of the line, or to the closing quote with spaces and
//     punctuation inside; in a URL query it stops at & or a space. Keywords in English, Slovak, Czech and German; other languages are a
//     known limit.
//   - prose "the password is hunter2" (needs the length/charset heuristic: it is a sentence, not an assignment)
//   - a high-entropy value (20+ characters, Shannon entropy >= 3.5 bits/char) after any "=" or ":"
//   - a base64 string (16+ characters) whose decoded text holds a secret (decoded and scanned once, bounded)
// Matching runs on a normalised copy (NFKD, marks / format / control characters dropped, Cyrillic and Greek look-alikes and small capitals
// folded, digit-for-letter spellings such as "passw0rd" read as letters) and maps its spans back, so the redaction covers the characters
// that were typed. Long texts are scanned in overlapping windows (64 K characters + 4 K overlap).
import { leet, mapBack, normalize } from "./normalize.ts";
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";

const WINDOW = 64 * 1024;
const OVERLAP = 4 * 1024;

const PEM = /-----BEGIN ([A-Z0-9 ]{3,40})-----[\s\S]*?(?:-----END \1-----|$)/g;
// a PEM / key body without its header: 3+ lines (or literal "\n" separated pieces) of 60+ base64 / base64url characters, with an
// optional quote mark or indentation; a last shorter line belongs to it
const B64 = "[A-Za-z0-9+/_-]";
const PEM_BODY = new RegExp(`(?<![ \\t>])(?:[ \\t>]*(?:(?<!${B64})|(?<=\\\\n))${B64}{60,}={0,2}[ \\t]*(?:\\r?\\n|\\\\n)){3,}(?:[ \\t>]*(?:${B64}{8,}={0,2}|${B64}{2,}={1,2}))?`, "g");
const PEM_B64 = /LS0tLS1CRUdJTi(?:[A-Za-z0-9+/=_-]|\r?\n(?=[A-Za-z0-9+/=_-]))*/g;
const PPK = /PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[ \t]*[0-9A-Fa-f]*|$)/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){1,4}/g;
// known key formats; the leading boundary stops "task-force-…" (sk-) and "xtb_…" from matching inside a word
const PREFIXES = [
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic style
  /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9+/=]{16,}/g, // Stripe webhook signing secret
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,255}/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g,
  /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}/g, // npm
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9_])xapp-[A-Za-z0-9-]{20,}/g, // Slack app-level token
  /(?:https?:\/\/)?hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}/g, // Slack incoming webhook
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, // Google API key
  /(?<![A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access token
  /(?<![A-Za-z0-9_])GOCSPX-[A-Za-z0-9_-]{20,}/g, // Google OAuth client secret
  /(?<![A-Za-z0-9/])1\/\/[A-Za-z0-9_-]{40,}/g, // Google refresh token
  /(?<![A-Za-z0-9_])dop_v1_[a-f0-9]{40,}/g, // DigitalOcean
  /(?<![A-Za-z0-9_])(?:SK|AC)[0-9a-f]{32}(?![A-Za-z0-9])/g, // Twilio
  /(?<![A-Za-z0-9_-])key-[0-9a-f]{32}(?![A-Za-z0-9])/g, // Mailgun
  /(?<![A-Za-z0-9_])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g, // Shopify
  /(?<![A-Za-z0-9_])lin_api_[A-Za-z0-9]{30,}/g, // Linear
  /(?<![A-Za-z0-9_])sntrys_[A-Za-z0-9+/=_-]{20,}/g, // Sentry
  /(?<![A-Za-z0-9_-])pypi-AgEI[A-Za-z0-9_-]{30,}/g, // PyPI
  /(?<![A-Za-z0-9_])rubygems_[a-f0-9]{30,}/g, // RubyGems
  /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{30,}/g, // Azure AD client secret
  /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])/g, // Discord bot token
  /(?<![A-Za-z0-9:])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, // Telegram bot token
  // Tealbrick keys: tbo_, tbag_, tbkg_, tbec_ … then a long base62 body (identifiers like tb_holds_pending have underscores)
  /(?<![A-Za-z0-9_])tb[a-z]{1,4}_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
];
const BEARER = /(?<![A-Za-z])Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE = /(?<![\w-])(?:Set-)?Cookie["']?[ \t]*:[ \t]*(\S[^\n]*)/gi;
const AZURE = /(?<![A-Za-z0-9_])(?:AccountKey|SharedAccessKey|SharedAccessSignature|SecretAccessKey)=[^;\s"']{8,}/gi;
const SAS_SIG = /(?<=[?&])sig=[A-Za-z0-9%+/=_-]{16,}/g;
const AWS_SECRET_40 = /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_-])/g;
const SCHEME_URL = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,20}:\/\//gi;

// KEYWORD = VALUE. The key is a whole identifier (letters, digits, _ . -) that CONTAINS a keyword and may continue with
// key/value/id/token/…: DB_PASSWORD, MY_API_KEY, AZURE_CLIENT_SECRET, aws_secret_access_key, access_token, dbPassword, clientSecret,
// STRIPE_KEY. "compass:", "bypass:", "tokenizer:" and "secretary:" are not keys: the keyword must be followed by the separator, a
// suffix, noise or a "for …" / "(…)" note, and the short keywords (pass, pw, psk) must not sit inside a word.
const KEYWORDS = [
  "pass(?:word|wd|phrase)s?", "pwd", "(?<![A-Za-z])(?:pass|pw|psk)", "tokens?", "api[ _.-]?keys?", "apikeys?", "(?:client[ _.-]?)?secrets?", "private[ _.-]?keys?", "access[ _.-]?keys?",
  "auth[ _.-]?keys?", "credentials?", "creds?", "authorization", "(?<=[_.-])keys?", "(?<![\\w.-])keys?", "sess(?:ion)?[ _.-]?(?:id|key|token|secret)", "phpsessid", "jsessionid", "connect\\.sid",
  // Slovak, Czech, German (diacritics are stripped before matching: kľúč → kluc, Schlüssel → schlussel)
  "hesl[oa]", "klu[cč]e?", "kli[cč]e?", "tajn[yý][ _.-]?(?:klu|kli)[cč]", "passwort(?:er)?", "kennwort", "kennworter", "zugangsdaten", "zugangscode", "schl(?:u|ue)ssel", "geheim(?:schl(?:u|ue)ssel|nis)?",
].join("|");
const SUFFIX = "(?:[_.-]?(?:key|value|id|token|secret|pass(?:word)?|access|string|hash|phrase)){0,6}";
const NOISE_BEFORE = "(?:[*_|>\"'“”`~\\\\ \\t]|<[^<>\\n]{1,30}>|&[a-z#0-9]{2,8};){0,30}";
const FOR_NOTE = "(?:[ \\t]+(?:for|of|pro|fur|fuer|na)[ \\t]+[\\w.@-]{1,30})?(?:[ \\t]*\\([^)\\n]{1,30}\\))?";
const SEP = "(?:=>|->|[:=|]|[ \\t][-–—](?=[ \\t]))";
const NOISE_AFTER = "(?:[*_>~ \\t]|<[^<>\\n]{1,30}>){0,30}(?:\\r?\\n[ \\t]*)?";
const KEY_ASSIGN = new RegExp(`(?<![\\w.-])[\\w.-]{0,64}?(?:${KEYWORDS})${SUFFIX}${NOISE_BEFORE}${FOR_NOTE}${NOISE_BEFORE}${SEP}${NOISE_AFTER}`, "gi");
// the sentence form: "the password is hunter2", "heslo je Kvet123", "the password for admin is …"
const KEY_PROSE = /(?<![\p{L}\p{N}_])(?:pass(?:word|wd|phrase)?|pwd|tokens?|api[ _-]?key|(?:client[ _-]?)?secret|private[ _-]?key|hesl[oa]|passwort|kennwort|zugangscode)["']?(?:[ \t]+(?:for|pro|fur|fuer)[ \t]+[\w.@-]{1,30})?\s+(?:is|je|ist|lautet|was|bol)\s+["']?([^\s"',;)]{4,})/giu;
const SQL = /\b(?:IDENTIFIED[ \t]+BY|PASSWORD(?:[ \t]*=)?|PASSWORD[ \t]*\()[ \t]*(['"])[^'"\n]{1,200}\1\)?/gi;
const FLAG = /(?<![\w-])-{1,2}(?:password|passwd|pass|pwd|pw|token|api[-_]?key|apikey|secret|client[-_]?secret|storepass|keypass|passin|passout|access[-_]?token|auth[-_]?token|private[-_]?key)[ \t]+(?:pass:|env:|file:)?(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi;
const DASH_P = /\b(?:mysql\w*|mariadb|sshpass|psql|mongo\w*|redis-cli)\b[^\n]{0,200}?[ \t](-p[ \t]?(?:"[^"\n]*"|'[^'\n]*'|[^\s]+))/gi;
const SEVEN_Z = /\b7za?\b[^\n]{0,200}?[ \t](-p(?:"[^"\n]*"|'[^'\n]*'|[^\s-][^\s]*))/gi;
const ENTROPY_CANDIDATE = /[:=][ \t]*["'`]?([A-Za-z0-9+/_.~=-]{20,})/g;
const B64_CANDIDATE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/g;

const NOT_A_VALUE = new Set(["true", "false", "null", "none", "nil", "undefined", "redacted", "<redacted>", "[redacted]", "***", "[secret removed]"]);
const PROSE_NOT_A_VALUE = new Set([
  "required", "optional", "mandatory", "incorrect", "invalid", "expired", "correct", "wrong", "changed", "empty", "missing", "undefined",
  "hidden", "redacted", "already", "povinné", "nesprávne", "chybné", "platné", "falsch", "erforderlich", "ungültig", "abgelaufen", "korrekt",
]);

/** The sentence form "password is …": the value must look like a secret (a prose word is not one). */
function looksLikeSecretValue(v: string): boolean {
  if (PROSE_NOT_A_VALUE.has(v.toLowerCase())) return false;
  if (v.length >= 12) return true;
  const digit = /\d/.test(v);
  const symbol = /[^\p{L}\p{N}]/u.test(v);
  const mixed = /\p{Ll}/u.test(v) && /\p{Lu}/u.test(v);
  return v.length >= 4 && (digit || symbol || (v.length >= 8 && mixed));
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
/** How many of lower / upper / digit / symbol a string uses. */
export function charClasses(s: string): number {
  return Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s)) + Number(/[^A-Za-z0-9]/.test(s));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’" };

/** Value after a keyword assignment: the closing quote, a YAML block, the end of the URL parameter, or the end of the line. */
function takeValue(text: string, from: number, urlParam: boolean): { end: number; inner: string } | null {
  let q = text[from];
  let at = from;
  let escaped = false;
  if (q === "\\" && CLOSERS[text[from + 1] as string]) {
    // escaped JSON: \"value\"
    escaped = true;
    at = from + 1;
    q = text[at];
  }
  const close = q ? CLOSERS[q] : undefined;
  if (q && close) {
    const closing = escaped ? `\\${close}` : close;
    const limit = Math.min(text.length, at + 4000);
    let j = at + 1;
    while (j < limit && !text.startsWith(closing, j)) j += !escaped && text[j] === "\\" ? 2 : 1;
    if (j < limit && text.startsWith(closing, j)) return { end: j + closing.length, inner: text.slice(at + 1, j) };
    // no closing quote: the rest of the line
  }
  let j = from;
  if (urlParam) {
    while (j < text.length && !/[&\s#]/.test(text[j] as string)) j++;
  } else {
    while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    // YAML block scalar: "key: |" or "key: >-" and then the indented lines
    const line = text.slice(from, j).trim();
    if (/^[|>][+-]?\d?$/.test(line)) {
      let k = j;
      let lines = 0;
      while (k < text.length && lines < 50 && k - j < 8000) {
        const eol = text.indexOf("\n", k + 1);
        const stop = eol === -1 ? text.length : eol;
        const next = text.slice(k + 1, stop);
        if (next.trim() !== "" && !/^[ \t]/.test(next)) break;
        k = stop;
        lines++;
        if (eol === -1) break;
      }
      return { end: k, inner: text.slice(j, k).trim() || line };
    }
  }
  while (j > from && /[ \t]/.test(text[j - 1] as string)) j--;
  return j > from ? { end: j, inner: text.slice(from, j) } : null;
}

/** Credentials in the userinfo of ANY scheme (an empty user, "@" or "/" in the password): up to the LAST "@" before the host. */
function userinfoSpans(text: string, add: (s: number, e: number) => void): void {
  for (const m of text.matchAll(SCHEME_URL)) {
    const start = m.index ?? 0;
    const from = start + m[0].length;
    let to = from;
    while (to < text.length && to - from < 600 && !/[\s"'<>]/.test(text[to] as string)) to++;
    const token = text.slice(from, to);
    const colon = token.indexOf(":");
    const at = token.lastIndexOf("@");
    if (colon === -1 || at <= colon) continue;
    const slash = token.indexOf("/");
    // "host:8080/path@x" is a port, not a password; "user:p/ss@host" and ":pw@host" are credentials
    const afterColon = token.slice(colon + 1, slash === -1 || slash > at ? at : slash);
    if (slash !== -1 && slash < colon) continue;
    if (/^\d*$/.test(afterColon) && slash !== -1 && slash < at && afterColon.length > 0) continue;
    if (afterColon.length === 0 && colon !== 0) continue;
    add(start, from + at + 1);
  }
}

/** One window of (already normalised) text. `depth` stops the base64 rescan from recursing. */
function scanWindow(text: string, depth: number): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (end > start) spans.push({ start, end });
  };
  const all = (re: RegExp) => {
    for (const m of text.matchAll(re)) add(m.index ?? 0, (m.index ?? 0) + m[0].length);
  };
  if (text.includes("-----BEGIN")) all(PEM);
  if (text.length >= 180 && (text.includes("\n") || text.includes("\\n"))) all(PEM_BODY);
  if (text.includes("LS0tLS1CRUdJTi")) all(PEM_B64);
  if (text.includes("PuTTY-User-Key-File")) all(PPK);
  if (text.includes("eyJ")) all(JWT);
  for (const re of PREFIXES) all(re);
  if (/bearer/i.test(text)) all(BEARER);
  if (/cookie/i.test(text))
    for (const m of text.matchAll(COOKIE)) {
      if ((m[1] ?? "").trimEnd().length >= 4) add(m.index ?? 0, (m.index ?? 0) + m[0].trimEnd().length);
    }
  if (text.includes("://")) userinfoSpans(text, add);
  if (/key=|signature=|sig=/i.test(text)) {
    all(AZURE);
    all(SAS_SIG);
  }
  // a bare AWS secret key: 40 base64 characters that use upper, lower and digits and are not a hash
  if (text.length >= 40) {
    for (const m of text.matchAll(AWS_SECRET_40)) {
      const v = m[0];
      if (!HASH.test(v) && charClasses(v) >= 3 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && shannonEntropy(v) >= 4.0) add(m.index ?? 0, (m.index ?? 0) + 40);
    }
  }
  // SQL and command lines
  if (/password|identified/i.test(text)) all(SQL);
  if (/(^|\s)-/.test(text)) {
    all(FLAG);
    for (const m of text.matchAll(DASH_P)) add((m.index ?? 0) + m[0].length - (m[1] ?? "").length, (m.index ?? 0) + m[0].length);
    for (const m of text.matchAll(SEVEN_Z)) add((m.index ?? 0) + m[0].length - (m[1] ?? "").length, (m.index ?? 0) + m[0].length);
  }
  // identifier = value (on the text and on its digit-for-letter reading: passw0rd, pa55word, s3cret)
  if (/[:=|]|[ \t][-–—]|->/.test(text)) {
    for (const t of [text, leet(text)]) {
      KEY_ASSIGN.lastIndex = 0;
      for (let m = KEY_ASSIGN.exec(t); m !== null; m = KEY_ASSIGN.exec(t)) {
        const after = (m.index ?? 0) + m[0].length;
        const urlParam = /[?&]/.test(t[(m.index ?? 0) - 1] ?? "");
        const v = takeValue(t, after, urlParam);
        if (v && v.inner.length >= 4 && !NOT_A_VALUE.has(v.inner.trim().toLowerCase())) {
          add(m.index ?? 0, v.end);
          KEY_ASSIGN.lastIndex = Math.max(v.end, KEY_ASSIGN.lastIndex);
        }
      }
    }
    // a high-entropy value after any "=" or ":" (a key we do not know)
    for (const m of text.matchAll(ENTROPY_CANDIDATE)) {
      const value = m[1] as string;
      if (value.startsWith("/") || value.includes("./") || UUID.test(value) || HASH.test(value) || TIMESTAMP.test(value)) continue;
      const trimmed = value.replace(/\.+$/, ""); // a full stop ends the sentence
      if (trimmed.length >= 20 && shannonEntropy(trimmed) >= 3.5) add((m.index ?? 0) + m[0].length - value.length, (m.index ?? 0) + m[0].length - (value.length - trimmed.length));
    }
  }
  // sentence form
  for (const t of [text, leet(text)]) {
    for (const m of t.matchAll(KEY_PROSE)) {
      // a full stop or "!" after the value ends the sentence, it is not part of the password
      const value = (m[1] ?? "").replace(/[.!?]+$/, "");
      if (looksLikeSecretValue(value)) add(m.index ?? 0, (m.index ?? 0) + m[0].length - ((m[1] ?? "").length - value.length));
    }
  }
  // a base64 string that decodes to something holding a secret ("cGFzc3dvcmQ6IGh1bnRlcjIyMjI=" → "password: hunter2222")
  if (depth === 0) {
    let budget = 64 * 1024;
    let seen = 0;
    for (const m of text.matchAll(B64_CANDIDATE)) {
      if (++seen > 200 || budget <= 0) break;
      const raw = m[0].replace(/=+$/, "");
      if (/^[a-z]+$/.test(raw) || /^\d+$/.test(raw) || raw.length > 5460) continue;
      const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
      budget -= decoded.length;
      if (decoded.length < 8) continue;
      let printable = 0;
      for (let i = 0; i < decoded.length; i++) {
        const c = decoded.charCodeAt(i);
        if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) printable++;
      }
      if (printable / decoded.length < 0.9) continue;
      if (scanWindow(decoded, 1).length > 0) add(m.index ?? 0, (m.index ?? 0) + m[0].length);
    }
  }
  return spans;
}

/** Secret spans on text that is already normalised (see detectSecrets for the public entry). Long texts are scanned in overlapping windows. */
export function detectSecretSpans(text: string): Span[] {
  if (text.length <= WINDOW) return scanWindow(text, 0);
  const out: Span[] = [];
  for (let start = 0; start < text.length; start += WINDOW - OVERLAP) {
    for (const s of scanWindow(text.slice(start, start + WINDOW), 0)) out.push({ start: s.start + start, end: s.end + start });
    if (start + WINDOW >= text.length) break;
  }
  return out;
}

export function detectSecrets(text: string): Detection {
  const norm = normalize(text, "keyword");
  const spans = detectSecretSpans(norm.text);
  return detection("secret", mergeOverlaps(mapBack(spans, norm)));
}
