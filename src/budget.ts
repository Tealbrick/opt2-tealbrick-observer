// The app-initiated call budget (DESIGN §4.5): the bridge allows 120 app-initiated calls a minute per instance; Observer keeps
// itself to 100 across EVERY Connect call it makes (job pulls and the owner's op handlers alike), 25 of them kept for the
// "live" lane (live pulls and the owner's clicks), so a long history read can never starve them.
export const CALLS_PER_MINUTE = 100;
export const LIVE_RESERVE = 25;
export type Lane = "live" | "backfill";

/** Sliding one-minute window of calls, shared by the whole process. */
export class CallBudget {
  #at: number[] = [];
  readonly perMinute: number;
  readonly liveReserve: number;
  constructor(perMinute = CALLS_PER_MINUTE, liveReserve = LIVE_RESERVE) {
    this.perMinute = perMinute;
    this.liveReserve = liveReserve;
  }
  /** 0: go (the call is counted); otherwise how many ms to wait. */
  take(lane: Lane, now: number): number {
    while (this.#at.length > 0 && (this.#at[0] as number) <= now - 60_000) this.#at.shift();
    const limit = lane === "live" ? this.perMinute : this.perMinute - this.liveReserve;
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
