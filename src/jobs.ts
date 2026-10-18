// The ingest jobs (DESIGN §4.3 step 1, §4.4) on the SDK job runner (miniapp-sdk 0.1.21+, `defineApp({ jobs })`): no scheduler
// of Observer's own. obs_jobs is the owner's truth (state, cursor, counts, error); the SDK job (`obs_jobs.sdk_job_id`) only runs
// the ticks. A tick reads obs_jobs and the slice pause BEFORE EVERY pull, so a paused, cancelled or failed job never pulls again.
//
//  live      forward from the anchor captured at source_add; per tick it pulls pages until Connect says `exhausted`, then waits
//            the source's live interval. After `cursor_invalid` it restarts from a FRESH anchor (job_control), never from
//            Connect's start: that would import what came before the source
//  backfill  history false: forward from Connect's start (what Connect kept), `since` .. `until` (= the anchor time at
//            backfill_start + 5 min); history true: backward from Connect's newest row down to `since`, with the same end.
//            Ends when exhausted or at `maxMessages` stored messages
//
// EVERY write of a tick goes through `ctx.checkpoint` (fenced by the SDK lease): a run that lost its lease (taken over, paused,
// cancelled, timed out) writes nothing at all, not even a failure count. ONE PAGE = ONE TRANSACTION (L31): every storeMessage of
// the page (each its own savepoint), the new cursor, the counts and the job's next state (running / waiting / done) are one
// checkpoint, together with windows → records → classify → route of the page's messages (records.ts, pipeline.ts, nested as
// savepoints). A crash or a failure anywhere in it keeps nothing of the page: the next run re-reads it (UNIQUE (source,
// conversation, provider_msg_id) stops a double, the unchanged cursor stops a gap), and a failure that repeats counts to 5.
//
// Waits are not failures: Connect's `retryAfterS` (honoured exactly), the bridge's `rate_limited` and Observer's own call budget
// (wait + backoff), a read Connect holds for the owner (re-checked every 15 min, never failed by holds alone), the slice pause.
// Other failures back off exponentially with jitter (15 s base, 15 min cap); 5 consecutive failures → `failed` and the app's
// attention (`jobs_failed`). Refusals that cannot get better (caller_unverified, not_found, scope_denied, cursor_invalid, a 4xx
// about the input such as since_invalid) fail the job at once with a plain sentence: no retry storm. An unexpected error of the
// tick itself counts as a failure the same way (runGuarded). A tick stops paging after TICK_BUDGET_MS, far below the SDK's
// 10 minute tick timeout. Budget: at most 100 Connect calls a minute (src/budget.ts); a history read stops at `maxMessages`.
import type { Db, Job, JobContext, JobOutcome, JobSpec, JobsApi, Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { CallBudget, sharedBudget } from "./budget.ts";
import { now as clockNow } from "./clock.ts";
import { type ConnectPort, connectPort, isPermanent, type PullQuery, plainError } from "./connect.ts";
import { toIncoming } from "./contract.ts";
import { storeMessage } from "./ingest.ts";
import { applyRouting } from "./pipeline.ts";
import { attachWindow } from "./records.ts";
import { jobRow, type Row, recordRow, sourceRow } from "./store.ts";
import { backfillWindows, liveWindows, type WindowMessage } from "./window.ts";

export { CALLS_PER_MINUTE, LIVE_RESERVE } from "./budget.ts";
export { CallBudget, sharedBudget };
export const LIVE_KIND = "obs.live";
export const BACKFILL_KIND = "obs.backfill";
export const MAX_FAILURES = 5;
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
/** a read Connect holds for the owner is looked at again after this long */
export const HELD_RECHECK_MS = BACKOFF_CAP_MS;
/** the bridge's rate limit gives no time: wait at least this long */
export const RATE_LIMIT_MIN_MS = 60_000;
/** while the slice pauses the app: look again after this long (no pull meanwhile) */
export const PAUSE_RECHECK_MS = 30_000;
export const PAGE_LIMIT = 200;
/** pages in one tick before the tick hands back (other jobs get a turn) */
export const PAGES_PER_TICK = 25;
/** a tick stops paging after this long; the SDK aborts a tick at 10 minutes */
export const TICK_BUDGET_MS = 2 * 60_000;

const ACTIVE = new Set(["queued", "running", "waiting"]);
const SDK_ACTIVE = new Set(["queued", "running", "waiting"]);
const SDK_TERMINAL = new Set(["done", "failed", "cancelled", "refused"]);
const str = (v: unknown): string => String(v);

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
  random?: () => number;
  /** rows per data_pull (default 200, Connect's maximum) */
  pageLimit?: number;
  statusChanged?(): void;
}

