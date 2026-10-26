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
| `src/detect/` | the deterministic detectors, one module each, pure (text → `{class, spans, count}`): `secret`, `email`, `phone`, `iban` (mod 97), `card` (Luhn + issuer), `govid` (SK/CZ rodné číslo, DE Steuer-ID, US SSN in one country table), `address` (low confidence), `name` (person names EN/SK/CZ/DE, medium to low confidence; lists in `names-data.ts`), `special` (GDPR art. 9 word lists EN/SK/DE), `redact` (labels, overlap merge), `words` (whole-word matcher) |
| `src/classify.ts`, `src/actionable.ts` | classify a text or a record (class counts, secret, words, merged spans) and the v1 "actionable" scorer with the owner's keywords; no model |
| `src/window.ts` | windowing, pure with an injected clock: live windows close after 30 min quiet or 24 h, backfill windows by count / character budget |
| `src/router.ts`, `src/pipeline.ts` | the router (rule 0 first, owner rules in order, first match decides, PII without `redact` → Review) and `applyRouting` (classify a stored record, store the result, drop / review / approve with an outbox row) |
| `src/records.ts` | the window → record mapping (persisted in `obs_messages.record_id`; late messages join the existing record as a new revision), re-classification after an edit or a late message, and the purge of a secret that spans messages |
| `src/ingest.ts` | the helper S2 calls per message: secrets are replaced BEFORE storage, excluded senders are never stored, 16 KiB cut, keyed digest |
| `src/clock.ts`, `src/manifest.ts` | the injected clock (tests never wait) and the manifest reader |
| `test/*.test.ts` | unit tests on a migrated in-memory database with a fake ctx (`helpers.ts`, `seed.ts`): agent ops, sources and jobs, rules, review and deliveries, privacy and purge, manifest guards, output schemas. `test/ui-*.test.ts` render each page in happy-dom against a stub server (`ui-harness.ts`) and check the op, the CSRF header and the idempotency key of every write |
| `conformance.start.ts`, `tealbrick-conformance.json` | the conformance harness; it seeds the fixture rows (`test/seed.ts`) that the agent ops need, because no op can create a job or a delivered record yet |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`), built to `dist/ui`. Pages: `sources.tsx` (cards, honest "Observer cannot read sources yet" state, `addsource.tsx` StepFlow, `history.tsx`), `review.tsx` (list + record with marked spans; a possible secret opens redacted, without subject or sender, and "Deliver as is" needs the original shown, a tick and `acknowledged: true` (the server refuses it otherwise); a recognised secret can only be dropped), `routing.tsx` (rule 0 locked; destinations that `targets` lacks are greyed), `activity.tsx`, `privacy.tsx`, `settings.tsx` (Connect and Knowledge are required). `api.ts` calls the person ops with an idempotency key on every write (the SDK adds the CSRF header); `app.css` is the app-only layout |
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
- Every review decision (also drop and keep) deletes the record's other unsent outbox rows, so a superseded delivery can never be revived. `delivery_retry` works only for the row of the owner's last decision (record approved, same revision, same `decided_destination`). A held delivery blocks every decision (`delivery_held`, decide the hold in Holds first). Deliver and keep need text (`text_gone` otherwise). A flag raises the record revision, so the owner can replace a flagged document.
- If the digest key cannot be read at start, Observer still starts (rule 0 is made first) and shows attention `digest_key_unavailable`; if the install made a key before but the secret store has none (a restore under another KEK), it shows `digest_key_lost`, makes no new key, and `digestOf` throws so no message is stored without a proper digest.
- Classification is deterministic (no model) and offsets-only: `review_get` and `record_get` return, per message, `spans` of `{class, start, end}` for the owner; no agent op returns them (the agent output allow-list in `src/guards.ts` fails on any new field). Settings: `gov_id_countries` (JSON list, default SK, CZ, DE, US) and `actionable_words` (JSON list) in `obs_settings`.
- Known limits of the detectors: addresses need a street with a house number; a person name is found only as a listed given name (alone or with the capitalised words after it), after a title or greeting, or after a sign-off, so a surname alone or a rare given name in running text can get through, and a capitalised word after a listed given name is read as its surname; a bare `0042…` number without a separator is read as an order number, not a phone; a password is recognised only next to a keyword (`password`, `token`, `api key`, `secret`, `heslo`, `Passwort` … also inside identifiers such as `DB_PASSWORD`), by a known key format, or as a high-entropy value after `=` / `:`. After an explicit `:` or `=` the whole rest of the line (or the quoted value) is removed: over-redacting is the safe side.
- Detection runs on a normalised copy (NFKC, zero-width and other format characters dropped, Cyrillic/Greek look-alikes folded for secrets) and maps every span back to the original offsets, so redaction covers the characters that were typed. A secret split over two messages is found in the joined text when the record closes: every message text of that record is then removed (ids, digests and the secret flag stay).

## What Observer does with secrets (an honest claim)
Observer removes the secrets it recognises before it stores a message: private keys and certificates (PEM, PuTTY), JWTs, API keys and tokens of the common services, passwords / tokens / keys written as `name = value` (also in identifiers such as `DB_PASSWORD`, in SQL, command lines, JSON, YAML and markdown), credentials in URLs, cookies and authorization headers. It also holds any record that contains a token that merely LOOKS like a secret (a long random-looking string) for your review: such a record is never delivered automatically, and it is not purged automatically either, because it may be a false positive. **It is not a complete secret scanner.** A secret in a form nobody wrote a pattern for can get through, and a record is only held when its text looks suspicious.

## Known limits
This is the end of widening the secret net for this version; S6 tunes the false positives.
- A secret split across two different records, 30 minutes or more apart, is not found: the records are scanned one by one.
- Keywords are recognised in English, Slovak, Czech and German; a key name in another language is found only by its value (a known key format, a high-entropy value after `=` / `:`, or the suspect check below).
- Over-redaction is the safe side: after an explicit `:` or `=` the whole rest of the line is removed.
- A record over 256 KiB (or with more than 2000 messages) is not scanned across messages; it is held for review as suspect instead.
- In a record with more than 200 messages, the seam check between two messages looks at 512 characters on each side (4096 below that), to stay inside the time budget.
- The suspect check is deliberately sensitive and has false positives: long random-looking identifiers, hex strings of 32+ characters without a hash word next to them, base64 data, tokens written in code-like groups. A flagged record is only held for review, never lost. It does not look at tokens shorter than 16 characters, at secrets written in words, or inside images and attachments (Observer stores no attachments).
- URLs are taken apart (userinfo, every path segment, query, fragment); a slug made of plain words is safe, a path segment or query value that looks like a key is not.
- Thread subjects and author handles are checked with the secret and suspect detectors only (not for email addresses or phone numbers: an author handle is metadata).
- A held delivery of a record that goes back to Review is marked `superseded`; S4 must call `deliverySendable` before every send. Until then nothing is sent at all.

