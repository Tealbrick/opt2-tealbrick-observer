// Redaction: replace detected spans with a class label. Overlapping spans merge into one (the label of the class with the
// highest priority wins), so "DE89 3704 0044 0532 0130 00" is ONE [bank account] even if the phone detector also fired on a part.
import type { DetectClass, Detection, Span } from "./types.ts";

export const LABELS: Readonly<Record<DetectClass, string>> = {
  secret: "[secret removed]",
  suspect_secret: "[possible secret]",
  email: "[email]",
  phone: "[phone]",
  iban: "[bank account]",
  card: "[card]",
  id: "[id]",
  address: "[address]",
  name: "[name]",
  special: "[special category]",
};
/** Which label a merged span gets when classes overlap: first in this list wins. */
export const PRIORITY: readonly DetectClass[] = ["secret", "suspect_secret", "iban", "card", "id", "email", "phone", "name", "address", "special"];

export interface ClassedSpan extends Span {
  class: DetectClass;
}

/** All spans of the detections, sorted; overlapping spans merged (touching spans stay separate). */
export function mergeSpans(detections: readonly Detection[]): ClassedSpan[] {
  const all: ClassedSpan[] = detections.flatMap((d) => d.spans.map((s) => ({ start: s.start, end: s.end, class: d.class })));
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ClassedSpan[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (PRIORITY.indexOf(s.class) < PRIORITY.indexOf(last.class)) last.class = s.class;
    } else out.push({ ...s });
  }
  return out;
}

/** Replace the (merged) spans of the given classes with their labels. `only` limits the classes (default: all given). */
export function redactText(text: string, detections: readonly Detection[], only?: readonly DetectClass[]): string {
  const use = only ? detections.filter((d) => only.includes(d.class)) : detections;
  const spans = mergeSpans(use);
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + LABELS[s.class];
    at = s.end;
  }
  return out + text.slice(at);
}
