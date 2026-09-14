
-- The durable effect ledger.
--
-- It lives in the one journal database on purpose. A second store would mean a
-- second writer, a second crash story and a second truth, and the boundary
-- guard forbids exactly that.
--
-- The journal does not know what a phase means. It stores an opaque phase tag
-- and enforces that the same effect never records the same phase twice. That
-- uniqueness is the exactly-once guarantee, held by the database rather than by
-- a check in code that a crash can skip.
--
-- Statement text below a marker must begin with its CREATE, because the
-- canonical schema manifest matches each object by that prefix.
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_effects (
    intent_id BLOB NOT NULL CHECK (length(intent_id) = 16),
    phase_sequence INTEGER NOT NULL CHECK (phase_sequence > 0),
    phase_tag INTEGER NOT NULL CHECK (phase_tag > 0 AND phase_tag < 256),
    stream_id BLOB NOT NULL CHECK (length(stream_id) = 16),
    cause_event_hash BLOB NOT NULL CHECK (length(cause_event_hash) = 32),
    payload_hash BLOB NOT NULL CHECK (length(payload_hash) = 32),
    previous_hash BLOB NOT NULL CHECK (length(previous_hash) = 32),
    record_hash BLOB NOT NULL UNIQUE CHECK (length(record_hash) = 32),
    at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
    PRIMARY KEY (intent_id, phase_sequence),
    UNIQUE (intent_id, phase_tag),
    FOREIGN KEY (payload_hash) REFERENCES journal_blobs(hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE INDEX journal_effects_latest
    ON journal_effects(intent_id, phase_sequence DESC);
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_effects_no_update
BEFORE UPDATE ON journal_effects
BEGIN
    SELECT RAISE(ABORT, 'journal effect records are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_effects_no_delete
BEFORE DELETE ON journal_effects
BEGIN
    SELECT RAISE(ABORT, 'journal effect records are append-only');
END;
