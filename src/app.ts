// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation, OpenAPI,
// receipts, holds, idempotency, scopes, backups and status from it. This file registers exactly one handler per manifest
// operation id (28). Op ids and I/O types come from the generated kit (#kit).
//
// Audiences (DESIGN §3, §5.7):
//   agent  status (labels + counts only, never text/senders/titles), job_pause (pause only), flag (only records Observer delivered)
//   person the owner's UI: sources, jobs, rules, review, records, deliveries, privacy, purge
// Observer declares no scopes: agents can read nothing but the status counts, so there is no instance to check.
//
// S1 scope: the owner ops on the real tables. NOT here yet: reading sources (needs Connect's data_* ops, spec request R3 →
// `connect_unavailable`), the job runner (S2), classification (S3), sending deliveries (S4), the UI (S5), retention jobs (S6).

import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { type Db, defineApp, type HandlerSpec, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type BackfillEstimateInput,
  type BackfillStartInput,
  type DeliveriesListInput,
  type DeliveryRetryInput,
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
import { connectPort, requireConnect } from "./connect.ts";
import { invalidWordEntries } from "./detect/words.ts";
import { digestAttention, setupDigestKey } from "./digest.ts";
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
      const { row, changed } = transitionJob(ctx.db, r, "pause", ctx.caller.id, now());
      if (changed) ctx.statusChanged();
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
      const open = target ? openFlag(ctx.db, ctx.caller.id, target.id) : null;
      if (open) return { flagId: open };
      // the cap comes before the lookup answer, so a capped agent learns nothing about which ids exist
      if (flagsToday(ctx.db, ctx.caller.id, t) >= FLAGS_PER_AGENT_PER_DAY) {
        throw new TbError("flag_limit", `at most ${FLAGS_PER_AGENT_PER_DAY} flags per agent per day`, 429);
      }
      // only a record that Observer delivered AND that is still delivered; an unknown id, a record never sent, dropped, or
      // already waiting in Review answers exactly like a missing one: no oracle
      if (target?.state !== "delivered") throw notFound("record");
      // TODO(S4): also tag the Knowledge document `observer-flagged` (one document_update through the outbox).
      const flagId = addFlag(ctx.db, target.id, { type: ctx.caller.type, id: ctx.caller.id }, reason, t);
      ctx.statusChanged();
      return { flagId };
    },
  }),

  // ───────────────────────────────────────────── person ops: sources
  [OP.sourcesAvailable]: op<SourcesAvailableInput, unknown>({
    async run(_i, ctx) {
      const port = connectPort(ctx);
      if (!port) return { accounts: [], connectMissing: true };
      return { accounts: await port.accounts(), connectMissing: false };
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
      const account = (await port.accounts()).find((a) => a.id === i.account);
      if (!account) throw new TbError("account_not_shared", "this account is not shared with Observer in Connect", 404);
      const known = new Set(account.conversations.map((c) => c.id));
      const unknown = conversations.find((c) => !known.has(c));
      if (unknown !== undefined) throw new TbError("conversation_unknown", `the account has no conversation "${unknown.slice(0, 80)}"`, 400);
      const made = createSource(
        ctx.db,
        {
          account: account.id,
          kind: account.kind,
          label,
          conversations,
          exclude: normalizeExclude(i.exclude ?? {}, { senders: [], domains: [] }),
          liveIntervalS: i.liveIntervalS ?? 60,
          retentionDays: i.retentionDays ?? null,
          historyCapable: account.historyCapable,
        },
        now(),
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
      // TODO(S2): check the conversation ids against Connect's catalog, and re-run the estimate when the list widens.
      // a FULL new exclude (both lists) replaces whatever is stored, also a damaged value; a partial one needs the stored one
      const full = i.exclude?.senders !== undefined && i.exclude?.domains !== undefined;
      const oldEx = full ? { senders: [], domains: [] } : excludeOf(r);
      const exclude = i.exclude ? normalizeExclude(i.exclude, oldEx) : oldEx;
      const retention = i.retentionDays !== undefined ? i.retentionDays : r.retention_days === null ? null : Number(r.retention_days);
      ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE obs_sources SET label = ?, conversations_json = ?, exclude_json = ?, live_interval_s = ?, retention_days = ?, updated_at = ? WHERE id = ?")
          .run(label, JSON.stringify(conversations), JSON.stringify(exclude), i.liveIntervalS ?? Number(r.live_interval_s), retention, now(), i.id);
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
      const { messagesPurged } = removeSource(ctx.db, i.id, now());
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
      const { row, changed } = transitionJob(ctx.db, r, i.action, ctx.caller.id, now());
      if (changed) ctx.statusChanged();
      return { job: jobView(row) };
    },
  }),
  [OP.backfillEstimate]: op<BackfillEstimateInput, unknown>({
    async run(i, ctx) {
      const port = requireConnect(ctx);
      const r = needSource(ctx.db, i.source);
      const since = parseDate(i.since, "since");
      const until = i.until !== undefined ? parseDate(i.until, "until") : null;
      if (until !== null && until <= since) throw new TbError("range_invalid", "until must be after since", 400);
      return port.estimate({ account: String(r.account), conversations: conversationsOf(r), since, until });
    },
  }),
  [OP.backfillStart]: op<BackfillStartInput, unknown>({
    redact: (i) => `read history of ${i.source}`,
    async run(i, ctx) {
      requireConnect(ctx);
      const r = needSource(ctx.db, i.source);
      if (Number(r.history_capable) !== 1) throw new TbError("history_unsupported", "this source cannot read history (live only)", 409);
      const t = now();
      const since = parseDate(i.since, "since");
      const until = i.until !== undefined ? parseDate(i.until, "until") : null;
      const oldest = new Date(t);
      oldest.setUTCFullYear(oldest.getUTCFullYear() - BACKFILL_MAX_YEARS);
      if (since < oldest.getTime()) throw new TbError("since_too_old", `history can reach back at most ${BACKFILL_MAX_YEARS} years`, 400);
      if (until !== null && until <= since) throw new TbError("range_invalid", "until must be after since", 400);
      if (activeBackfill(ctx.db, i.source)) throw new TbError("backfill_active", "this source already has a history job; cancel it first", 409);
      // TODO(S2): capture the anchor BEFORE the job starts (no gap, no double) from Connect.
      const job = createBackfill(ctx.db, i.source, { since, until, maxMessages: i.maxMessages ?? BACKFILL_DEFAULT_MAX_MESSAGES }, t);
      ctx.statusChanged();
      return { job: jobView(job) };
    },
  }),

  // ───────────────────────────────────────────── person ops: rules
  [OP.rulesList]: op<RulesListInput, unknown>({
    async run(_i, ctx) {
      return { rules: listRules(ctx.db) };
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
      decideRecord(ctx.db, r, { decision: i.decision, destination: i.destination, input: i }, ctx.caller.id, now(), getPrivacy(ctx.db).textRetentionDays);
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
      // S1: the row changes (failed → pending); S4 sends it with the stored key
      return { delivery: retryDelivery(ctx.db, r, now()) };
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
  },
  // The owner must act when the digest key is gone or the secret store failed (digest.ts); S2 adds failed jobs.
  async attention() {
    return digestAttention();
  },
  // Records waiting in Review (C86): canvas badge and the count of things that need the owner.
  async pendingCount(db) {
    return pendingCount(db);
  },
  // TODO(S2): `jobs` (SDK job runner, R1) and `attention` (failed jobs: one Inbox item).
};

export const app = defineApp(definition);
