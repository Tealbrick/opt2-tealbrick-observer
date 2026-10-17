// Secrets (rule 0, ALWAYS). A secret is replaced before the text is stored (ingest.ts) and its record can only be dropped, so
// this detector leans to over-redaction: a missed secret is a leak, an extra redaction costs a few words.
//
// What it finds:
//   - PEM blocks (an unterminated one runs to the end), and a PEM BODY without its header (4+ lines of 60+ base64 characters)
//   - JWS/JWT and JWE (eyJ… with 1–4 more dot parts, parts may be empty)
//   - key formats: sk-, Stripe, GitHub, GitLab, Slack (xox, xapp, hooks), AWS, Google (AIza, ya29.), npm, Hugging Face,
//     SendGrid, Stripe webhook, Telegram bot tokens, Tealbrick keys
//   - Authorization: Basic …, Bearer <8+ chars>, credentials inside URLs, Azure connection strings and SAS signatures
//   - KEYWORD = VALUE for identifier-style keys (DB_PASSWORD, aws_secret_access_key, "access_token", dbPassword, clientSecret,
//     ?access_token= …). After an explicit ":" / "=" ANY value of 4+ characters is a secret (only boolean/null words are not); it runs
//     to the end of the line, or to the closing quote with spaces and punctuation inside. In a URL query it stops at & or space.
//   - prose "the password is hunter2" (needs the length/charset heuristic: it is a sentence, not an assignment)
//   - a high-entropy value (20+ characters, Shannon entropy >= 3.5 bits/char) after any "=" or ":"
// It runs on a normalised copy (NFKC, format characters dropped, Cyrillic/Greek look-alikes folded) and maps its spans back, so
// "pаssword" (Cyrillic а) and "pass\u200bword" are found and the redaction covers the original characters.
import { mapBack, normalize } from "./normalize.ts";
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";

