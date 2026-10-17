// Manifest invariants (DESIGN §5.1 A7, §5.7, S1 row). Each guard is tested quiet-on-good (the real manifest and good
// fixtures pass) and fire-on-bad (fixture manifests that widen Connect or leak message content fail), L27, L34.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentOutputLeaks, CONNECT_DATA_OPS, connectCompanionProblems, FORBIDDEN_AGENT_FIELDS } from "../src/guards.ts";
import { manifest } from "../src/manifest.ts";

type Companion = { product: string; operations?: string[]; crud?: string[] };
const CONNECT_OK: Companion = { product: "connect", operations: [...CONNECT_DATA_OPS], crud: ["read"] };
const withCompanions = (...companions: Companion[]) => ({ ...manifest, companions: [...(manifest.companions ?? []), ...companions] });

describe("the Connect companion is exactly read-only data ops", () => {
  it("the real manifest passes (S1 has no Connect companion yet; when one is added it must pass too)", () => {
    assert.deepEqual(connectCompanionProblems(manifest), []);
    assert.ok(!(manifest.companions ?? []).some((c) => c.product === "connect") || connectCompanionProblems(manifest).length === 0);
    assert.deepEqual(
      (manifest.companions ?? []).map((c) => c.product),
      ["knowledge", "kanban", "inbox"],
    );
  });
  it("quiet on good: the full set, or a subset, with crud exactly [read]", () => {
    assert.deepEqual(connectCompanionProblems(withCompanions(CONNECT_OK)), []);
    assert.deepEqual(connectCompanionProblems(withCompanions({ ...CONNECT_OK, operations: ["data_pull"] })), []);
  });
  it("fires when a send op is added", () => {
    for (const op of ["send_message", "data_send", "reply", "tools"]) {
      const problems = connectCompanionProblems(withCompanions({ ...CONNECT_OK, operations: [...CONNECT_DATA_OPS, op] }));
      assert.equal(problems.length, 1, op);
      assert.match(problems[0] ?? "", new RegExp(`"${op}"`));
    }
  });
  it("fires on a write crud (create, update, delete), an empty crud and an empty operation list", () => {
    for (const crud of [["read", "create"], ["read", "update"], ["read", "delete"], ["create"], []]) {
      assert.ok(connectCompanionProblems(withCompanions({ ...CONNECT_OK, crud })).some((p) => p.includes("crud")), JSON.stringify(crud));
    }
    assert.ok(connectCompanionProblems(withCompanions({ ...CONNECT_OK, operations: [] })).some((p) => p.includes("no operations")));
  });
  it("fires on a second Connect entry and on a wildcard companion", () => {
    assert.ok(connectCompanionProblems(withCompanions(CONNECT_OK, CONNECT_OK)).some((p) => p.includes("more than one")));
    assert.ok(connectCompanionProblems(withCompanions({ product: "*", operations: ["x"], crud: ["read"] })).some((p) => p.includes("wildcard")));
  });
  it("does not touch the other companions (Knowledge may create and update)", () => {
    assert.deepEqual(connectCompanionProblems(withCompanions({ product: "knowledge", operations: ["document_delete"], crud: ["delete"] })), []);
  });
});

describe("no agent op can return message content", () => {
  it("the real manifest passes: 3 agent ops, closed objects, no text / sender / author / title", () => {
    assert.deepEqual(agentOutputLeaks(manifest), []);
    assert.deepEqual(manifest.operations.filter((o) => o.audience === "agent").map((o) => o.id), ["status", "job_pause", "flag"]);
  });
  const fixture = (output: unknown) => ({ operations: [{ id: "x", audience: "agent", output }] });
  const closed = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties });
  it("quiet on good: labels, ids and counts", () => {
    assert.deepEqual(agentOutputLeaks(fixture(closed({ label: { type: "string" }, count: { type: "integer" }, items: { type: "array", items: closed({ id: { type: "string" } }) } }))), []);
  });
  it("fires on every forbidden field name, at any depth, in any case, also inside arrays and anyOf", () => {
    for (const name of FORBIDDEN_AGENT_FIELDS) {
      for (const n of [name, name.toUpperCase()]) {
        assert.equal(agentOutputLeaks(fixture(closed({ [n]: { type: "string" } }))).length, 1, n);
        assert.equal(agentOutputLeaks(fixture(closed({ a: { type: "array", items: closed({ b: closed({ [n]: { type: "string" } }) }) } }))).length, 1, `deep ${n}`);
        assert.equal(agentOutputLeaks(fixture(closed({ a: { anyOf: [{ type: "null" }, closed({ [n]: { type: "string" } })] } }))).length, 1, `anyOf ${n}`);
      }
    }
  });
  it("fires on an open object (it could carry anything)", () => {
    assert.equal(agentOutputLeaks(fixture({ type: "object" })).length, 1);
    assert.equal(agentOutputLeaks(fixture(closed({ meta: { type: "object" } }))).length, 1);
    assert.equal(agentOutputLeaks(fixture({ type: "object", additionalProperties: true, properties: {} })).length, 1);
  });
  it("looks only at agent ops (person ops may return text)", () => {
    assert.deepEqual(agentOutputLeaks({ operations: [{ id: "record_get", audience: "person", output: closed({ text: { type: "string" } }) }] }), []);
  });
});
