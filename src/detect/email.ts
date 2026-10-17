// Email addresses. Scans outward from each "@" (no regex backtracking on long text), then validates the shape: a local part, a
// dotted domain whose labels are not empty or hyphen-edged, and a top-level label of 2+ letters ("name@1.2", "user@localhost",
// "@mention" and "a@b" are not addresses). Local parts may hold combining marks (NFD "ä"), and the characters of SRS and
// plus-addressing ("user+SRS0=HHH=TT=example.com=bob@forwarder.example"); hosts may hold underscores.
import { type Detection, detection, isAlnum, type Span } from "./types.ts";

const LOCAL_EXTRA = new Set([".", "_", "%", "+", "-", "'", "=", "~", "!", "#", "$", "&", "*", "^", "`", "{", "|", "}"]);
const MARK = /\p{M}/u;
const isMark = (ch: string): boolean => ch.charCodeAt(0) > 127 && MARK.test(ch);
const isLocal = (ch: string): boolean => LOCAL_EXTRA.has(ch) || isAlnum(ch) || isMark(ch);
const isDomain = (ch: string): boolean => ch === "." || ch === "-" || ch === "_" || isAlnum(ch) || isMark(ch);
const TLD = /^[\p{L}\p{M}]{2,}$/u;
const MAX_LOCAL = 128;

export function detectEmails(text: string): Detection {
  const spans: Span[] = [];
  let at = text.indexOf("@");
  let last = 0;
  while (at !== -1) {
    let i = at;
    while (i > last && at - i < MAX_LOCAL && isLocal(text[i - 1] as string)) i--;
    while (i < at && !isAlnum(text[i] as string)) i++; // the local part starts with a letter or digit
    let j = at + 1;
    while (j < text.length && j - at < 255 && isDomain(text[j] as string)) j++;
    while (j > at + 1 && (text[j - 1] === "." || text[j - 1] === "-" || text[j - 1] === "_")) j--;
    const labels = text.slice(at + 1, j).split(".");
    const ok = i < at && labels.length >= 2 && labels.every((l) => l.length > 0 && !l.startsWith("-") && !l.endsWith("-")) && TLD.test(labels[labels.length - 1] as string);
    if (ok) {
      spans.push({ start: i, end: j });
      last = j;
    }
    at = text.indexOf("@", at + 1);
  }
  return detection("email", spans);
}
