// Person names (EN, SK/CZ, DE): MEDIUM / LOW confidence, deterministic, no model. A name is
//   - a known given name (names-data.ts) followed by up to two more capitalised words ("Jana Testová", "Peter Example"),
//   - a known given name alone, unless it is also a common word ("Will", "May", "Frank": those need a surname or a cue),
//   - any capitalised word after a courtesy title ("Mr", "pán", "Frau") or a greeting ("Dear", "Ahoj", "Liebe"), up to three words,
//   - a short capitalised line after a sign-off ("Thanks,", "S pozdravom", "Viele Grüße"), or after its comma on the same line.
// The span covers the name words only, never the title or greeting. Words inside an email address or URL are skipped (the email
// detector owns them). All-capital words and single letters are not read as names. One pass over the tokens: linear in the text.
import { AMBIGUOUS, CLOSINGS, GIVEN_DE, GIVEN_EN, GIVEN_SK_CZ, GREETINGS, NOT_NAMES, TITLES } from "./names-data.ts";
import { type Detection, detection, mergeOverlaps, type Span } from "./types.ts";
import { fold } from "./words.ts";

const set = (words: readonly string[]): Set<string> => new Set(words.map(fold));
const GIVEN = set([...GIVEN_EN, ...GIVEN_SK_CZ, ...GIVEN_DE]);
const AMBIG = set(AMBIGUOUS);
const TITLE = set(TITLES);
const GREET = set(GREETINGS);
const NOT = set(NOT_NAMES);
const CLOSE = [...set(CLOSINGS)].sort((a, b) => b.length - a.length); // longest first: "best regards" before "best"

const TOKEN = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const CAPITALISED = /^\p{Lu}[\p{Ll}\p{M}]/u;
const SPACE = /^[ \t\u00a0]$/;
// "Mr. Smith", "Dear Anna": a title may take a dot; a comma after a greeting ends it ("Hi, Hope you are well" is no name)
const AFTER_CUE = /^\.?[ \t\u00a0]{1,2}$/;
const NAME_LINE = /^(\p{Lu}[\p{Ll}\p{M}'’-]{1,30}(?:[ \t\u00a0]\p{Lu}[\p{Ll}\p{M}'’-]{1,30}){0,2})[ \t\u00a0]*[.!]?[ \t\u00a0]*$/u;
const MAX_RUN = 3;

interface Tok {
  start: number;
  end: number;
  key: string;
  cap: boolean;
}

/** True when the token sits in a word with "@" or "://" (an email address or a URL), which the other detectors own. */
function inAddress(text: string, start: number, end: number): boolean {
  let a = start;
  while (a > 0 && start - a < 200 && !/\s/.test(text[a - 1] ?? " ")) a--;
  let b = end;
  while (b < text.length && b - end < 200 && !/\s/.test(text[b] ?? " ")) b++;
  const word = text.slice(a, b);
  return word.includes("@") || word.includes("://");
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const cap = m[0].length >= 2 && CAPITALISED.test(m[0]) && !inAddress(text, start, end);
    out.push({ start, end, key: fold(m[0]), cap });
  }
  return out;
}

const nameWord = (t: Tok | undefined): t is Tok => !!t && t.cap && !NOT.has(t.key) && !TITLE.has(t.key) && !GREET.has(t.key);

/** The capitalised run that starts at token i (up to MAX_RUN words, single spaces between): its last token index. */
function runEnd(text: string, toks: readonly Tok[], i: number): number {
  let j = i;
  while (j + 1 < toks.length && j - i + 1 < MAX_RUN) {
    const next = toks[j + 1];
    const cur = toks[j];
    if (!next || !cur || !nameWord(next) || !SPACE.test(text.slice(cur.end, next.start))) break;
    j++;
  }
  return j;
}

/** A signature line is a name only when none of its words is a NOT_NAMES word ("Dein Team", "The Team"). */
const plainName = (line: string): boolean => line.split(/[ \t\u00a0]/).every((w) => !NOT.has(fold(w)));

/** Names after a sign-off: "Thanks,\nAlex" and "Best regards, Jana Testová". */
function signatures(text: string, spans: Span[]): void {
  let lineStart = 0;
  let prevClosing = false;
  while (lineStart <= text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const raw = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const lead = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line) {
      const folded = fold(line);
      let closing = false;
      for (const c of CLOSE) {
        if (!folded.startsWith(c)) continue;
        const rest = line.slice(c.length);
        if (/^[ \t]*[,!.]?[ \t]*$/.test(rest)) {
          closing = true;
          break;
        }
        const same = /^[ \t]*[,!.][ \t]*/.exec(rest);
        const name = same ? NAME_LINE.exec(rest.slice(same[0].length)) : null;
        if (same && name?.[1] && plainName(name[1])) {
          const start = lineStart + lead + c.length + same[0].length;
          spans.push({ start, end: start + name[1].length });
        }
        break;
      }
      if (!closing && prevClosing) {
        const name = NAME_LINE.exec(line);
        if (name?.[1] && plainName(name[1])) spans.push({ start: lineStart + lead, end: lineStart + lead + name[1].length });
      }
      prevClosing = closing;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
}

export function detectNames(text: string): Detection {
  const spans: Span[] = [];
  if (!/\p{Lu}/u.test(text)) return detection("name", spans);
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const prev = toks[i - 1];
    const cued = !!prev && (TITLE.has(prev.key) || GREET.has(prev.key)) && AFTER_CUE.test(text.slice(prev.end, t.start));
    if (!nameWord(t)) continue;
    const end = runEnd(text, toks, i);
    const last = toks[end] ?? t;
    const given = GIVEN.has(t.key) || GIVEN.has(t.key.split(/['’-]/)[0] ?? ""); // "Anna-Lena": the first part counts
    if (cued || (given && (end > i || !AMBIG.has(t.key)))) {
      spans.push({ start: t.start, end: last.end });
      i = end;
    }
  }
  signatures(text, spans);
  return detection("name", mergeOverlaps(spans));
}
