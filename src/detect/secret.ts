// Secrets (rule 0, ALWAYS): PEM blocks, JWS/JWT, known key prefixes, "password / token / api key / secret" + value, bearer
// tokens and credentials inside URLs. A secret is replaced before the text is stored (ingest.ts) and its record can only be
// dropped. Fail-closed bias: an unterminated PEM block runs to the end of the text.
import { type Detection, detection, type Span } from "./types.ts";

const PEM = /-----BEGIN [A-Z0-9 ]{3,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{3,40}-----|$)/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g;
// known key prefixes; the leading boundary stops "task-force-…" (sk-) and "xtb_…" from matching inside a word
const PREFIXES = [
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic style
  /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,255}/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g,
  /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, // Google API key
  // Tealbrick keys: tbo_, tbag_, tbkg_, tbec_ … then a long base62 body (identifiers like tb_holds_pending have underscores)
  /(?<![A-Za-z0-9_])tb[a-z]{1,4}_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
];
const BEARER = /(?<![A-Za-z])Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi;
const URL_CREDENTIALS = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@]{1,64}:[^\s@/]{3,}@/gi;
// "password is hunter2", "api key: sk…", "token=abc123", "heslo je …", "Passwort: …"
const KEYWORD_VALUE =
  /(?<![\p{L}\p{N}_])(?:pass(?:word|wd|phrase)?|pwd|token|api[ _-]?key|(?:client[ _-]?)?secret|private[ _-]?key|heslo|passwort|kennwort|zugangscode)["']?\s*(?:[:=]|=>|(?<=[\p{L}\p{N}"'])\s(?:is|je|ist|lautet)\b)\s*["']?([^\s"',;)]{4,})/giu;

const NOT_A_VALUE = new Set([
  "required", "optional", "mandatory", "incorrect", "invalid", "expired", "correct", "wrong", "changed", "empty", "missing", "undefined",
  "hidden", "redacted", "already", "povinné", "nesprávne", "chybné", "platné", "falsch", "erforderlich", "ungültig", "abgelaufen", "korrekt",
]);

/** Does this value after "password:" look like a real secret? (rejects "password is required", "token: expired") */
function looksLikeSecretValue(v: string): boolean {
  if (NOT_A_VALUE.has(v.toLowerCase())) return false;
  if (v.length >= 12) return true;
  const digit = /\d/.test(v);
  const symbol = /[^\p{L}\p{N}]/u.test(v);
  const mixed = /\p{Ll}/u.test(v) && /\p{Lu}/u.test(v);
  return v.length >= 4 && (digit || symbol || (v.length >= 8 && mixed));
}

export function detectSecrets(text: string): Detection {
  const spans: Span[] = [];
  const add = (m: RegExpMatchArray, end = (m.index ?? 0) + m[0].length) => spans.push({ start: m.index ?? 0, end });
  if (text.includes("-----BEGIN")) for (const m of text.matchAll(PEM)) add(m);
  if (text.includes("eyJ")) for (const m of text.matchAll(JWT)) add(m);
  for (const re of PREFIXES) for (const m of text.matchAll(re)) add(m);
  if (/bearer/i.test(text)) for (const m of text.matchAll(BEARER)) add(m);
  if (text.includes("://")) for (const m of text.matchAll(URL_CREDENTIALS)) add(m);
  for (const m of text.matchAll(KEYWORD_VALUE)) {
    // a full stop or "!" after the value ends the sentence, it is not part of the password
    const value = (m[1] ?? "").replace(/[.!?]+$/, "");
    if (looksLikeSecretValue(value)) add(m, (m.index ?? 0) + m[0].length - ((m[1] ?? "").length - value.length));
  }
  return detection("secret", spans);
}
