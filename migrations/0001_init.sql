-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only (prefix obs_); `tb_*` names are reserved for the SDK. Design: leads/scribe/DESIGN.md §4.1 (Observer, C190).
-- Message text is personal data of third parties: it is kept only inside the retention (privacy_set) and never returned to
-- agents (DESIGN §5.7).

CREATE TABLE obs_sources (
  id TEXT PRIMARY KEY,                      -- src_<ULID>
  account TEXT NOT NULL,                    -- Connect account ref (shared with Observer, read only)
  kind TEXT NOT NULL,                       -- gmail | slack | discord | telegram | buzz | … (from Connect)
  label TEXT NOT NULL,
  conversations_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '{"senders":[],"domains":[]}',
  live_interval_s INTEGER NOT NULL DEFAULT 60 CHECK (live_interval_s BETWEEN 15 AND 3600),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 365),
  history_capable INTEGER NOT NULL DEFAULT 1,  -- Telegram bots: 0 (live only)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per Observer job; leases, attempts and retries live in the SDK job runner (tb_jobs, R1).
CREATE TABLE obs_jobs (
  id TEXT PRIMARY KEY,                      -- job_<ULID>
  source_id TEXT NOT NULL REFERENCES obs_sources (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('live', 'backfill')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'paused', 'done', 'failed', 'cancelled')),
  sdk_job_id TEXT,                          -- the SDK job that runs it
  cursor TEXT,                              -- opaque, from Connect
  anchor TEXT,                              -- backfill: captured BEFORE it starts (no gap, no double)
  since_at INTEGER,
  until_at INTEGER,
  max_messages INTEGER,
  read_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  last_error TEXT,
  paused_by TEXT,                           -- per_… / agt_… (who paused)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX obs_jobs_by_source ON obs_jobs (source_id, kind);

CREATE TABLE obs_messages (
  source_id TEXT NOT NULL REFERENCES obs_sources (id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  provider_msg_id TEXT NOT NULL,
  thread TEXT,
  sent_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  author_ref TEXT NOT NULL,                 -- canonical handle (<channel>:<value>)
  author_key TEXT NOT NULL,                 -- author_ref as NFC + JS toLowerCase (exclusions compare in JS; SQLite lower() is ASCII only)
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'bot', 'self')),
  text TEXT,                                -- NULL after purge; ≤ 16 KiB (longer is cut with a marker)
  text_digest TEXT NOT NULL,                -- HMAC-SHA256 with the app secret obs_digest_key (a plain hash of a short message can be guessed)
  record_id TEXT,
  PRIMARY KEY (source_id, conversation, provider_msg_id)  -- idempotent ingestion (DESIGN §4.1)
);
CREATE INDEX obs_messages_by_record ON obs_messages (record_id);

CREATE TABLE obs_records (
  id TEXT PRIMARY KEY,                      -- rec_<ULID>
  source_id TEXT NOT NULL REFERENCES obs_sources (id) ON DELETE CASCADE,
  thread TEXT,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('open', 'classified', 'review', 'approved', 'delivered', 'dropped')),
  pii_json TEXT NOT NULL DEFAULT '{}',      -- class → count (never the values)
  secret INTEGER NOT NULL DEFAULT 0,        -- a secret was found (and removed before storage); only "drop" is allowed
  rule_id TEXT,
  actionable INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at INTEGER,
  decided_destination TEXT,                 -- where the owner decided to deliver (knowledge | kanban | inbox); NULL for drop / keep. A retry must match it
  text_purge_at INTEGER,                    -- when the text of this record's messages goes (retention)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX obs_records_by_state ON obs_records (state, updated_at DESC);

CREATE TABLE obs_deliveries (
  id TEXT PRIMARY KEY,                      -- dlv_<ULID>
  record_id TEXT NOT NULL REFERENCES obs_records (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('knowledge', 'kanban', 'inbox')),
  target_ref TEXT,                          -- document / issue / item id once sent
  idem_key TEXT NOT NULL UNIQUE,            -- obs_ + sha256(record, revision, destination)[0..40]
  input_json TEXT NOT NULL,                 -- exact bytes replayed on retry
  status TEXT NOT NULL CHECK (status IN ('pending', 'held', 'sent', 'failed')),
  hold_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  first_attempt_at INTEGER,
  last_error TEXT,
  warning TEXT,                             -- e.g. may_duplicate: set when a retry after 23 h made a new key
  superseded INTEGER NOT NULL DEFAULT 0,    -- 1 when its record went back to Review after the decision (a held row stays held; S4 must not send it)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (record_id, revision, destination) -- one outbox row per record revision and destination, whatever its key
);
CREATE INDEX obs_deliveries_by_status ON obs_deliveries (status, next_at);

-- Routing rules: first match decides; no match → Review. Rule 0 ("never keep secrets") is created by the app and locked.
CREATE TABLE obs_rules (
  id TEXT PRIMARY KEY,                      -- rul_<ULID> (rule 0: rul_00000000000000000000000000)
  position INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  match_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE obs_flags (
  id TEXT PRIMARY KEY,                      -- flg_<ULID>
  record_id TEXT NOT NULL REFERENCES obs_records (id) ON DELETE CASCADE,
  by_type TEXT NOT NULL,
  by_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER                         -- set when the owner decides the record again; one OPEN flag per (agent, record)
);
CREATE INDEX obs_flags_by_agent_day ON obs_flags (by_id, created_at);

CREATE TABLE obs_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
