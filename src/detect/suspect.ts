// The structural fail-safe (class `suspect_secret`). Patterns always have gaps, so besides the secret patterns Observer asks a
// different question: does this text hold a TOKEN that looks like a secret, whatever it is called? A record with such a token is held
// for the owner's review: never delivered automatically, not purged automatically (it may be a false positive), and deliver_redacted
// replaces the token. Pure. Tuning the false-positive rate is S6's job; this detector is deliberately sensitive.
//
// A token is a run of 16+ characters from [A-Za-z0-9+/_~%#$!^*-] (and "=" padding). It is suspect when ANY of these holds (and no safe shape applies):
//   1. at least 3 character classes (lower, upper, digit, symbol) and Shannon entropy >= 3.5 bits per character
//   2. 16–20 characters, at least 12 different characters and 2+ classes (no entropy floor)
//   3. 24+ characters, exactly 2 classes, entropy >= 4.0
//   4. 32+ letters of one case, entropy >= 4.0
// plus these special shapes:
//   - hex of 32+ characters (0x allowed) unless one of sha, sha1, sha256, md5, commit, checksum, digest, hash, revision, rev, etag is
//     within 40 characters
//   - a UUID next to key / token / secret / api / password words
//   - base32 (A–Z, 2–7): 32 characters anywhere, or 16–31 next to otp / totp / 2fa / seed / authenticator
//   - groups of a spaced / dotted / colon-separated token ("k8Jd 92Lm Qx7P zVb3 …"), judged collapsed
// Safe shapes: a whole-token UUID or ISO date, slugs and identifiers made of words (my-long-article-title, snake_case_name,
// camelCaseName). URLs get NO blanket exemption: userinfo, every path segment, every query value and the #fragment are looked at one
// by one, and the known webhook paths (Discord, Slack, Outlook / Teams) are suspect as a whole.
import { charClasses, shannonEntropy } from "./secret.ts";
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";

export const SUSPECT_MIN_LENGTH = 16;
export const SUSPECT_MIN_ENTROPY = 3.5;
const TOKEN = /[A-Za-z0-9+/_~%#$!^*-]{16,}={0,2}/g; // "=" only as base64 padding: "token=<value>" is two tokens
const URL_TOKEN = /[A-Za-z0-9+_~%$!^*-]{16,}/g; // inside a URL "/", "=", "#", "@", ":", "." and "&" separate the parts
const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)\]]+/gi;
const WEBHOOK_URL = /(?:discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/|hooks\.slack\.com\/|outlook\.office(?:365)?\.com\/webhook|webhook\.office\.com\/)/i;
const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT = /(?<![0-9A-Za-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z-])/gi;
const ISO_FULL = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const HEX_RUN = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;
const HEX_ONLY = /^(?:0x)?[0-9a-fA-F]+$/;
const HEX_CONTEXT = /(?<![A-Za-z0-9])(?:sha(?:1|224|256|384|512)?|md5|commit|checksum|digest|hash|revision|rev|etag)(?![A-Za-z0-9])/i;
const KEY_CONTEXT = /(?<![A-Za-z0-9])(?:keys?|tokens?|secrets?|api|apikey|password|passwd|bearer|credentials?)(?![A-Za-z0-9])/i;
const OTP_CONTEXT = /(?<![A-Za-z0-9])(?:otp|totp|hotp|2fa|mfa|seed|authenticator)(?![A-Za-z0-9])/i;
const BASE32 = /(?<![A-Za-z0-9])[A-Z2-7]{16,32}(?![A-Za-z0-9])/g;
const GROUPED = /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{2,8}[ \t.:]){3,}[A-Za-z0-9]{2,8}(?![A-Za-z0-9])/g;
const IPV6ISH = /^[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,}$/i;
// words joined by - or _ (slugs, snake_case) and camelCase / PascalCase identifiers are made of words, not of a key
const SLUG = /^[a-z]{2,14}(?:[-_][a-z]{2,14})+$/;
const CAMEL = /^(?:[a-z]{2,}(?:[A-Z][a-z]{2,}){2,}|(?:[A-Z][a-z]{2,}){3,})$/;

const near = (text: string, start: number, end: number, re: RegExp): boolean => re.test(text.slice(Math.max(0, start - 40), start)) || re.test(text.slice(end, end + 40));

