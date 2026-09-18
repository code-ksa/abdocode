
-- Compaction as a journal transaction (S130, DeepSeek-3).
--
-- Compaction is where a session's history is replaced by a summary, and doing
-- it from the engine — read a range, write a summary, hope — is how a run loses
-- the only copy of what it did. So it is a transaction here, next to the events
-- it shadows, and it obeys the same rule everything in this file obeys: nothing
-- is deleted.
--
-- A compaction SHADOWS a precise range. The events stay exactly where they
-- were, with their sequences and their hash chain untouched, and the triggers
-- below make that structural rather than a promise. `read_from` still returns
-- the raw range, so the shadowed span remains rebuildable — which is the
-- difference between compaction and loss.
--
-- Two invariants are expressed as CHECKs rather than as Rust, because a
-- constraint the database enforces cannot be bypassed by a future caller who
-- did not read the function:
--
--   * `through_sequence >= from_sequence` — an empty or inverted range is not
--     a compaction, it is a bug with a receipt.
--   * `tokens_after <= tokens_before` — a "compaction" that grew the stream is
--     refused by the schema. Without this it would be recorded as a success and
--     nobody would look again.
--
-- The foreign key to `journal_events` is the anchor: a compaction must name an
-- event that exists, at the sequence it claims, with the hash it claims. A
-- shadow over a range nobody can verify is a summary with no provenance, which
-- is the thing structured memory exists to avoid.
--
-- Statement text below a marker must begin with its CREATE, because the
-- canonical schema manifest matches each object by that prefix.
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_compactions (
    stream_id BLOB NOT NULL CHECK (length(stream_id) = 16),
    from_sequence INTEGER NOT NULL CHECK (from_sequence > 0),
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= from_sequence),
    source_hash BLOB NOT NULL CHECK (length(source_hash) = 32),
    blob_hash BLOB NOT NULL CHECK (length(blob_hash) = 32),
    tokens_before INTEGER NOT NULL CHECK (tokens_before >= 0),
    tokens_after INTEGER NOT NULL CHECK (tokens_after >= 0 AND tokens_after <= tokens_before),
    PRIMARY KEY (stream_id, from_sequence),
    FOREIGN KEY (stream_id, through_sequence, source_hash)
        REFERENCES journal_events(stream_id, stream_sequence, event_hash),
    FOREIGN KEY (blob_hash) REFERENCES journal_blobs(hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE INDEX journal_compactions_latest
    ON journal_compactions(stream_id, through_sequence DESC);
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_compactions_no_update
BEFORE UPDATE ON journal_compactions
BEGIN
    SELECT RAISE(ABORT, 'journal compactions are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_compactions_no_delete
BEFORE DELETE ON journal_compactions
BEGIN
    SELECT RAISE(ABORT, 'journal compactions are append-only');
END;
