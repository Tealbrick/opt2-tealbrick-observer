// Connect access (DESIGN §4.4). Observer has no credentials: it reads sources through Connect's app-only data ops
// (data_accounts_list, data_catalog, data_pull; Connect 0.6.0, C230 R3) with its own companion grant, crud ["read"].
//
// `connectPort(ctx)` returns null while Connect cannot be used (the manifest companion is not sane, or the slice does not let
// the app call Connect), so source_add, backfill_estimate and backfill_start answer `connect_unavailable`. Otherwise it is a
// port over `ctx.callApp("connect", …)`: the op handlers use it with the person's ctx, the job ticks with the job's ctx.
//
// What Connect answers is untrusted (L24): accounts and catalogs are read defensively, every pulled row is checked against the
// frozen messages/1 schema (src/contract.ts) and a row that does not conform is skipped and counted, never stored.
import type { AppDefinition, CompanionTargetsView, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type CallBudget, type Lane, sharedBudget } from "./budget.ts";
import { now as clockNow } from "./clock.ts";
import { MESSAGES_CONTRACT, MESSAGES_DATASET, type Page, readPage } from "./contract.ts";
import { CONNECT_PRODUCT, connectCompanionProblems } from "./guards.ts";
import { manifest } from "./manifest.ts";

export const CONNECT_UNAVAILABLE_MESSAGE = "Observer needs Connect with shared read access (data_pull). Connect does not offer it yet.";

/** An account Connect shares with Observer for reading, as data_accounts_list names it (no catalog call). */
export interface SharedAccount {
  id: string;
  kind: string;
  label: string;
}
export interface ConnectConversation {
  id: string;
  title: string;
  /** estimated message count, null when Connect cannot tell */
  estimate: number | null;
}
export interface ConnectAccount {
  id: string;
  /** the service as Connect names it (slack, telegram, …): kinds come from Connect, not from a fixed list */
  kind: string;
  label: string;
  /** Connect can page this source backward past what it kept (data_catalog `history`); false: forward through the kept log only */
  historyCapable: boolean;
  /** how many days Connect keeps the messages it received (null when it does not say) */
  retentionDays: number | null;
  conversations: ConnectConversation[];
}
export interface ConnectEstimate {
  messages: number;
  records: number;
  durationS: number;
  providerNote: string | null;
}
export interface PullQuery {
  account: string;
  direction: "forward" | "backward";
  /** opaque, from an earlier answer (never decoded); null = Connect's start in that direction */
  cursor: string | null;
  /** inclusive lower bound on the sent time, epoch ms */
  since?: number | null;
  /** exclusive upper bound on the sent time, epoch ms */
  until?: number | null;
  /** 1..200 */
  limit?: number;
  /** which share of the call budget the pull uses (default live) */
  lane?: Lane;
}
export interface ConnectPort {
  /** accounts shared with Observer for reading (level shared): ONE call, no catalogs */
  accounts(): Promise<SharedAccount[]>;
  /** one shared account with its conversations, history flag and kept days (the list + ONE catalog), or null */
  account(id: string): Promise<ConnectAccount | null>;
  estimate(q: { account: string; conversations: string[]; since: number; until: number | null }): Promise<ConnectEstimate>;
  /** one page of the account's `messages` dataset (all conversations, in Connect's change order) */
  pull(q: PullQuery): Promise<Page>;
}

/** What the port needs from a context: an op handler ctx and a job ctx both have it. */
export type ConnectCtx = Pick<OpContext, "callApp"> & Partial<Pick<CompanionTargetsView, "companionTargets">>;
type Factory = (ctx: ConnectCtx, m: AppDefinition["manifest"]) => ConnectPort | null;

/** Product ids the slice lets this app call (SDK 0.1.14+; [] when the SDK or the slice does not say). */
export function companionTargets(ctx: object): string[] {
  const fn = (ctx as Partial<Pick<CompanionTargetsView, "companionTargets">>).companionTargets;
  return typeof fn === "function" ? fn.call(ctx) : [];
}

