// A fake of Knowledge's companion ops as Observer calls them (Tealbrick/opt2-tealbrick-knowledge main: src/handlers.ts areas_list,
// document_create, document_update; manifest input schemas). Served through `ctx.callApp("knowledge", op, input, { idempotencyKey })`.
//
// Mirrored: the input schemas are checked (additionalProperties false, title 1..200, tags ≤ 20 of 1..40, area pattern), an
// idempotency key is required for document_create; the same key with the same op answers the stored output (no second
// document); `areas_list` answers the areas with the caller's access. `appWrites` models what Knowledge decides for an APP caller:
//   "allowed": a companion app may write to the shared area (what Observer needs)
//   "refused": Knowledge main today: an app caller gets the manifest defaults (shared → read), so a write answers scope_denied 403
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";

export interface FakeDoc {
  id: string;
  area: string;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  status: string;
  version: number;
}
type Fault = { op: string; error: { code: string; status: number }; afterApply?: boolean } | { op: string; held: true };

const AREA = /^[a-z0-9][a-z0-9-]{1,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class FakeKnowledge {
  readonly docs = new Map<string, FakeDoc>();
  readonly areas = [
    { id: "company", label: "Company", kind: "shared" },
    { id: "agt-scout", label: "Scout (own memory)", kind: "agent" },
  ];
  appWrites: "allowed" | "refused" = "allowed";
  readonly calls: { op: string; input: Record<string, unknown>; key: string | null }[] = [];
  readonly faults: Fault[] = [];
  readonly #idem = new Map<string, Json>();
  /** holds by idempotency key: undefined = none, "pending" until the owner decides */
  readonly holds = new Map<string, "pending" | "approved" | "denied">();
  #n = 0;

  fail(op: string, code: string, status: number, opts: { afterApply?: boolean; times?: number } = {}): void {
    for (let i = 0; i < (opts.times ?? 1); i++) this.faults.push({ op, error: { code, status }, ...(opts.afterApply ? { afterApply: true } : {}) });
  }
  hold(op: string): void {
    this.faults.push({ op, held: true });
  }
  writes(): number {
    return this.calls.filter((c) => c.op !== "areas_list").length;
  }

  callApp = async (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }): Promise<{ status: string; output?: Json; holdId?: string; expiresAt?: string }> => {
    if (product !== "knowledge") throw new TbError("companion_undeclared", `fake: not knowledge (${product})`, 500);
    const i = isObj(input) ? input : {};
    const key = opts?.idempotencyKey ?? null;
    this.calls.push({ op, input: structuredClone(i), key });
    const idemKey = key === null ? null : `${op}\u0000${key}`;
    // a held call asked again with the same key: still held, or the decision
    if (idemKey !== null && this.holds.has(idemKey)) {
      const h = this.holds.get(idemKey);
      if (h === "pending") return { status: "held", holdId: `hld_${key?.slice(4, 30)}`, expiresAt: "2026-10-28T12:00:00Z" };
      if (h === "denied") throw new TbError("hold_denied", "the owner denied this call", 403);
      this.holds.delete(idemKey);
    } else if (idemKey !== null && this.#idem.has(idemKey)) return { status: "ok", output: this.#idem.get(idemKey) as Json };
    const fi = this.faults.findIndex((f) => f.op === op);
    const fault = fi >= 0 ? this.faults.splice(fi, 1)[0] : undefined;
    if (fault && "held" in fault && idemKey !== null) {
      this.holds.set(idemKey, "pending");
      return { status: "held", holdId: `hld_${key?.slice(4, 30)}`, expiresAt: "2026-10-28T12:00:00Z" };
    }
    if (fault && "error" in fault && !fault.afterApply) throw new TbError(fault.error.code, `fake ${fault.error.code}`, fault.error.status);
    let output: Json;
    switch (op) {
      case "areas_list":
        output = { areas: this.areas.map((a) => ({ ...a, own: false, access: a.kind === "shared" ? (this.appWrites === "allowed" ? "read_write" : "read") : "read" })) };
        break;
      case "document_create":
        output = this.#create(i, key);
        break;
      case "document_update":
        output = this.#update(i);
        break;
      default:
        throw new TbError("unknown_tool", `fake: no op ${op}`, 404);
    }
    if (idemKey !== null) this.#idem.set(idemKey, output);
    // the call was applied, but the answer is lost on the way back (a 5xx after the write)
    if (fault && "error" in fault && fault.afterApply) throw new TbError(fault.error.code, `fake ${fault.error.code}`, fault.error.status);
    return { status: "ok", output };
  };

  /** a person edits the document in Knowledge: a new version (Observer must not overwrite it) */
  humanEdit(id: string, body: string): void {
    const d = this.docs.get(id);
    if (!d) throw new Error(`fake: no document ${id}`);
    d.body = body;
    d.version += 1;
  }

  #check(i: Record<string, unknown>, allowed: string[]): void {
    for (const k of Object.keys(i)) if (!allowed.includes(k)) throw new TbError("input_invalid", `fake: unknown member ${k}`, 400);
    if (i.title !== undefined && (typeof i.title !== "string" || i.title.length < 1 || i.title.length > 200)) throw new TbError("input_invalid", "title", 400);
    if (i.expectedVersion !== undefined && (typeof i.expectedVersion !== "number" || !Number.isInteger(i.expectedVersion) || i.expectedVersion < 1)) throw new TbError("input_invalid", "expectedVersion", 400);
    if (i.body !== undefined && (typeof i.body !== "string" || i.body.length > 500_000)) throw new TbError("input_invalid", "body", 400);
    if (i.summary !== undefined && (typeof i.summary !== "string" || i.summary.length > 2000)) throw new TbError("input_invalid", "summary", 400);
    if (i.status !== undefined && !["draft", "published", "archived"].includes(String(i.status))) throw new TbError("input_invalid", "status", 400);
    if (i.tags !== undefined && (!Array.isArray(i.tags) || i.tags.length > 20 || !i.tags.every((t) => typeof t === "string" && t.length >= 1 && t.length <= 40))) throw new TbError("input_invalid", "tags", 400);
  }

  #create(i: Record<string, unknown>, key: string | null): Json {
    this.#check(i, ["area", "collectionId", "parentId", "title", "body", "summary", "status", "tags"]);
    if (key === null) throw new TbError("idempotency_key_required", "document_create needs an idempotency key", 400);
    if (typeof i.title !== "string") throw new TbError("input_invalid", "title required", 400);
    // an app caller has no own area: it must name one (scope_denied otherwise, as Knowledge's defaultArea)
    if (typeof i.area !== "string" || !AREA.test(i.area)) throw new TbError("scope_denied", "name an area you can access: this caller has no area of its own", 403);
    if (!this.areas.some((a) => a.id === i.area)) throw new TbError("not_found", "not found", 404);
    const shared = this.areas.find((a) => a.id === i.area)?.kind === "shared";
    if (!shared || this.appWrites === "refused") throw new TbError("scope_denied", `no create access to area ${String(i.area)}`, 403);
    this.#n += 1;
    const id = `doc_${String(this.#n).padStart(4, "0")}`;
    this.docs.set(id, { id, area: i.area, title: i.title, body: String(i.body ?? ""), summary: String(i.summary ?? ""), tags: (i.tags as string[]) ?? [], status: String(i.status ?? "draft"), version: 1 });
    return { id, area: i.area, version: 1 };
  }

  #update(i: Record<string, unknown>): Json {
    this.#check(i, ["id", "expectedVersion", "title", "body", "summary", "status", "tags"]);
    const d = typeof i.id === "string" ? this.docs.get(i.id) : undefined;
    if (!d) throw new TbError("not_found", "not found", 404);
    if (this.appWrites === "refused") throw new TbError("scope_denied", `no update access to area ${d.area}`, 403);
    // Knowledge store.updateDocument: expectedVersion that is not the current version → version_conflict 409 (nothing changes)
    if (i.expectedVersion !== undefined && i.expectedVersion !== d.version) throw new TbError("version_conflict", `document is at version ${d.version}`, 409);
    Object.assign(d, {
      ...(i.title !== undefined ? { title: i.title } : {}),
      ...(i.body !== undefined ? { body: i.body } : {}),
      ...(i.summary !== undefined ? { summary: i.summary } : {}),
      ...(i.tags !== undefined ? { tags: i.tags } : {}),
      ...(i.status !== undefined ? { status: i.status } : {}),
      version: d.version + 1,
    });
    return { id: d.id, version: d.version };
  }
}
