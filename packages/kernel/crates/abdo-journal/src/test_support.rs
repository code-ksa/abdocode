use std::fs;
use std::path::Path;

use abdo_contracts::{
    AdmissionEvent, CauseRef, CommandId, EventId, ProposalId, ReceivedEvent, RootCause,
};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest as ShaDigest, Sha256};

use crate::identity::harden_connection;
use crate::migration::{migration_statement_counts, APPLICATION_ID, LATEST_SCHEMA_VERSION};
use crate::{ChainHash, Head, Journal, JournalError, SqliteIdentity, StreamId};

pub const TEST_CHILD_ROLE_ENV: &str = "ABDO_JOURNAL_TEST_CHILD_ROLE";
pub const TEST_CHILD_DIR_ENV: &str = "ABDO_JOURNAL_TEST_CHILD_DIR";
pub const TEST_CRASH_TOKEN_ENV: &str = "ABDO_JOURNAL_TEST_CRASH_TOKEN";
pub const TEST_CRASH_POINT_ENV: &str = "ABDO_JOURNAL_TEST_CRASH_POINT";
pub const TEST_HANDSHAKE_FILENAME: &str = ".abdo-journal-test-token";
pub const CRASH_EXIT_CODE: i32 = 86;
const FIXTURE_DOMAIN: &[u8] = b"ABDO/JOURNAL/FIXTURE/1\0";
const PARENT_GATE_ENVS: &[&str] = &[
    "ABDO_JOURNAL_CRASH_10K_PARENT_GATE",
    "ABDO_JOURNAL_MIGRATION_PARENT_GATE",
    "ABDO_JOURNAL_RESTORE_100K_PARENT_GATE",
];

pub const TEST_APPEND_CRASH_POINTS: &[&str] = &[
    "append.before_begin",
    "append.after_begin",
    "append.after_event_insert",
    "append.after_projection",
    "append.after_snapshot",
    "append.after_head_cas",
    "append.before_commit",
    "append.after_commit_before_ack",
];

pub const TEST_CHECKPOINT_CRASH_POINTS: &[&str] = &["checkpoint.before", "checkpoint.after"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MigrationState {
    Empty,
    /// Wholly at an applied migration version that is not yet the latest.
    ///
    /// With more than one migration this is a legitimate resting place, not a
    /// half-applied one: a crash between two migrations leaves the database
    /// entirely at the earlier version, with that version recorded and its
    /// objects present. Treating it as corruption would be reading "atomic" as
    /// "all migrations commit together", which they deliberately do not.
    Intermediate {
        version: u32,
    },
    Current,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FixtureSeedReport {
    pub events: u64,
    pub snapshot_sequence: u64,
    pub head: Head,
    pub fixture_digest: [u8; 32],
}

pub fn fold_fixture_digest(previous: [u8; 32], hash: ChainHash) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(FIXTURE_DOMAIN);
    hasher.update(previous);
    hasher.update(hash.as_bytes());
    hasher.finalize().into()
}

pub fn execute_authorization_probe(journal: &Journal, sql: &str) -> Result<(), JournalError> {
    journal.execute_authorization_probe(sql)
}

pub fn seed_fixture(
    journal: &mut Journal,
    stream_id: StreamId,
    start_seed: u128,
    count: u64,
    snapshot_sequence: u64,
) -> Result<FixtureSeedReport, JournalError> {
    ensure_authorized_test_child(journal.database_path_for_test())?;
    if std::env::var_os(TEST_CRASH_POINT_ENV).is_some() {
        return Err(JournalError::InvalidInput(
            "fixture seeding forbids an append crash-point marker",
        ));
    }
    let report = journal.seed_fixture_batch(stream_id, start_seed, count, snapshot_sequence)?;
    journal.checkpoint()?;
    let verified = journal.verify()?;
    if verified.events != count || verified.snapshots != 1 {
        return Err(JournalError::Integrity(
            "fixture verification count differs after seeding".to_owned(),
        ));
    }
    Ok(report)
}

pub fn migration_crash_points() -> Vec<String> {
    let mut points = vec![
        "migration.before_begin".to_owned(),
        "migration.after_begin".to_owned(),
    ];
    for (version, statements) in migration_statement_counts() {
        points.extend(
            (1..=statements).map(|index| format!("migration.after_statement.{version}.{index}")),
        );
    }
    points.extend([
        "migration.before_record".to_owned(),
        "migration.after_record".to_owned(),
        "migration.before_commit".to_owned(),
        "migration.after_commit".to_owned(),
    ]);
    points
}

pub fn inspect_migration_state(path: &Path) -> Result<MigrationState, JournalError> {
    if !path.exists() {
        return Ok(MigrationState::Empty);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|source| JournalError::sqlite("inspect migration state", source))?;
    connection
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(|source| JournalError::sqlite("bound migration inspector wait", source))?;
    harden_connection(&connection)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|source| JournalError::sqlite("enable inspector foreign keys", source))?;
    let locking_mode = connection
        .pragma_update_and_check(None, "locking_mode", "EXCLUSIVE", |row| {
            row.get::<_, String>(0)
        })
        .map_err(|source| JournalError::sqlite("lock migration inspector", source))?;
    if !locking_mode.eq_ignore_ascii_case("exclusive") {
        return Err(JournalError::Integrity(
            "migration inspector could not acquire exclusive mode".to_owned(),
        ));
    }
    connection
        .execute_batch("BEGIN EXCLUSIVE; COMMIT;")
        .map_err(|source| JournalError::sqlite("acquire migration inspector lock", source))?;
    let application_id: u32 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|source| JournalError::sqlite("inspect application id", source))?;
    let user_version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|source| JournalError::sqlite("inspect schema version", source))?;
    let table_count: u32 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_schema
             WHERE type IN ('table', 'index', 'trigger') AND name LIKE 'journal_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|source| JournalError::sqlite("inspect journal schema", source))?;

    if application_id == 0 && user_version == 0 && table_count == 0 {
        return Ok(MigrationState::Empty);
    }
    if application_id == APPLICATION_ID && user_version == LATEST_SCHEMA_VERSION {
        SqliteIdentity::inspect(&connection)?;
        crate::migration::verify_migration_history(&connection)?;
        return Ok(MigrationState::Current);
    }
    if application_id == APPLICATION_ID
        && user_version > 0
        && user_version < LATEST_SCHEMA_VERSION
        && table_count > 0
    {
        // Whole, just not finished. The recorded history must agree exactly
        // with the versions claimed, or this really is a mixed state.
        SqliteIdentity::inspect(&connection)?;
        crate::migration::verify_migration_history_through(&connection, user_version)?;
        return Ok(MigrationState::Intermediate {
            version: user_version,
        });
    }
    Err(JournalError::Integrity(format!(
        "mixed migration state: application_id={application_id:#x}, user_version={user_version}, journal_objects={table_count}"
    )))
}