/** True when the manifest declares a sane Connect companion AND the slice lets the app call Connect. Both must hold. */
export function connectReachable(ctx: object, m: AppDefinition["manifest"] = manifest): boolean {
  const declared = (m.companions ?? []).some((c) => c.product === CONNECT_PRODUCT);
  return declared && connectCompanionProblems(m).length === 0 && companionTargets(ctx).includes(CONNECT_PRODUCT);
}

// ───────────────────────────────────────────────────────────────────────── the real port
export const MAX_ACCOUNTS = 100;
export const MAX_CONVERSATIONS = 200;
export const PULL_LIMIT_MAX = 200;
/** pages per minute a history read gets (the call budget, src/jobs.ts: 100/min, 25 kept for live reads) */
const HISTORY_PAGES_PER_MIN = 75;
/** a v1 record holds about this many messages (estimate only) */
const MESSAGES_PER_RECORD = 10;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v : "").slice(0, max);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** source.kind is 1..32 characters: a service name Observer cannot show as it is becomes "chat" */
const kindOf = (v: unknown): string => {
  const k = text(v, 64).toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(k) ? k : "chat";
};
const isoOf = (ms: number): string => new Date(ms).toISOString();

export const CALL_BUDGET_MESSAGE = "Observer is reading a lot from Connect right now. Try again in a minute.";
type Caller = (op: string, input: Record<string, unknown>, lane?: Lane) => Promise<unknown>;

/** Every Connect call goes through the budget first (also the owner's op handlers: they are app calls for the bridge too). */
function caller(ctx: ConnectCtx, budget: CallBudget): Caller {
  return async (op, input, lane = "live") => {
    const wait = budget.take(lane, clockNow());
    if (wait > 0) throw new TbError("call_budget", CALL_BUDGET_MESSAGE, 429, { retryAfterMs: wait });
    return call(ctx, op, input);
  };
}

async function call(ctx: ConnectCtx, op: string, input: Record<string, unknown>): Promise<unknown> {
  const r = await ctx.callApp(CONNECT_PRODUCT, op, input as never);
  // Connect's data ops are reads; a held read (an owner policy) is a wait, not an answer
  if (r.status !== "ok") throw new TbError("connect_held", "Connect holds this read for an owner decision. Observer tries again later.", 409);
  return r.output;
}

/** The `messages` dataset of one catalog answer, or null when the account has none Observer can read. */
function messagesDataset(out: unknown): Record<string, unknown> | null {
  if (!isObj(out) || !Array.isArray(out.datasets)) return null;
  const d = out.datasets.find((x) => isObj(x) && x.dataset === MESSAGES_DATASET && x.delivery === "pull" && (x.contract === undefined || x.contract === MESSAGES_CONTRACT));
  return isObj(d) ? d : null;
}

async function catalog(c: Caller, account: string): Promise<Record<string, unknown> | null> {
  try {
    return messagesDataset(await c("data_catalog", { account }));
  } catch (e) {
    // the share changed between the list and the catalog: the account is simply not there
    if (e instanceof TbError && (e.code === "not_found" || e.code === "scope_denied")) return null;
    throw e;
  }
}

function accountOf(a: Record<string, unknown>, d: Record<string, unknown>): ConnectAccount {
  const convs = Array.isArray(d.conversations) ? d.conversations : [];
  return {
    id: text(a.account, 128),
    kind: kindOf(a.service),
    label: text(a.label, 200) || text(a.account, 128),
    historyCapable: d.history === true,
    retentionDays: count(d.retentionDays),
    conversations: convs
      .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.id === "string" && c.id.length >= 1 && c.id.length <= 200)
      .slice(0, MAX_CONVERSATIONS)
      .map((c) => ({ id: String(c.id), title: text(c.name, 200) || String(c.id), estimate: count(c.approxRows) })),
  };
}