const PEM = /-----BEGIN [A-Z0-9 ]{3,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{3,40}-----|$)/g;
const PEM_BODY = /(?:^[A-Za-z0-9+/]{60,}={0,2}[ \t]*(?:\r?\n|$)){4,}/gm;
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
  /(?<![A-Za-z0-9:])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, // Telegram bot token
  // Tealbrick keys: tbo_, tbag_, tbkg_, tbec_ … then a long base62 body (identifiers like tb_holds_pending have underscores)
  /(?<![A-Za-z0-9_])tb[a-z]{1,4}_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
];
const AUTH_BASIC = /Authorization["']?\s*[:=]\s*(?:Basic|Digest)\s+[A-Za-z0-9+/=._-]{8,}/gi;
const BEARER = /(?<![A-Za-z])Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@]{1,64}:[^\s@/]{3,}@/gi;
const AZURE = /(?<![A-Za-z0-9_])(?:AccountKey|SharedAccessKey|SharedAccessSignature|SecretAccessKey)=[^;\s"']{8,}/gi;
const SAS_SIG = /(?<=[?&])sig=[A-Za-z0-9%+/=_-]{16,}/g;

// KEYWORD = VALUE. The key is a whole identifier (letters, digits, _ . -) that CONTAINS a keyword and may continue with
// key/value/id/token/…: DB_PASSWORD, MY_API_KEY, AZURE_CLIENT_SECRET, aws_secret_access_key, access_token, dbPassword, clientSecret.
// "compass:", "bypass:", "tokenizer:" and "secretary:" are not keys (the keyword must be followed by the separator or a suffix).
const KEYWORDS = "pass(?:word|wd|phrase)|pwd|token|api[ _.-]?key|apikey|secret|private[ _.-]?key|access[ _.-]?key|auth[ _.-]?key|credentials?|heslo|passwort|kennwort|zugangscode";
const SUFFIX = "(?:[_.-]?(?:key|value|id|token|secret|pass(?:word)?|access|string|hash|phrase))*";
const KEY_ASSIGN = new RegExp(`(?<![\\w.-])[\\w.-]*?(?:${KEYWORDS})${SUFFIX}["'\`]?[ \\t]*(?:=>|[:=])[ \\t]*(?:\\r?\\n[ \\t]*)?`, "gi");
// the sentence form: "the password is hunter2", "heslo je Kvet123"
const KEY_PROSE = /(?<![\p{L}\p{N}_])(?:pass(?:word|wd|phrase)?|pwd|token|api[ _-]?key|(?:client[ _-]?)?secret|private[ _-]?key|heslo|passwort|kennwort|zugangscode)["']?\s+(?:is|je|ist|lautet)\s+["']?([^\s"',;)]{4,})/giu;
const ENTROPY_CANDIDATE = /[:=][ \t]*["'`]?([A-Za-z0-9+/_.~=-]{20,})/g;

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Value after a keyword assignment: the closing quote, the end of the URL parameter, or the end of the line. */
function takeValue(text: string, from: number, urlParam: boolean): { start: number; end: number; inner: string } | null {
  const q = text[from];
  if (q === '"' || q === "'" || q === "`") {
    let j = from + 1;
    const limit = Math.min(text.length, from + 4000);
    while (j < limit && text[j] !== q) j += text[j] === "\\" ? 2 : 1;
    if (j < limit && text[j] === q) return { start: from, end: j + 1, inner: text.slice(from + 1, j) };
    // no closing quote: the rest of the line
  }
  let j = from;
  if (urlParam) while (j < text.length && !/[&\s#]/.test(text[j] as string)) j++;
  else while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
  while (j > from && /[ \t]/.test(text[j - 1] as string)) j--;
  return j > from ? { start: from, end: j, inner: text.slice(from, j) } : null;
}

/** Secret spans on text that is already normalised (see detectSecrets for the public entry). */
export function detectSecretSpans(text: string): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (end > start) spans.push({ start, end });
  };
  const all = (re: RegExp) => {
    for (const m of text.matchAll(re)) add(m.index ?? 0, (m.index ?? 0) + m[0].length);
  };
  if (text.includes("-----BEGIN")) all(PEM);
  if (text.length > 240 && text.includes("\n")) all(PEM_BODY);
  if (text.includes("eyJ")) all(JWT);
  for (const re of PREFIXES) all(re);
  if (/authorization/i.test(text)) all(AUTH_BASIC);
  if (/bearer/i.test(text)) all(BEARER);
  if (text.includes("://")) all(URL_CREDENTIALS);
  if (/key=|signature=|sig=/i.test(text)) {
    all(AZURE);
    all(SAS_SIG);
  }
  // identifier = value
  if (text.includes(":") || text.includes("=")) {
    KEY_ASSIGN.lastIndex = 0;
    for (let m = KEY_ASSIGN.exec(text); m !== null; m = KEY_ASSIGN.exec(text)) {
      const after = (m.index ?? 0) + m[0].length;
      const urlParam = /[?&]/.test(text[(m.index ?? 0) - 1] ?? "");
      const v = takeValue(text, after, urlParam);
      if (v && v.inner.length >= 4 && !NOT_A_VALUE.has(v.inner.trim().toLowerCase())) {
        add(m.index ?? 0, v.end);
        KEY_ASSIGN.lastIndex = v.end;
      }
    }
    // a high-entropy value after any "=" or ":" (a key we do not know)
    for (const m of text.matchAll(ENTROPY_CANDIDATE)) {
      const value = m[1] as string;
      if (value.startsWith("/") || value.includes("./") || UUID.test(value) || HASH.test(value) || TIMESTAMP.test(value)) continue;
      if (shannonEntropy(value) >= 3.5) add((m.index ?? 0) + m[0].length - value.length, (m.index ?? 0) + m[0].length);
    }
  }
  // sentence form
  for (const m of text.matchAll(KEY_PROSE)) {
    // a full stop or "!" after the value ends the sentence, it is not part of the password
    const value = (m[1] ?? "").replace(/[.!?]+$/, "");
    if (looksLikeSecretValue(value)) add(m.index ?? 0, (m.index ?? 0) + m[0].length - ((m[1] ?? "").length - value.length));
  }
  return spans;
}

export function detectSecrets(text: string): Detection {
  const norm = normalize(text, true);
  const spans = detectSecretSpans(norm.text);
  return detection("secret", mergeOverlaps(mapBack(spans, norm)));
}
