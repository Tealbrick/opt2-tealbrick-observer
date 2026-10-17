// The structural fail-safe (class `suspect_secret`). Patterns always have gaps, so besides the secret patterns Observer asks a
// different question: does this text hold a TOKEN that looks like a secret, whatever it is called? A token is a run of 16+
// characters from [A-Za-z0-9+/=_~%#$!^*-] with Shannon entropy >= 3.5 bits per character that mixes at least three character classes
// (lower, upper, digit, symbol). Known safe shapes are ignored: UUIDs, ISO dates, hashes (hex, in a commit / code context or not:
// hex has two classes), words in a URL path without a query string.
// A record with such a token is held for the owner's review (never delivered automatically, not purged automatically: it may be
// a false positive); deliver_redacted replaces the token. Pure.
import { charClasses, shannonEntropy } from "./secret.ts";
import { type Detection, detection, type Span } from "./types.ts";

export const SUSPECT_MIN_LENGTH = 16;
export const SUSPECT_MIN_ENTROPY = 3.5;
const TOKEN = /[A-Za-z0-9+/=_~%#$!^*-]{16,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/;
const HEX = /^[0-9a-f]+$/i;
/** the safe shape of a token inside a URL path: lower-case words, digits and separators */
const PATHISH = /^[a-z0-9_.~%/-]+$/;

export function detectSuspect(text: string): Detection {
  const spans: Span[] = [];
  if (text.length < SUSPECT_MIN_LENGTH) return detection("suspect_secret", spans);
  // URLs: the whole URL is safe when it has no query string; with a query only the query part is looked at
  const safe: Span[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const q = m[0].indexOf("?");
    safe.push({ start, end: q === -1 ? start + m[0].length : start + q });
  }
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const tok = m[0];
    if (safe.some((s) => start >= s.start && end <= s.end)) continue;
    if (UUID.test(tok) || ISO.test(tok) || HEX.test(tok.replace(/-/g, ""))) continue;
    if (PATHISH.test(tok) && tok.includes("/") && !/[A-Z]/.test(tok)) continue; // a file path or a slug path
    if (charClasses(tok) < 3 || shannonEntropy(tok) < SUSPECT_MIN_ENTROPY) continue;
    spans.push({ start, end });
  }
  return detection("suspect_secret", spans);
}
