// Structural guards over a manifest (DESIGN §5.1 A7, §5.7). Pure functions, so the tests can feed them fixture manifests:
// the real manifest must pass, a manifest that widens a companion or lets an agent read message content must fail.
//
// 1. Companions are pinned: exact operations and exact crud per product, no `delete` crud anywhere, no wildcard. Observer is
//    read-only toward its sources "by construction": the only Connect companion (none yet) is exactly crud ["read"] and
//    names only Connect's app-only read ops (data_*).
// 2. Agent output is an ALLOW-LIST, not a deny-list: every op that is not exactly audience "person" is agent-reachable and
//    must be one of the 3 known agent ops; their output schemas may use only a small keyword set (closed objects, bounded
//    strings, bounded integers, booleans, enums, null unions) and every property path must be in AGENT_OUTPUT_ALLOW. A new
//    field (body, message, subject, senders, snippet, …) or a loose schema ({}, $ref, type arrays) fails until a human
//    updates the snapshot below on purpose.

export const CONNECT_PRODUCT = "connect";
export const CONNECT_DATA_OPS: readonly string[] = ["data_accounts_list", "data_catalog", "data_pull"];

interface Companion {
  product: string;
  operations?: readonly string[];
  crud?: readonly string[];
}
interface ManifestLike {
  companions?: readonly Companion[];
  operations: readonly { id: string; audience?: unknown; output?: unknown }[];
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

// ───────────────────────────────────────────────────────────────────────── companions
/** Problems with the Connect companion ([] = fine; also fine when there is none). */
export function connectCompanionProblems(m: ManifestLike): string[] {
  const out: string[] = [];
  const connect = (m.companions ?? []).filter((c) => c.product === CONNECT_PRODUCT);
  if ((m.companions ?? []).some((c) => c.product === "*")) out.push('a wildcard companion ("*") could reach Connect');
  if (connect.length > 1) out.push("more than one Connect companion");
  for (const c of connect) {
    const crud = c.crud ?? [];
    if (crud.length !== 1 || crud[0] !== "read") out.push(`Connect companion crud must be exactly ["read"], got ${JSON.stringify(crud)}`);
    const ops = c.operations ?? [];
    if (ops.length === 0) out.push("Connect companion names no operations");
    for (const op of ops) if (!CONNECT_DATA_OPS.includes(op)) out.push(`Connect companion operation "${op}" is not one of ${CONNECT_DATA_OPS.join(", ")}`);
  }
  return out;
}

/** The companions Observer declares, exactly (S1 manifest). Widening one is a manifest review, not a drive-by edit. */
export const PINNED_COMPANIONS: Readonly<Record<string, { operations: readonly string[]; crud: readonly string[] }>> = {
  knowledge: { operations: ["areas_list", "document_create", "document_update"], crud: ["read", "create", "update"] },
  kanban: { operations: ["projects_list", "issue_create"], crud: ["read", "create"] },
  inbox: { operations: ["inbox_ask", "inbox_status"], crud: ["read", "create"] },
};

/** Exact operations and crud per companion, no `delete` crud anywhere, no wildcard, no unknown product. Connect is optional
 *  and checked by connectCompanionProblems (read only, data_* ops). */
export function companionProblems(m: ManifestLike, pinned: typeof PINNED_COMPANIONS = PINNED_COMPANIONS): string[] {
  const out = [...connectCompanionProblems(m)];
  const seen = new Set<string>();
  for (const c of m.companions ?? []) {
    if ((c.crud ?? []).includes("delete")) out.push(`companion "${c.product}" has delete crud`);
    if (c.product === CONNECT_PRODUCT || c.product === "*") continue;
    const pin = pinned[c.product];
    if (!pin) {
      out.push(`companion "${c.product}" is not one Observer declares`);
      continue;
    }
    if (seen.has(c.product)) out.push(`more than one "${c.product}" companion`);
    seen.add(c.product);
    if (!same(c.operations ?? [], pin.operations)) out.push(`companion "${c.product}" operations must be exactly ${JSON.stringify(pin.operations)}, got ${JSON.stringify(c.operations ?? [])}`);
    if (!same(c.crud ?? [], pin.crud)) out.push(`companion "${c.product}" crud must be exactly ${JSON.stringify(pin.crud)}, got ${JSON.stringify(c.crud ?? [])}`);
  }
  for (const product of Object.keys(pinned)) if (!seen.has(product)) out.push(`companion "${product}" is missing`);
  return out;
}

// ───────────────────────────────────────────────────────────────────────── agent output allow-list
export const AGENT_OPS: readonly string[] = ["status", "job_pause", "flag"];

/** The only keywords an agent output schema may use. Anything else ($ref, $defs, format, not, oneOf, …) fails. */
const KEYWORDS = new Set(["type", "additionalProperties", "required", "properties", "items", "maxItems", "minItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "enum", "anyOf"]);
const TYPES = new Set(["object", "array", "string", "integer", "boolean", "null"]);

/** Every node of the 3 agent output schemas, as `op:path=shape`. The snapshot: updating it is a deliberate review. */
export const AGENT_OUTPUT_ALLOW: readonly string[] = [
  "flag:$=object",
  "flag:$.flagId=string",
  "job_pause:$=object",
  "job_pause:$.job=object",
  "job_pause:$.job.id=string",
  "job_pause:$.job.state=string",
  "status:$=object",
  "status:$.review=object",
  "status:$.review.waiting=integer",
  "status:$.sources=array",
  "status:$.sources[]=object",
  "status:$.sources[].history=object",
  "status:$.sources[].history.done=integer",
  "status:$.sources[].history.since=null|string",
  "status:$.sources[].history.state=string",
  "status:$.sources[].history.total=integer|null",
  "status:$.sources[].historyJobId=null|string",
  "status:$.sources[].id=string",
  "status:$.sources[].kind=string",
  "status:$.sources[].label=string",
  "status:$.sources[].live=object",
  "status:$.sources[].live.lastReadAt=null|string",
  "status:$.sources[].live.nextAt=null|string",
  "status:$.sources[].live.state=string",
  "status:$.sources[].liveJobId=null|string",
];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk one output schema; returns the nodes (`path=shape`) and the structural problems found. */
function walkOutput(schema: unknown, op: string): { nodes: string[]; problems: string[] } {
  const nodes: string[] = [];
  const problems: string[] = [];
  const bad = (path: string, why: string): void => {
    problems.push(`${op}:${path}: ${why}`);
  };
  const shape = (s: unknown): string | null => {
    if (!isObj(s)) return null;
    if (Array.isArray(s.anyOf)) {
      const parts = s.anyOf.map((b) => (isObj(b) && typeof b.type === "string" ? b.type : "?"));
      return [...new Set(parts)].sort().join("|");
    }
    return typeof s.type === "string" ? s.type : null;
  };
  const walk = (s: unknown, path: string): void => {
    if (!isObj(s) || Object.keys(s).length === 0) {
      bad(path, "empty or non-object schema ({} accepts anything)");
      return;
    }
    for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) bad(path, `keyword "${k}" is not allowed`);
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) {
        bad(path, "anyOf must be a non-empty list");
        return;
      }
      if (Object.keys(s).length !== 1) bad(path, "anyOf must stand alone");
      nodes.push(`${op}:${path}=${shape(s)}`);
      for (const [i, b] of s.anyOf.entries()) walk(b, `${path}|${i}`);
      return;
    }
    if (typeof s.type !== "string") {
      bad(path, "type must be one single type name (no type arrays)");
      return;
    }
    if (!TYPES.has(s.type)) {
      bad(path, `type "${s.type}" is not allowed`);
      return;
    }
    nodes.push(`${op}:${path}=${s.type}`);
    switch (s.type) {
      case "object": {
        if (!isObj(s.properties)) bad(path, "object without properties");
        if (s.additionalProperties !== false) bad(path, "object must set additionalProperties: false");
        const props = isObj(s.properties) ? s.properties : {};
        if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string" && r in props))) bad(path, "required names a property that does not exist");
        for (const [name, sub] of Object.entries(props)) walk(sub, `${path}.${name}`);
        break;
      }
      case "array":
        if (!Number.isInteger(s.maxItems)) bad(path, "array without maxItems");
        if (s.items === undefined) bad(path, "array without items");
        else walk(s.items, `${path}[]`);
        break;
      case "string":
        if (!Number.isInteger(s.maxLength) && !(Array.isArray(s.enum) && s.enum.length > 0)) bad(path, "string without maxLength or enum");
        break;
      case "integer":
        if (!Number.isInteger(s.minimum) || !Number.isInteger(s.maximum)) bad(path, "integer without minimum and maximum");
        break;
      default:
        break;
    }
    if (s.type !== "object" && (s.properties !== undefined || s.required !== undefined)) bad(path, "properties/required on a non-object");
  };
  walk(schema, "$");
  // a union is described by its branches, so the union node and its branches both appear; keep only the union nodes
  return { nodes: nodes.filter((n) => !/\|\d+=/.test(n)), problems };
}

