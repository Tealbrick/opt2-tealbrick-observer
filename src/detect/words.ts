// Whole-word matching for word lists, Unicode-aware, case-insensitive, one pass over the text. A list entry is a word
// ("cancer"), a stem ending in "*" ("rakovin*" matches rakovina, rakoviny, rakovinu …) or a phrase of words ("sick leave", the
// last word may be a stem: "trade union*"). Tokens are looked up in a Set / stem index, so the cost is the text length, not
// the list length times the text length.
import type { Span } from "./types.ts";

interface Index {
  exact: Set<string>;
  stems: Map<string, string[]>; // first 3 letters → stems
  phrases: Map<string, { words: string[]; stem: boolean }[]>; // first word → phrases
}
export type WordMatcher = (text: string) => Span[];

const TOKEN = /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}'’-]*/gu;
const lower = (s: string): string => s.toLowerCase().normalize("NFC");

export function buildWordMatcher(entries: readonly string[]): WordMatcher {
  const idx: Index = { exact: new Set(), stems: new Map(), phrases: new Map() };
  for (const raw of entries) {
    const entry = lower(raw.trim());
    if (!entry) continue;
    const stem = entry.endsWith("*");
    const words = (stem ? entry.slice(0, -1) : entry).split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const first = words[0] as string;
      idx.phrases.set(first, [...(idx.phrases.get(first) ?? []), { words, stem }]);
    } else if (stem) {
      const w = words[0] as string;
      idx.stems.set(w.slice(0, 3), [...(idx.stems.get(w.slice(0, 3)) ?? []), w]);
    } else idx.exact.add(words[0] as string);
  }
  const single = (w: string): boolean => idx.exact.has(w) || !!idx.stems.get(w.slice(0, 3))?.some((s) => w.startsWith(s));
  return (text) => {
    const spans: Span[] = [];
    const tokens = [...text.matchAll(TOKEN)].map((m) => ({ w: lower(m[0]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as (typeof tokens)[number];
      let end = -1;
      for (const p of idx.phrases.get(t.w) ?? []) {
        let ok = true;
        for (let k = 1; k < p.words.length && ok; k++) {
          const nt = tokens[i + k];
          const prev = tokens[i + k - 1] as (typeof tokens)[number];
          const last = k === p.words.length - 1 && p.stem;
          // the words of a phrase are separated by whitespace only
          ok = !!nt && /^\s+$/.test(text.slice(prev.end, nt.start)) && (last ? nt.w.startsWith(p.words[k] as string) : nt.w === p.words[k]);
        }
        if (ok) end = Math.max(end, (tokens[i + p.words.length - 1] as (typeof tokens)[number]).end);
      }
      if (end === -1 && single(t.w)) end = t.end;
      if (end !== -1) {
        spans.push({ start: t.start, end });
        while (i + 1 < tokens.length && (tokens[i + 1] as (typeof tokens)[number]).start < end) i++;
      }
    }
    return spans;
  };
}
