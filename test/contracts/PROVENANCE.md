# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header in
the same commit. `test/contract.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `messages/1` (one page of the Connect `messages` dataset, answer of `data_pull`; producer: Connect, consumers: Knowledge foundry and this app). Decision C230, request R3, FOUNDRY-DESIGN v2 §3.4. Connect vendors the same bytes (its `test/contracts/PROVENANCE.md`).

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `messages.1.schema.json` | `packages/spec/schemas/contracts/messages.1.schema.json` | `9a627953cac9b7bb20a2bed14a807a2db334b776aa34f051495794a4b1302a24` |
| `messages.1.json` | `packages/spec/examples/contracts/messages.1.json` | `1734dc67c65fd6edd80ba3987319339aa0e5d9b46b25198df1c9887b7bff7c12` |
| `../../src/contracts/messages.1.schema.json` (runtime copy: the image has no `test/`) | same as the schema above | `9a627953cac9b7bb20a2bed14a807a2db334b776aa34f051495794a4b1302a24` |

How this app uses them:
- `src/contract.ts` checks every row Observer pulls against the runtime copy with the JSON Schema 2020-12 validator that
  `@opt2-tealbrick/manifest` exports (`validateAgainstSchema`, the one Connect uses). A row that does not conform is skipped and
  counted (`skipped` on the job), never stored. The envelope fields Observer acts on (`nextCursor`, `exhausted`, `anchor`,
  `retryAfterS`) must be right or the page is refused.
- `test/fake-connect.ts` validates EVERY page it serves against the schema in this folder and throws when one does not conform,
  so the fake cannot drift from the contract (L1). The fixtures `valid` and `invalid` run through the same validator in
  `test/contract.test.ts`.