async function sharedList(c: Caller): Promise<Record<string, unknown>[]> {
  const out = await c("data_accounts_list", {});
  const list = isObj(out) && Array.isArray(out.accounts) ? out.accounts : [];
  return list
    .filter(
      (a): a is Record<string, unknown> =>
        isObj(a) && a.level === "shared" && typeof a.account === "string" && a.account.length >= 1 && a.account.length <= 128 && (!Array.isArray(a.kinds) || a.kinds.includes(MESSAGES_DATASET)),
    )
    .slice(0, MAX_ACCOUNTS);
}

export function realPort(ctx: ConnectCtx, budget: CallBudget = sharedBudget): ConnectPort {
  const c = caller(ctx, budget);
  return {
    async accounts() {
      return (await sharedList(c)).map((a) => ({ id: text(a.account, 128), kind: kindOf(a.service), label: text(a.label, 200) || text(a.account, 128) }));
    },
    async account(id) {
      const a = (await sharedList(c)).find((x) => x.account === id);
      if (!a) return null;
      const d = await catalog(c, id);
      return d ? accountOf(a, d) : null;
    },
    async estimate(q) {
      const d = await catalog(c, q.account);
      if (!d) throw new TbError("account_not_shared", "this account is not shared with Observer in Connect", 404);
      const a = accountOf({ account: q.account }, d);
      const messages = a.conversations.filter((c) => q.conversations.includes(c.id)).reduce((n, c) => n + (c.estimate ?? 0), 0);
      const pages = Math.ceil(messages / PULL_LIMIT_MAX);
      const kept = a.retentionDays === null ? "" : ` (up to ${a.retentionDays} days)`;
      return {
        messages,
        records: Math.ceil(messages / MESSAGES_PER_RECORD),
        durationS: Math.ceil((pages * 60) / HISTORY_PAGES_PER_MIN),
        providerNote: a.historyCapable ? null : `This source has no older history: Observer reads what Connect kept${kept}.`,
      };
    },
    async pull(q) {
      const input: Record<string, unknown> = { account: q.account, dataset: MESSAGES_DATASET, direction: q.direction, limit: Math.max(1, Math.min(PULL_LIMIT_MAX, q.limit ?? PULL_LIMIT_MAX)) };
      if (q.cursor !== null) input.cursor = q.cursor;
      if (q.since !== undefined && q.since !== null) input.since = isoOf(q.since);
      if (q.until !== undefined && q.until !== null) input.until = isoOf(q.until);
      return readPage(await c("data_pull", input, q.lane ?? "live"));
    },
  };
}

const realFactory: Factory = (ctx, m) => (connectReachable(ctx, m) && typeof ctx.callApp === "function" ? realPort(ctx) : null);

let factory: Factory = realFactory;
/** Tests may install their own port; `null` restores the real one (which the tests drive against the fake Connect). */
export function setConnectFactory(fn: Factory | null): void {
  factory = fn ?? realFactory;
}

export function connectPort(ctx: ConnectCtx): ConnectPort | null {
  return factory(ctx, manifest);
}

/** The port, or the clear refusal. */
export function requireConnect(ctx: ConnectCtx): ConnectPort {
  const port = connectPort(ctx);
  if (!port) throw new TbError("connect_unavailable", CONNECT_UNAVAILABLE_MESSAGE, 409);
  return port;
}

// ───────────────────────────────────────────────────────────────────────── Connect's refusals, in plain words
/** Refusals that do not get better by trying again: the job fails at once (no retry storm). */
export const PERMANENT_CODES: ReadonlySet<string> = new Set(["caller_unverified", "not_found", "scope_denied", "no_access", "cursor_invalid", "account_not_shared", "since_invalid", "until_invalid"]);
/** 4xx answers that are waits, not wrong input: everything else in 400..499 is permanent too. */
const WAIT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);
const WAIT_CODES: ReadonlySet<string> = new Set(["paused", "rate_limited", "call_budget", "connect_held", "connect_unavailable"]);

