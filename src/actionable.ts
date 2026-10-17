// Relevance / "actionable" scorer, v1 style (DESIGN §5.3): word-boundary matching of request phrases (EN, SK, DE) plus the
// owner's keyword list; no model. Pure.
//   score = 2 per distinct request phrase (max 8) + 1 per question mark (max 2) + 3 per owner keyword hit (max 6)
//   actionable = score >= ACTIONABLE_THRESHOLD
import { buildWordMatcher } from "./detect/words.ts";

export const ACTIONABLE_THRESHOLD = 3;

export const REQUEST_PHRASES: readonly string[] = [
  // English
  "please", "can you", "could you", "would you", "will you", "need to", "needs to", "i need", "we need", "must", "have to", "deadline", "asap",
  "urgent", "urgently", "by tomorrow", "by monday", "by tuesday", "by wednesday", "by thursday", "by friday", "by end of day", "action item*",
  "todo", "to-do", "follow up", "follow-up", "remind me", "reminder", "let me know", "send me", "forward", "approve", "approval", "sign off",
  // Slovak
  "prosím", "prosim", "môžeš", "môžete", "mohol by si", "mohli by ste", "potrebujem", "potrebujeme", "musíme", "musím", "termín", "do zajtra",
  "do piatku", "naliehavé", "urgentné", "pošli", "pošlite", "pripomeň", "dajte vedieť", "schváľ", "schváliť",
  // German
  "bitte", "könnten sie", "kannst du", "könntest du", "können sie", "ich brauche", "wir brauchen", "wir müssen", "ich muss", "frist", "dringend",
  "bis morgen", "bis freitag", "schick mir", "schicken sie", "erinnere", "gib bescheid", "freigeben", "genehmigen",
];
const REQUEST = buildWordMatcher(REQUEST_PHRASES);

export function actionableScore(text: string, ownerWords: readonly string[] = []): number {
  const seen = new Set<string>();
  for (const s of REQUEST(text)) seen.add(text.slice(s.start, s.end).toLowerCase().replace(/\s+/g, " "));
  let score = Math.min(seen.size * 2, 8);
  let q = 0;
  for (let i = text.indexOf("?"); i !== -1 && q < 2; i = text.indexOf("?", i + 1)) q++;
  score += q;
  if (ownerWords.length > 0) {
    const own = new Set<string>();
    for (const s of buildWordMatcher(ownerWords)(text)) own.add(text.slice(s.start, s.end).toLowerCase());
    score += Math.min(own.size * 3, 6);
  }
  return score;
}
export const isActionable = (text: string, ownerWords: readonly string[] = []): boolean => actionableScore(text, ownerWords) >= ACTIONABLE_THRESHOLD;
