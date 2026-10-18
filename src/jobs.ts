// The ingest jobs (DESIGN §4.3 step 1, §4.4) on the SDK job runner (miniapp-sdk 0.1.21+, `defineApp({ jobs })`): no scheduler
// of Observer's own. obs_jobs is the owner's truth (state, cursor, counts, error); the SDK job (`obs_jobs.sdk_job_id`) only runs
// the ticks. A tick reads obs_jobs and the slice pause BEFORE EVERY pull, so a paused, cancelled or failed job never pulls again.
//
//  live      forward from the anchor captured at source_add; per tick it pulls pages until Connect says `exhausted`, then waits
//            the source's live interval
//  backfill  history false: forward from Connect's start (what Connect kept), `since` .. `until` (= the anchor time at
//            backfill_start); history true: backward from Connect's newest row down to `since`, also bounded by the anchor time.
//            Ends when exhausted or at `maxMessages` stored messages
//
// ONE PAGE = ONE TRANSACTION (L31): every storeMessage of the page (each its own savepoint), the new cursor and the counts are
// written in one `ctx.checkpoint` (fenced by the SDK lease, so a stale run never commits). A crash before it re-reads the page:
// UNIQUE (source, conversation, provider_msg_id) stops a double, the unchanged cursor stops a gap. After the commit the page's
// messages go through windows → records → classify → route (records.ts, pipeline.ts); a crash in between leaves messages without
// a record, and the next tick of either job windows them.
//
// Failures: `retryAfterS` from Connect is honoured exactly and is not a failure. Other failures back off exponentially with jitter
// (15 s base, 15 min cap); 5 consecutive failures → `failed` and the app's attention (`jobs_failed`). Refusals that cannot get
// better (caller_unverified, not_found, scope_denied, cursor_invalid, …) fail the job at once with a plain sentence: no retry storm.
// Budget: at most 100 data_pull calls a minute across all jobs (the bridge allows 120 app-initiated calls), 25 of them kept for
// live reads; a history read stops at its `maxMessages`.
import type { Db, Job, JobContext, JobOutcome, JobSpec, JobsApi, Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { now as clockNow } from "./clock.ts";
import { type ConnectPort, connectPort, PERMANENT_CODES, type PullQuery, plainError } from "./connect.ts";
import { toIncoming } from "./contract.ts";
import { storeMessage } from "./ingest.ts";
import { applyRouting } from "./pipeline.ts";
import { attachWindow } from "./records.ts";
import { jobRow, type Row, recordRow, sourceRow } from "./store.ts";
import { backfillWindows, liveWindows, type WindowMessage } from "./window.ts";

export const LIVE_KIND = "obs.live";
export const BACKFILL_KIND = "obs.backfill";
export const MAX_FAILURES = 5;
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
/** while the slice pauses the app: look again after this long (no pull meanwhile) */
export const PAUSE_RECHECK_MS = 30_000;
export const PAGE_LIMIT = 200;
/** pages in one tick before the tick hands back (other jobs get a turn; the SDK tick timeout is 10 min) */
export const PAGES_PER_TICK = 25;
export const CALLS_PER_MINUTE = 100;
export const LIVE_RESERVE = 25;

const ACTIVE = new Set(["queued", "running", "waiting"]);
const SDK_ACTIVE = new Set(["queued", "running", "waiting"]);
const SDK_TERMINAL = new Set(["done", "failed", "cancelled", "refused"]);
const str = (v: unknown): string => String(v);

/** Sliding one-minute window of data_pull calls, shared by every job of the process. Live reads may use all of it, history reads
 *  leave `liveReserve` for them. */
export class CallBudget {
  #at: number[] = [];
  readonly perMinute: number;
  readonly liveReserve: number;
  constructor(perMinute = CALLS_PER_MINUTE, liveReserve = LIVE_RESERVE) {
    this.perMinute = perMinute;
    this.liveReserve = liveReserve;
  }
  /** 0: go (the call is counted); otherwise how many ms to wait. */
  take(kind: "live" | "backfill", now: number): number {
    while (this.#at.length > 0 && (this.#at[0] as number) <= now - 60_000) this.#at.shift();
    const limit = kind === "live" ? this.perMinute : this.perMinute - this.liveReserve;
    if (this.#at.length < limit) {
      this.#at.push(now);
      return 0;
    }
    return Math.max(1, (this.#at[this.#at.length - limit] as number) + 60_000 - now);
  }
  get used(): number {
    return this.#at.length;
  }
}
export const sharedBudget = new CallBudget();

/** Exponential with jitter: between half and all of base·2^(n-1), at most the cap. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const full = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(full / 2 + (random() * full) / 2);
}

export interface TickDeps {
  db: Db;
  port: ConnectPort | null;
  /** ctx.checkpoint: the cursor + the app's writes in ONE transaction, fenced by the job's lease (throws job_lease_lost) */
  checkpoint<T>(state: Json, write: (db: Db) => T): T;
  /** the slice pauses the app (workspace or instance) */
  paused(): boolean;
  signal?: AbortSignal;
  budget?: CallBudget;
  random?: () => number;
  /** rows per data_pull (default 200, Connect's maximum) */
  pageLimit?: number;
  statusChanged?(): void;
}

const again = (afterMs: number): JobOutcome => ({ status: "again", afterMs: Math.max(0, Math.round(afterMs)) });
const DONE: JobOutcome = { status: "done" };

/** A state write of the tick: only while the job is still active (an owner pause or cancel in between wins). */
function setState(db: Db, id: string, sql: string, args: unknown[], at: number): boolean {
  return db.prepare(`UPDATE obs_jobs SET ${sql}, updated_at = ? WHERE id = ? AND state IN ('queued', 'running', 'waiting')`).run(...args, at, id).changes > 0;
}

function query(job: Row, src: Row, limit = PAGE_LIMIT): PullQuery {
  const backfill = job.kind === "backfill";
  const backward = backfill && Number(src.history_capable) === 1;
  return {
    account: str(src.account),
    direction: backward ? "backward" : "forward",
    cursor: job.cursor === null || job.cursor === undefined ? null : str(job.cursor),
    ...(backfill ? { since: job.since_at === null ? null : Number(job.since_at), until: job.until_at === null ? null : Number(job.until_at) } : {}),
    limit,
  };
}

function fail(d: TickDeps, job: Row, e: unknown, at: number): JobOutcome {
  const code = e instanceof TbError ? e.code : "error";
  if (code === "job_lease_lost") throw e;
  // the slice paused the app between our check and the call: not a failure
  if (code === "paused") return again(PAUSE_RECHECK_MS);
  const id = str(job.id);
  const failures = Number(job.consecutive_failures) + 1;
  const message = plainError(code);
  if (PERMANENT_CODES.has(code) || failures >= MAX_FAILURES) {
    setState(d.db, id, "state = 'failed', consecutive_failures = ?, last_error = ?, error_code = ?, retry_at = NULL", [failures, message, code.slice(0, 64)], at);
    d.statusChanged?.();
    return DONE;
  }
  const wait = Math.max(backoffMs(failures, d.random), code === "rate_limited" ? 60_000 : 0);
  setState(d.db, id, "state = 'waiting', consecutive_failures = ?, last_error = ?, error_code = ?, retry_at = ?", [failures, message, code.slice(0, 64), at + wait], at);
  d.statusChanged?.();
  return again(wait);
}

export interface PageResult {
  stored: number;
  skipped: number;
}

/** Write one page: every message, the cursor and the counts, in the ONE checkpoint transaction. */
function commitPage(d: TickDeps, job: Row, rows: ReturnType<typeof toIncoming>[], skipped: number, nextCursor: string | null, at: number): PageResult {
  const id = str(job.id);
  const source = str(job.source_id);
  return d.checkpoint({ cursor: nextCursor } as Json, (db) => {
    let stored = 0;
    for (const m of rows) {
      const r = storeMessage(db, source, m, at);
      if (r.status === "inserted" || r.status === "updated") stored += 1;
    }
    const ok = db
      .prepare(
        `UPDATE obs_jobs SET cursor = ?, read_count = read_count + ?, skipped_count = skipped_count + ?, last_read_at = ?, consecutive_failures = 0,
           last_error = NULL, error_code = NULL, retry_at = NULL, state = 'running', updated_at = ? WHERE id = ? AND state IN ('queued', 'running', 'waiting')`,
      )
      .run(nextCursor, stored, skipped, at, at, id).changes;
    // paused or cancelled while the page was on its way: nothing of it is kept, the cursor stays (the next run re-reads it)
    if (ok === 0) throw new TbError("job_not_active", "the job was stopped while the page was read", 409);
    return { stored, skipped };
  });
}

/**
 * Windows → records → classify → route for the messages a source has not given a record yet (live: also the messages of its
 * open records, so a live window grows until it closes). Closed windows are routed through the pipeline. Returns the number of
 * new records. Every step is its own transaction (attachWindow, applyRouting); a crash in between is picked up next time.
 */
export function windowSource(db: Db, sourceId: string, kind: "live" | "backfill", at: number): number {
  const open = kind === "live" ? " OR r.state = 'open'" : "";
  const msgs: WindowMessage[] = db
    .prepare(
      `SELECT m.provider_msg_id AS id, m.conversation, m.thread, m.sent_at, m.text FROM obs_messages m LEFT JOIN obs_records r ON r.id = m.record_id
       WHERE m.source_id = ? AND (m.record_id IS NULL${open})`,
    )
    .all(sourceId)
    .map((r) => ({ id: str(r.id), conversation: str(r.conversation), thread: r.thread === null ? null : str(r.thread), sentAt: Number(r.sent_at), arrivedAt: at, chars: r.text === null ? 0 : str(r.text).length }));
  if (msgs.length === 0) return 0;
  const windows = kind === "live" ? liveWindows(msgs, at) : backfillWindows(msgs, { now: at });
  let created = 0;
  for (const w of windows) {
    const a = attachWindow(db, sourceId, w, at);
    if (a.created) created += 1;
    if (!w.closed) continue;
    const state = str(recordRow(db, a.recordId)?.state);
    if (state === "open" || state === "classified") applyRouting(db, a.recordId, at);
  }
  return created;
}

/** One tick of an Observer job. Pure over its deps (tests drive it with a fake checkpoint, a fake Connect and the test clock). */
export async function runTick(jobId: string, d: TickDeps): Promise<JobOutcome> {
  const budget = d.budget ?? sharedBudget;
  for (let pages = 0; ; pages++) {
    if (d.signal?.aborted) return again(0);
    const job = jobRow(d.db, jobId);
    // paused, cancelled, failed, done or gone: this run ends here; a resume enqueues a new SDK job (syncSdkJob)
    if (!job || !ACTIVE.has(str(job.state))) return DONE;
    if (d.paused()) return again(PAUSE_RECHECK_MS);
    const src = sourceRow(d.db, str(job.source_id));
    if (!src) return DONE;
    const kind = job.kind === "backfill" ? "backfill" : "live";
    const t = clockNow();
    // a wait that is set (Connect's retryAfterS, a backoff, the live interval) is kept to the millisecond
    if (job.retry_at !== null && Number(job.retry_at) > t) return again(Number(job.retry_at) - t);
    if (pages >= PAGES_PER_TICK) return again(0);
    if (kind === "backfill" && job.max_messages !== null && Number(job.read_count) >= Number(job.max_messages)) {
      setState(d.db, jobId, "state = 'done', retry_at = NULL", [], t);
      d.statusChanged?.();
      return DONE;
    }
    if (!d.port) return fail(d, job, new TbError("connect_unavailable", "Connect is not reachable", 409), t);
    const wait = budget.take(kind, t);
    if (wait > 0) return again(wait);
    if (str(job.state) !== "running") setState(d.db, jobId, "state = 'running'", [], t);
    let page: Awaited<ReturnType<ConnectPort["pull"]>>;
    try {
      page = await d.port.pull(query(job, src, d.pageLimit));
    } catch (e) {
      return fail(d, jobRow(d.db, jobId) ?? job, e, clockNow());
    }
    const at = clockNow();
    const fresh = jobRow(d.db, jobId);
    if (!fresh || !ACTIVE.has(str(fresh.state))) return DONE; // stopped while the page was on its way: it is not stored
    if (page.retryAfterS !== null) {
      const ms = page.retryAfterS * 1000;
      setState(d.db, jobId, "state = 'waiting', retry_at = ?", [at + ms], at);
      d.statusChanged?.();
      return again(ms);
    }
    const before = job.cursor === null || job.cursor === undefined ? null : str(job.cursor);
    // a forward page keeps its cursor when exhausted (poll from it); a backward one ends with null
    const nextCursor = page.nextCursor ?? (query(job, src).direction === "forward" ? before : null);
    try {
      commitPage(d, fresh, page.rows.map(toIncoming), page.invalid + page.quarantined, nextCursor, at);
    } catch (e) {
      // nothing of the page was kept (one transaction); a lost lease is the SDK's (fail rethrows it), a stopped job just ends
      if (e instanceof TbError && e.code === "job_not_active") return DONE;
      return fail(d, fresh, e, at);
    }
    const created = windowSource(d.db, str(src.id), kind, at);
    if (created > 0) d.db.prepare("UPDATE obs_jobs SET record_count = record_count + ? WHERE id = ?").run(created, jobId);
    d.statusChanged?.();
    if (page.exhausted || (kind === "backfill" && page.nextCursor === null)) {
      if (kind === "backfill") {
        setState(d.db, jobId, "state = 'done', retry_at = NULL", [], at);
        d.statusChanged?.();
        return DONE;
      }
      const ms = Number(src.live_interval_s) * 1000;
      setState(d.db, jobId, "state = 'waiting', retry_at = ?", [at + ms], at);
      return again(ms);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────── the SDK side
export const sdkKind = (job: Row): string => (job.kind === "backfill" ? BACKFILL_KIND : LIVE_KIND);

/** The SDK jobs API of a ctx (op handlers, onStart), or null when the SDK gives none (tests, an older SDK). */
export function jobsOf(ctx: unknown): JobsApi | null {
  const j = (ctx as { jobs?: unknown } | null)?.jobs;
  return j && typeof (j as JobsApi).enqueue === "function" ? (j as JobsApi) : null;
}

function quietly<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    // the SDK job moved on its own (finished, paused by the app pause): obs_jobs is the truth and every tick reads it
    return null;
  }
}

/** Make the SDK runner follow obs_jobs.state after a transition. Best effort by design: a tick that finds the job not active ends. */
export function syncSdkJob(jobs: JobsApi | null, db: Db, jobId: string): void {
  if (!jobs) return;
  const r = jobRow(db, jobId);
  if (!r) return;
  const sdk: Job | null = r.sdk_job_id ? quietly(() => jobs.get(str(r.sdk_job_id))) : null;
  const state = str(r.state);
  if (ACTIVE.has(state)) {
    if (sdk && sdk.status === "paused") quietly(() => jobs.resume(sdk.id));
    else if (!sdk || SDK_TERMINAL.has(sdk.status)) {
      const made = jobs.enqueue(sdkKind(r), { job: jobId });
      db.prepare("UPDATE obs_jobs SET sdk_job_id = ? WHERE id = ?").run(made.id, jobId);
    }
  } else if (state === "paused") {
    if (sdk && SDK_ACTIVE.has(sdk.status)) quietly(() => jobs.pause(sdk.id));
  } else if (sdk && !SDK_TERMINAL.has(sdk.status)) quietly(() => jobs.cancel(sdk.id));
}

/** After a restart (L6): every active Observer job has a live SDK job; one the SDK gave up on (repeated crashes) is failed
 *  visibly instead of being started again for ever. */
export function reconcileJobs(jobs: JobsApi | null, db: Db, at: number): void {
  if (!jobs) return;
  for (const r of db.prepare("SELECT * FROM obs_jobs WHERE state IN ('queued', 'running', 'waiting')").all()) {
    const sdk = r.sdk_job_id ? quietly(() => jobs.get(str(r.sdk_job_id))) : null;
    if (sdk && (sdk.status === "failed" || sdk.status === "refused")) {
      db.prepare("UPDATE obs_jobs SET state = 'failed', last_error = ?, error_code = 'job_crashed', retry_at = NULL, updated_at = ? WHERE id = ?").run(
        "The job stopped after repeated crashes. Press Try again.",
        at,
        str(r.id),
      );
      continue;
    }
    syncSdkJob(jobs, db, str(r.id));
  }
}

/** Failed jobs need the owner (L3): the app's attention while any is failed. */
export function jobsAttention(db: Db): { code: string; reason: string } | null {
  const n = Number(db.prepare("SELECT COUNT(*) AS c FROM obs_jobs WHERE state = 'failed'").get()?.c ?? 0);
  if (n === 0) return null;
  return { code: "jobs_failed", reason: `${n} Observer job${n === 1 ? "" : "s"} stopped after repeated failures. Open Sources to see why and try again.` };
}

/** The SDK job spec of both kinds: input `{ job: <obs job id> }`. */
export const jobSpec: JobSpec = {
  async run(input, ctx: JobContext) {
    const id = input && typeof input === "object" && !Array.isArray(input) && typeof input.job === "string" ? input.job : null;
    if (!id) return DONE;
    return runTick(id, {
      db: ctx.db,
      port: connectPort(ctx),
      checkpoint: (state, write) => ctx.checkpoint(state, write),
      paused: () => {
        const p = ctx.paused(null);
        return p.workspace || p.instance;
      },
      signal: ctx.signal,
      statusChanged: () => ctx.statusChanged(),
    });
  },
};
