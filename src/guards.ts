// Structural guards over a manifest (DESIGN §5.1 A7, §5.7). Pure functions, so the tests can feed them fixture manifests:
// the real manifest must pass, a manifest that widens the Connect companion or lets an agent read message content must fail.
//
// 1. Observer is read-only toward its sources "by construction": the only Connect companion is exactly crud ["read"] and
//    names only Connect's app-only read ops (data_*). A send op or a write crud fails (a malicious release must not widen it).
// 2. No agent op output schema can carry message content: no property named text / sender / author / title, and no open
//    object (an object without `properties` + `additionalProperties: false` could carry anything).

export const CONNECT_PRODUCT = "connect";
export const CONNECT_DATA_OPS: readonly string[] = ["data_accounts_list", "data_catalog", "data_pull"];
export const FORBIDDEN_AGENT_FIELDS: readonly string[] = ["text", "sender", "author", "title"];

interface ManifestLike {
  companions?: readonly { product: string; operations?: readonly string[]; crud?: readonly string[] }[];
  operations: readonly { id: string; audience?: string; output?: unknown }[];
}

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

/** Where an agent op output schema could carry message content (paths like `status.sources[].title`). */
export function agentOutputLeaks(m: ManifestLike): string[] {
  const out: string[] = [];
  const walk = (schema: unknown, path: string): void => {
    if (!schema || typeof schema !== "object") return;
    const s = schema as Record<string, unknown>;
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const list = s[key];
      if (Array.isArray(list)) for (const [i, x] of list.entries()) walk(x, `${path}.${key}[${i}]`);
    }
    if (s.items) walk(s.items, `${path}[]`);
    const props = s.properties as Record<string, unknown> | undefined;
    if (s.type === "object" || props) {
      if (!props || s.additionalProperties !== false) out.push(`${path}: open object (could carry message content)`);
      for (const [name, sub] of Object.entries(props ?? {})) {
        if (FORBIDDEN_AGENT_FIELDS.includes(name.toLowerCase())) out.push(`${path}.${name}: forbidden field name`);
        walk(sub, `${path}.${name}`);
      }
    }
  };
  for (const o of m.operations) if (o.audience === "agent") walk(o.output, o.id);
  return out;
}
