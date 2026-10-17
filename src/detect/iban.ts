// IBAN: country code + 2 check digits + BBAN, in groups or not, the length of the country, and mod-97 == 1.
// A bad checksum, an unknown country or the wrong length is not an IBAN ("AB12 3456", order numbers).
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";

/** IBAN length by country: every SEPA country plus the rest of the SWIFT registry that chat is likely to hold (one table). */
export const IBAN_LENGTH: Readonly<Record<string, number>> = {
  // SEPA
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21,
  HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24, SM: 27, VA: 22,
  // Brazil and the other registry countries
  BR: 29, AL: 28, AE: 23, AZ: 28, BA: 20, BH: 22, BY: 28, CR: 22, DO: 28, EG: 29, FO: 18, GE: 22, GL: 18, GT: 28, IL: 23, IQ: 23, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LY: 25, MD: 24, ME: 22, MK: 19, MR: 27, MU: 30, PK: 24, PS: 29, QA: 29, RS: 22, SA: 24, SC: 31, SD: 18,
  ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
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

// SK/CZ domestic account numbers: [prefix-]number/bank code, both parts with the mod-11 check (weights 10 5 8 4 2 1 and 6 3 7 9 10 5 8 4 2 1)
const DOMESTIC = /(?<![\d/-])(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})(?!\d)/g;
const W_PREFIX = [10, 5, 8, 4, 2, 1];
const W_NUMBER = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];
function mod11(digits: string, weights: readonly number[]): boolean {
  const padded = digits.padStart(weights.length, "0");
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(padded[i]) * (weights[i] as number);
  return sum % 11 === 0;
}
export function domesticAccountValid(prefix: string | undefined, number: string): boolean {
  if ((prefix ?? "").length + number.length < 6) return false; // "12/3456" is a fraction or a date, not an account
  return (prefix === undefined || mod11(prefix, W_PREFIX)) && mod11(number, W_NUMBER);
}
function findDomestic(text: string): Span[] {
  const out: Span[] = [];
  if (!text.includes("/")) return out;
  for (const m of text.matchAll(DOMESTIC)) if (domesticAccountValid(m[1], m[2] as string)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return out;
}

/** IBANs (any SEPA country, BR and the rest of the table, mod 97) and Slovak / Czech domestic account numbers with their check. */
export function detectIbans(text: string): Detection {
  const spans: Span[] = findDomestic(text);
  if (!/[A-Za-z]{2}\d{2}/.test(text)) return detection("iban", mergeOverlaps(spans));
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
  return detection("iban", mergeOverlaps(spans));
}
