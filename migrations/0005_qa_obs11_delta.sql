-- C373 QA-OBS11 delta fixes. Forward-only.
-- frozen_at   set when a person changed the Knowledge document after Observer's last write (version_conflict): Observer no longer
--             updates that document (later revisions wait in ONE failed delivery) until the owner presses Retry on it, which forgets
--             the link so the next send makes a new document and leaves the edited one as the person made it
ALTER TABLE obs_targets ADD COLUMN frozen_at INTEGER;
