// Windowing (DESIGN §4.3 step 2): messages group into records per thread. Pure functions with an injected clock.
//   live      : a window closes after 30 minutes without a message, or 24 hours after its first message
//   backfill  : windows close by a count / character budget (the v1 chunker); all backfill windows are closed
// Messages without a thread form one stream per conversation and are split by the same quiet gap.
export const LIVE_QUIET_MS = 30 * 60_000;
export const LIVE_MAX_MS = 24 * 3_600_000;
export const BACKFILL_MAX_MESSAGES = 50;
export const BACKFILL_MAX_CHARS = 8_000;

export interface WindowMessage {
  id: string;
  conversation: string;
  thread: string | null;
  sentAt: number;
  /** characters of text (the budget counts them) */
  chars: number;
}
export interface MessageWindow {
  /** stable: conversation, thread and the id of the first message (the same messages always give the same key) */
  key: string;
  conversation: string;
  thread: string | null;
  start: number;
  end: number;
  messageIds: string[];
  chars: number;
  closed: boolean;
}

function streams(messages: readonly WindowMessage[]): WindowMessage[][] {
  const by = new Map<string, WindowMessage[]>();
  for (const m of messages) {
    const k = `${m.conversation}\u0000${m.thread ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  return [...by.values()].map((s) => s.sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : 1))).sort((a, b) => (a[0] as WindowMessage).sentAt - (b[0] as WindowMessage).sentAt);
}
const open = (m: WindowMessage): MessageWindow => ({
  key: `${m.conversation}|${m.thread ?? ""}|${m.id}`,
  conversation: m.conversation,
  thread: m.thread,
  start: m.sentAt,
  end: m.sentAt,
  messageIds: [m.id],
  chars: m.chars,
  closed: false,
});
const add = (w: MessageWindow, m: WindowMessage): void => {
  w.messageIds.push(m.id);
  w.end = m.sentAt;
  w.chars += m.chars;
};

export interface LiveOptions {
  quietMs?: number;
  maxMs?: number;
}
/** Live windows as of `now`: a window is closed when it has been quiet for `quietMs`, or is `maxMs` old; a message that would
 *  stretch a window past `maxMs` or follows a quiet gap starts the next one. */
export function liveWindows(messages: readonly WindowMessage[], now: number, opts: LiveOptions = {}): MessageWindow[] {
  const quiet = opts.quietMs ?? LIVE_QUIET_MS;
  const max = opts.maxMs ?? LIVE_MAX_MS;
  const out: MessageWindow[] = [];
  for (const stream of streams(messages)) {
    let cur: MessageWindow | null = null;
    for (const m of stream) {
      if (cur && m.sentAt - cur.end < quiet && m.sentAt - cur.start < max) add(cur, m);
      else {
        cur = open(m);
        out.push(cur);
      }
    }
  }
  for (const w of out) w.closed = now - w.end >= quiet || now - w.start >= max;
  return out;
}

export interface BackfillOptions {
  maxMessages?: number;
  maxChars?: number;
  /** a gap longer than this splits a stream with no thread (default: the live quiet time) */
  quietMs?: number;
}
/** Backfill windows: per thread, closed when the next message would exceed the count or character budget. A single message
 *  larger than the budget is a window of its own. Thread-less streams are also split by the quiet gap. */
export function backfillWindows(messages: readonly WindowMessage[], opts: BackfillOptions = {}): MessageWindow[] {
  const maxMessages = opts.maxMessages ?? BACKFILL_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? BACKFILL_MAX_CHARS;
  const quiet = opts.quietMs ?? LIVE_QUIET_MS;
  const out: MessageWindow[] = [];
  for (const stream of streams(messages)) {
    let cur: MessageWindow | null = null;
    for (const m of stream) {
      const gap = m.thread === null && cur !== null && m.sentAt - cur.end >= quiet;
      if (cur && !gap && cur.messageIds.length < maxMessages && cur.chars + m.chars <= maxChars) add(cur, m);
      else {
        cur = open(m);
        out.push(cur);
      }
    }
  }
  for (const w of out) w.closed = true;
  return out;
}
