// Words for a routing rule: what it matches and where it delivers. Pure; shared by Routing and by the route line in Review.
import { classLabel, destinationName, type Rule, type RuleAction, type RuleMatch } from "./api.ts";

export const RULE_ZERO_ID = "rul_00000000000000000000000000";

const list = (xs: readonly string[], max = 3): string => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

/** "Work inbox; mentions “invoice”; contains email address, phone number". `sources` maps a source id to its label. */
export function matchPhrase(m: RuleMatch, sources: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  if (m.sources?.length) parts.push(list(m.sources.map((id) => sources.get(id) ?? "a removed source")));
  if (m.conversations?.length) parts.push(m.conversations.length === 1 ? "1 conversation" : `${m.conversations.length} conversations`);
  if (m.senders?.length) parts.push(`from ${list(m.senders)}`);
  if (m.words?.length) parts.push(`mentions ${list(m.words.map((w) => `“${w}”`))}`);
  if (m.pii?.length) parts.push(`contains ${list(m.pii.map(classLabel))}`);
  if (m.actionable !== undefined) parts.push(m.actionable ? "asks for an action" : "asks for no action");
  if (m.minWords) parts.push(`at least ${m.minWords} ${m.minWords === 1 ? "word" : "words"}`);
  return parts.length === 0 ? "any record" : parts.join("; ");
}

/** "Knowledge · area Clients · as draft · deliver redacted", "drop". */
export function actionPhrase(a: RuleAction): string {
  if (a.deliver === "drop") return "drop, keep no text";
  const parts: string[] = [destinationName(a.deliver)];
  if (a.deliver === "knowledge") {
    if (a.area) parts.push(`area ${a.area}`);
    parts.push(a.knowledgeStatus === "published" ? "published" : "as draft");
  }
  if (a.deliver === "kanban") {
    if (a.project) parts.push(`project ${a.project}`);
    if (a.assignee) parts.push(`assigned to ${a.assignee}`);
  }
  if ((a.deliver === "kanban" || a.deliver === "inbox") && a.priority) parts.push(`priority ${a.priority}`);
  if (a.redact) parts.push("deliver redacted");
  return parts.join(" · ");
}

/** Rule 0 is the only locked rule: its words are fixed (product copy, DESIGN amendment of 2026-10-17). */
export const RULE_ZERO_TITLE = "Remove the secrets Observer recognises";
export const RULE_ZERO_TEXT = "Secrets Observer recognises are removed before anything is stored, and a record that held one can only be dropped. Records with a possible secret are held for your review. Locked.";

export const isRuleZero = (r: Rule): boolean => r.locked || r.id === RULE_ZERO_ID;
