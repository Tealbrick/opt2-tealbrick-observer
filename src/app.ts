// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation, OpenAPI,
// receipts, holds, idempotency, scopes, backups and status from it. This file registers exactly one handler per manifest
// operation id (28). Op ids and I/O types come from the generated kit (#kit).
//
// Audiences (DESIGN §3, §5.7):
//   agent  status (labels + counts only, never text/senders/titles), job_pause (pause only), flag (only records Observer delivered)
//   person the owner's UI: sources, jobs, rules, review, records, deliveries, privacy, purge
// Observer declares no scopes: agents can read nothing but the status counts, so there is no instance to check.
//
// Reading sources (S2): through Connect's data_* ops (src/connect.ts) by jobs on the SDK runner (src/jobs.ts); without a
// reachable Connect the source ops answer `connect_unavailable`. NOT here yet: sending deliveries (S4), retention jobs (S6).

import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { type Db, defineApp, type HandlerSpec, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type BackfillEstimateInput,
  type BackfillStartInput,
  type DeliveriesListInput,
  type DeliveryRetryInput,
  type DeliveryTargetGetInput,
  type DeliveryTargetSetInput,
  type FlagInput,
  type FlagOutput,
  type JobControlInput,
  type JobGetInput,
  type JobPauseInput,
  type JobPauseOutput,
  type JobsListInput,
  OP,
  type OpId,
  type PrivacyGetInput,
  type PrivacySetInput,
  type PurgeInput,
  type RecordGetInput,
  type RecordsListInput,
  type ReviewDecideInput,
  type ReviewGetInput,
  type ReviewListInput,
  type RuleDeleteInput,
  type RulePutInput,
  type RulesListInput,
  type RulesReorderInput,
  type SourceAddInput,
  type SourceGetInput,
  type SourceRemoveInput,
  type SourcesAvailableInput,
  type SourcesListInput,
  type SourceUpdateInput,
  type StatusInput,
  type StatusOutput,
} from "#kit";
import { now, setClock } from "./clock.ts";
import { companionTargets, connectPort, connectRefusal, requireConnect, viaConnect } from "./connect.ts";
import { DOCUMENTS_DATASET, MESSAGES_DATASET } from "./contract.ts";
import { chosenArea, DELIVER_KIND, defaultArea, deliverJob, deliveryCounts, ensureDrainJob, HUMAN_EDITED, KNOWLEDGE, KNOWLEDGE_MISSING, knowledgeAreas, setChosenArea } from "./deliver.ts";
import { invalidWordEntries } from "./detect/words.ts";
import { digestAttention, setupDigestKey } from "./digest.ts";
import { BACKFILL_KIND, DOC_DEFAULT_INTERVAL_S, jobSpec, jobsAttention, jobsOf, LIVE_KIND, reconcileJobs, syncSdkJob } from "./jobs.ts";
import { manifest, migrationsDir } from "./manifest.ts";
import {
  activeBackfill,
  addFlag,
  BACKFILL_DEFAULT_MAX_MESSAGES,
  BACKFILL_MAX_YEARS,
  conversationsOf,
  createBackfill,
  createSource,
  decideRecord,
  deleteRule,
  deliveredRecord,
  deliveryRow,
  deliveryView,
  dropOutOfScope,
  ensureRuleZero,
  excludeOf,
  FLAGS_PER_AGENT_PER_DAY,
  flagsToday,
  getPrivacy,
  jobRow,
  jobView,
  listJobs,
  listRules,
  listSources,
  normalizeExclude,
  notFound,
  openFlag,
  pageOf,
  parseDate,
  pendingCount,
  purgeText,
  putRule,
  RECORD_STATES,
  recordDetail,
  recordRow,
  recordView,
  removeSource,
  reorderRules,
  retryDelivery,
  setPrivacy,
  sourceRow,
  sourceView,
  statusView,
  transitionJob,
} from "./store.ts";

export { manifest, migrationsDir, setClock };

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

/** The app DB for `holdView` (it gets no context); bound once in onStart. */
let boundDb: Db | null = null;
export function bindDb(db: Db | null): void {
  boundDb = db;
}

