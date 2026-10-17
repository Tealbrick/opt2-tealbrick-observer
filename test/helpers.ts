// Test helpers: a migrated node:sqlite database shaped like the SDK `Db`, and a handler context with a fake caller.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
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
      if (depth > 0) return fn();
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
}
export const AGENT_A: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout" };
export const AGENT_B: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000B", name: "Clerk" };
export const OWNER: FakeCaller = { type: "person", id: "per_01J00000000000000000000000", name: "Owner" };

export interface Fake {
  ctx: OpContext;
  changed(): number;
}
/** A handler context. `targets` = what ctx.companionTargets() answers (omit: the SDK is too old to have it). */
export function ctxFor(db: Db, caller: FakeCaller, opts: { context?: Record<string, unknown>; targets?: string[] } = {}): OpContext & { statusChanges: number } {
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
