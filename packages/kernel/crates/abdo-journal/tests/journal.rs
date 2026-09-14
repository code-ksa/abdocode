#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use abdo_contracts::{
    AdmissionEvent, CauseRef, CommandId, EventId, KernelSessionId, ProposalId, ReceivedEvent,
    RootCause,
};
#[cfg(feature = "test-hooks")]
use abdo_journal::test_support::execute_authorization_probe;
use abdo_journal::{
    AppendRequest, ChainHash, Head, Journal, JournalError, ProjectionKey, ProjectionUpdate,
    SnapshotInput, StreamId, PINNED_SQLITE_SOURCE_ID, PINNED_SQLITE_VERSION,
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct TempJournal {
    root: PathBuf,
    database: PathBuf,
}

impl TempJournal {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        for _ in 0..1_000 {
            let nonce = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "abdo-journal-{label}-{}-{timestamp}-{nonce}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let database = root.join("journal.sqlite3");
                    return Self { root, database };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create exclusive journal test directory: {error}"),
            }
        }
        panic!("cannot allocate an exclusive journal test directory")
    }

    fn path(&self) -> &Path {
        &self.database
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn id<T>(value: u128) -> T
where
    T: TryFromU128,
{
    T::from_u128(value)
}

trait TryFromU128 {
    fn from_u128(value: u128) -> Self;
}

macro_rules! impl_id {
    ($($type:ty),+ $(,)?) => {
        $(
            impl TryFromU128 for $type {
                fn from_u128(value: u128) -> Self {
                    <$type>::try_from_u128(value).unwrap()
                }
            }
        )+
    };
}

impl_id!(CommandId, EventId, KernelSessionId, ProposalId);

fn event(seed: u128) -> AdmissionEvent {
    AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: id(seed + 1),
        proposal_id: id(seed + 2),
        command_id: id(seed + 3),
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms: 1_000 + seed as u64,
    }))
}

#[test]
fn opens_only_the_pinned_hardened_sqlite_identity() {
    let temp = TempJournal::new("identity");
    let journal = Journal::open(temp.path()).unwrap();
    let identity = journal.sqlite_identity();

    assert_eq!(identity.version, PINNED_SQLITE_VERSION);
    assert_eq!(identity.source_id, PINNED_SQLITE_SOURCE_ID);
    assert_eq!(identity.journal_mode, "wal");
    assert!(identity
        .compile_options
        .iter()
        .any(|item| item == "THREADSAFE=1"));
    assert!(identity
        .compile_options
        .iter()
        .any(|item| item == "DEFAULT_FOREIGN_KEYS"));
}

#[test]
fn append_restore_projection_snapshot_and_blob_cas_share_one_transaction() {
    let temp = TempJournal::new("round-trip");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(11).unwrap();
    let projection_key = ProjectionKey::new("session-state").unwrap();
    let first = event(100);

    let first_receipt = journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: None,
            event: &first,
            projection: Some(ProjectionUpdate {
                key: &projection_key,
                expected_sequence: 0,
                bytes: b"projection-v1",
            }),
            snapshot: Some(SnapshotInput {
                bytes: b"snapshot-v1",
            }),
        })
        .unwrap();

    assert_eq!(first_receipt.global_sequence, 1);
    assert_eq!(first_receipt.stream_sequence, 1);
    let second = event(110);
    let second_receipt = journal
        .append(AppendRequest::event(
            stream,
            Some(first_receipt.head),
            &second,
        ))
        .unwrap();
    assert_eq!(journal.head(stream).unwrap(), Some(second_receipt.head));

    drop(journal);
    let journal = Journal::open(temp.path()).unwrap();
    let restored = journal.restore(stream).unwrap();
    assert_eq!(restored.head, Some(second_receipt.head));
    assert_eq!(restored.snapshot.as_ref().unwrap().bytes, b"snapshot-v1");
    assert_eq!(
        restored.snapshot.as_ref().unwrap().source_hash,
        first_receipt.head.hash
    );
    assert_eq!(restored.events.len(), 1);
    assert_eq!(restored.events[0].event_id, second_receipt.event_id);
    assert_eq!(restored.events[0].previous_hash, first_receipt.head.hash);
    assert_eq!(restored.events[0].hash, second_receipt.head.hash);

    let projection = journal
        .projection(stream, &projection_key)
        .unwrap()
        .unwrap();
    assert_eq!(projection.bytes, b"projection-v1");
    assert_eq!(projection.through_sequence, 1);
    assert_eq!(projection.source_hash, first_receipt.head.hash);

    let report = journal.verify().unwrap();
    assert_eq!(report.events, 2);
    assert_eq!(report.streams, 1);
    assert_eq!(report.blobs, 2);
    assert_eq!(report.snapshots, 1);
    assert_eq!(report.projections, 1);
}