/** Free text after trim must not be empty (the schema checks only the raw length). */
function nonEmpty(v: string, field: string): string {
  const t = v.trim();
  if (!t) throw new TbError(`${field}_empty`, `${field} is empty`, 400);
  return t;
}

/** DESIGN §3.1: `status` returns no items, so a Rules narrowing with `v: 1` (memory tags) is irrelevant and ignored; any other
 *  shape cannot be honoured → fail closed. */
function checkNarrowing(ctx: OpContext): void {
  const n = ctx.context["rules.narrowing"];
  if (n === undefined) return;
  if (n && typeof n === "object" && !Array.isArray(n) && (n as { v?: unknown }).v === 1) return;
  throw new TbError("narrowing_unsupported", "Observer cannot apply this narrowing", 409);
}

function needSource(db: Db, id: string): Record<string, unknown> {
  const r = sourceRow(db, id);
  if (!r) throw notFound("source");
  return r;
}

const MAX_SOURCES = 100;

export const DOCUMENTS_NO_HISTORY = "A documents source reads every document of its collections when you start it, so there is no separate history read.";

/** The collections other documents sources of this account already read (one collection, one source: dedupe per account). */
function takenCollections(db: Db, account: string, except: string | null): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare("SELECT id, conversations_json FROM obs_sources WHERE account = ? AND dataset = 'documents'").all(account)) {
    if (except !== null && String(r.id) === except) continue;
    for (const c of conversationsOf(r)) out.add(c);
  }
  return out;
}

/** A history read ends this long after its anchor time: clocks of Connect, the provider and Observer differ a little, and a
 *  message can be in flight while the anchor is taken. Reading 5 minutes too far is harmless (UNIQUE per message: the live job
 *  may have stored it already); reading too little would be a gap. */
export const BACKFILL_UNTIL_MARGIN_MS = 5 * 60_000;

/** Where Connect's log of the account is now: a no-cursor pull answers `anchor` (absent when the log is empty: then the start is
 *  the anchor). Taken BEFORE the job exists, so the job's start can never be later than this moment (no gap). */
async function captureAnchor(port: ReturnType<typeof requireConnect>, account: string, direction: "forward" | "backward"): Promise<string | null> {
  try {
    return (await port.pull({ account, direction, cursor: null, limit: 1, lane: "live" })).anchor;
  } catch (e) {
    throw connectRefusal(e);
  }
}

/**
 * Who a record, a pause or a decision is attributed to (SDK-CALLER-PRODUCT, SDK 0.1.27). An app caller is keyed on its VERIFIED
 * product (`ctx.caller.product`, set from the Portal-signed slice), never on `ctx.caller.name` or the manifest name: two apps can
 * share a name, a product is unique. An app whose slice entry carries no product is keyed on its verified instance id (the
 * `tb:ins:<id>` of its grant), which is also never a name, and the key says so (`ins:` instead of `app:`). Agents and persons keep
 * their id. Observer serves no op to apps today, so this is the single place a future one gets its identity.
 */
export function callerKey(ctx: OpContext): string {
  if (ctx.caller.type !== "app") return ctx.caller.id;
  const product = (ctx.caller as { product?: unknown }).product;
  return typeof product === "string" && product !== "" ? `app:${product}` : `ins:${ctx.caller.id}`;
}

/** The apps the slice lets Observer call right now (for the owner UI: a destination that is not here is greyed). Product ids only. */
const KNOWN_TARGETS = ["connect", "knowledge", "kanban", "inbox"] as const;
function targetsOf(ctx: OpContext): string[] {
  const t = companionTargets(ctx);
  return KNOWN_TARGETS.filter((p) => t.includes(p));
}

