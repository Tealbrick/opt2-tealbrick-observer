// Government ids with checksums, per country, in ONE table (GOV_ID_COUNTRIES). The classifier takes the list of countries to
// check (settings key `gov_id_countries`, default DEFAULT_GOV_COUNTRIES); a country that is not listed is not looked for.
//   SK, CZ  rodné číslo: YYMMDD/SSSC, 10 digits divisible by 11 (the pre-1954 9-digit form only with the slash)
//   DE      Steuerliche Identifikationsnummer: 11 digits, ISO 7064 mod 11,10, digit-frequency rule
//   US      SSN: AAA-GG-SSSS with the area rules (no 000, 666, 900–999; group 00 and serial 0000 do not exist)
import { type Detection, detection, type Span } from "./types.ts";

export type GovFinder = (text: string) => Span[];

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function findRodneCislo(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/(?<![\d/])(\d{2})(\d{2})(\d{2})(\/?)(\d{3,4})(?!\d)/g)) {
    const [, yy, mm, dd, slash, tail] = m as unknown as [string, string, string, string, string, string];
    const y = Number(yy);
    let month = Number(mm);
    if (tail.length === 3 && (slash !== "/" || y >= 54)) continue; // 9-digit numbers exist only for people born before 1954
    const year = tail.length === 3 ? 1900 + y : y < 54 ? 2000 + y : 1900 + y;
    if (month > 50) month -= 50; // women
    if (month > 20 && year >= 2004) month -= 20; // overflow of the serial part (since 2004)
    if (month < 1 || month > 12 || Number(dd) < 1 || Number(dd) > daysIn(year, month)) continue;
    if (tail.length === 4) {
      const whole = BigInt(yy + mm + dd + tail);
      const first9 = Number(yy + mm + dd + tail.slice(0, 3));
      const ok = whole % 11n === 0n || (first9 % 11 === 10 && tail[3] === "0"); // 1954–1985: remainder 10 → check digit 0
      if (!ok) continue;
    }
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

export function steuerIdValid(d: string): boolean {
  if (!/^[1-9]\d{10}$/.test(d)) return false;
  const counts = new Map<string, number>();
  for (const c of d.slice(0, 10)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const freq = [...counts.values()];
  // exactly one digit appears 2 or 3 times, none more often (so 9 or 8 different digits)
  if (freq.filter((n) => n >= 2).length !== 1 || freq.some((n) => n > 3)) return false;
  if (/(\d)\1\1/.test(d.slice(0, 10))) return false; // three equal digits in a row are not allowed
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(d[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === Number(d[10]);
}
function findSteuerId(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/(?<![\d-])[1-9]\d ?\d{3} ?\d{3} ?\d{3}(?![\d-])/g)) {
    if (steuerIdValid(m[0].replace(/ /g, ""))) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

function findSsn(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])/g)) {
    const area = Number(m[1]);
    if (area === 0 || area === 666 || area >= 900 || m[3] === "00" || m[4] === "0000") continue;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

export const GOV_ID_COUNTRIES: Readonly<Record<string, { name: string; find: GovFinder }>> = {
  SK: { name: "rodné číslo (SK)", find: findRodneCislo },
  CZ: { name: "rodné číslo (CZ)", find: findRodneCislo },
  DE: { name: "Steuer-ID (DE)", find: findSteuerId },
  US: { name: "SSN (US)", find: findSsn },
};
export const DEFAULT_GOV_COUNTRIES: readonly string[] = ["SK", "CZ", "DE", "US"];

export function detectGovIds(text: string, countries: readonly string[] = DEFAULT_GOV_COUNTRIES): Detection {
  const spans: Span[] = [];
  if (!/\d{3}/.test(text)) return detection("id", spans);
  const done = new Set<GovFinder>(); // SK and CZ share a finder
  for (const code of countries) {
    const entry = GOV_ID_COUNTRIES[code.toUpperCase()];
    if (!entry || done.has(entry.find)) continue;
    done.add(entry.find);
    spans.push(...entry.find(text));
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return detection("id", spans);
}
