// Payment cards: 13–19 digits (single spaces or dashes between), a Luhn checksum AND a known issuer range. Luhn alone passes one
// random number in ten, so timestamps, order numbers and ids without a card prefix stay quiet. EVERY 13–19 digit window of a
// digit run is tested, so a card followed by an expiry ("4111 1111 1111 1111 12/26"), a CVV, or preceded by a prefix is found.
import { type Detection, detection, type Span } from "./types.ts";

const RUN = /\d(?:[ -]?\d)*/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Issuer ranges (IIN) of the major networks, with the card length they use. */
export function knownIssuer(d: string): boolean {
  const n = d.length;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  const p6 = Number(d.slice(0, 6));
  if (d[0] === "4") return n === 13 || n === 16 || n === 19; // Visa
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16; // Mastercard
  if (p2 === 34 || p2 === 37) return n === 15; // American Express
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || (p6 >= 622126 && p6 <= 622925)) return n >= 16 && n <= 19; // Discover
  if (p4 >= 3528 && p4 <= 3589) return n >= 16 && n <= 19; // JCB
  if (p2 === 62) return n >= 16 && n <= 19; // UnionPay
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38 || p2 === 39) return n >= 14 && n <= 19; // Diners
  if (p2 === 50 || (p2 >= 56 && p2 <= 69)) return n >= 12 && n <= 19; // Maestro
  return false;
}

export function detectCards(text: string): Detection {
  const spans: Span[] = [];
  if (!/\d{4}/.test(text)) return detection("card", spans);
  for (const m of text.matchAll(RUN)) {
    const base = m.index ?? 0;
    const pos: number[] = [];
    let digits = "";
    for (let i = 0; i < m[0].length; i++) {
      const c = m[0][i] as string;
      if (c >= "0" && c <= "9") {
        pos.push(base + i);
        digits += c;
      }
    }
    if (digits.length < 13) continue;
    for (let s = 0; s + 13 <= digits.length; s++) {
      let hit = 0;
      for (let len = Math.min(19, digits.length - s); len >= 13 && !hit; len--) {
        const w = digits.slice(s, s + len);
        if (luhn(w) && knownIssuer(w)) hit = len;
      }
      if (hit) {
        spans.push({ start: pos[s] as number, end: (pos[s + hit - 1] as number) + 1 });
        s += hit - 1;
      }
    }
  }
  return detection("card", spans);
}