/** Problems with what an agent can receive. [] = the real manifest. Also checks that no op is agent-reachable by an odd
 *  audience spelling: only exactly "person" is owner-only; every other op must be one of AGENT_OPS. */
export function agentOutputProblems(m: ManifestLike, allow: readonly string[] = AGENT_OUTPUT_ALLOW): string[] {
  const out: string[] = [];
  const reachable = m.operations.filter((o) => o.audience !== "person");
  for (const o of reachable) if (!AGENT_OPS.includes(o.id)) out.push(`${o.id}: audience ${JSON.stringify(o.audience)} is not exactly "person" and the op is not a known agent op`);
  for (const id of AGENT_OPS) {
    const o = m.operations.find((x) => x.id === id);
    if (!o) out.push(`${id}: agent op missing`);
    else if (o.audience !== "agent") out.push(`${id}: audience must be exactly "agent", got ${JSON.stringify(o.audience)}`);
  }
  const seen: string[] = [];
  for (const o of reachable) {
    const w = walkOutput(o.output, o.id);
    out.push(...w.problems);
    seen.push(...w.nodes);
  }
  for (const n of seen) if (!allow.includes(n)) out.push(`${n}: not in the agent output allow-list`);
  for (const a of allow) if (!seen.includes(a)) out.push(`${a}: in the allow-list but gone from the manifest (update the snapshot on purpose)`);
  return out;
}