/** True when trying again cannot help: a known refusal, or a 4xx answer about the input (since_invalid, until_invalid, …). */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof TbError)) return false;
  if (PERMANENT_CODES.has(e.code)) return true;
  if (WAIT_CODES.has(e.code)) return false;
  return e.httpStatus >= 400 && e.httpStatus < 500 && !WAIT_STATUSES.has(e.httpStatus);
}

const PLAIN: Record<string, string> = {
  caller_unverified: "Connect could not verify that the caller is Observer, so it shared nothing. Ask the workspace owner to update Observer and Connect.",
  not_found: "Connect does not share this account with Observer any more. Share it again in Connect, then press Try again.",
  account_not_shared: "Connect does not share this account with Observer any more. Share it again in Connect, then press Try again.",
  scope_denied: "Connect shares this account for its list only. Share it for reading in Connect, then press Try again.",
  no_access: "Connect refused Observer as a caller of its data operations.",
  cursor_invalid: "Connect did not accept the saved reading position. Press Try again: a history read starts again from what Connect keeps, live reading starts again from now.",
  since_invalid: "Connect did not accept the start time of this read. Stop it and start a new one.",
  until_invalid: "Connect did not accept the end time of this read. Stop it and start a new one.",
  connect_unavailable: "Observer cannot reach Connect now (the workspace does not let it call Connect).",
  connect_contract: "Connect answered a page Observer cannot use.",
  connect_held: "Connect holds this read for your approval. Approve it in Holds, then press Try again.",
  rate_limited: "Connect is busy. Observer waits and tries again by itself.",
  call_budget: CALL_BUDGET_MESSAGE,
};
/**
 * The sentence the owner reads for a failure (never the provider's own message: it can carry untrusted text). `final`: the job
 * failed for good (a permanent refusal, or the last of 5 tries): the sentence never promises a retry. `retry`: Observer waits
 * and tries again by itself.
 */
export function plainError(code: string, mode: "retry" | "final" = "retry"): string {
  const c = code.slice(0, 60);
  const known = PLAIN[code];
  if (mode === "retry") return known ?? `Reading from Connect failed (${c}). Observer tries again by itself.`;
  if (PERMANENT_CODES.has(code) && known) return known;
  return `${known ?? `Reading failed (${c}).`} Observer stopped this job and does not try again by itself: press Try again when the cause is fixed.`;
}

const OP_REFUSAL: Record<string, { code: string; status: number }> = {
  not_found: { code: "account_not_shared", status: 404 },
  account_not_shared: { code: "account_not_shared", status: 404 },
  scope_denied: { code: "account_list_only", status: 403 },
  caller_unverified: { code: "caller_unverified", status: 403 },
  no_access: { code: "no_access", status: 403 },
  connect_held: { code: "connect_held", status: 409 },
  connect_unavailable: { code: "connect_unavailable", status: 409 },
  call_budget: { code: "call_budget", status: 429 },
  rate_limited: { code: "connect_busy", status: 429 },
};
const OP_SENTENCE: Record<string, string> = {
  account_not_shared: "this account is not shared with Observer in Connect",
  account_list_only: PLAIN.scope_denied as string,
  caller_unverified: PLAIN.caller_unverified as string,
  no_access: PLAIN.no_access as string,
  connect_held: "Connect holds this read for your approval. Try again after you decide it.",
  connect_unavailable: CONNECT_UNAVAILABLE_MESSAGE,
  call_budget: CALL_BUDGET_MESSAGE,
  connect_busy: "Connect is busy. Try again in a minute.",
  connect_failed: "Observer could not read from Connect. Try again later.",
};

/** What an op handler answers when a Connect call fails: a fixed code and a fixed sentence, never Connect's own message. */
export function connectRefusal(e: unknown): TbError {
  const known = e instanceof TbError ? OP_REFUSAL[e.code] : undefined;
  const code = known?.code ?? "connect_failed";
  return new TbError(code, OP_SENTENCE[code] as string, known?.status ?? 502);
}

/** Run an op handler's Connect calls; any failure becomes connectRefusal. */
export async function viaConnect<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw connectRefusal(e);
  }
}
