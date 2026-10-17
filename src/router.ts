// The router (DESIGN §4.3 step 4). Pure: facts + rules → a decision.
//   1. rule 0 FIRST: a secret record is dropped before any owner rule is looked at (a catch-all rule cannot deliver it)
//   2. the owner's rules in order; the FIRST rule that matches decides (also when the decision is "review")
//   3. a rule that delivers a record holding PII (email, phone, bank account, card, id, address, special category) without
//      `redact: true` sends the record to Review instead
//   4. no rule matches → Review
import { buildWordMatcher } from "./detect/words.ts";
import type { RuleView } from "./store.ts";
import { authorKey, isExcluded, normalizeExclude, RULE_ZERO_ID } from "./store.ts";

export interface RouteFacts {
  source: string;
  conversations: readonly string[];
  /** author_key of every author in the record */
  authors: readonly string[];
  /** the record's text (the stored, secret-free text of its messages) */
  text: string;
  classes: Readonly<Record<string, number>>;
  secret: boolean;
  actionable: boolean;
  words: number;
}
export type Destination = "knowledge" | "kanban" | "inbox";
export type Route =
  | { kind: "drop"; ruleId: string; reason: "secret" | "rule" }
  | { kind: "deliver"; ruleId: string; destination: Destination; redact: boolean }
  | { kind: "review"; ruleId: string | null; reason: "no_rule" | "pii_needs_redact" | "no_text" };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const matcherCache = new Map<string, ReturnType<typeof buildWordMatcher>>();
function wordMatcher(words: string[]): ReturnType<typeof buildWordMatcher> {
  const key = JSON.stringify(words);
  let m = matcherCache.get(key);
  if (!m) {
    if (matcherCache.size > 500) matcherCache.clear();
    m = buildWordMatcher(words);
    matcherCache.set(key, m);
  }
  return m;
}

/** Does a rule's `match` fit the facts? Every field that is present must fit (AND); `{}` matches everything. */
export function matches(match: Record<string, unknown>, f: RouteFacts): boolean {
  const sources = strings(match.sources);
  if ("sources" in match && !sources.includes(f.source)) return false;
  const conversations = strings(match.conversations);
  if ("conversations" in match && !conversations.some((c) => f.conversations.includes(c))) return false;
  if ("senders" in match) {
    const ex = normalizeExclude({ senders: strings(match.senders) }, { senders: [], domains: [] });
    if (!f.authors.some((a) => isExcluded(authorKey(a), ex))) return false;
  }
  if ("words" in match) {
    const words = strings(match.words);
    if (words.length === 0 || wordMatcher(words)(f.text).length === 0) return false;
  }
  if ("pii" in match) {
    const wanted = strings(match.pii);
    if (!wanted.some((c) => (f.classes[c] ?? 0) > 0)) return false;
  }
  if ("actionable" in match && Boolean(match.actionable) !== f.actionable) return false;
  if ("minWords" in match && f.words < Number(match.minWords)) return false;
  return true;
}

/** The PII classes a record holds: EVERY class with a count except the secret (a class the detectors add later counts too). */
export const piiClassesOf = (classes: Readonly<Record<string, number>>): string[] => Object.keys(classes).filter((c) => c !== "secret" && (classes[c] ?? 0) > 0);

export function routeFacts(f: RouteFacts, rules: readonly RuleView[]): Route {
  // the flag OR a secret count in the classes: either one is enough
  if (f.secret || (f.classes.secret ?? 0) > 0) return { kind: "drop", ruleId: RULE_ZERO_ID, reason: "secret" };
  for (const rule of [...rules].sort((a, b) => a.position - b.position)) {
    if (rule.id === RULE_ZERO_ID || !matches(rule.match, f)) continue;
    const deliver = String(rule.action.deliver);
    if (deliver === "drop") return { kind: "drop", ruleId: rule.id, reason: "rule" };
    if (deliver !== "knowledge" && deliver !== "kanban" && deliver !== "inbox") return { kind: "review", ruleId: rule.id, reason: "no_rule" };
    const redact = rule.action.redact === true;
    if (piiClassesOf(f.classes).length > 0 && !redact) return { kind: "review", ruleId: rule.id, reason: "pii_needs_redact" };
    return { kind: "deliver", ruleId: rule.id, destination: deliver, redact };
  }
  return { kind: "review", ruleId: null, reason: "no_rule" };
}
