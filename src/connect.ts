// Connect access (DESIGN §4.4). Observer has no credentials: it reads sources through Connect's app-only data ops
// (data_accounts_list, data_catalog, data_pull). Those ops do not exist yet (spec request R3), and the manifest has no Connect
// companion yet, so in S1 every Connect-dependent op answers `connect_unavailable`.
//
// The seam for S2 is `connectPort(ctx)`: it returns null while Connect cannot be used, and a ConnectPort once it can. The
// handlers (sources_available, source_add, backfill_estimate, backfill_start) already work against the port.
import type { AppDefinition, CompanionTargetsView, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { CONNECT_PRODUCT, connectCompanionProblems } from "./guards.ts";
import { manifest } from "./manifest.ts";

export const CONNECT_UNAVAILABLE_MESSAGE = "Observer needs Connect with shared read access (data_pull). Connect does not offer it yet.";

export interface ConnectConversation {
  id: string;
  title: string;
  /** estimated message count, null when Connect cannot tell */
  estimate: number | null;
}
export interface ConnectAccount {
  id: string;
  kind: string;
  label: string;
  /** Telegram bots cannot read history: false */
  historyCapable: boolean;
  conversations: ConnectConversation[];
}
export interface ConnectEstimate {
  messages: number;
  records: number;
  durationS: number;
  providerNote: string | null;
}
export interface ConnectPort {
  /** accounts shared with Observer (read only) and their conversations */
  accounts(): Promise<ConnectAccount[]>;
  estimate(q: { account: string; conversations: string[]; since: number; until: number | null }): Promise<ConnectEstimate>;
}

type Factory = (ctx: OpContext, m: AppDefinition["manifest"]) => ConnectPort | null;

/** Product ids the slice lets this app call (SDK 0.1.14+; [] when the SDK or the slice does not say). */
export function companionTargets(ctx: OpContext): string[] {
  const fn = (ctx as Partial<CompanionTargetsView>).companionTargets;
  return typeof fn === "function" ? fn.call(ctx) : [];
}

/** True when the manifest declares a sane Connect companion AND the slice lets the app call Connect. Both must hold. */
export function connectReachable(ctx: OpContext, m: AppDefinition["manifest"] = manifest): boolean {
  const declared = (m.companions ?? []).some((c) => c.product === CONNECT_PRODUCT);
  return declared && connectCompanionProblems(m).length === 0 && companionTargets(ctx).includes(CONNECT_PRODUCT);
}

const realFactory: Factory = (ctx, m) => {
  if (!connectReachable(ctx, m)) return null;
  // TODO(S2): build the port over ctx.callApp("connect", "data_accounts_list" | "data_catalog", …) once Connect ships the
  // data_* ops (R3) and the manifest declares the Connect companion. Until then there is nothing to call.
  return null;
};

let factory: Factory = realFactory;
/** Tests install a fake Connect (built from Connect's kit types in S2, L1); `null` restores the real one. */
export function setConnectFactory(fn: Factory | null): void {
  factory = fn ?? realFactory;
}

export function connectPort(ctx: OpContext): ConnectPort | null {
  return factory(ctx, manifest);
}

/** The port, or the clear refusal. */
export function requireConnect(ctx: OpContext): ConnectPort {
  const port = connectPort(ctx);
  if (!port) throw new TbError("connect_unavailable", CONNECT_UNAVAILABLE_MESSAGE, 409);
  return port;
}
