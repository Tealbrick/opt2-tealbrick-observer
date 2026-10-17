// Detection runs on a NORMALISED copy of the text, and every span is mapped back to the ORIGINAL offsets, so redaction covers
// exactly the characters that were typed (zero-width ones included):
//   - NFKC (full-width digits, ligatures, circled letters become plain ones)
//   - format characters (\p{Cf}: zero-width space/joiner, soft hyphen, bidi marks, BOM) are dropped
//   - `fold`: Cyrillic and Greek look-alikes of Latin letters become the Latin letter ("pаssword" with a Cyrillic а)
// Pure ASCII text (the common case) is its own normal form: no copy, identity mapping.
import type { Span } from "./types.ts";

const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ӏ: "l", ѡ: "w",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", І: "I", Ј: "J", Ѕ: "S", У: "Y",
  // Greek
  α: "a", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", ν: "v", χ: "x", ϲ: "c", ϳ: "j",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Latin look-alikes
  ı: "i", ɡ: "g", ǀ: "l",
};
const FORMAT = /\p{Cf}/u;
function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

export interface Normalized {
  text: string;
  /** original offset where normalised character i begins */
  start(i: number): number;
  /** original offset where normalised character i ends */
  end(i: number): number;
  /** the normal form is the text itself */
  identity: boolean;
}

export function normalize(text: string, fold = false): Normalized {
  if (isAscii(text)) return { text, start: (i) => i, end: (i) => i + 1, identity: true };
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    if (cp > 127 && FORMAT.test(ch)) {
      i += len;
      continue;
    }
    let n = cp > 127 ? ch.normalize("NFKC") : ch;
    if (fold) {
      let f = "";
      for (const c of n) f += CONFUSABLES[c] ?? c;
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
