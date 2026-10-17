# Changelog

All notable changes to Observer. One section per released version (handbook §3.2).

## Unreleased (0.1.0)
- Scaffold from create-tealbrick-miniapp (template ci-v9.10); pins miniapp-sdk 0.1.25, manifest 0.1.18, conformance 0.1.18, ui 0.2.4. Refs: C160, C169, C190
- S1 core: one handler per manifest op (28) on the `obs_*` tables: agent `status` (labels and counts only), `job_pause`, `flag` (delivered records only, 50 a day); owner sources, jobs (state machine), rules (locked rule 0), review decisions (secret records: drop only; outbox rows pending), records, deliveries, privacy, purge. Connect-dependent ops answer `connect_unavailable` until Connect offers `data_pull`. Manifest invariant tests, conformance fixtures. Refs: C169
