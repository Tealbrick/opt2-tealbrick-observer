# Observer

A Teal Brick opt2 miniapp (product id `observer`), built on `@opt2-tealbrick/miniapp-sdk`.

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, scopes, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (28; op ids and I/O types from `#kit`), `onStart` (creates the locked rule 0), `pendingCount` (records in Review) |
| `src/store.ts` | table access over the migrated `obs_*` tables (plain functions over the SDK `Db`): views, job state machine, rules, review decisions, outbox rows, purge. Agent `status` is built here from labels and counts only |
| `src/connect.ts` | the Connect seam: `connectPort(ctx)` is null until Connect offers `data_*` (spec request R3), so `source_add`, `backfill_estimate`, `backfill_start` answer `connect_unavailable` (409) and `sources_available` answers `connectMissing` |
| `src/guards.ts` | manifest invariants as pure functions: the Connect companion is exactly `crud ["read"]` with `data_*` ops only; no agent op output can carry text, sender, author or title |
| `src/clock.ts`, `src/manifest.ts` | the injected clock (tests never wait) and the manifest reader |
| `test/*.test.ts` | unit tests on a migrated in-memory database with a fake ctx (`helpers.ts`, `seed.ts`): agent ops, sources and jobs, rules, review and deliveries, privacy and purge, manifest guards, output schemas |
| `conformance.start.ts`, `tealbrick-conformance.json` | the conformance harness; it seeds the fixture rows (`test/seed.ts`) that the agent ops need, because no op can create a job or a delivered record yet |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`), built to `dist/ui` |
| `src/ui/standard.tsx` | the standard pages (Holds, Receipts, Agents & scopes, Backups & export) and the page router; pass your own words as props, do not edit (one source: the template) |
| `src/ui/pages.css` | page layout helpers of the approved mockups (`.page-head`, `.ruled`, `.item`, ...); tokens only. App-only layout goes in `src/ui/app.css` (linked after it when present) |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` | Apache-2.0 (C154), the copyright notice and the upstream licences the app ships (React, the UI kit, Nunito OFL); update the notices when you add a dependency |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-observer/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test      # lint = biome + check-system (the design-system guard)
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

Before its first claim the SDK checks that `TB_DATA_DIR` is a mounted volume (SDK 0.1.12); on a container's own
disk it waits and does not use the enrolment code. Tests and CI that run `startApp` or `tb-exec` in bridge mode on
Linux set `TB_DATA_EPHEMERAL=1` in that test or CI step (this template's own tests run app-alone and need none). Never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-observer`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).

## Data rules worth knowing
- Removing a source (`source_remove`) deletes everything Observer stored for it: messages and their ids, records, the outbox ledger, flags and jobs. Documents already delivered to Knowledge stay there (the owner deletes them in Knowledge). The privacy setting `onSourceDelete` is a different thing: it says what Observer does when the PROVIDER deletes a message (DESIGN §5.5), and `source_remove` does not read it.
- Narrowing a source (fewer conversations, new excluded senders or domains) and `purge` delete in one transaction: the stored messages or their text, the unsent deliveries of the records they belonged to, records left with no message, and the stored input of sent deliveries. No text of an excluded sender stays in any table. Exclusions compare in JavaScript (`obs_messages.author_key`, NFC + `toLowerCase`), because SQLite `lower()` folds ASCII only.
- A secret record can only be dropped: `review_decide` and `delivery_retry` refuse everything else (`secret_drop_only`), and the router (`routeRecord`) drops a secret before it looks at any rule.
- Message digests are HMAC-SHA256 under the app secret `obs_digest_key`, created once at start.
