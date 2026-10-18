// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots the app with
// the env the suite gives it (fake bridge, enrolment code, TB_KEK, data dir) and drives it like the bridge does. The SDK
// listens on the free port the suite chose (TBCONF_PORT, conformance ≥ 0.1.13; else manifest `runtime.port`, SDK-API §13),
// so two runs on one machine never clash; `backupNow` lets the suite run the backup/restore round-trip (A7).
// Test roots (C63; the suite default since spec 0.1.12, `--test-roots` kept for older suites): the suite passes TEST
// Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS; only this harness reads it and hands them to startApp. Required: the SDK
// refuses every slice whose key-set statement is not signed by a root it pins. Production never reads that variable.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { startApp } from "@opt2-tealbrick/miniapp-sdk";
import { app, manifest } from "./src/app.ts";
import { seedConformance } from "./test/seed.ts";

// The harness has no Connect to read a source from, and no op can create a delivered record yet (S4), so the harness writes the
// fixtures the agent ops need into the migrated database after boot (a second connection; same file the SDK opened). The ids
// are named in tealbrick-conformance.json.
function seedFixtures(dataDir: string): void {
  const raw = new DatabaseSync(join(dataDir, "app.db"));
  try {
    raw.exec("PRAGMA busy_timeout = 5000");
    seedConformance({ exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql), transaction: <T>(fn: () => T) => fn() } as unknown as Db);
  } finally {
    raw.close();
  }
}

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const harness = {
    ...(env.TBCONF_PORTAL_ROOT_KEYS ? { portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } : {}),
    port: env.TBCONF_PORT ? Number(env.TBCONF_PORT) : manifest.runtime.port,
  } as Parameters<typeof startApp>[2];
  const running = await startApp(app, env, harness);
  seedFixtures(env.TB_DATA_DIR ?? "");
  return {
    url: `http://127.0.0.1:${running.port}`,
    stop: () => running.stop(),
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
