// The HMAC key for message digests (obs_messages.text_digest). It lives in the app secrets (sealed under TB_KEK), never in the
// database. States, set once per start:
//   ok           the key is available
//   unavailable  the secret store failed at start (error, no ctx.secrets): attention digest_key_unavailable
//   lost         obs_settings says a key was created, but the secret store has none (a restore under another KEK): a NEW key is
//                never made (old digests would stop matching and dedupe would break); attention digest_key_lost. The owner acts.
//   unset        onStart has not run
// While the state is not ok, digestOf() throws, so S2's ingestion cannot store a message without a proper digest.
import { randomBytes } from "node:crypto";
import type { Db, Logger } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { getSetting, putSetting, textDigest } from "./store.ts";

export const DIGEST_KEY_NAME = "obs_digest_key";
export const DIGEST_CREATED_SETTING = "digest_key_created";
export type DigestState = "ok" | "unavailable" | "lost" | "unset";

let state: DigestState = "unset";
let key: string | null = null;

export function digestState(): DigestState {
  return state;
}

export interface DigestStart {
  db: Db;
  secrets?: { get(name: string): Promise<string | null>; put(name: string, value: string): Promise<void> };
  log?: Logger;
  statusChanged?: () => void;
}
/** Never throws: a failure here must not stop the app from starting (rule 0 is already in place). */
export async function setupDigestKey(ctx: DigestStart, now: number): Promise<DigestState> {
  state = "unavailable";
  key = null;
  try {
    const secrets = ctx.secrets;
    if (!secrets) throw new Error("no secret store");
    const existing = await secrets.get(DIGEST_KEY_NAME);
    const created = getSetting(ctx.db, DIGEST_CREATED_SETTING);
    if (existing) {
      key = existing;
      state = "ok";
      if (created === null) putSetting(ctx.db, DIGEST_CREATED_SETTING, new Date(now).toISOString());
    } else if (created !== null) {
      state = "lost";
      ctx.log?.error("the digest key was created on this install but the secret store has none (restored under another key?); no new key is made", { createdAt: created });
    } else {
      const fresh = randomBytes(32).toString("base64");
      await secrets.put(DIGEST_KEY_NAME, fresh);
      putSetting(ctx.db, DIGEST_CREATED_SETTING, new Date(now).toISOString());
      key = fresh;
      state = "ok";
    }
  } catch (e) {
    key = null;
    state = "unavailable";
    ctx.log?.error("the digest key is unavailable", { error: e instanceof Error ? e.message : String(e) });
  }
  if (state !== "ok") ctx.statusChanged?.();
  return state;
}

/** The digest S2's ingestion stores for a message text. Throws unless the key is available: never an unkeyed hash. */
export function digestOf(text: string): string {
  if (state !== "ok" || !key) {
    const code = state === "lost" ? "digest_key_lost" : state === "unavailable" ? "digest_key_unavailable" : "digest_key_missing";
    throw new TbError(code, "message digests are not available; new messages are not stored", 503);
  }
  return textDigest(key, text);
}

/** App attention for the owner (shown on the app card). */
export function digestAttention(): { code: string; reason: string } | null {
  if (state === "lost") return { code: "digest_key_lost", reason: "The key for message digests is gone from the secret store. New messages are not stored until you act." };
  if (state === "unavailable") return { code: "digest_key_unavailable", reason: "The secret store could not give Observer its digest key. New messages are not stored." };
  return null;
}
