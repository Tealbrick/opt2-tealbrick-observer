// Shared harness of the owner-UI tests (test/ui-*.test.ts): a happy-dom page, a stub server for the app's person ops under
// /a/observer/tb/v1/, and the helpers to mount a page, click, and read what was called. The UI is compiled with the build tsconfig
// (JSX needs a compile) into dist/ui-test-<name> and imported from there; the compiled output is removed after the run.
// Every call the stub sees is recorded with the CSRF header and the idempotency key, so each test can check both.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));

// ── DOM ────────────────────────────────────────────────────────────────────
export const win = new Window({ url: "http://localhost/a/observer/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "File"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
for (const k of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[k] = (win as unknown as Record<string, (...a: unknown[]) => unknown>)[k]?.bind(win);
g.IS_REACT_ACT_ENVIRONMENT = true;
// reduced motion: a StepFlow changes step at once instead of after its fade
g.matchMedia = (q: string) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
// src/ui/index.html has <base href="/a/observer/">; the router reads paths relative to it
const base = win.document.createElement("base");
base.setAttribute("href", "/a/observer/");
win.document.head.appendChild(base);

// ── fixtures ───────────────────────────────────────────────────────────────
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
export const ALL_TARGETS = ["connect", "knowledge", "kanban", "inbox"];
export const RULE_ZERO = "rul_00000000000000000000000000";

export const SRC_GMAIL = { id: "src_gmail", label: "Work inbox", kind: "gmail", account: "acc_gmail", conversations: ["clients", "suppliers"], live: { state: "running", lastReadAt: null, nextAt: null }, history: { state: "running", done: 18240, total: 50000, since: "2026-01-01T00:00:00.000Z" }, historyCapable: true, keptDays: null };
export const SRC_TG = { id: "src_tg", label: "Clinic partners", kind: "telegram", account: "acc_tg", conversations: ["group"], live: { state: "waiting", lastReadAt: null, nextAt: iso(NOW + 40_000) }, history: { state: "none", done: 0, total: null, since: null }, historyCapable: false, keptDays: 30 };
export const SRC_NEW = { id: "src_new", label: "Team updates", kind: "buzz", account: "acc_buzz", conversations: ["updates"], live: { state: "paused", lastReadAt: null, nextAt: null }, history: { state: "none", done: 0, total: null, since: null }, historyCapable: true, keptDays: null };
const job = (id: string, source: string, kind: "live" | "backfill", state: string, extra: Record<string, unknown> = {}) => ({ id, source, kind, state, counts: { read: 0, records: 0, failures: 0, skipped: 0 }, lastError: null, retryAt: null, note: null, ...extra });
export const JOBS = [job("job_gmail_live", "src_gmail", "live", "running"), job("job_gmail_hist", "src_gmail", "backfill", "running"), job("job_tg_live", "src_tg", "live", "waiting", { retryAt: iso(NOW + 40_000) }), job("job_new_live", "src_new", "live", "paused")];

/** A string that LOOKS like a key. Built at run time: no secret-shaped literal sits in this file. */
export const looksLikeKey = (): string => ["Zq8", "Lm4Vx7", "Rt1Yb6", "Wp2KhN9"].join("");

const msgText = "Hello, the invoice 2026-114 went to the old account. Please use CZ6508000000192000145399 from now on. Call me on +420 123 456 789.";
const spanOf = (text: string, needle: string, cls: string) => ({ class: cls, start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const rec = (id: string, thread: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  source: "src_gmail",
  thread,
  windowStart: iso(NOW - 3 * 3_600_000),
  windowEnd: iso(NOW - 2 * 3_600_000),
  revision: 1,
  state: "review",
  pii: {},
  secret: false,
  possibleSecret: false,
  problem: null,
  ruleId: null,
  actionable: false,
  decidedBy: null,
  decidedAt: null,
  textPurgeAt: iso(NOW + 30 * 86_400_000),
  createdAt: iso(NOW - 3 * 3_600_000),
  updatedAt: iso(NOW - 2 * 3_600_000),
  ...extra,
});
export const REC_BANK = rec("rec_bank", "Invoice question from M. Horak", { pii: { iban: 1, email: 2, phone: 1 }, ruleId: "rul_clients" });
/** What the server answers for a possible secret: no thread subject (it can carry the token). */
export const REC_KEY = rec("rec_key", null, { pii: { suspect_secret: 1 }, possibleSecret: true });
export const REC_SECRET = rec("rec_secret", "Deploy notes", { pii: { secret: 1 }, secret: true });
export const REC_PLAIN = rec("rec_plain", null, { source: "src_tg" });
/** A record Observer could not sort (routing_failed): held, text hidden, not a possible secret. */
export const REC_UNSORTED = rec("rec_unsorted", null, { problem: "routing_failed" });
const message = (text: string | null, spans: unknown[], extra: Record<string, unknown> = {}) => ({ conversation: "clients", id: `m_${Math.random().toString(36).slice(2, 8)}`, thread: null, sentAt: iso(NOW - 3 * 3_600_000), editedAt: null, deleted: false, author: "email:horak@example.com", authorKind: "person", text, spans, ...extra });
export function detailOf(r: ReturnType<typeof rec>): Record<string, unknown> {
  if (r.id === "rec_bank") return { ...r, messages: [message(msgText, [spanOf(msgText, "CZ6508000000192000145399", "iban"), spanOf(msgText, "+420 123 456 789", "phone")]), message("Thanks, I will tell accounting.", [], { author: "me", authorKind: "self" })] };
  if (r.id === "rec_key") {
    const t = `New key for the booking system: ${looksLikeKey()}`;
    return { ...r, messages: [message(t, [spanOf(t, looksLikeKey(), "suspect_secret")], { author: "" })] };
  }
  if (r.id === "rec_unsorted") return { ...r, messages: [message("Can you call the clinic about the order?", [])] };
  if (r.id === "rec_secret") return { ...r, messages: [message("Deploy notes: the key is [secret removed]", [])] };
  return { ...r, messages: [message("Lunch on Friday?", [])] };
}

export const RULES = [
  { id: RULE_ZERO, position: 0, locked: true, match: { pii: ["secret"] }, action: { deliver: "drop", redact: false } },
  { id: "rul_clients", position: 1, locked: false, match: { sources: ["src_gmail"], words: ["invoice"] }, action: { deliver: "knowledge", area: "Clients", knowledgeStatus: "draft", redact: true } },
  { id: "rul_support", position: 2, locked: false, match: { sources: ["src_tg"], actionable: true }, action: { deliver: "kanban", project: "Observer intake" } },
  { id: "rul_small", position: 3, locked: false, match: { minWords: 1 }, action: { deliver: "drop" } },
];
const delivery = (id: string, recordId: string, destination: string, status: string, extra: Record<string, unknown> = {}) => ({ id, recordId, revision: 1, destination, targetRef: null, status, holdId: null, attempts: 1, nextAt: null, lastError: null, createdAt: iso(NOW - 5 * 3_600_000), updatedAt: iso(NOW - 4 * 3_600_000), warning: null, superseded: false, ...extra });
export const DELIVERIES = [
  delivery("dlv_sent", "rec_bank", "knowledge", "sent", { targetRef: "doc_1" }),
  delivery("dlv_pending", "rec_plain", "kanban", "pending"),
  delivery("dlv_held", "rec_key", "inbox", "held", { holdId: "hld_1" }),
  delivery("dlv_failed", "rec_bank", "knowledge", "failed", { nextAt: iso(NOW + 40 * 60_000), lastError: "raw upstream text must never show", warning: "may_duplicate: the first attempt was more than 23 hours ago" }),
  delivery("dlv_super", "rec_key", "knowledge", "held", { holdId: "hld_2", superseded: true }),
];
export const PRIVACY = { textRetentionDays: 30, reviewRetentionDays: 90, onSourceDelete: "purge" };
export const ACCOUNTS = [
  { id: "acc_gmail", kind: "gmail", label: "work@example.com", historyCapable: true, retentionDays: null, conversations: [{ id: "clients", title: "Label “Clients”", estimate: 28500 }, { id: "suppliers", title: "Label “Suppliers”", estimate: 4100 }, { id: "all", title: "Inbox (all mail)", estimate: null }] },
  { id: "acc_tg", kind: "telegram", label: "Front desk bot", historyCapable: false, retentionDays: 30, conversations: [{ id: "group", title: "Clinic partners", estimate: null }] },
];

// ── stub server ────────────────────────────────────────────────────────────
export interface Call {
  op: string;
  input: Record<string, any>;
  csrf: string | null;
  key: string | null;
}
type Handler = unknown | ((input: Record<string, any>) => unknown);
export interface Stub {
  calls: Call[];
  /** per-op error envelope */
  fail: Record<string, { status: number; code: string } | undefined>;
  /** per-op promise the answer waits for */
  gate: Record<string, Promise<void> | undefined>;
  /** per-op answer (a value, or a function of the input) that replaces the default one */
  out: Record<string, Handler>;
  networkDown: boolean;
  targets: string[];
  connectMissing: boolean;
  sources: unknown[];
  jobs: unknown[];
  review: ReturnType<typeof rec>[];
  records: ReturnType<typeof rec>[];
  rules: unknown[];
  deliveries: unknown[];
  accounts: unknown[];
  privacy: Record<string, unknown>;
}
export const stub = {} as Stub;
export function reset(): void {
  Object.assign(stub, {
    calls: [],
    fail: {},
    gate: {},
    out: {},
    networkDown: false,
    targets: [...ALL_TARGETS],
    connectMissing: false,
    sources: [SRC_GMAIL, SRC_TG],
    jobs: [...JOBS],
    review: [REC_BANK, REC_KEY, REC_SECRET, REC_PLAIN],
    records: [REC_BANK, REC_KEY, REC_PLAIN, rec("rec_done", "Price list update", { state: "delivered" })],
    rules: structuredClone(RULES),
    deliveries: structuredClone(DELIVERIES),
    accounts: structuredClone(ACCOUNTS),
    privacy: { ...PRIVACY },
  });
}
reset();

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const callsOfOp = (op: string) => stub.calls.filter((c) => c.op === op);

function answer(op: string, input: Record<string, any>): unknown {
  switch (op) {
    case "tb.holds_list":
      return { items: [], nextCursor: null };
    case "sources_available":
      // like the server: the list names the accounts only; one account comes with its catalog
      if (stub.connectMissing) return { accounts: [], connectMissing: true, targets: stub.targets };
      if (input.account) return { accounts: (stub.accounts as { id: string }[]).filter((a) => a.id === input.account), connectMissing: false, targets: stub.targets };
      return { accounts: (stub.accounts as { id: string; kind: string; label: string }[]).map(({ id, kind, label }) => ({ id, kind, label })), connectMissing: false, targets: stub.targets };
    case "sources_list":
      return { sources: stub.sources };
    case "jobs_list":
      return { jobs: input.source ? (stub.jobs as { source: string }[]).filter((j) => j.source === input.source) : stub.jobs };
    case "job_control":
      return { job: { ...(stub.jobs as { id: string }[]).find((j) => j.id === input.id), state: "queued" } };
    case "source_add":
      return { source: { ...SRC_NEW, id: "src_made", label: input.label, account: input.account, conversations: input.conversations } };
    case "backfill_estimate":
      return { messages: 1200, records: 140, durationS: 600, providerNote: null };
    case "backfill_start":
      return { job: job("job_hist_new", input.source, "backfill", "queued") };
    case "source_remove":
      return { removed: true, messagesPurged: 3 };
    case "rules_list":
      return { rules: stub.rules, targets: stub.targets };
    case "rule_put":
      return { rule: { id: input.id ?? "rul_new", position: input.position, locked: false, match: input.match, action: input.action } };
    case "rule_delete":
      return { deleted: true };
    case "rules_reorder":
      return { rules: stub.rules };
    case "review_list":
      return { items: stub.review, nextCursor: null };
    case "review_get": {
      const r = stub.review.find((x) => x.id === input.id);
      if (!r) throw Object.assign(new Error("gone"), { status: 404, code: "not_found" });
      return { record: detailOf(r) };
    }
    case "review_decide": {
      stub.review = stub.review.filter((x) => x.id !== input.recordId);
      return { record: { id: input.recordId, state: input.decision === "drop" ? "dropped" : "approved" } };
    }
    case "records_list":
      return { items: stub.records, nextCursor: null };
    case "deliveries_list":
      return { items: input.status ? (stub.deliveries as { status: string }[]).filter((d) => d.status === input.status) : stub.deliveries, nextCursor: null };
    case "delivery_retry":
      return { delivery: { ...(stub.deliveries as { id: string }[]).find((d) => d.id === input.id), status: "pending" } };
    case "privacy_get":
      return stub.privacy;
    case "privacy_set":
      stub.privacy = { ...stub.privacy, ...input };
      return stub.privacy;
    case "purge":
      return { purged: 7 };
    default:
      return {};
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (stub.networkDown) throw new TypeError("fetch failed");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/observer/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["source_add", "backfill_start", "rule_put"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, any>; idempotencyKey?: string };
  stub.calls.push({ op, input: body.input ?? {}, csrf: headers.get("TB-CSRF"), key: body.idempotencyKey ?? null });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  try {
    const given = stub.out[op];
    const output = given !== undefined ? (typeof given === "function" ? (given as (i: Record<string, any>) => unknown)(body.input ?? {}) : given) : answer(op, body.input ?? {});
    return json(200, { status: "ok", output });
  } catch (e) {
    const err = e as { status?: number; code?: string };
    return json(err.status ?? 500, { error: { code: err.code ?? "internal", message: "raw upstream text", requestId: "req_1" } });
  }
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

export { act, h };

export async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
export async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "observer" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
export const click = (el: Element) => act(async () => (el as HTMLElement).click());
/** A button or link by its exact text (the nth one). */
export function control(host: Element, text: string, n = 0): HTMLButtonElement {
  const found = [...host.querySelectorAll("button, a")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `control "${text}"`);
  return found as HTMLButtonElement;
}
/** The dialog that is open (closed dialogs stay in the page, empty). */
export function openDialog(host: Element): HTMLDialogElement {
  const found = [...host.querySelectorAll("dialog")].find((d) => d.childElementCount > 0);
  assert.ok(found, "an open dialog");
  return found as HTMLDialogElement;
}
export function within(host: Element, label: string): Element {
  const found = host.querySelector(`[aria-label="${label}"]`);
  assert.ok(found, `region "${label}"`);
  return found;
}
export const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
export const callsOf = (op: string): Call[] => callsOfOp(op);
export const lastCall = (op: string): Call => {
  const c = callsOfOp(op).at(-1);
  assert.ok(c, `a call of ${op}`);
  return c;
};
/** Type into a kit TextInput / Textarea (React listens to the native `input` event). */
export async function type(el: Element, value: string): Promise<void> {
  await act(async () => {
    const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}
/** Open the kit Select that carries this aria label / label id and choose the option with this text. */
export async function choose(host: Element, trigger: Element, optionText: string): Promise<void> {
  await click(trigger);
  const option = [...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(optionText));
  assert.ok(option, `option "${optionText}"`);
  await click(option);
  await flush();
}

/** Every write goes out with the session's CSRF token and an idempotency key (SDK-API §4.4). */
export function assertWriteHeaders(c: Call): void {
  assert.equal(c.csrf, "csrf-token", `${c.op}: TB-CSRF header`);
  assert.match(c.key ?? "", /^[A-Za-z0-9._:-]{8,128}$/, `${c.op}: idempotency key`);
}

/** Compile the UI once for this test file and import a compiled module. */
export function compileUi(name: string): <T>(file: string) => Promise<T> {
  const outDir = join(root, "dist", `ui-test-${name}`);
  before(() => {
    const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  });
  after(() => rmSync(outDir, { recursive: true, force: true }));
  return async <T>(file: string) => (await import(pathToFileURL(join(outDir, "ui", file)).href)) as T;
}
