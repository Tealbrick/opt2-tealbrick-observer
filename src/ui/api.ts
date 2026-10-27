// Typed person-op calls for the owner UI (op ids and I/O types from the generated kit; types only, erased at build), plain
// sentences for failures (L18), the shapes of the ops whose kit output is an open object, and the small formatters the pages share.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";
import { errorMessage } from "./standard.tsx";

export type In<K extends keyof PersonOps> = PersonOps[K]["input"];
export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];

// ── what the server returns inside the open objects of the kit (src/store.ts views) ──────────────────────────────

export interface Source {
  id: string;
  label: string;
  kind: string;
  account: string;
  conversations: string[];
  live: { state: string; lastReadAt: string | null; nextAt: string | null };
  history: { state: string; done: number; total: number | null; since: string | null };
  /** Connect can page further back than what it kept */
  historyCapable: boolean;
  /** days Connect keeps the account's messages (null: it did not say) */
  keptDays: number | null;
}
export type Job = Out<"jobs_list">["jobs"][number];
export interface RecordSummary {
  id: string;
  source: string;
  thread: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  revision: number;
  state: string;
  pii: Record<string, number>;
  secret: boolean;
  /** a token in the text looks like a secret (suspect_secret): held for the owner */
  possibleSecret: boolean;
  /** routing_failed: Observer could not sort the record; held for the owner, text opens hidden (NOT a possible secret) */
  problem?: string | null;
  ruleId: string | null;
  actionable: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  textPurgeAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface Message {
  conversation: string;
  id: string;
  thread: string | null;
  sentAt: string | null;
  editedAt: string | null;
  deleted: boolean;
  author: string;
  authorKind: string;
  /** null once purged, past retention, or deleted at the provider */
  text: string | null;
  /** where the detectors found something: classes and offsets only */
  spans: { class: string; start: number; end: number }[];
}
export type RecordDetail = RecordSummary & { messages: Message[] };
export interface Delivery {
  id: string;
  recordId: string;
  revision: number;
  destination: string;
  targetRef: string | null;
  status: string;
  holdId: string | null;
  attempts: number;
  nextAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  warning: string | null;
  superseded: boolean;
}
export interface RuleMatch {
  sources?: string[];
  conversations?: string[];
  senders?: string[];
  words?: string[];
  pii?: string[];
  actionable?: boolean;
  minWords?: number;
}
export interface RuleAction {
  deliver: "knowledge" | "kanban" | "inbox" | "drop";
  area?: string;
  project?: string;
  assignee?: string;
  priority?: "low" | "medium" | "high";
  redact?: boolean;
  knowledgeStatus?: "draft" | "published";
}
export interface Rule {
  id: string;
  position: number;
  locked: boolean;
  match: RuleMatch;
  action: RuleAction;
}
export interface ConnectConversation {
  id: string;
  title: string;
  estimate: number | null;
}
export interface ConnectAccount {
  id: string;
  kind: string;
  label: string;
  /** false: Connect cannot page further back than what it kept (every source of Connect 0.6.0) */
  historyCapable: boolean;
  /** how many days Connect keeps what it received; null when it does not say */
  retentionDays: number | null;
  conversations: ConnectConversation[];
}

/** What widening a source's conversations does not bring by itself (source_update; the edit page shows it). */
export const WIDEN_NOTE = "Messages of the new conversations from before today come only with a history read.";

/** What a source without history reads (the agreed sentence). */
export const keptSentence = (days: number | null): string =>
  `Observer reads from the time you share it, plus what Connect kept${days === null ? "" : ` (up to ${days} day${days === 1 ? "" : "s"})`}.`;

// ── calls ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ops that change something (manifest idempotency `supported` or `required`): the UI always sends a key for them. */
const WRITE_OPS: ReadonlySet<string> = new Set([
  "source_add",
  "source_update",
  "source_remove",
  "job_control",
  "backfill_start",
  "rule_put",
  "rule_delete",
  "rules_reorder",
  "review_decide",
  "delivery_retry",
  "privacy_set",
  "purge",
]);

/** Keys of calls whose outcome is unknown (network failure, server error): the SAME call sent again reuses its key, so the
 *  server replays the first answer instead of doing it twice. A definite refusal (4xx) forgets the key. */
const unsettled = new Map<string, string>();

/** One person op. A write op carries an idempotency key (the SDK sends the session's CSRF token with every POST). */
export async function run<K extends keyof PersonOps>(op: K, input: In<K>): Promise<Out<K>> {
  if (!WRITE_OPS.has(op)) return callOp<Out<K>>(op, input as never);
  const sig = `${op}:${JSON.stringify(input)}`;
  const key = unsettled.get(sig) ?? globalThis.crypto.randomUUID();
  try {
    const out = await callOp<Out<K>>(op, input as never, { idempotencyKey: key });
    unsettled.delete(sig);
    return out;
  } catch (e) {
    const status = Number((e as { httpStatus?: unknown } | null)?.httpStatus ?? 0);
    if (status === 0 || status >= 500) unsettled.set(sig, key);
    else unsettled.delete(sig);
    throw e;
  }
}

/** Plain sentence for a failed call: the cause and what to do, never raw JSON or upstream text (L18). */
export function explain(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown };
  switch (err.code) {
    case "connect_unavailable":
      return "Observer cannot read sources yet. Sources start when Connect gives Observer data access.";
    case "account_not_shared":
      return "That account is not shared with Observer in Connect any more. Share it in Connect first.";
    case "conversation_unknown":
      return "One of the conversations is gone from the account. Pick the conversations again.";
    case "conversations_empty":
      return "Choose at least one conversation.";
    case "label_empty":
      return "Give the source a name.";
    case "sources_limit":
      return "Observer holds no more sources. Remove one first.";
    case "account_list_only":
      return "Connect shares this account for its list only. Share it for reading in Connect, then try again.";
    case "caller_unverified":
      return "Connect could not verify that the caller is Observer, so it shared nothing. Ask the workspace owner to update Observer and Connect.";
    case "no_access":
      return "Connect refused Observer as a caller of its data operations.";
    case "since_too_old":
      return "History reaches back three years at most. Pick a later date.";
    case "range_invalid":
      return "The end date must be after the start date.";
    case "since_in_future":
      return "Pick a start date in the past.";
    case "connect_failed":
      return "Observer could not read from Connect. Try again later.";
    case "connect_held":
      return "Connect holds this read for your approval. Try again after you decide it.";
    case "connect_busy":
      return "Connect is busy. Try again in a minute.";
    case "call_budget":
      return "Observer is reading a lot from Connect right now. Try again in a minute.";
    case "reanchor_required":
      return "Observer needs Connect to restart this live job. Try again when Connect is available.";
    case "backfill_active":
      return "This source already has a history job. Stop it first.";
    case "job_state_invalid":
      return "That job cannot do this now. Reload the page and look again.";
    case "secret_drop_only":
      return "This record held a secret. It can only be dropped.";
    case "record_not_waiting":
      return "This record is not waiting any more. Reload the list.";
    case "destination_required":
      return "Choose where to deliver the record.";
    case "destination_invalid":
      return "Choose Knowledge, Task Board or Operator Inbox.";
    case "nothing_to_keep":
      return "This record was never delivered, so there is no delivered version to keep.";
    case "text_gone":
      return "The text of this record is gone. It can only be dropped.";
    case "delivery_held":
      return "A delivery of this record waits for your approval. Decide it in Holds first.";
    case "already_delivered":
      return "This version of the record was already delivered to this place.";
    case "delivery_state_invalid":
      return "This delivery is not from your last decision on the record. Decide the record in Review.";
    case "rule_locked":
      return "Rule 0 is locked. It cannot be changed, moved or deleted.";
    case "revision_changed":
      return "This record changed after you opened it. It is shown again as it is now. Read it again before you decide.";
    case "rules_mismatch":
      return "The rules changed in the meantime. Reload the page and try again.";
    case "rules_limit":
      return "Observer holds no more rules. Delete one first.";
    case "rule_word_invalid":
      return "A word in the rule is not usable. Use words of at least 3 letters, none empty, none just *.";
    case "not_found":
      return "That item is gone. Reload the page and look again.";
    case "invalid_input":
      return "Check the fields and try again.";
    default:
      return errorMessage(e);
  }
}

