-- C373: documents sources (S2, contract documents/1 DRAFT) and deliveries to Knowledge (S4). Forward-only.
-- dataset        which Connect dataset the source reads: messages (messages/1) or documents (documents/1). For documents the
--                source's `conversations_json` holds the chosen COLLECTIONS (the unit an owner shares and an app picks).
ALTER TABLE obs_sources ADD COLUMN dataset TEXT NOT NULL DEFAULT 'messages' CHECK (dataset IN ('messages', 'documents'));

-- One row per document Observer read (dedupe key: the source's account, the collection and the document id; a source has one
-- account). `rev` and `updated_at` are the newest revision Observer took; an older or equal one is ignored. The document's text is
-- stored as chunk messages (obs_messages, provider_msg_id "<id>#<n>") of ONE record (`record_id`). A new revision retires the old
-- record and makes a new one; `deleted` = the provider deleted it (its text goes per privacy `onSourceDelete`).
CREATE TABLE obs_documents (
  source_id TEXT NOT NULL REFERENCES obs_sources (id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT,                                -- documents/1 `kind` hint (document | chat_transcript | table | report | record)
  mime TEXT NOT NULL DEFAULT 'text/plain',  -- text/plain | text/markdown | text/csv (a CSV body has its formula cells escaped on delivery)
  url TEXT,                                 -- https link to the original (cleaned), when the source has one
  path TEXT,                                -- human path (cleaned)
  deleted INTEGER NOT NULL DEFAULT 0,
  record_id TEXT,
  PRIMARY KEY (source_id, collection, doc_id)
);
CREATE INDEX obs_documents_by_record ON obs_documents (record_id);

-- Where a delivered thing lives in the destination, so a newer revision UPDATES it instead of making a copy. Keyed on the
-- provenance, not on the source row: removing and adding a source again keeps the link (Knowledge keeps the documents).
--   documents: key = "doc:" + account + NUL + collection + NUL + document id
--   messages : key = "rec:" + record id
CREATE TABLE obs_targets (
  key TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('knowledge', 'kanban', 'inbox')),
  target_ref TEXT NOT NULL,                 -- the Knowledge document id
  area TEXT,                                -- the Knowledge area it was created in
  rev TEXT,                                 -- the document revision (documents) or record revision (messages) last sent
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, destination)
);

-- payload_json   the exact companion call (op + input) built at the first attempt; every retry sends these bytes with the same key
ALTER TABLE obs_deliveries ADD COLUMN payload_json TEXT;
