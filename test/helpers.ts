// Test helpers: a migrated node:sqlite database shaped like the SDK `Db`, and a handler context with a fake caller.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db, Job, JobsApi, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { definition } from "../src/app.ts";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      // nested = a savepoint, like the SDK's tx(): an inner failure rolls back only the inner part
      if (depth > 0) {
        const sp = `tsp${depth}`;
        raw.exec(`SAVEPOINT ${sp}`);
        depth++;
        try {
          const out = fn();
          raw.exec(`RELEASE ${sp}`);
          return out;
        } catch (e) {
          raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        } finally {
          depth--;
        }
      }
      depth++;
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return db as unknown as Db;
}

export interface FakeCaller {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
  /** the VERIFIED product of an app caller (SDK 0.1.27); absent = an app the slice does not name */
  product?: string;
}
export const AGENT_A: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout" };
export const AGENT_B: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000B", name: "Clerk" };
export const OWNER: FakeCaller = { type: "person", id: "per_01J00000000000000000000000", name: "Owner" };

export interface Fake {
  ctx: OpContext;
  changed(): number;
}
/** A handler context. `targets` = what ctx.companionTargets() answers (omit: the SDK is too old to have it); `callApp` = the
 *  companion call (the fake Connect); `jobs` = the SDK jobs API (FakeJobs). */
export function ctxFor(
  db: Db,
  caller: FakeCaller,
  opts: { context?: Record<string, unknown>; targets?: string[]; callApp?: OpContext["callApp"] | ((p: string, op: string, input: Json) => Promise<unknown>); jobs?: FakeJobs } = {},
): OpContext & { statusChanges: number } {
  const state = { statusChanges: 0 };
  const ctx: Record<string, unknown> = {
    db,
    caller: { ...caller, mode: caller.type === "agent" ? "free" : null },
    context: opts.context ?? {},
    receipt: { summary() {}, meta() {} },
    statusChanged: () => {
      state.statusChanges++;
    },
    get statusChanges() {
      return state.statusChanges;
    },
  };
  if (opts.targets) ctx.companionTargets = () => opts.targets;
  if (opts.callApp) ctx.callApp = opts.callApp;
  if (opts.jobs) ctx.jobs = opts.jobs;
  return ctx as unknown as OpContext & { statusChanges: number };
}

/** Fake app secrets (the SDK seals them under TB_KEK; here a Map). */
export function fakeSecrets(): { get(n: string): Promise<string | null>; put(n: string, v: string): Promise<void>; delete(n: string): Promise<void>; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (n) => store.get(n) ?? null,
    put: async (n, v) => {
      store.set(n, v);
    },
    delete: async (n) => {
      store.delete(n);
    },
  };
}
/** Run the app's onStart on a test database (rule 0, digest key). */
export async function start(db: Db, secrets = fakeSecrets()): Promise<ReturnType<typeof fakeSecrets>> {
  await definition.onStart?.({ db, secrets } as never);
  return secrets;
}

/** The SDK jobs API as Observer uses it (enqueue, get, pause, resume, cancel), in memory, with a log of the calls. */
export class FakeJobs {
  readonly jobs = new Map<string, Job>();
  readonly log: string[] = [];
  #n = 0;
  enqueue(kind: string, input: Json = null): Job {
    this.#n += 1;
    const id = `sdkjob${this.#n}`;
    const job = { id, kind, key: null, input, state: null, status: "queued", op: null, caller: null, runAt: 0, cron: null, attempts: 0, maxAttempts: 5, lastError: null, result: null, holdId: null, pausedBy: null, runs: 0, createdAt: 0, updatedAt: 0, finishedAt: null } as Job;
    this.jobs.set(id, job);
    this.log.push(`enqueue ${kind} ${JSON.stringify(input)}`);
    return job;
  }
  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }
  #set(id: string, verb: string, status: Job["status"], from: Job["status"][]): Job {
    const j = this.jobs.get(id);
    if (!j || !from.includes(j.status)) throw new TbError("job_state", `cannot ${verb}`, 409);
    j.status = status;
    this.log.push(`${verb} ${id}`);
    return j;
  }
  pause(id: string): Job {
    return this.#set(id, "pause", "paused", ["queued", "waiting", "running"]);
  }
  resume(id: string): Job {
    return this.#set(id, "resume", "queued", ["paused", "failed"]);
  }
  cancel(id: string): Job {
    return this.#set(id, "cancel", "cancelled", ["queued", "waiting", "running", "paused", "failed"]);
  }
  list(): Job[] {
    return [...this.jobs.values()];
  }
  pauseAll(): void {}
  resumeAll(): void {}
  appPaused(): boolean {
    return false;
  }
  get api(): JobsApi {
    return this as unknown as JobsApi;
  }
}
