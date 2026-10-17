// Whole-word matching for word lists, Unicode-aware, case- and diacritic-insensitive ("tehotna" matches "tehotná"), one pass over
// the text. A list entry is
//   a word      "cancer"
//   a stem      "rakovin*"      rakovina, rakoviny, rakovinu …
//   a suffix    "*krebs"        Lungenkrebs, Hautkrebs … (German compounds; use sparingly: it is a low-confidence match)
//   a phrase    "sick leave"    words separated by white space or hyphens; the last word may be a stem ("trade union*")
// Text is split into letter/digit tokens, so "HIV-positive" has the token "HIV" and "follow-up" matches the phrase "follow up".
// Tokens are looked up in a Set / stem index: the cost is the text length, not the list length times the text length.
import type { Span } from "./types.ts";

interface Index {
  exact: Set<string>;
  stems: Map<string, string[]>; // first 3 letters → stems
  suffixes: string[];
  phrases: Map<string, { words: string[]; stem: boolean }[]>; // first word → phrases
}
export type WordMatcher = (text: string) => Span[];

const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
const MARKS = /\p{M}/gu;
/** lower case, no diacritics */
export const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(MARKS, "").normalize("NFC");
const SEPARATOR = /^[\s-]+$/;

/** Minimum letters in a stem or suffix: "ab*" would match half the dictionary. */
export const MIN_STEM = 3;

/** Is this a usable list entry? Not empty, not "*", no stem or suffix under 3 letters, every phrase word non-empty. */
export function validWordEntry(raw: string): boolean {
  const e = raw.trim();
  if (!e) return false;
  const star = e.startsWith("*") ? "suffix" : e.endsWith("*") ? "stem" : null;
  const core = star === "suffix" ? e.slice(1) : star === "stem" ? e.slice(0, -1) : e;
  if (core.includes("*")) return false;
  const words = core.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return false;
  if (star) {
    const target = star === "suffix" ? words[0] : words[words.length - 1];
    if (!target || [...fold(target)].filter((c) => /[\p{L}\p{N}]/u.test(c)).length < MIN_STEM) return false;
    if (star === "suffix" && words.length > 1) return false;
  }
  return words.every((w) => /[\p{L}\p{N}]/u.test(w));
}
/** The entries that are not usable (empty, "*", stems under 3 letters …). */
export const invalidWordEntries = (list: readonly string[]): string[] => list.filter((e) => !validWordEntry(e));

export function buildWordMatcher(entries: readonly string[]): WordMatcher {
  const idx: Index = { exact: new Set(), stems: new Map(), suffixes: [], phrases: new Map() };
  for (const raw of entries) {
    if (!validWordEntry(raw)) continue; // an unusable entry matches nothing (rule_put refuses it up front)
    const e = raw.trim();
    if (e.startsWith("*")) {
      idx.suffixes.push(fold(e.slice(1)));
      continue;
    }
    const stem = e.endsWith("*");
    const words = fold(stem ? e.slice(0, -1) : e)
      .split(/[\s-]+/)
      .filter(Boolean);
    if (words.length > 1) {
      const first = words[0] as string;
      idx.phrases.set(first, [...(idx.phrases.get(first) ?? []), { words, stem }]);
    } else if (stem) {
      const w = words[0] as string;
      idx.stems.set(w.slice(0, 3), [...(idx.stems.get(w.slice(0, 3)) ?? []), w]);
    } else idx.exact.add(words[0] as string);
  }
  const single = (w: string): boolean => idx.exact.has(w) || !!idx.stems.get(w.slice(0, 3))?.some((s) => w.startsWith(s)) || idx.suffixes.some((s) => w.endsWith(s));
  return (text) => {
    const spans: Span[] = [];
    const tokens = [...text.matchAll(TOKEN)].map((m) => ({ w: fold(m[0]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as (typeof tokens)[number];
      let end = -1;
      for (const p of idx.phrases.get(t.w) ?? []) {
        let ok = true;
        for (let k = 1; k < p.words.length && ok; k++) {
          const nt = tokens[i + k];
          const prev = tokens[i + k - 1] as (typeof tokens)[number];
          const last = k === p.words.length - 1 && p.stem;
          // the words of a phrase are separated by white space or a hyphen only
          ok = !!nt && SEPARATOR.test(text.slice(prev.end, nt.start)) && (last ? nt.w.startsWith(p.words[k] as string) : nt.w === p.words[k]);
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