#[test]
fn stale_head_and_stale_projection_are_zero_mutation_failures() {
    let temp = TempJournal::new("cas");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(12).unwrap();
    let first = event(200);
    let first_receipt = journal
        .append(AppendRequest::event(stream, None, &first))
        .unwrap();

    let second = event(300);
    let stale = Head {
        sequence: first_receipt.head.sequence,
        hash: ChainHash::ZERO,
    };
    assert!(matches!(
        journal.append(AppendRequest::event(stream, Some(stale), &second)),
        Err(JournalError::CasConflict { .. })
    ));
    assert_eq!(journal.head(stream).unwrap(), Some(first_receipt.head));
    assert_eq!(journal.verify().unwrap().events, 1);
}

#[test]
fn projection_has_an_independent_cas_and_rolls_back_the_event() {
    let temp = TempJournal::new("projection-cas");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(14).unwrap();
    let key = ProjectionKey::new("session-state").unwrap();
    let first = event(500);
    let first_receipt = journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: None,
            event: &first,
            projection: Some(ProjectionUpdate {
                key: &key,
                expected_sequence: 0,
                bytes: b"projection-one",
            }),
            snapshot: None,
        })
        .unwrap();

    let second = event(600);
    assert!(matches!(
        journal.append(AppendRequest {
            stream_id: stream,
            expected_head: Some(first_receipt.head),
            event: &second,
            projection: Some(ProjectionUpdate {
                key: &key,
                expected_sequence: 0,
                bytes: b"projection-two",
            }),
            snapshot: None,
        }),
        Err(JournalError::ProjectionCasConflict { .. })
    ));
    assert_eq!(journal.head(stream).unwrap(), Some(first_receipt.head));
    assert_eq!(journal.verify().unwrap().events, 1);
    assert_eq!(
        journal.projection(stream, &key).unwrap().unwrap().bytes,
        b"projection-one"
    );
}

#[test]
fn a_second_live_writer_fails_closed_and_the_lock_is_recoverable() {
    let temp = TempJournal::new("writer");
    let first = Journal::open(temp.path()).unwrap();
    assert!(matches!(
        Journal::open(temp.path()),
        Err(JournalError::WriterBusy { .. })
    ));

    drop(first);
    Journal::open(temp.path()).unwrap();
}

#[test]
fn duplicate_event_ids_are_rejected_without_advancing_the_head() {
    let temp = TempJournal::new("duplicate");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(13).unwrap();
    let first = event(400);
    let receipt = journal
        .append(AppendRequest::event(stream, None, &first))
        .unwrap();

    assert!(matches!(
        journal.append(AppendRequest::event(stream, Some(receipt.head), &first)),
        Err(JournalError::DuplicateEvent { .. })
    ));
    assert_eq!(journal.head(stream).unwrap(), Some(receipt.head));
}

