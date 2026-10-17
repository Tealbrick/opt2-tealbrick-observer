// Phone numbers: digit count AND shape, never just a number. Fires on
//   +CC … with 8–15 digits, written with or without separators,
//   00CC … where CC is a real country calling code and the rest has a plausible national length (bare or with separators),
//   national numbers that start with one 0: bare 0 + 9 digits (0911123456), or 9–12 digits with separators (02/123 456 78),
//   US style (555) 123-4567 / 555-123-4567.
// A candidate that is not a phone as a whole is split on "/" ("0911 123 456/0912 111 222"); "," and ";" end a candidate anyway.
// Quiet on order numbers (0012345678: calling code 1 needs 10 digits), dates, timestamps, versions, dotted IPs, UUID parts, and
// the digit groups of cards and IBANs.
import { type Detection, detection, type Span } from "./types.ts";

const CANDIDATE = /(?<![\p{L}\p{N}+])(?:\+|00)?\(?\d[\d ()./-]{6,24}\d(?![\p{L}\p{N}])/gu;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const US = /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}$/;
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;
const DOTTED_SHORT = /^\d{1,3}(?:\.\d{1,3}){3,}$/;

// country calling codes (ITU E.164); a prefix-free set, so the first match is the code
const CC1 = new Set(["1", "7"]);
const CC2 = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"]);
const CC3_RANGES: [number, number][] = [[211, 213], [216, 216], [218, 218], [220, 258], [260, 269], [290, 291], [297, 299], [350, 359], [370, 389], [420, 423], [500, 509], [590, 599], [670, 683], [685, 692], [850, 850], [852, 853], [855, 856], [880, 880], [886, 886], [960, 968], [970, 977], [992, 996], [998, 998]];
/** Split digits after "00" into [calling code, national number], or null when it does not start with a calling code. */
export function splitCallingCode(d: string): [string, string] | null {
  if (CC1.has(d.slice(0, 1))) return [d.slice(0, 1), d.slice(1)];
  if (CC2.has(d.slice(0, 2))) return [d.slice(0, 2), d.slice(2)];
  const n3 = Number(d.slice(0, 3));
  if (d.length >= 3 && CC3_RANGES.some(([a, b]) => n3 >= a && n3 <= b)) return [d.slice(0, 3), d.slice(3)];
  return null;
}
function nationalFits(cc: string, national: string): boolean {
  if (cc === "1" || cc === "7") return national.length === 10;
  return national.length >= 5 && national.length <= 12 && cc.length + national.length <= 15;
}

function isPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  const n = digits.length;
  if (DATE_LIKE.test(raw) || DOTTED_SHORT.test(raw) || /^(\d)\1+$/.test(digits)) return false;
  const sep = /[ ()./-]/.test(raw.replace(/^\+/, ""));
  if (raw.startsWith("+")) return n >= 8 && n <= 15;
  if (raw.startsWith("00")) {
    const split = splitCallingCode(digits.slice(2));
    return split !== null && nationalFits(split[0], split[1]);
  }
  if (US.test(raw)) return true;
  if (/^\(?0/.test(raw)) return (sep && n >= 9 && n <= 12) || (!sep && /^0\d{9}$/.test(digits));
  return false;
}

export function detectPhones(text: string): Detection {
  const spans: Span[] = [];
  if (!/\d{3}/.test(text)) return detection("phone", spans);
  const uuids: Span[] = [];
  if (text.includes("-")) for (const m of text.matchAll(UUID_RE)) uuids.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    if (uuids.some((u) => start >= u.start && start < u.end)) continue;
    if (isPhone(raw)) {
      spans.push({ start, end: start + raw.length });
      continue;
    }
    if (raw.includes("/")) {
      // "0911 123 456/0912 111 222": each part on its own
      let at = 0;
      for (const part of raw.split("/")) {
        const p = part.trim();
        const offset = start + raw.indexOf(part, at);
        at = raw.indexOf(part, at) + part.length;
        if (p.length >= 8 && isPhone(p)) spans.push({ start: offset + part.indexOf(p), end: offset + part.indexOf(p) + p.length });
      }
    }
  }
  return detection("phone", spans);
}