const again = (afterMs: number): JobOutcome => ({ status: "again", afterMs: Math.max(0, Math.round(afterMs)) });
const DONE: JobOutcome = { status: "done" };
const cursorOf = (job: Row): string | null => (job.cursor === null || job.cursor === undefined ? null : str(job.cursor));

/**
 * The one way a tick writes: inside the lease-fenced checkpoint (the job's state there is its cursor), and only while the job is
 * still active (an owner pause or cancel in between wins). A lost lease throws job_lease_lost and NOTHING is written; an aborted
 * run writes nothing either.
 */
function guarded<T>(d: TickDeps, job: Row, write: (db: Db) => T): T | null {
  if (d.signal?.aborted) return null;
  return d.checkpoint({ cursor: cursorOf(job) } as Json, write);
}
function setState(d: TickDeps, job: Row, sql: string, args: unknown[], at: number): boolean {
  return (
    guarded(d, job, (db) => db.prepare(`UPDATE obs_jobs SET ${sql}, updated_at = ? WHERE id = ? AND state IN ('queued', 'running', 'waiting')`).run(...args, at, str(job.id)).changes > 0) ===
    true
  );
}

function query(job: Row, src: Row, limit = PAGE_LIMIT): PullQuery {
  const backfill = job.kind === "backfill";
  const backward = backfill && Number(src.history_capable) === 1;
  return {
    account: str(src.account),
    direction: backward ? "backward" : "forward",
    cursor: cursorOf(job),
    ...(backfill ? { since: job.since_at === null ? null : Number(job.since_at), until: job.until_at === null ? null : Number(job.until_at) } : {}),
    limit,
    lane: backfill ? "backfill" : "live",
  };
}

/** A failed pull, page or tick: a wait, a failure that counts, or a refusal that fails the job at once. */
export function fail(d: TickDeps, job: Row, e: unknown, at: number): JobOutcome {
  const code = e instanceof TbError ? e.code : "error";
  if (code === "job_lease_lost") throw e;
  if (d.signal?.aborted) return again(0); // the SDK gives this run back; nothing is written
  // the slice paused the app between our check and the call: not a failure
  if (code === "paused") return again(PAUSE_RECHECK_MS);
  const failures = Number(job.consecutive_failures);
  const waitWithout = (ms: number, message: string | null): JobOutcome => {
    setState(d, job, `state = 'waiting', retry_at = ?${message === null ? "" : ", last_error = ?, error_code = ?"}`, message === null ? [at + ms] : [at + ms, message, code.slice(0, 64)], at);
    d.statusChanged?.();
    return again(ms);
  };
  // waits that are not failures: the count does not move
  if (code === "call_budget") return again(Number((e as TbError).details?.retryAfterMs ?? 1000));
  if (code === "rate_limited") return waitWithout(Math.max(RATE_LIMIT_MIN_MS, backoffMs(failures + 1, d.random)), plainError(code));
  if (code === "connect_held") return waitWithout(HELD_RECHECK_MS, plainError(code));
  const next = failures + 1;
  const message = plainError(code);
  if (isPermanent(e) || next >= MAX_FAILURES) {
    setState(d, job, "state = 'failed', consecutive_failures = ?, last_error = ?, error_code = ?, retry_at = NULL", [next, message, code.slice(0, 64)], at);
    d.statusChanged?.();
    return DONE;
  }
  const wait = backoffMs(next, d.random);
  setState(d, job, "state = 'waiting', consecutive_failures = ?, last_error = ?, error_code = ?, retry_at = ?", [next, message, code.slice(0, 64), at + wait], at);
  d.statusChanged?.();
  return again(wait);
}

/** Write one page: every message, its windows and records, the cursor, the counts and the job's next state, in the ONE
 *  checkpoint transaction. */
