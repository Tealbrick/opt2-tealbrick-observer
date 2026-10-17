// Detector contract (DESIGN §5.3): every detector is a pure function text → Detection. No I/O, no clock, no state.
// Spans are [start, end) offsets in UTF-16 code units of the text that was given (the same offsets JS string methods use).
// Detections hold offsets and classes ONLY: never the matched value.
export type PiiClass = "email" | "phone" | "iban" | "card" | "id" | "address" | "special";
export type DetectClass = "secret" | PiiClass;
export interface Span {
  start: number;
  end: number;
}
export interface Detection {
  class: DetectClass;
  spans: Span[];
  count: number;
}
export type Detector = (text: string) => Detection;

export const PII_CLASSES: readonly PiiClass[] = ["email", "phone", "iban", "card", "id", "address", "special"];
export const isPiiClass = (c: string): c is PiiClass => (PII_CLASSES as readonly string[]).includes(c);

export function detection(cls: DetectClass, spans: Span[]): Detection {
  return { class: cls, spans, count: spans.length };
}

export const isAsciiDigit = (c: number): boolean => c >= 48 && c <= 57;
export const isAsciiAlnum = (c: number): boolean => isAsciiDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Letter or digit in any script (fast path for ASCII). */
export function isAlnum(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c < 128 ? isAsciiAlnum(c) : LETTER_OR_DIGIT.test(ch);
}