// ── time ────────────────────────────────────────────────────────────────────────────────────────────────────────

const LOCALE = "en-GB";
/** "9 Oct 2026" (en-GB, the same for everyone). */
export function dateOf(isoTime: string): string {
  return new Date(isoTime).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
}
/** "14 Oct 08:40". */
export function stamp(isoTime: string): string {
  const d = new Date(isoTime);
  return `${d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}
/** "4 min ago", "3 h ago", else the date. */
export function ago(isoTime: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(isoTime).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return dateOf(isoTime);
}
/** "in 12 min", "in 3 h", else the date; "soon" when it is due now. */
export function until(isoTime: string, now: number = Date.now()): string {
  const s = Math.round((new Date(isoTime).getTime() - now) / 1000);
  if (s < 45) return "soon";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86_400) return `in ${Math.round(s / 3600)} h`;
  return dateOf(isoTime);
}
/** "30 s", "5 min", "1 h" for an interval in seconds. */
export function everyLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const count = (n: number) => n.toLocaleString(LOCALE);

// ── words for what the server says ──────────────────────────────────────────────────────────────────────────────

/** The apps Observer delivers to (op `deliver` values) and what the owner calls them. */
export const DESTINATIONS = [
  { id: "knowledge", name: "Knowledge" },
  { id: "kanban", name: "Task Board" },
  { id: "inbox", name: "Operator Inbox" },
] as const;
export type Destination = (typeof DESTINATIONS)[number]["id"];
export const destinationName = (id: string): string => DESTINATIONS.find((d) => d.id === id)?.name ?? id;

/** Observer cannot work without these two (reading needs Connect, delivering needs Knowledge); Task Board and Operator Inbox are optional. */
export const REQUIRED_APPS = [
  { id: "connect", name: "Connect" },
  { id: "knowledge", name: "Knowledge" },
] as const;
/** Names of the required apps that `targets` (the apps the slice lets Observer call) does not hold. */
export const missingRequired = (targets: readonly string[]): string[] => REQUIRED_APPS.filter((a) => !targets.includes(a.id)).map((a) => a.name);

const KIND_NAMES: Record<string, string> = { gmail: "Gmail", slack: "Slack", discord: "Discord", telegram: "Telegram", buzz: "Buzz" };
export const kindName = (kind: string): string => KIND_NAMES[kind] ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Source");

/** The class names the owner reads (the redaction labels use the same words). */
export const CLASS_NAMES: Record<string, string> = {
  secret: "secret removed",
  suspect_secret: "possible secret",
  email: "email address",
  phone: "phone number",
  iban: "bank account",
  card: "payment card",
  id: "personal id",
  address: "address",
  name: "person name",
  special: "special category",
};
export const classLabel = (c: string): string => CLASS_NAMES[c] ?? c;
/** What `deliver_redacted` puts in the place of a marked span (src/detect/redact.ts LABELS). */
export const REDACTION_LABELS: Record<string, string> = {
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
/** Classes the owner would call sensitive (a brick tag); contact data gets a quiet one. */
export const SENSITIVE = new Set(["secret", "suspect_secret", "iban", "card", "id", "special"]);
/** The PII classes a routing rule can ask for. */
export const PII_CHOICES = ["email", "phone", "iban", "card", "id", "address", "name", "special"] as const;

/** The title of a record: its thread subject, else the source it came from. */
export const recordTitle = (r: Pick<RecordSummary, "thread">, sourceLabel: string | undefined): string => (r.thread?.trim() ? r.thread.trim() : `Messages in ${sourceLabel ?? "a source"}`);

/** Sets/arrays the server returns as `unknown` objects, read defensively. */
export const asRecord = (v: unknown): RecordSummary => v as RecordSummary;
export const asDelivery = (v: unknown): Delivery => v as Delivery;
export const asRule = (v: unknown): Rule => v as Rule;
export const asAccount = (v: unknown): ConnectAccount => {
  const a = (v ?? {}) as Partial<ConnectAccount>;
  return {
    id: String(a.id ?? ""),
    kind: String(a.kind ?? ""),
    label: String(a.label ?? a.id ?? ""),
    historyCapable: a.historyCapable !== false,
    retentionDays: typeof a.retentionDays === "number" && Number.isInteger(a.retentionDays) && a.retentionDays >= 0 ? a.retentionDays : null,
    conversations: Array.isArray(a.conversations) ? a.conversations.map((c) => ({ id: String(c?.id ?? ""), title: String(c?.title ?? c?.id ?? ""), estimate: typeof c?.estimate === "number" ? c.estimate : null })) : [],
  };
};