function commitPage(d: TickDeps, job: Row, rows: ReturnType<typeof toIncoming>[], skipped: number, nextCursor: string | null, next: { state: "running" | "waiting" | "done"; retryAt: number | null }, at: number): number {
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
           last_error = NULL, error_code = NULL, retry_at = ?, state = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'running', 'waiting')`,
      )
      .run(nextCursor, stored, skipped, at, next.retryAt, next.state, at, id).changes;
    // paused or cancelled while the page was on its way: nothing of it is kept, the cursor stays (the next run re-reads it)
    if (ok === 0) throw new TbError("job_not_active", "the job was stopped while the page was read", 409);
    const created = windowSource(db, source, job.kind === "backfill" ? "backfill" : "live", at);
    if (created > 0) db.prepare("UPDATE obs_jobs SET record_count = record_count + ? WHERE id = ?").run(created, id);
    return stored;
  });
}

/**
 * Windows → records → classify → route for the messages a source has not given a record yet (live: also the messages of its
 * open records, so a live window grows until it closes). Closed windows are routed through the pipeline. Returns the number of
 * new records. It runs inside the page's checkpoint (attachWindow and applyRouting nest as savepoints).
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
  const started = clockNow();
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
    if (pages >= PAGES_PER_TICK || t - started >= TICK_BUDGET_MS) return again(0);
    if (kind === "backfill" && job.max_messages !== null && Number(job.read_count) >= Number(job.max_messages)) {
      setState(d, job, "state = 'done', retry_at = NULL", [], t);
      d.statusChanged?.();
      return DONE;
    }
    if (!d.port) return fail(d, job, new TbError("connect_unavailable", "Connect is not reachable", 409), t);
    if (str(job.state) !== "running") setState(d, job, "state = 'running'", [], t);
    const q = query(job, src, d.pageLimit);
    let page: Awaited<ReturnType<ConnectPort["pull"]>>;
    try {
      page = await d.port.pull(q);
    } catch (e) {
      return fail(d, jobRow(d.db, jobId) ?? job, e, clockNow());
    }
    const at = clockNow();
    const fresh = jobRow(d.db, jobId);
    if (!fresh || !ACTIVE.has(str(fresh.state))) return DONE; // stopped while the page was on its way: it is not stored
    if (page.retryAfterS !== null) {
      const ms = page.retryAfterS * 1000;
      setState(d, fresh, "state = 'waiting', retry_at = ?", [at + ms], at);
      d.statusChanged?.();
      return again(ms);
    }
    // a forward page keeps its cursor when exhausted (poll from it); a backward one ends with null
    const nextCursor = page.nextCursor ?? (q.direction === "forward" ? cursorOf(job) : null);
    const finished = page.exhausted || (kind === "backfill" && page.nextCursor === null);
    const interval = Number(src.live_interval_s) * 1000;
    // the job's next state is part of the page's transaction (the last page of a history read writes `done` with it)
    const next = !finished ? { state: "running" as const, retryAt: null } : kind === "backfill" ? { state: "done" as const, retryAt: null } : { state: "waiting" as const, retryAt: at + interval };
    try {
      commitPage(d, fresh, page.rows.map(toIncoming), page.invalid + page.quarantined, nextCursor, next, at);
    } catch (e) {
      // nothing of the page was kept (one transaction); a lost lease is the SDK's (fail rethrows it), a stopped job just ends
      if (e instanceof TbError && e.code === "job_not_active") return DONE;
      return fail(d, fresh, e, at);
    }
    d.statusChanged?.();
    if (finished) return kind === "backfill" ? DONE : again(interval);
  }
}

/** runTick, and an unexpected error of the tick itself counts as a failure (towards the 5, with a plain sentence) and waits. */
export async function runGuarded(jobId: string, d: TickDeps): Promise<JobOutcome> {
  try {
    return await runTick(jobId, d);
  } catch (e) {
    if (e instanceof TbError && e.code === "job_lease_lost") throw e;
    const job = jobRow(d.db, jobId);
    if (!job || !ACTIVE.has(str(job.state))) return DONE;
    try {
      return fail(d, job, e, clockNow());
    } catch (inner) {
      if (inner instanceof TbError && inner.code === "job_lease_lost") throw inner;
      return again(backoffMs(Number(job.consecutive_failures) + 1, d.random));
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
    return runGuarded(id, {
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
