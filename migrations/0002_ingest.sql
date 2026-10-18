-- S2 ingest (DESIGN §4.1, §4.3): what the job runner writes after each page of Connect's data_pull. Forward-only.
-- anchor_at     when the anchor was captured (source_add / backfill_start), BEFORE the job started: a history read ends there
-- last_read_at  when the last page was stored (the source card shows it)
-- skipped_count rows that did not conform to messages/1 (skipped by Observer) or that Connect itself quarantined: never stored
-- error_code    the code of the last failure (last_error is the sentence the owner reads); `cursor_invalid` lets a resume
--               start again from the beginning of what Connect keeps instead of failing on the same cursor for ever
ALTER TABLE obs_jobs ADD COLUMN anchor_at INTEGER;
ALTER TABLE obs_jobs ADD COLUMN last_read_at INTEGER;
ALTER TABLE obs_jobs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE obs_jobs ADD COLUMN error_code TEXT;
-- note          a sentence for the owner about the job that is not an error (a live job that restarted from a fresh anchor
--               after `cursor_invalid` says which time span may be missing)
ALTER TABLE obs_jobs ADD COLUMN note TEXT;
-- kept_days     how many days Connect keeps this account's messages (data_catalog retentionDays, read at source_add); with
--               history_capable it is what the source card says about history
ALTER TABLE obs_sources ADD COLUMN kept_days INTEGER;
-- caught_up_at  live: when a page last came back `exhausted` (everything up to then was read); a restart's gap starts here
-- gap_from      live: the start of a span a restart from a fresh anchor may have missed (it ends at anchor_at); cleared, with
--               the note, only when a history read that covers the span is done
ALTER TABLE obs_jobs ADD COLUMN caught_up_at INTEGER;
ALTER TABLE obs_jobs ADD COLUMN gap_from INTEGER;
-- problem       a record Observer could not window or route (an error of its own pipeline): it is held in Review as a possible
--               secret with this fixed reason, so one bad record never stalls the source
ALTER TABLE obs_records ADD COLUMN problem TEXT;