#[test]
fn sqlite_head_foreign_key_binds_the_exact_stream_event_tuple() {
    let temp = TempJournal::new("head-exact-foreign-key");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(14).unwrap();
    journal
        .append(AppendRequest::event(stream, None, &event(600)))
        .unwrap();
    drop(journal);

    let connection = rusqlite::Connection::open(temp.path()).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let error = connection
        .execute(
            "UPDATE journal_stream_heads SET stream_sequence = 2 WHERE stream_id = ?1",
            [stream.to_be_bytes().as_slice()],
        )
        .expect_err("a stream head must not point at a different stream sequence");
    assert!(
        error.to_string().contains("FOREIGN KEY constraint failed"),
        "unexpected exact-head constraint failure: {error}"
    );
}

#[test]
fn sqlite_level_immutability_ids_and_extension_denial_are_enforced() {
    let temp = TempJournal::new("sqlite-hardening");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(15).unwrap();
    let key = ProjectionKey::new("session-state").unwrap();
    let first = event(700);
    journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: None,
            event: &first,
            projection: Some(ProjectionUpdate {
                key: &key,
                expected_sequence: 0,
                bytes: b"projection",
            }),
            snapshot: Some(SnapshotInput { bytes: b"snapshot" }),
        })
        .unwrap();
    drop(journal);

    let connection = rusqlite::Connection::open(temp.path()).unwrap();
    let (stream_type, stream_length, event_type, event_length): (String, i64, String, i64) =
        connection
            .query_row(
                "SELECT typeof(stream_id), length(stream_id), typeof(event_id), length(event_id)
                 FROM journal_events WHERE global_sequence = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
    assert_eq!((stream_type.as_str(), stream_length), ("blob", 16));
    assert_eq!((event_type.as_str(), event_length), ("blob", 16));

    for statement in [
        "UPDATE journal_metadata SET sqlite_version = 'forged' WHERE singleton = 1",
        "DELETE FROM journal_metadata WHERE singleton = 1",
        "UPDATE journal_blobs SET bytes = bytes",
        "DELETE FROM journal_blobs",
        "UPDATE journal_snapshots SET source_hash = source_hash",
        "DELETE FROM journal_snapshots",
        "UPDATE journal_migrations SET checksum = checksum",
        "DELETE FROM journal_migrations",
    ] {
        assert!(
            connection.execute(statement, []).is_err(),
            "SQLite-level immutability guard accepted: {statement}"
        );
    }
    let extension_error = connection
        .query_row("SELECT load_extension('')", [], |row| {
            row.get::<_, String>(0)
        })
        .expect_err("SQLite extension loading must remain unauthorized");
    assert!(
        extension_error.to_string().contains("not authorized"),
        "unexpected load_extension failure: {extension_error}"
    );
    drop(connection);

    Journal::open(temp.path()).unwrap().verify().unwrap();
}

#[test]
fn sequence_values_above_sqlite_i64_are_rejected_before_mutation() {
    let temp = TempJournal::new("sequence-overflow");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(16).unwrap();
    let first = event(800);
    let impossible = Head {
        sequence: i64::MAX as u64 + 1,
        hash: ChainHash::ZERO,
    };
    assert!(matches!(
        journal.append(AppendRequest::event(stream, Some(impossible), &first)),
        Err(JournalError::InvalidInput(_))
    ));
    assert_eq!(journal.verify().unwrap().events, 0);
}

#[test]
fn exact_schema_manifest_rejects_a_dropped_or_rogue_journal_object() {
    let dropped = TempJournal::new("schema-dropped");
    drop(Journal::open(dropped.path()).unwrap());
    let connection = rusqlite::Connection::open(dropped.path()).unwrap();
    connection
        .execute_batch("DROP TRIGGER journal_events_no_update;")
        .unwrap();
    drop(connection);
    assert!(matches!(
        Journal::open(dropped.path()),
        Err(JournalError::Integrity(_))
    ));

    let rogue = TempJournal::new("schema-rogue");
    drop(Journal::open(rogue.path()).unwrap());
    let connection = rusqlite::Connection::open(rogue.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER rogue_after_insert
             AFTER INSERT ON journal_events
             BEGIN
                 SELECT 1;
             END;",
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        Journal::open(rogue.path()),
        Err(JournalError::Integrity(_))
    ));
}

