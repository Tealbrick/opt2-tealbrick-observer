// Windowing: live windows close after 30 min quiet or 24 h; backfill windows close by a count / character budget.
// Pure functions: the clock is an argument.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKFILL_MAX_CHARS, BACKFILL_MAX_MESSAGES, backfillWindows, LIVE_MAX_MS, LIVE_QUIET_MS, liveWindows, type WindowMessage } from "../src/window.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 8, 0, 0);
let n = 0;
const msg = (atMin: number, extra: Partial<WindowMessage> = {}): WindowMessage => ({ id: `m${++n}`, conversation: "inbox", thread: "t1", sentAt: T0 + atMin * MIN, chars: 10, ...extra });
const ids = (w: { messageIds: string[] }[]) => w.map((x) => x.messageIds);

describe("live windows", () => {
  it("messages less than 30 minutes apart are one window; it is open while the last message is younger than 30 minutes", () => {
    const [a, b, c] = [msg(0), msg(10), msg(39)];
    const w = liveWindows([a, b, c], T0 + 60 * MIN);
    assert.deepEqual(ids(w), [[a.id, b.id, c.id]]);
    assert.equal(liveWindows([a, b, c], T0 + 39 * MIN + LIVE_QUIET_MS - 1)[0]?.closed, false, "one millisecond short of 30 minutes: open");
    assert.equal(liveWindows([a, b, c], T0 + 39 * MIN + LIVE_QUIET_MS)[0]?.closed, true, "30 minutes quiet: closed");
  });
  it("a gap of 30 minutes or more starts the next window; 29:59 does not", () => {
    const a = msg(0);
    const justUnder: WindowMessage = { ...msg(0), sentAt: T0 + LIVE_QUIET_MS - 1 };
    const exactly: WindowMessage = { ...msg(0), sentAt: T0 + LIVE_QUIET_MS };
    assert.equal(liveWindows([a, justUnder], T0 + 5 * 3_600_000).length, 1);
    assert.equal(liveWindows([a, exactly], T0 + 5 * 3_600_000).length, 2);
  });
  it("a window closes 24 hours after its first message even if people keep talking, and the next message opens a new one", () => {
    const talk = Array.from({ length: 24 * 12 + 2 }, (_, i) => msg(i * 5)); // every 5 minutes for a day and 5 minutes
    const now = T0 + 24 * 3_600_000 + 6 * MIN;
    const w = liveWindows(talk, now);
    assert.equal(w.length, 2);
    assert.equal(w[0]?.messageIds.length, 24 * 12, "first message to 23:55 later");
    assert.deepEqual([w[0]?.closed, w[1]?.closed], [true, false]);
    assert.equal(w[0] && w[0].end - w[0].start < LIVE_MAX_MS, true);
    // right at the 24 h mark the window is closed although the last message is only 5 minutes old
    assert.equal(liveWindows(talk.slice(0, 24 * 12), T0 + LIVE_MAX_MS)[0]?.closed, true);
    assert.equal(liveWindows(talk.slice(0, 24 * 12), T0 + LIVE_MAX_MS - 1)[0]?.closed, false);
  });
  it("threads and conversations are separate streams; messages without a thread form one stream per conversation", () => {
    const a = msg(0, { thread: "t1" });
    const b = msg(1, { thread: "t2" });
    const c = msg(2, { thread: "t1", conversation: "other" });
    const d = msg(3, { thread: null });
    const e = msg(4, { thread: null });
    const w = liveWindows([a, b, c, d, e], T0 + 3_600_000);
    assert.equal(w.length, 4);
    assert.deepEqual(ids(w).sort(), [[a.id], [b.id], [c.id], [d.id, e.id]].sort());
  });
  it("order of the input does not matter; keys are stable and name the first message; chars add up", () => {
    const a = msg(0, { chars: 5 });
    const b = msg(5, { chars: 7 });
    const x = liveWindows([a, b], T0 + 3_600_000);
    const y = liveWindows([b, a], T0 + 3_600_000);
    assert.deepEqual(x, y);
    assert.equal(x[0]?.key, `inbox|t1|${a.id}`);
    assert.equal(x[0]?.chars, 12);
    assert.deepEqual([x[0]?.start, x[0]?.end], [a.sentAt, b.sentAt]);
    assert.deepEqual(liveWindows([], T0), []);
  });
});

describe("backfill windows", () => {
  const many = (count: number, extra: Partial<WindowMessage> = {}) => Array.from({ length: count }, (_, i) => msg(i, extra));
  it("close by message count: 50 per window, all closed", () => {
    const w = backfillWindows(many(BACKFILL_MAX_MESSAGES * 2 + 3));
    assert.deepEqual(w.map((x) => x.messageIds.length), [50, 50, 3]);
    assert.ok(w.every((x) => x.closed));
  });
  it("close by character budget; a message bigger than the budget is a window of its own", () => {
    const w = backfillWindows([msg(0, { chars: 5000 }), msg(1, { chars: 3000 }), msg(2, { chars: 1 }), msg(3, { chars: BACKFILL_MAX_CHARS + 1 }), msg(4, { chars: 10 })]);
    assert.deepEqual(w.map((x) => [x.messageIds.length, x.chars]), [[2, 8000], [1, 1], [1, BACKFILL_MAX_CHARS + 1], [1, 10]]);
  });
  it("budgets can be set; threads stay separate; a thread-less stream is also cut by a quiet gap", () => {
    assert.equal(backfillWindows(many(10), { maxMessages: 3 }).length, 4);
    assert.equal(backfillWindows([...many(3, { thread: "a" }), ...many(3, { thread: "b" })]).length, 2);
    const gap = backfillWindows([msg(0, { thread: null }), msg(1, { thread: null }), msg(500, { thread: null })]);
    assert.deepEqual(gap.map((x) => x.messageIds.length), [2, 1]);
    const threaded = backfillWindows([msg(0), msg(1), msg(500)]);
    assert.deepEqual(threaded.map((x) => x.messageIds.length), [3], "a thread is one conversation however long the pauses");
  });
});
