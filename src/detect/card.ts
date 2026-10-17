// Payment cards: 13–19 digits (spaces or dashes between), a Luhn checksum AND a known issuer range. Luhn alone passes one random
// number in ten, so timestamps, order numbers and ids without a card prefix stay quiet.
import { type Detection, detection, type Span } from "./types.ts";

const CANDIDATE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

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
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    // a longer digit chain that merely starts like a card ("1234 5678 9012 3456 7890 1234") is not one
    if ((text[end] === " " || text[end] === "-") && /\d/.test(text[end + 1] ?? "")) continue;
    if (luhn(digits) && knownIssuer(digits)) spans.push({ start, end });
  }
  return detection("card", spans);
}
