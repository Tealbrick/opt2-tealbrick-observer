// Detection runs on a NORMALISED copy of the text, and every span is mapped back to the ORIGINAL offsets, so redaction covers
// exactly the characters that were typed (zero-width ones included).
//   mode "text" (all detectors but the keyword search):
//     NFKC (full-width digits, ligatures, circled letters become plain ones); format characters (\p{Cf}: zero-width space and joiner,
//     soft hyphen, bidi marks, BOM) are dropped
//   mode "keyword" (secret key names):
//     NFKD, then marks (\p{M}: accents, variation selectors, combining marks), format characters and control characters
//     (\p{Cc}, except tab / newline / carriage return) are dropped, and look-alike letters are folded to the Latin letter:
//     Cyrillic and Greek, small capitals ("ᴘᴀssᴡᴏʀᴅ"), dotless i … "pаssword" (Cyrillic а), "pasśword" and "pass\u0001word" all
//     become "password". Diacritics go too, so "kľúč" is "kluc".
// A dropped character is mapped to the end of the character before it, so a span that ends there covers it.
// Pure ASCII text without control characters is its own normal form: no copy, identity mapping.
import type { Span } from "./types.ts";

const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ӏ: "l", ѡ: "w", ѵ: "v", ԛ: "q", ԝ: "w", ᴦ: "r", 
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", І: "I", Ј: "J", Ѕ: "S", У: "Y", Ѵ: "V", Ԛ: "Q", Ԝ: "W",
  // Greek
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", ν: "v", χ: "x", ϲ: "c", ϳ: "j", γ: "y", η: "n", μ: "u", ω: "w", π: "n",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", Ϲ: "C", Ϳ: "J",
  // small capitals and other Latin look-alikes
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  ı: "i", ɡ: "g", ǀ: "l", ſ: "s", ƅ: "b", ƙ: "k", ɑ: "a", ɩ: "i", ℓ: "l", ⅰ: "i", ⅼ: "l",
};
const FORMAT = /\p{Cf}/u;
const MARK = /\p{M}/u;
const CONTROL = /\p{Cc}/u;

/** ASCII without control characters other than tab / newline / carriage return. */
function plainAscii(text: string, strict: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return false;
    if (strict && ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127)) return false;
  }
  return true;
}

export type NormalizeMode = "text" | "keyword";

export interface Normalized {
  text: string;
  /** original offset where normalised character i begins */
  start(i: number): number;
  /** original offset where normalised character i ends (dropped characters after it are included) */
  end(i: number): number;
  /** the normal form is the text itself */
  identity: boolean;
}

export function normalize(text: string, mode: NormalizeMode = "text"): Normalized {
  const keyword = mode === "keyword";
  if (plainAscii(text, keyword)) return { text, start: (i) => i, end: (i) => i + 1, identity: true };
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    const drop = (cp > 127 && (FORMAT.test(ch) || (keyword && MARK.test(ch)))) || (keyword && CONTROL.test(ch) && cp !== 9 && cp !== 10 && cp !== 13);
    if (drop) {
      if (ends.length > 0) ends[ends.length - 1] = i + len; // the character before it now ends after this one
      i += len;
      continue;
    }
    let n = cp > 127 ? ch.normalize(keyword ? "NFKD" : "NFKC") : ch;
    if (keyword) {
      let f = "";
      for (const c of n) f += MARK.test(c) ? "" : (CONFUSABLES[c] ?? c);
      n = f;
    }
    for (let k = 0; k < n.length; k++) {
      if ((n.charCodeAt(k) & 0xfc00) === 0xd800 && k + 1 < n.length) {
        // keep a surrogate pair together: both units map to the same original range
        out.push(n[k] as string, n[k + 1] as string);
        starts.push(i, i);
        ends.push(i + len, i + len);
        k++;
      } else {
        out.push(n[k] as string);
        starts.push(i);
        ends.push(i + len);
      }
    }
    i += len;
  }
  return { text: out.join(""), start: (k) => starts[k] ?? text.length, end: (k) => ends[k] ?? text.length, identity: false };
}

/** Spans on the normalised text → spans on the original text. */
export function mapBack(spans: readonly Span[], norm: Normalized): Span[] {
  if (norm.identity) return spans.map((s) => ({ start: s.start, end: s.end }));
  const out: Span[] = [];
  for (const s of spans) {
    if (s.end <= s.start) continue;
    out.push({ start: norm.start(s.start), end: norm.end(s.end - 1) });
  }
  return out;
}

/** Digit-for-letter look-alikes ("passw0rd", "pa55word", "s3cret", "t0ken", "p@ssword"): a 1:1 map, so offsets do not move. */
const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };
export function leet(text: string): string {
  let out = "";
  for (const c of text) out += LEET[c] ?? c;
  return out;
}
