// Manifest invariants (DESIGN §5.1 A7, §5.7, S1 row). Each guard is tested quiet-on-good (the real manifest and good
// fixtures pass) and fire-on-bad (fixture manifests that widen a companion or leak message content fail), L27, L34.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_OPS, AGENT_OUTPUT_ALLOW, agentOutputProblems, CONNECT_DATA_OPS, companionProblems, connectCompanionProblems, PINNED_COMPANIONS } from "../src/guards.ts";
import { manifest } from "../src/manifest.ts";

type Companion = { product: string; operations?: string[]; crud?: string[] };
type Op = { id: string; audience?: unknown; output?: any; [k: string]: unknown };
type M = { companions: Companion[]; operations: Op[] };
const fresh = (): M => structuredClone(manifest) as unknown as M;
const withCompanion = (c: Companion): M => ({ ...fresh(), companions: [...fresh().companions, c] });
const CONNECT_OK: Companion = { product: "connect", operations: [...CONNECT_DATA_OPS], crud: ["read"] };
const op = (m: M, id: string): Op => {
  const o = m.operations.find((x) => x.id === id);
  assert.ok(o, id);
  return o;
};
const statusItem = (m: M): any => op(m, "status").output.properties.sources.items;

describe("companions are pinned: exact operations and crud, no delete", () => {
  it("the real manifest passes, and the pin matches what it declares", () => {
    assert.deepEqual(companionProblems(manifest), []);
    assert.deepEqual(
      (manifest.companions ?? []).map((c) => [c.product, [...(c.operations ?? [])].sort(), [...(c.crud ?? [])].sort()]),
      Object.entries(PINNED_COMPANIONS).map(([p, v]) => [p, [...v.operations].sort(), [...v.crud].sort()]),
    );
  });
  it("fires when an operation is added, removed or swapped (also document_delete)", () => {
    for (const change of [
      (c: Companion) => c.operations?.push("document_delete"),
      (c: Companion) => c.operations?.push("document_get"),
      (c: Companion) => c.operations?.pop(),
      (c: Companion) => {
        c.operations = ["areas_list", "document_create", "document_delete"];
      },
    ]) {
      const m = fresh();
      change(m.companions.find((c) => c.product === "knowledge") as Companion);
      assert.ok(companionProblems(m).some((p) => p.includes('"knowledge" operations')), String(change));
    }
  });
  it("fires when a crud is widened or narrowed, and on ANY delete crud (also on a companion that is otherwise fine)", () => {
    for (const crud of [["read", "create", "update", "delete"], ["read", "create"], ["read"], []]) {
      const m = fresh();
      (m.companions.find((c) => c.product === "knowledge") as Companion).crud = crud;
      assert.ok(companionProblems(m).some((p) => p.includes('"knowledge" crud')), JSON.stringify(crud));
    }
    const m = fresh();
    (m.companions.find((c) => c.product === "kanban") as Companion).crud = ["read", "create", "delete"];
    assert.ok(companionProblems(m).some((p) => p.includes("kanban") && p.includes("delete")));
    assert.ok(companionProblems(withCompanion({ ...CONNECT_OK, crud: ["read", "delete"] })).some((p) => p.includes("connect") && p.includes("delete")));
  });
  it("fires on an unknown product, a missing companion, a duplicate and a wildcard", () => {
    assert.ok(companionProblems(withCompanion({ product: "mail", operations: ["send"], crud: ["create"] })).some((p) => p.includes('"mail" is not one Observer declares')));
    const missing = fresh();
    missing.companions = missing.companions.filter((c) => c.product !== "inbox");
    assert.ok(companionProblems(missing).some((p) => p.includes('"inbox" is missing')));
    const dup = withCompanion(structuredClone(fresh().companions[0]) as Companion);
    assert.ok(companionProblems(dup).some((p) => p.includes("more than one")));
    assert.ok(companionProblems(withCompanion({ product: "*", operations: ["x"], crud: ["read"] })).some((p) => p.includes("wildcard")));
  });
});

describe("the Connect companion is exactly read-only data ops", () => {
  it("quiet on good: none yet; the full set; a subset; always crud exactly [read]", () => {
    assert.deepEqual(connectCompanionProblems(manifest), []);
    assert.deepEqual(companionProblems(withCompanion(CONNECT_OK)), []);
    assert.deepEqual(companionProblems(withCompanion({ ...CONNECT_OK, operations: ["data_pull"] })), []);
  });
  it("fires when a send op is added", () => {
    for (const op of ["send_message", "data_send", "reply", "tools"]) {
      const problems = connectCompanionProblems(withCompanion({ ...CONNECT_OK, operations: [...CONNECT_DATA_OPS, op] }));
      assert.equal(problems.length, 1, op);
      assert.match(problems[0] ?? "", new RegExp(`"${op}"`));
    }
  });
  it("fires on a write crud (create, update, delete), an empty crud and an empty operation list", () => {
    for (const crud of [["read", "create"], ["read", "update"], ["read", "delete"], ["create"], []]) {
      assert.ok(connectCompanionProblems(withCompanion({ ...CONNECT_OK, crud })).some((p) => p.includes("crud")), JSON.stringify(crud));
    }
    assert.ok(connectCompanionProblems(withCompanion({ ...CONNECT_OK, operations: [] })).some((p) => p.includes("no operations")));
  });
  it("fires on a second Connect entry", () => {
    assert.ok(connectCompanionProblems({ companions: [CONNECT_OK, CONNECT_OK], operations: [] }).some((p) => p.includes("more than one")));
  });
});

