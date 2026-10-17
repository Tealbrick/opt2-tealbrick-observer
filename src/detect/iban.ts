// IBAN: country code + 2 check digits + BBAN, in groups or not, the length of the country, and mod-97 == 1.
// A bad checksum, an unknown country or the wrong length is not an IBAN ("AB12 3456", order numbers).
import { type Detection, detection, type Span } from "./types.ts";

/** IBAN length by country (SWIFT registry; the countries Observer's sources are likely to see, plus the EU/EEA). */
export const IBAN_LENGTH: Readonly<Record<string, number>> = {
  AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22,
  IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
  TR: 26, UA: 29, RS: 22, ME: 22, MK: 19, AL: 28, BA: 20, XK: 20, MD: 24, GE: 22, AE: 23, SA: 24, IL: 23,
};
const CANDIDATE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{1,4}){2,9}/g;

export function mod97(compact: string): number {
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < moved.length; i++) {
    const c = moved.charCodeAt(i);
    const v = c >= 65 ? c - 55 : c - 48; // A=10 … Z=35
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97;
  }
  return rem;
}

export function detectIbans(text: string): Detection {
  const spans: Span[] = [];
  if (!/[A-Za-z]{2}\d{2}/.test(text)) return detection("iban", spans);
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    const cc = m[0].slice(0, 2).toUpperCase();
    const want = IBAN_LENGTH[cc];
    if (!want) continue;
    // walk the match until `want` letters/digits are taken (the pattern may have run on into the next word)
    let taken = 0;
    let end = start;
    for (let i = 0; i < m[0].length && taken < want; i++) {
      const ch = m[0][i] as string;
      if (ch !== " " && ch !== "-") taken++;
      end = start + i + 1;
    }
    if (taken !== want) continue;
    const compact = text.slice(start, end).replace(/[ -]/g, "").toUpperCase();
    if (compact.length === want && mod97(compact) === 1) spans.push({ start, end });
  }
  return detection("iban", spans);
}