/** Is this single token (16+ characters) suspect? Pure hex of 32+ is decided separately (it depends on the words around it). */
export function suspectToken(tok: string): boolean {
  if (tok.length < SUSPECT_MIN_LENGTH) return false;
  if (UUID_FULL.test(tok) || ISO_FULL.test(tok) || SLUG.test(tok) || CAMEL.test(tok)) return false;
  if (tok.length >= 32 && HEX_ONLY.test(tok)) return false;
  const classes = charClasses(tok);
  const h = shannonEntropy(tok);
  if (classes >= 3 && h >= SUSPECT_MIN_ENTROPY) return true;
  if (tok.length <= 20 && classes >= 2 && new Set(tok).size >= 12) return true;
  if (tok.length >= 24 && classes === 2 && h >= 4.0) return true;
  if (tok.length >= 32 && classes === 1 && /^[A-Za-z]+$/.test(tok) && h >= 4.0) return true;
  return false;
}

/** Tokens of a text with their offsets: URLs are taken apart (userinfo, path segments, query, fragment), the rest by TOKEN. */
function tokens(text: string, spans: Span[]): void {
  const urlRanges: Span[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = m[0].replace(/[.,;:!?]+$/, "");
    urlRanges.push({ start, end: start + url.length });
    if (WEBHOOK_URL.test(url)) {
      spans.push({ start, end: start + url.length });
      continue;
    }
    for (const t of url.matchAll(URL_TOKEN)) if (suspectToken(t[0])) spans.push({ start: start + (t.index ?? 0), end: start + (t.index ?? 0) + t[0].length });
  }
  // the rest of the text, with the URLs blanked out
  let rest = text;
  for (const r of urlRanges) rest = rest.slice(0, r.start) + " ".repeat(r.end - r.start) + rest.slice(r.end);
  for (const t of rest.matchAll(TOKEN)) if (suspectToken(t[0])) spans.push({ start: t.index ?? 0, end: (t.index ?? 0) + t[0].length });
}

export function detectSuspect(text: string): Detection {
  const spans: Span[] = [];
  if (text.length < SUSPECT_MIN_LENGTH) return detection("suspect_secret", spans);
  tokens(text, spans);
  // hex of 32+ characters: a secret unless the words around it say it is a hash
  if (/[0-9a-fA-F]{32}/.test(text)) {
    for (const m of text.matchAll(HEX_RUN)) {
      const start = m.index ?? 0;
      if (!near(text, start, start + m[0].length, HEX_CONTEXT)) spans.push({ start, end: start + m[0].length });
    }
  }
  // a UUID-shaped key next to key / token / secret / api words
  if (text.includes("-")) {
    for (const m of text.matchAll(UUID_IN_TEXT)) {
      const start = m.index ?? 0;
      if (near(text, start, start + m[0].length, KEY_CONTEXT)) spans.push({ start, end: start + m[0].length });
    }
  }
  // base32 (TOTP seeds)
  if (/[A-Z2-7]{16}/.test(text)) {
    for (const m of text.matchAll(BASE32)) {
      const start = m.index ?? 0;
      if (m[0].length === 32 || near(text, start, start + m[0].length, OTP_CONTEXT)) spans.push({ start, end: start + m[0].length });
    }
  }
  // a token written in groups: "k8Jd 92Lm Qx7P zVb3 TnYc", "ab12.cd34.ef56.gh78", judged collapsed. Only consecutive groups that all
  // look like code (a digit or a lower→upper change inside) count, and at least two of them must hold letters (not a phone number,
  // a card or an id written in groups).
  if (/[A-Za-z0-9]{2,8}[ \t.:][A-Za-z0-9]{2,8}[ \t.:][A-Za-z0-9]{2,8}[ \t.:]/.test(text)) {
    for (const m of text.matchAll(GROUPED)) {
      if (IPV6ISH.test(m[0])) continue;
      const base = m.index ?? 0;
      const parts: { g: string; start: number }[] = [];
      for (const g of m[0].matchAll(/[A-Za-z0-9]+/g)) parts.push({ g: g[0], start: base + (g.index ?? 0) });
      let run: { g: string; start: number }[] = [];
      const flush = () => {
        if (run.length >= 3) {
          const joined = run.map((x) => x.g).join("");
          const letters = run.filter((x) => /[A-Za-z]/.test(x.g)).length >= 2; // not a number written in groups
          const last = run[run.length - 1] as { g: string; start: number };
          const start = (run[0] as { start: number }).start;
          const end = last.start + last.g.length;
          if (letters && (suspectToken(joined) || (joined.length >= 32 && HEX_ONLY.test(joined) && !near(text, start, end, HEX_CONTEXT)))) spans.push({ start, end });
        }
        run = [];
      };
      for (const p of parts) {
        if (/\d|[a-z][A-Z]/.test(p.g)) run.push(p);
        else flush();
      }
      flush();
    }
  }
  return detection("suspect_secret", mergeOverlaps(spans));
}