#[test]
fn blob_limit_is_a_sql_constraint_and_ignored_checks_still_fail_closed() {
    const OVERSIZED: i64 = 16_777_217;
    let temp = TempJournal::new("blob-bound");
    drop(Journal::open(temp.path()).unwrap());
    let connection = rusqlite::Connection::open(temp.path()).unwrap();
    let hash = [0x7a_u8; 32];
    assert!(
        connection
            .execute(
                "INSERT INTO journal_blobs(hash, size, bytes)
                 VALUES (?1, ?2, zeroblob(?2))",
                rusqlite::params![hash.as_slice(), OVERSIZED],
            )
            .is_err(),
        "the SQLite CHECK must reject a blob above 16MiB"
    );
    connection
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    connection
        .execute(
            "INSERT INTO journal_blobs(hash, size, bytes)
             VALUES (?1, ?2, zeroblob(?2))",
            rusqlite::params![hash.as_slice(), OVERSIZED],
        )
        .unwrap();
    drop(connection);
    assert!(
        Journal::open(temp.path()).is_err(),
        "a persisted oversized blob must be rejected without an unbounded Rust read"
    );
}

#[test]
fn a_persistent_hard_link_alias_cannot_reopen_the_journal() {
    let temp = TempJournal::new("hard-link");
    let journal = Journal::open(temp.path()).unwrap();
    let alias = temp.root.join("journal-alias.sqlite3");
    fs::hard_link(temp.path(), &alias).unwrap();

    assert!(
        Journal::open(&alias).is_err(),
        "a live journal must reject an alternate hard-link name"
    );
    #[cfg(unix)]
    assert!(
        journal.head(StreamId::try_from_u128(18).unwrap()).is_err(),
        "Unix public reads must reject a database while its link count is not one"
    );
    drop(journal);

    assert!(
        Journal::open(&alias).is_err(),
        "the persisted canonical-path digest must reject an alias after close"
    );
    #[cfg(unix)]
    assert!(
        Journal::open(temp.path()).is_err(),
        "Unix reopen must reject a database while its link count is not one"
    );

    fs::remove_file(alias).unwrap();
    Journal::open(temp.path()).unwrap();
}

#[cfg(unix)]
#[test]
fn a_hard_linked_wal_sidecar_blocks_every_public_read() {
    let temp = TempJournal::new("wal-hard-link");
    let mut journal = Journal::open(temp.path()).unwrap();
    let stream = StreamId::try_from_u128(17).unwrap();
    journal
        .append(AppendRequest::event(stream, None, &event(900)))
        .unwrap();
    let mut wal = temp.path().as_os_str().to_owned();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    let alias = temp.root.join("wal-alias");
    fs::hard_link(&wal, &alias).unwrap();
    assert!(matches!(
        journal.head(stream),
        Err(JournalError::Integrity(_))
    ));
    fs::remove_file(alias).unwrap();
    assert!(journal.head(stream).is_ok());
}

#[cfg(feature = "test-hooks")]
#[test]
fn runtime_authorizer_denies_database_escape_and_schema_ddl() {
    let temp = TempJournal::new("authorizer");
    let journal = Journal::open(temp.path()).unwrap();
    for sql in [
        "ATTACH DATABASE ':memory:' AS escaped",
        "DETACH DATABASE escaped",
        "CREATE TABLE escaped_table(value INTEGER)",
    ] {
        assert!(
            execute_authorization_probe(&journal, sql).is_err(),
            "runtime authorizer accepted: {sql}"
        );
    }
    let vacuum_target = temp.root.join("vacuum-escape.sqlite3");
    let vacuum_sql = format!("VACUUM INTO '{}'", vacuum_target.display());
    assert!(execute_authorization_probe(&journal, &vacuum_sql).is_err());
    assert!(
        !vacuum_target.exists(),
        "denied VACUUM INTO must not create a second database"
    );
    journal.verify().unwrap();
}