export const handlers = {
  // ───────────────────────────────────────────── agent ops
  [OP.status]: op<StatusInput, StatusOutput>({
    async run(_i, ctx) {
      checkNarrowing(ctx);
      return statusView(ctx.db);
    },
  }),
  [OP.jobPause]: op<JobPauseInput, JobPauseOutput>({
    redact: (i) => `pause job ${i.jobId}`,
    async run(i, ctx) {
      // pause only: start, resume and cancel are owner-only (job_control is a person op)
      // ONE answer for an unknown id and for a job that cannot be paused (done, failed, cancelled): no 404/409 oracle
      const r = jobRow(ctx.db, i.jobId);
      if (!r || !["queued", "running", "waiting", "paused"].includes(String(r.state))) throw notFound("job");
      const { row, changed } = transitionJob(ctx.db, r, "pause", callerKey(ctx), now());
      if (changed) {
        syncSdkJob(jobsOf(ctx), ctx.db, String(row.id));
        ctx.statusChanged();
      }
      return { job: { id: String(row.id), state: String(row.state) } };
    },
  }),
  [OP.flag]: op<FlagInput, FlagOutput>({
    redact: (i) => `flag ${i.recordId ?? i.documentId ?? "?"}`,
    async run(i, ctx) {
      if (i.recordId === undefined && i.documentId === undefined) throw new TbError("flag_target_missing", "give recordId or documentId", 400);
      const reason = nonEmpty(i.reason, "reason");
      const t = now();
      const target = deliveredRecord(ctx.db, i);
      // flagging the same record again is idempotent: the agent gets its open flag back, no new row, no cap use
      const open = target ? openFlag(ctx.db, callerKey(ctx), target.id) : null;
      if (open) return { flagId: open };
      // the cap comes before the lookup answer, so a capped agent learns nothing about which ids exist
      if (flagsToday(ctx.db, callerKey(ctx), t) >= FLAGS_PER_AGENT_PER_DAY) {
        throw new TbError("flag_limit", `at most ${FLAGS_PER_AGENT_PER_DAY} flags per agent per day`, 429);
      }
      // only a record that Observer delivered AND that is still delivered; an unknown id, a record never sent, dropped, or
      // already waiting in Review answers exactly like a missing one: no oracle
      if (target?.state !== "delivered") throw notFound("record");
      // TODO(S4): also tag the Knowledge document `observer-flagged` (one document_update through the outbox).
      const flagId = addFlag(ctx.db, target.id, { type: ctx.caller.type, id: callerKey(ctx) }, reason, t);
      ctx.statusChanged();
      return { flagId };
    },
  }),

  // ───────────────────────────────────────────── person ops: sources
  [OP.sourcesAvailable]: op<SourcesAvailableInput, unknown>({
    async run(i, ctx) {
      const port = connectPort(ctx);
      const targets = targetsOf(ctx);
      if (!port) return { accounts: [], connectMissing: true, targets };
      // the list is ONE call; the conversations of an account (one catalog call) only when the owner picked it
      const account = (i as { account?: string }).account;
      if (account !== undefined) {
        const a = await viaConnect(() => port.account(account, i.dataset));
        return { accounts: a ? [a] : [], connectMissing: false, targets };
      }
      return { accounts: await viaConnect(() => port.accounts()), connectMissing: false, targets };
    },
  }),
  [OP.sourcesList]: op<SourcesListInput, unknown>({
    async run(_i, ctx) {
      return { sources: listSources(ctx.db) };
    },
  }),
  [OP.sourceGet]: op<SourceGetInput, unknown>({
    async run(i, ctx) {
      const r = needSource(ctx.db, i.id);
      return { source: sourceView(ctx.db, r), jobs: listJobs(ctx.db, i.id, 20) };
    },
  }),
  [OP.sourceAdd]: op<SourceAddInput, unknown>({
    redact: (i) => `add source (account ${i.account})`,
    async run(i, ctx) {
      const port = requireConnect(ctx);
      const label = nonEmpty(i.label, "label");
      const conversations = [...new Set(i.conversations)];
      if (conversations.length === 0) throw new TbError("conversations_empty", "choose at least one conversation", 400);
      if (Number(ctx.db.prepare("SELECT COUNT(*) AS c FROM obs_sources").get()?.c ?? 0) >= MAX_SOURCES) throw new TbError("sources_limit", `at most ${MAX_SOURCES} sources`, 409);
      const dataset = i.dataset ?? MESSAGES_DATASET;
      const docs = dataset === DOCUMENTS_DATASET;
      const account = await viaConnect(() => port.account(i.account, dataset));
      if (!account) throw new TbError("account_not_shared", docs ? "this account shares no documents with Observer in Connect" : "this account is not shared with Observer in Connect", 404);
      const known = new Set(account.conversations.map((c) => c.id));
      const unknown = conversations.find((c) => !known.has(c));
      if (unknown !== undefined) throw new TbError("conversation_unknown", `the account has no ${docs ? "collection" : "conversation"} "${unknown.slice(0, 80)}"`, 400);
      // documents are deduplicated on (account, collection, id): one collection is read by one source only
      if (docs) {
        const taken = takenCollections(ctx.db, account.id, null);
        const twice = conversations.find((c) => taken.has(c));
        if (twice !== undefined) throw new TbError("collection_taken", `another source already reads the collection "${twice.slice(0, 80)}" of this account`, 409);
      }
      // messages: the anchor FIRST, the live job reads forward from it, so nothing that arrives after this moment can be missed.
      // documents: no anchor, the job reads every document of the collections from Connect's start (then follows the changes)
      const anchor = docs ? null : await captureAnchor(port, account.id, "forward");
      const anchorAt = now();
      const made = createSource(
        ctx.db,
        {
          account: account.id,
          kind: account.kind,
          label,
          conversations,
          exclude: normalizeExclude(i.exclude ?? {}, { senders: [], domains: [] }),
          liveIntervalS: i.liveIntervalS ?? (docs ? DOC_DEFAULT_INTERVAL_S : 60),
          retentionDays: i.retentionDays ?? null,
          historyCapable: account.historyCapable,
          keptDays: account.retentionDays,
          anchor,
          anchorAt,
          dataset,
        },
        anchorAt,
      );
      ctx.statusChanged();
      return { source: sourceView(ctx.db, needSource(ctx.db, made.source)) };
    },
  }),
  [OP.sourceUpdate]: op<SourceUpdateInput, unknown>({
    redact: (i) => `change source ${i.id}`,
    async run(i, ctx) {
      const r = needSource(ctx.db, i.id);
      const label = i.label !== undefined ? nonEmpty(i.label, "label") : String(r.label);
      const before = conversationsOf(r);
      const conversations = i.conversations !== undefined ? [...new Set(i.conversations)] : before;
      if (conversations.length === 0) throw new TbError("conversations_empty", "a source needs at least one conversation (remove the source to stop watching)", 400);
      // widening needs Connect: a new conversation id must be one the account has (narrowing works without Connect). The UI
      // shows the estimate for the wider list through backfill_estimate before a history read.
      const added = conversations.filter((c) => !before.includes(c));
      if (added.length > 0) {
        const port = requireConnect(ctx);
        const dataset = r.dataset === DOCUMENTS_DATASET ? DOCUMENTS_DATASET : MESSAGES_DATASET;
        const account = await viaConnect(() => port.account(String(r.account), dataset));
        if (!account) throw new TbError("account_not_shared", "this account is not shared with Observer in Connect", 404);
        if (dataset === DOCUMENTS_DATASET) {
          const taken = takenCollections(ctx.db, String(r.account), i.id);
          const twice = added.find((c) => taken.has(c));
          if (twice !== undefined) throw new TbError("collection_taken", `another source already reads the collection "${twice.slice(0, 80)}" of this account`, 409);
        }
        const known = new Set(account.conversations.map((c) => c.id));
        const unknown = added.find((c) => !known.has(c));
        if (unknown !== undefined) throw new TbError("conversation_unknown", `the account has no conversation "${unknown.slice(0, 80)}"`, 400);
      }
      // a FULL new exclude (both lists) replaces whatever is stored, also a damaged value; a partial one needs the stored one
      const full = i.exclude?.senders !== undefined && i.exclude?.domains !== undefined;
      const oldEx = full ? { senders: [], domains: [] } : excludeOf(r);
      const exclude = i.exclude ? normalizeExclude(i.exclude, oldEx) : oldEx;
      const retention = i.retentionDays !== undefined ? i.retentionDays : r.retention_days === null ? null : Number(r.retention_days);
      ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE obs_sources SET label = ?, conversations_json = ?, exclude_json = ?, live_interval_s = ?, retention_days = ?, updated_at = ? WHERE id = ?")
          .run(label, JSON.stringify(conversations), JSON.stringify(exclude), i.liveIntervalS ?? Number(r.live_interval_s), retention, now(), i.id);
        // documents: a changed collection list restarts the scan from the start (a mid-scan cursor is cheap to lose, and the new list
        // may make the old position meaningless)
        if (r.dataset === DOCUMENTS_DATASET && (conversations.length !== before.length || conversations.some((c) => !before.includes(c)))) {
          ctx.db.prepare("UPDATE obs_jobs SET cursor = NULL, same_cursor_count = 0, updated_at = ? WHERE source_id = ? AND kind = 'live'").run(now(), i.id);
        }
        // narrowing applies at once: stored messages the source may no longer hold go now.
        dropOutOfScope(
          ctx.db,
          i.id,
          before.filter((c) => !conversations.includes(c)),
          i.exclude ? exclude : null,
          now(),
        );
      });
      ctx.statusChanged();
      return { source: sourceView(ctx.db, needSource(ctx.db, i.id)) };
    },
  }),
  [OP.sourceRemove]: op<SourceRemoveInput, unknown>({
    redact: (i) => `remove source ${i.id}`,
    holdView: (i) => {
      const r = boundDb ? sourceRow(boundDb, i.id) : undefined;
      const n = boundDb && r ? Number(boundDb.prepare("SELECT COUNT(*) AS c FROM obs_messages WHERE source_id = ?").get(i.id)?.c ?? 0) : 0;
      return r ? `Remove the source "${String(r.label)}": stop its jobs and delete ${n} stored message(s) with their ids. Documents already delivered to Knowledge stay.` : `Remove the source ${i.id}.`;
    },
    async run(i, ctx) {
      needSource(ctx.db, i.id);
      const { messagesPurged, sdkJobs } = removeSource(ctx.db, i.id, now());
      const jobs = jobsOf(ctx);
      for (const id of sdkJobs) {
        try {
          jobs?.cancel(id);
        } catch {
          // already finished: nothing runs; a tick that still runs finds its job gone and ends
        }
      }
      ctx.statusChanged();
      return { removed: true, messagesPurged };
    },
  }),

  // ───────────────────────────────────────────── person ops: jobs
  [OP.jobsList]: op<JobsListInput, unknown>({
    async run(i, ctx) {
      return { jobs: listJobs(ctx.db, i.source) };
    },
  }),
  [OP.jobGet]: op<JobGetInput, unknown>({
    async run(i, ctx) {
      const r = jobRow(ctx.db, i.id);
      if (!r) throw notFound("job");
      return { job: jobView(r) };
    },
  }),
  [OP.jobControl]: op<JobControlInput, unknown>({
    redact: (i) => `${i.action} job ${i.id}`,
    async run(i, ctx) {
      const r = jobRow(ctx.db, i.id);
      if (!r) throw notFound("job");
      // Try again on a LIVE job whose cursor Connect refused: never from Connect's start (that would import what came before
      // the source). A fresh anchor first, the job continues from it, and its note says which span may be missing.
      // A documents source reads its collections again from Connect's start instead (a document read twice is unchanged).
      let reanchor: { anchor: string | null; at: number; fromStart?: boolean } | undefined;
      if (i.action === "resume" && r.state === "failed" && r.kind === "live" && r.error_code === "cursor_invalid") {
        const src = needSource(ctx.db, String(r.source_id));
        if (src.dataset === DOCUMENTS_DATASET) reanchor = { anchor: null, at: now(), fromStart: true };
        else {
          const anchor = await captureAnchor(requireConnect(ctx), String(src.account), "forward");
          reanchor = { anchor, at: now() };
        }
      }
      const { row, changed } = transitionJob(ctx.db, r, i.action, callerKey(ctx), now(), reanchor);
      if (changed) {
        syncSdkJob(jobsOf(ctx), ctx.db, String(row.id));
        ctx.statusChanged();
      }
      return { job: jobView(jobRow(ctx.db, String(row.id)) ?? row) };
    },
  }),
  [OP.backfillEstimate]: op<BackfillEstimateInput, unknown>({
    async run(i, ctx) {
      const port = requireConnect(ctx);
      const r = needSource(ctx.db, i.source);
      const since = parseDate(i.since, "since");
      const until = i.until !== undefined ? parseDate(i.until, "until") : null;
      if (until !== null && until <= since) throw new TbError("range_invalid", "until must be after since", 400);
      const dataset = r.dataset === DOCUMENTS_DATASET ? DOCUMENTS_DATASET : MESSAGES_DATASET;
      return viaConnect(() => port.estimate({ account: String(r.account), conversations: conversationsOf(r), since, until, dataset }));
    },
  }),
  [OP.backfillStart]: op<BackfillStartInput, unknown>({
    redact: (i) => `read history of ${i.source}`,
    async run(i, ctx) {
      const port = requireConnect(ctx);
      const r = needSource(ctx.db, i.source);
      // a documents source reads every document of its collections when it starts: a history read has nothing more to read
      if (r.dataset === DOCUMENTS_DATASET) throw new TbError("history_not_needed", DOCUMENTS_NO_HISTORY, 409);
      // a source without history (Telegram bots, every provider of Connect 0.6.0) still has what Connect kept: it is read forward
      const history = Number(r.history_capable) === 1;
      const t = now();
      const since = parseDate(i.since, "since");
      const until = i.until !== undefined ? parseDate(i.until, "until") : null;
      const oldest = new Date(t);
      oldest.setUTCFullYear(oldest.getUTCFullYear() - BACKFILL_MAX_YEARS);
      if (since < oldest.getTime()) throw new TbError("since_too_old", `history can reach back at most ${BACKFILL_MAX_YEARS} years`, 400);
      if (until !== null && until <= since) throw new TbError("range_invalid", "until must be after since", 400);
      if (activeBackfill(ctx.db, i.source)) throw new TbError("backfill_active", "this source already has a history job; cancel it first", 409);
      if (since >= t) throw new TbError("since_in_future", "since must be in the past", 400);
      // the anchor BEFORE the job exists: the history read ends at this moment (what comes later is the live job's), so there
      // is no gap; an overlap with the live job is harmless (UNIQUE per message)
      const anchor = await captureAnchor(port, String(r.account), history ? "backward" : "forward");
      const anchorAt = now();
      const end = anchorAt + BACKFILL_UNTIL_MARGIN_MS;
      const job = createBackfill(ctx.db, i.source, { since, until: until === null ? end : Math.min(until, end), maxMessages: i.maxMessages ?? BACKFILL_DEFAULT_MAX_MESSAGES, anchor, anchorAt }, anchorAt);
      syncSdkJob(jobsOf(ctx), ctx.db, String(job.id));
      ctx.statusChanged();
      return { job: jobView(jobRow(ctx.db, String(job.id)) ?? job) };
    },
  }),

  // ───────────────────────────────────────────── person ops: rules
  [OP.rulesList]: op<RulesListInput, unknown>({
    async run(_i, ctx) {
      return { rules: listRules(ctx.db), targets: targetsOf(ctx) };
    },
  }),
  [OP.rulePut]: op<RulePutInput, unknown>({
    redact: (i) => `${i.id ? "change" : "add"} rule at ${i.position}`,
    async run(i, ctx) {
      // a word list entry that is empty, "*" or a stem under 3 letters would match (almost) everything or nothing
      const bad = invalidWordEntries(i.match.words ?? []);
      if (bad.length > 0) throw new TbError("rule_word_invalid", `unusable word in the rule: ${JSON.stringify(bad[0])} (not empty, not "*", stems at least 3 letters)`, 400);
      return { rule: putRule(ctx.db, i, now()) };
    },
  }),
  [OP.ruleDelete]: op<RuleDeleteInput, unknown>({
    redact: (i) => `delete rule ${i.id}`,
    holdView: (i) => `Delete the routing rule ${i.id}. Records that matched it will match the next rule, or wait in Review.`,
    async run(i, ctx) {
      return { deleted: deleteRule(ctx.db, i.id, now()) };
    },
  }),
  [OP.rulesReorder]: op<RulesReorderInput, unknown>({
    redact: (i) => `reorder ${i.ids.length} rules`,
    async run(i, ctx) {
      return { rules: reorderRules(ctx.db, i.ids, now()) };
    },
  }),

  // ───────────────────────────────────────────── person ops: review, records, deliveries
  [OP.reviewList]: op<ReviewListInput, unknown>({
    async run(i, ctx) {
      return pageOf(ctx.db, "obs_records", ["state = 'review'"], [], i.cursor, recordView);
    },
  }),
  [OP.reviewGet]: op<ReviewGetInput, unknown>({
    async run(i, ctx) {
      const r = recordRow(ctx.db, i.id);
      if (!r || String(r.state) !== "review") throw notFound("review item");
      return { record: recordDetail(ctx.db, r, now()) };
    },
  }),
  [OP.reviewDecide]: op<ReviewDecideInput, unknown>({
    redact: (i) => `${i.decision} record ${i.recordId}${i.destination ? ` to ${i.destination}` : ""}`,
    async run(i, ctx) {
      const r = recordRow(ctx.db, i.recordId);
      if (!r) throw notFound("record");
      // every guard (secret, state, destination, keep, text, held) lives in decideRecord
      decideRecord(ctx.db, r, { decision: i.decision, destination: i.destination, acknowledged: i.acknowledged, revision: i.revision, input: i }, callerKey(ctx), now(), getPrivacy(ctx.db).textRetentionDays);
      // the outbox drain sends it (S4); make sure it runs
      ensureDrainJob(jobsOf(ctx));
      ctx.statusChanged();
      const row = recordRow(ctx.db, i.recordId);
      if (!row) throw notFound("record");
      return { record: recordView(row) };
    },
  }),
  [OP.recordsList]: op<RecordsListInput, unknown>({
    async run(i, ctx) {
      if (i.state !== undefined && !(RECORD_STATES as readonly string[]).includes(i.state)) throw new TbError("state_invalid", `state must be one of ${RECORD_STATES.join(", ")}`, 400);
      const where: string[] = [];
      const args: unknown[] = [];
      if (i.source !== undefined) {
        where.push("source_id = ?");
        args.push(i.source);
      }
      if (i.state !== undefined) {
        where.push("state = ?");
        args.push(i.state);
      }
      return pageOf(ctx.db, "obs_records", where, args, i.cursor, recordView);
    },
  }),
  [OP.recordGet]: op<RecordGetInput, unknown>({
    async run(i, ctx) {
      const r = recordRow(ctx.db, i.id);
      if (!r) throw notFound("record");
      return { record: recordDetail(ctx.db, r, now()) };
    },
  }),
  [OP.deliveriesList]: op<DeliveriesListInput, unknown>({
    async run(i, ctx) {
      return pageOf(ctx.db, "obs_deliveries", i.status ? ["status = ?"] : [], i.status ? [i.status] : [], i.cursor, (r) => deliveryView(r));
    },
  }),
  [OP.deliveryRetry]: op<DeliveryRetryInput, unknown>({
    redact: (i) => `retry delivery ${i.id}`,
    async run(i, ctx) {
      const r = deliveryRow(ctx.db, i.id);
      if (!r) throw notFound("delivery");
      // the row changes (failed → pending); the outbox drain sends it with the stored key and the stored call
      const delivery = ctx.db.transaction(() => {
        const out = retryDelivery(ctx.db, r, now());
        // a document a person edited in Knowledge: the owner resets it. The link is forgotten, so the next send makes a NEW document
        // from this version and the edited one stays as the person left it
        if (r.last_error === HUMAN_EDITED && r.target_key) ctx.db.prepare("DELETE FROM obs_targets WHERE key = ? AND destination = 'knowledge'").run(String(r.target_key));
        return out;
      });
      ensureDrainJob(jobsOf(ctx));
      return { delivery };
    },
  }),
  [OP.deliveryTargetGet]: op<DeliveryTargetGetInput, unknown>({
    async run(_i, ctx) {
      const area = chosenArea(ctx.db);
      const counts = deliveryCounts(ctx.db);
      if (!companionTargets(ctx).includes(KNOWLEDGE)) return { area, effectiveArea: area, areas: [], knowledgeMissing: true, error: null, counts };
      try {
        const areas = await knowledgeAreas(ctx.callApp as never);
        return { area, effectiveArea: area ?? defaultArea(areas), areas, knowledgeMissing: false, error: null, counts };
      } catch (e) {
        // Knowledge's own words never reach the page: a fixed sentence with its code
        const code = e instanceof TbError ? e.code.slice(0, 60) : "error";
        return { area, effectiveArea: area, areas: [], knowledgeMissing: false, error: `Observer could not list the Knowledge areas (${code}).`, counts };
      }
    },
  }),
  [OP.deliveryTargetSet]: op<DeliveryTargetSetInput, unknown>({
    redact: (i) => `deliver to ${i.area ?? "the company area"}`,
    async run(i, ctx) {
      if (i.area !== null) {
        if (!companionTargets(ctx).includes(KNOWLEDGE)) throw new TbError("knowledge_unavailable", KNOWLEDGE_MISSING, 409);
        const areas = await knowledgeAreas(ctx.callApp as never).catch(() => {
          throw new TbError("knowledge_failed", "Observer could not list the Knowledge areas. Try again later.", 502);
        });
        if (!areas.some((a) => a.id === i.area)) throw new TbError("area_unknown", "Knowledge does not show Observer this area", 404);
      }
      setChosenArea(ctx.db, i.area, now());
      return { area: chosenArea(ctx.db) };
    },
  }),

  // ───────────────────────────────────────────── person ops: privacy
  [OP.privacyGet]: op<PrivacyGetInput, unknown>({
    async run(_i, ctx) {
      return getPrivacy(ctx.db);
    },
  }),
  [OP.privacySet]: op<PrivacySetInput, unknown>({
    redact: () => "change privacy settings",
    async run(i, ctx) {
      // TODO(S6): a shorter retention also moves text_purge_at of records already decided.
      return setPrivacy(ctx.db, i);
    },
  }),
  [OP.purge]: op<PurgeInput, unknown>({
    redact: (i) => `delete stored text${i.source ? ` of ${i.source}` : ""}${i.before ? ` before ${i.before}` : ""}`,
    holdView: (i) =>
      `Delete stored message text now${i.source ? ` of source ${i.source}` : " of every source"}${i.before ? ` sent before ${i.before}` : ""}. Message ids stay so nothing is read twice.`,
    async run(i, ctx) {
      if (i.source !== undefined) needSource(ctx.db, i.source);
      const before = i.before !== undefined ? parseDate(i.before, "before") : undefined;
      return { purged: purgeText(ctx.db, { ...(i.source !== undefined ? { source: i.source } : {}), ...(before !== undefined ? { before } : {}) }, now()) };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  async onStart(ctx) {
    bindDb(ctx.db);
    // rule 0, "never keep secrets": created at start, locked, always first (DESIGN §3.2). FIRST, so nothing below can leave the
    // app without it.
    ensureRuleZero(ctx.db, now());
    // the HMAC key for message digests (digest.ts): a failure is logged and shown as attention, it does not stop the start
    await setupDigestKey(ctx, now());
    // L6: a restart never strands a job; every active Observer job gets its SDK job back
    reconcileJobs(jobsOf(ctx), ctx.db, now());
    // S4: the outbox drain runs for the app's lifetime
    ensureDrainJob(jobsOf(ctx));
  },
  // The SDK drains the running ticks after this; Observer has no timers of its own.
  async onStop() {
    bindDb(null);
  },
  // The owner must act when the digest key is gone or the secret store failed (digest.ts), or when a job failed (L3).
  // TODO(S4): one Inbox item per failed job (R5).
  async attention(db) {
    return digestAttention() ?? jobsAttention(db);
  },
  // Records waiting in Review (C86): canvas badge and the count of things that need the owner.
  async pendingCount(db) {
    return pendingCount(db);
  },
  // The ingest jobs on the SDK runner (src/jobs.ts): one kind per Observer job kind, input { job: <obs job id> }.
  jobs: { [LIVE_KIND]: jobSpec, [BACKFILL_KIND]: jobSpec, [DELIVER_KIND]: deliverJob },
};

export const app = defineApp(definition);
