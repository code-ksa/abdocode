-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_global_sequence INTEGER NOT NULL CHECK (next_global_sequence >= 0),
    sqlite_version TEXT NOT NULL,
    sqlite_source_id TEXT NOT NULL,
    database_path_hash BLOB NOT NULL CHECK (length(database_path_hash) = 32),
    normalized_options_hash BLOB NOT NULL CHECK (length(normalized_options_hash) = 32),
    full_options_hash BLOB NOT NULL CHECK (length(full_options_hash) = 32)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    checksum BLOB NOT NULL UNIQUE CHECK (length(checksum) = 32)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_blobs (
    hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
    size INTEGER NOT NULL CHECK (size >= 0 AND size <= 16777216 AND size = length(bytes)),
    bytes BLOB NOT NULL
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_events (
    global_sequence INTEGER PRIMARY KEY CHECK (global_sequence > 0),
    stream_id BLOB NOT NULL CHECK (length(stream_id) = 16),
    stream_sequence INTEGER NOT NULL CHECK (stream_sequence > 0),
    event_id BLOB NOT NULL UNIQUE CHECK (length(event_id) = 16),
    previous_hash BLOB NOT NULL CHECK (length(previous_hash) = 32),
    event_hash BLOB NOT NULL UNIQUE CHECK (length(event_hash) = 32),
    event_frame BLOB NOT NULL CHECK (length(event_frame) BETWEEN 1 AND 65536),
    UNIQUE (stream_id, stream_sequence),
    UNIQUE (stream_id, stream_sequence, event_hash),
    UNIQUE (stream_id, stream_sequence, global_sequence, event_hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_stream_heads (
    stream_id BLOB PRIMARY KEY CHECK (length(stream_id) = 16),
    stream_sequence INTEGER NOT NULL CHECK (stream_sequence > 0),
    global_sequence INTEGER NOT NULL CHECK (global_sequence > 0),
    event_hash BLOB NOT NULL CHECK (length(event_hash) = 32),
    FOREIGN KEY (stream_id, stream_sequence, global_sequence, event_hash)
        REFERENCES journal_events(stream_id, stream_sequence, global_sequence, event_hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_snapshots (
    stream_id BLOB NOT NULL CHECK (length(stream_id) = 16),
    through_sequence INTEGER NOT NULL CHECK (through_sequence > 0),
    source_hash BLOB NOT NULL CHECK (length(source_hash) = 32),
    blob_hash BLOB NOT NULL CHECK (length(blob_hash) = 32),
    PRIMARY KEY (stream_id, through_sequence),
    FOREIGN KEY (stream_id, through_sequence, source_hash)
        REFERENCES journal_events(stream_id, stream_sequence, event_hash),
    FOREIGN KEY (blob_hash) REFERENCES journal_blobs(hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_projections (
    stream_id BLOB NOT NULL CHECK (length(stream_id) = 16),
    projection_key TEXT NOT NULL CHECK (length(projection_key) BETWEEN 1 AND 64),
    through_sequence INTEGER NOT NULL CHECK (through_sequence > 0),
    source_hash BLOB NOT NULL CHECK (length(source_hash) = 32),
    blob_hash BLOB NOT NULL CHECK (length(blob_hash) = 32),
    PRIMARY KEY (stream_id, projection_key),
    FOREIGN KEY (stream_id, through_sequence, source_hash)
        REFERENCES journal_events(stream_id, stream_sequence, event_hash),
    FOREIGN KEY (blob_hash) REFERENCES journal_blobs(hash)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE INDEX journal_snapshots_latest
    ON journal_snapshots(stream_id, through_sequence DESC);
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_events_no_update
BEFORE UPDATE ON journal_events
BEGIN
    SELECT RAISE(ABORT, 'journal events are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_events_no_delete
BEFORE DELETE ON journal_events
BEGIN
    SELECT RAISE(ABORT, 'journal events are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_blobs_no_update
BEFORE UPDATE ON journal_blobs
BEGIN
    SELECT RAISE(ABORT, 'journal blobs are immutable');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_blobs_no_delete
BEFORE DELETE ON journal_blobs
BEGIN
    SELECT RAISE(ABORT, 'journal blobs are immutable');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_snapshots_no_update
BEFORE UPDATE ON journal_snapshots
BEGIN
    SELECT RAISE(ABORT, 'journal snapshots are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_snapshots_no_delete
BEFORE DELETE ON journal_snapshots
BEGIN
    SELECT RAISE(ABORT, 'journal snapshots are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_migrations_no_update
BEFORE UPDATE ON journal_migrations
BEGIN
    SELECT RAISE(ABORT, 'journal migration history is immutable');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_migrations_no_delete
BEFORE DELETE ON journal_migrations
BEGIN
    SELECT RAISE(ABORT, 'journal migration history is immutable');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_metadata_identity_no_update
BEFORE UPDATE ON journal_metadata
WHEN NEW.singleton != OLD.singleton
  OR NEW.sqlite_version != OLD.sqlite_version
  OR NEW.sqlite_source_id != OLD.sqlite_source_id
  OR NEW.database_path_hash != OLD.database_path_hash
  OR NEW.normalized_options_hash != OLD.normalized_options_hash
  OR NEW.full_options_hash != OLD.full_options_hash
BEGIN
    SELECT RAISE(ABORT, 'journal build identity is immutable');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_metadata_no_delete
BEFORE DELETE ON journal_metadata
BEGIN
    SELECT RAISE(ABORT, 'journal metadata cannot be deleted');
END;
