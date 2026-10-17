// Classification of text (pure): which sensitive classes a record holds, whether it is actionable, how many words, and where
// the spans are (offsets and classes only, for the owner's review view). Secrets count from the detector AND from the
// marker that ingest left where it removed one (ingest.ts), so a record whose secret was already cut out is still a secret record.
import { isActionable } from "./actionable.ts";
import { type DetectConfig, detectAll, mergeSpans } from "./detect/index.ts";
import { LABELS } from "./detect/redact.ts";
import type { DetectClass, Detection, Span } from "./detect/types.ts";

export const SECRET_MARKER = LABELS.secret;

export interface ClassifyConfig extends DetectConfig {
  /** the owner's keywords for "actionable" (obs_settings `actionable_words`) */
  ownerWords?: readonly string[];
}
export interface ClassedSpan extends Span {
  class: DetectClass;
}
export interface TextFacts {
  /** class → count; `secret` only when > 0 */
  classes: Record<string, number>;
  secret: boolean;
  words: number;
  /** merged spans (overlaps joined, strongest class wins) */
  spans: ClassedSpan[];
}
export interface RecordFacts {
  /** class → count over all messages; `secret` only when > 0 */
  classes: Record<string, number>;
  secret: boolean;
  actionable: boolean;
  words: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}

function markerDetection(text: string): Detection {
  const spans: Span[] = [];
  for (let i = text.indexOf(SECRET_MARKER); i !== -1; i = text.indexOf(SECRET_MARKER, i + SECRET_MARKER.length)) spans.push({ start: i, end: i + SECRET_MARKER.length });
  return { class: "secret", spans, count: spans.length };
}

/** Classify one text. Never returns the matched values. */
export function classifyText(text: string, cfg: ClassifyConfig = {}): TextFacts {
  const found = detectAll(text, cfg);
  const marker = markerDetection(text);
  const all = marker.count > 0 ? [...found, marker] : found;
  const classes: Record<string, number> = {};
  for (const d of all) classes[d.class] = (classes[d.class] ?? 0) + d.count;
  return { classes, secret: (classes.secret ?? 0) > 0, words: countWords(text), spans: mergeSpans(all) };
}

/** Classify the texts of one record (a null text is a purged or deleted message: nothing to read). */
export function classifyRecord(texts: readonly (string | null)[], cfg: ClassifyConfig = {}): RecordFacts {
  const classes: Record<string, number> = {};
  let words = 0;
  const joined: string[] = [];
  for (const t of texts) {
    if (t === null) continue;
    const f = classifyText(t, cfg);
    for (const [k, n] of Object.entries(f.classes)) classes[k] = (classes[k] ?? 0) + n;
    words += f.words;
    joined.push(t);
  }
  return { classes, secret: (classes.secret ?? 0) > 0, actionable: isActionable(joined.join("\n"), cfg.ownerWords ?? []), words };
}