pub(crate) fn maybe_crash(database_path: &Path, point: &str) {
    if std::env::var(TEST_CHILD_ROLE_ENV).as_deref() != Ok("1")
        || std::env::var(TEST_CRASH_POINT_ENV).as_deref() != Ok(point)
    {
        return;
    }
    if ensure_authorized_test_child(database_path).is_err() {
        return;
    }
    std::process::exit(CRASH_EXIT_CODE);
}

pub(crate) fn fixture_event(seed: u128) -> Result<AdmissionEvent, JournalError> {
    let event_id = seed
        .checked_add(1)
        .ok_or(JournalError::InvalidInput("fixture event id overflow"))?;
    let proposal_id = seed
        .checked_add(2)
        .ok_or(JournalError::InvalidInput("fixture proposal id overflow"))?;
    let command_id = seed
        .checked_add(3)
        .ok_or(JournalError::InvalidInput("fixture command id overflow"))?;
    let at_ms = u64::try_from(seed)
        .ok()
        .and_then(|value| value.checked_add(1_000))
        .ok_or(JournalError::InvalidInput("fixture timestamp overflow"))?;
    Ok(AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: EventId::try_from_u128(event_id)
            .map_err(|_| JournalError::InvalidInput("fixture event id is zero"))?,
        proposal_id: ProposalId::try_from_u128(proposal_id)
            .map_err(|_| JournalError::InvalidInput("fixture proposal id is zero"))?,
        command_id: CommandId::try_from_u128(command_id)
            .map_err(|_| JournalError::InvalidInput("fixture command id is zero"))?,
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms,
    })))
}

fn ensure_authorized_test_child(database_path: &Path) -> Result<(), JournalError> {
    if std::env::var(TEST_CHILD_ROLE_ENV).as_deref() != Ok("1") {
        return Err(JournalError::InvalidInput(
            "test child role marker is absent",
        ));
    }
    if PARENT_GATE_ENVS
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        return Err(JournalError::InvalidInput(
            "test child cannot inherit a parent gate marker",
        ));
    }
    let token = std::env::var(TEST_CRASH_TOKEN_ENV)
        .map_err(|_| JournalError::InvalidInput("test child token is absent"))?;
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(JournalError::InvalidInput(
            "test child token is not canonical lowercase SHA-256 hex",
        ));
    }
    let child_dir = std::env::var(TEST_CHILD_DIR_ENV)
        .map_err(|_| JournalError::InvalidInput("test child directory is absent"))?;
    let child_dir = fs::canonicalize(child_dir)
        .map_err(|_| JournalError::InvalidInput("test child directory is not canonicalizable"))?;
    if !child_dir.is_absolute() {
        return Err(JournalError::InvalidInput(
            "test child directory must be absolute",
        ));
    }
    let parent = database_path
        .parent()
        .ok_or(JournalError::InvalidInput("test database has no parent"))?;
    let parent = fs::canonicalize(parent)
        .map_err(|_| JournalError::InvalidInput("test database parent is not canonicalizable"))?;
    if parent != child_dir {
        return Err(JournalError::InvalidInput(
            "test database parent differs from the authorized child directory",
        ));
    }
    let handshake = fs::read_to_string(child_dir.join(TEST_HANDSHAKE_FILENAME))
        .map_err(|_| JournalError::InvalidInput("test child handshake is absent"))?;
    if handshake != token {
        return Err(JournalError::InvalidInput(
            "test child handshake does not match the token",
        ));
    }
    Ok(())
}