describe("agents get only what the allow-list names", () => {
  it("quiet on good: the real manifest passes, and the snapshot is the 3 agent ops exactly", () => {
    assert.deepEqual(agentOutputProblems(manifest), []);
    assert.deepEqual([...AGENT_OPS].sort(), manifest.operations.filter((o) => o.audience === "agent").map((o) => o.id).sort());
    assert.equal(new Set(AGENT_OUTPUT_ALLOW).size, AGENT_OUTPUT_ALLOW.length, "no duplicate entry");
    assert.ok(AGENT_OUTPUT_ALLOW.every((n) => AGENT_OPS.includes(n.split(":")[0] ?? "")));
  });
  it("fires on every new field an agent could read content from, at any depth", () => {
    for (const name of ["body", "message", "subject", "senders", "snippet", "text", "title", "sender", "author", "content", "TEXT"]) {
      const m = fresh();
      statusItem(m).properties[name] = { type: "string", maxLength: 10 };
      assert.ok(agentOutputProblems(m).some((p) => p.includes(`.${name}=string: not in the agent output allow-list`)), `status item ${name}`);
      const f = fresh();
      op(f, "flag").output.properties[name] = { type: "string", maxLength: 10 };
      assert.ok(agentOutputProblems(f).some((p) => p.includes(`$.${name}`)), `flag ${name}`);
      const d = fresh();
      statusItem(d).properties.history.properties[name] = { type: "string", maxLength: 10 };
      assert.ok(agentOutputProblems(d).some((p) => p.includes(`history.${name}`)), `deep ${name}`);
    }
  });
  it("fires when a field is gone or changes shape (the snapshot is exact)", () => {
    const gone = fresh();
    delete statusItem(gone).properties.kind;
    statusItem(gone).required = statusItem(gone).required.filter((r: string) => r !== "kind");
    assert.ok(agentOutputProblems(gone).some((p) => p.includes("status:$.sources[].kind=string: in the allow-list but gone")));
    const changed = fresh();
    statusItem(changed).properties.label = { type: "integer", minimum: 0, maximum: 5 };
    const problems = agentOutputProblems(changed);
    assert.ok(problems.some((p) => p.includes("label=integer: not in")) && problems.some((p) => p.includes("label=string: in the allow-list but gone")));
  });
  it("fires on a loose schema: {}, an open object, a type array, $ref, $defs and every keyword outside the list", () => {
    const cases: [string, (m: M) => void][] = [
      ["{}", (m) => (op(m, "flag").output.properties.flagId = {})],
      ["whole output {}", (m) => (op(m, "flag").output = {})],
      ["open object", (m) => (op(m, "job_pause").output.properties.job = { type: "object" })],
      ["additionalProperties true", (m) => (op(m, "job_pause").output.properties.job.additionalProperties = true)],
      ["type array", (m) => (op(m, "flag").output.properties.flagId.type = ["string", "null"])],
      ["type [object,null]", (m) => (op(m, "job_pause").output.properties.job.type = ["object", "null"])],
      ["$ref", (m) => (op(m, "flag").output.properties.flagId = { $ref: "#/$defs/x" })],
      ["$defs", (m) => (op(m, "flag").output.$defs = { x: { type: "string", maxLength: 5 } })],
      ["format", (m) => (op(m, "flag").output.properties.flagId.format = "email")],
      ["description", (m) => (op(m, "flag").output.properties.flagId.description = "x")],
      ["oneOf", (m) => (op(m, "flag").output.properties.flagId = { oneOf: [{ type: "string", maxLength: 5 }] })],
      ["not", (m) => (op(m, "flag").output.properties.flagId.not = { type: "null" })],
      ["patternProperties", (m) => (op(m, "job_pause").output.patternProperties = { ".*": { type: "string", maxLength: 5 } })],
      ["unbounded string", (m) => delete op(m, "flag").output.properties.flagId.maxLength],
      ["unbounded integer", (m) => delete statusItem(m).properties.history.properties.done.maximum],
      ["array without maxItems", (m) => delete op(m, "status").output.properties.sources.maxItems],
      ["array of anything", (m) => delete op(m, "status").output.properties.sources.items],
      ["anyOf with extra keyword", (m) => (statusItem(m).properties.live.properties.nextAt.minLength = 1)],
      ["unknown type", (m) => (op(m, "flag").output.properties.flagId = { type: "number" })],
      ["required names a missing field", (m) => op(m, "flag").output.required.push("body")],
    ];
    for (const [name, mutate] of cases) {
      const m = fresh();
      mutate(m);
      assert.ok(agentOutputProblems(m).length > 0, name);
    }
  });
  it("fires on audience variants: only exactly 'person' hides an op from agents", () => {
    for (const audience of ["Agent", "AGENT", "agent ", "agent,person", ["agent"], ["agent", "person"], "app", "both", "any", "", undefined, null, "Person", "person "]) {
      const m = fresh();
      op(m, "record_get").audience = audience; // a person op that returns message text
      assert.ok(
        agentOutputProblems(m).some((p) => p.startsWith("record_get:")),
        `record_get audience ${JSON.stringify(audience)}`,
      );
    }
    for (const audience of ["Agent", "person", undefined, ["agent"], "agent "]) {
      const m = fresh();
      op(m, "job_pause").audience = audience;
      assert.ok(agentOutputProblems(m).some((p) => p.includes("job_pause") && p.includes("audience")), `job_pause audience ${JSON.stringify(audience)}`);
    }
    const missing = fresh();
    missing.operations = missing.operations.filter((o) => o.id !== "flag");
    assert.ok(agentOutputProblems(missing).some((p) => p.includes("flag: agent op missing")));
  });
  it("a person op may return text: the real record_get does, and the guard stays quiet", () => {
    assert.ok(JSON.stringify(op(fresh(), "record_get").output).length > 0);
    assert.deepEqual(agentOutputProblems(manifest), []);
  });
});
