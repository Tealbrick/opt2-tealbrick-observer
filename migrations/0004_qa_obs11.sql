-- C373 QA-OBS11 fixes. Forward-only.
-- same_cursor_count   consecutive pages that did not move the cursor and did not finish the read (a Connect that loops): at
--                     STUCK_LIMIT the job fails with a plain sentence instead of polling for ever
ALTER TABLE obs_jobs ADD COLUMN same_cursor_count INTEGER NOT NULL DEFAULT 0;

-- version / tags_json  the Knowledge version Observer's last write left (document_update sends expectedVersion = it, so a human
--                      edit in Knowledge is never overwritten) and the tags that write set (a tag-only change keeps them)
ALTER TABLE obs_targets ADD COLUMN version INTEGER;
ALTER TABLE obs_targets ADD COLUMN tags_json TEXT;

-- target_key / payload_op  the provenance key and the op of the stored call (payload_json): an attempted document_create whose
--                          answer is lost must be resolved BEFORE a newer revision of the same document creates another one
ALTER TABLE obs_deliveries ADD COLUMN target_key TEXT;
ALTER TABLE obs_deliveries ADD COLUMN payload_op TEXT;
CREATE INDEX obs_deliveries_by_target ON obs_deliveries (target_key);

-- A document deleted at its source whose Knowledge copy must follow the privacy setting `onSourceDelete`:
--   archive  (purge) document_update: status archived, body and summary replaced by a short notice, tag source-deleted
--   tag      (keep)  document_update: tags only (the stored tags + source-deleted); the text stays until the retention ends
-- One row per provenance key. No text is stored here.
CREATE TABLE obs_retractions (
  key TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('knowledge')),
  target_ref TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('archive', 'tag')),
  idem_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, destination)
);
