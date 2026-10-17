// Phone numbers: digit count AND separators, never a bare number. Fires on:
//   +CC … or 00CC … with 8–15 digits (00CC needs a separator: a bare 0012345678 is an order number),
//   national numbers that start with 0 and are written with separators (9–12 digits: 0911 123 456, 02/123 456 78, (030) 1234567),
//   US style (555) 123-4567 / 555-123-4567.
// Quiet on order numbers (bare digits), dates, timestamps, version strings, dotted IPs, UUIDs, card and IBAN digit groups.
import { type Detection, detection, type Span } from "./types.ts";

const CANDIDATE = /(?<![\p{L}\p{N}+])(?:\+|00)?\(?\d[\d ()./-]{6,24}\d(?![\p{L}\p{N}])/gu;
const US = /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}$/;
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;
const DOTTED_SHORT = /^\d{1,3}(?:\.\d{1,3}){3,}$/;

function isPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  const n = digits.length;
  if (DATE_LIKE.test(raw) || DOTTED_SHORT.test(raw)) return false;
  const sep = /[ ()./-]/.test(raw.replace(/^\+/, ""));
  if (raw.startsWith("+")) return n >= 8 && n <= 15;
  if (raw.startsWith("00")) return n >= 8 && n <= 15 && sep;
  if (US.test(raw)) return true;
  if (/^\(?0/.test(raw)) return sep && n >= 9 && n <= 12;
  return false;
}

export function detectPhones(text: string): Detection {
  const spans: Span[] = [];
  if (!/\d{3}/.test(text)) return detection("phone", spans);
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    // trim a trailing separator the pattern may have taken before the last digit boundary
    const raw = m[0];
    if (isPhone(raw)) spans.push({ start, end: start + raw.length });
  }
  return detection("phone", spans);
}
