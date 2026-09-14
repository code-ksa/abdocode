use std::path::Path;

use rusqlite::{params, Connection, TransactionBehavior};

use crate::hash::bytes_digest;
use crate::identity::SqliteIdentity;
use crate::JournalError;

pub(crate) const APPLICATION_ID: u32 = 0x4142_444a;
pub(crate) const LATEST_SCHEMA_VERSION: u32 = 4;
const STATEMENT_MARKER: &str = "-- ABDO_MIGRATION_STATEMENT";
const INITIAL_SQL: &str = include_str!("../../../migrations/0001_initial.sql");
const EFFECTS_SQL: &str = include_str!("../../../migrations/0002_effects.sql");
const GOVERNANCE_SQL: &str = include_str!("../../../migrations/0003_leases_budgets.sql");
const COMPACTION_SQL: &str = include_str!("../../../migrations/0004_compactions.sql");

/// Every migration, in the order they must be applied.
///
/// Each entry runs inside its own immediate transaction, so a crash between two
/// migrations leaves the database wholly at one version and never between two.
const MIGRATIONS: &[(u32, &str)] = &[
    (1, INITIAL_SQL),
    (2, EFFECTS_SQL),
    (3, GOVERNANCE_SQL),
    (4, COMPACTION_SQL),
];
const SCHEMA_MANIFEST_DOMAIN: &[u8] = b"ABDO/JOURNAL/SQLITE-SCHEMA/1\0";
const DATABASE_PATH_DOMAIN: &[u8] = b"ABDO/JOURNAL/DATABASE-PATH/1\0";

#[derive(Debug, Eq, PartialEq)]
struct SchemaObject {
    object_type: String,
    name: String,
    table_name: String,
    sql: String,
}

const SCHEMA_OBJECT_IDENTITIES: &[(&str, &str, &str)] = &[
    ("index", "journal_compactions_latest", "journal_compactions"),
    ("index", "journal_effects_latest", "journal_effects"),
    ("index", "journal_leases_current", "journal_leases"),
    ("index", "journal_snapshots_latest", "journal_snapshots"),
    ("table", "journal_blobs", "journal_blobs"),
    ("table", "journal_budgets", "journal_budgets"),
    ("table", "journal_compactions", "journal_compactions"),
    ("table", "journal_effects", "journal_effects"),
    ("table", "journal_events", "journal_events"),
    ("table", "journal_leases", "journal_leases"),
    ("table", "journal_metadata", "journal_metadata"),
    ("table", "journal_migrations", "journal_migrations"),
    ("table", "journal_projections", "journal_projections"),
    ("table", "journal_snapshots", "journal_snapshots"),
    ("table", "journal_stream_heads", "journal_stream_heads"),
    ("trigger", "journal_blobs_no_delete", "journal_blobs"),
    ("trigger", "journal_blobs_no_update", "journal_blobs"),
    (
        "trigger",
        "journal_budgets_consumption_only_grows",
        "journal_budgets",
    ),
    ("trigger", "journal_budgets_no_delete", "journal_budgets"),
    (
        "trigger",
        "journal_compactions_no_delete",
        "journal_compactions",
    ),
    (
        "trigger",
        "journal_compactions_no_update",
        "journal_compactions",
    ),
    ("trigger", "journal_effects_no_delete", "journal_effects"),
    ("trigger", "journal_effects_no_update", "journal_effects"),
    ("trigger", "journal_events_no_delete", "journal_events"),
    ("trigger", "journal_events_no_update", "journal_events"),
    ("trigger", "journal_leases_no_delete", "journal_leases"),
    ("trigger", "journal_leases_no_update", "journal_leases"),
    (
        "trigger",
        "journal_metadata_identity_no_update",
        "journal_metadata",
    ),
    ("trigger", "journal_metadata_no_delete", "journal_metadata"),
    (
        "trigger",
        "journal_migrations_no_delete",
        "journal_migrations",
    ),
    (
        "trigger",
        "journal_migrations_no_update",
        "journal_migrations",
    ),
    (
        "trigger",
        "journal_snapshots_no_delete",
        "journal_snapshots",
    ),
    (
        "trigger",
        "journal_snapshots_no_update",
        "journal_snapshots",
    ),
];

// SHA-256 over the domain-separated, length-prefixed canonical object manifest.
// Pinned from the canonical migration/SQLite representation and deliberately
// not derived from the live database.
const EXPECTED_SCHEMA_MANIFEST_DIGEST: [u8; 32] = [
    0xe6, 0x04, 0xe8, 0xb2, 0xb1, 0x49, 0xc6, 0x67, 0x90, 0xd7, 0x69, 0x32, 0xa5, 0xb1, 0x3f, 0xd8,
    0x55, 0xe1, 0x33, 0xc0, 0xb2, 0x76, 0x6b, 0xc1, 0xe9, 0x5d, 0x9e, 0xc6, 0xfd, 0x3a, 0x6a, 0xb4,
];

pub(crate) fn migrate(
    connection: &mut Connection,
    path: &Path,
    identity: &SqliteIdentity,
) -> Result<(), JournalError> {
    let application_id = read_pragma_u32(connection, "application_id")?;
    let user_version = read_pragma_u32(connection, "user_version")?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(JournalError::SqliteIdentity(format!(
            "application id {application_id:#x} is not an Abdo journal"
        )));
    }
    if user_version > LATEST_SCHEMA_VERSION {
        return Err(JournalError::UnsupportedSchema {
            found: user_version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }

    if user_version == LATEST_SCHEMA_VERSION {
        if application_id != APPLICATION_ID {
            return Err(JournalError::SqliteIdentity(format!(
                "application id {application_id:#x} is not an Abdo journal"
            )));
        }
        return Ok(());
    }
    if user_version != 0
        && !MIGRATIONS
            .iter()
            .any(|(version, _)| *version == user_version)
    {
        return Err(JournalError::UnsupportedSchema {
            found: user_version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }

    for (version, sql) in MIGRATIONS
        .iter()
        .filter(|(version, _)| *version > user_version)
    {
        apply_migration(connection, path, identity, *version, sql)?;
    }
    Ok(())
}

/// Apply one migration inside one immediate transaction.
///
/// Everything the migration needs to be believed, including the recorded
/// checksum and the advanced schema version, commits with it. A crash anywhere
/// inside leaves the database wholly at the previous version: there is no state
/// in which the statements ran but the version did not, or the reverse.
fn apply_migration(
    connection: &mut Connection,
    path: &Path,
    identity: &SqliteIdentity,
    version: u32,
    sql: &str,
) -> Result<(), JournalError> {
    crash(path, "migration.before_begin");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| JournalError::sqlite("begin migration", source))?;
    crash(path, "migration.after_begin");

    for (index, statement) in migration_statements(sql).enumerate() {
        transaction
            .execute_batch(statement)
            .map_err(|source| JournalError::sqlite("execute migration statement", source))?;
        crash(
            path,
            &format!("migration.after_statement.{version}.{}", index + 1),
        );
    }

    if version == 1 {
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(|source| JournalError::sqlite("set journal application id", source))?;
        transaction
            .execute(
                "INSERT INTO journal_metadata (
                singleton, next_global_sequence, sqlite_version, sqlite_source_id,
                database_path_hash, normalized_options_hash, full_options_hash
             ) VALUES (1, 0, ?1, ?2, ?3, ?4, ?5)",
                params![
                    identity.version,
                    identity.source_id,
                    database_path_digest(path).as_slice(),
                    identity.normalized_options_hash.as_slice(),
                    identity.full_options_hash.as_slice(),
                ],
            )
            .map_err(|source| JournalError::sqlite("write journal identity", source))?;
    }
    crash(path, "migration.before_record");
    transaction
        .execute(
            "INSERT INTO journal_migrations(version, checksum) VALUES (?1, ?2)",
            params![version, bytes_digest(sql.as_bytes()).as_slice()],
        )
        .map_err(|source| JournalError::sqlite("record migration", source))?;
    transaction
        .pragma_update(None, "user_version", version)
        .map_err(|source| JournalError::sqlite("advance schema version", source))?;
    crash(path, "migration.after_record");
    crash(path, "migration.before_commit");
    transaction
        .commit()
        .map_err(|source| JournalError::sqlite("commit migration", source))?;
    crash(path, "migration.after_commit");
    Ok(())
}

pub(crate) fn verify_migration_history(connection: &Connection) -> Result<(), JournalError> {
    verify_migration_history_through(connection, LATEST_SCHEMA_VERSION)
}

/// Verify the recorded history matches exactly the migrations up to `through`.
pub(crate) fn verify_migration_history_through(
    connection: &Connection,
    through: u32,
) -> Result<(), JournalError> {
    let rows = connection
        .prepare("SELECT version, checksum FROM journal_migrations ORDER BY version")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, u32>(0)?, row.get::<_, Vec<u8>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|source| JournalError::sqlite("read migration history", source))?;
    let expected = MIGRATIONS
        .iter()
        .filter(|(version, _)| *version <= through)
        .map(|(version, sql)| (*version, bytes_digest(sql.as_bytes()).to_vec()))
        .collect::<Vec<_>>();
    if rows != expected {
        return Err(JournalError::Integrity(format!(
            "migration history differs: {rows:?}"
        )));
    }
    Ok(())
}

pub(crate) fn verify_persisted_identity(
    connection: &Connection,
    identity: &SqliteIdentity,
    path: &Path,
) -> Result<(), JournalError> {
    let stored = connection
        .query_row(
            "SELECT sqlite_version, sqlite_source_id, database_path_hash,
                    normalized_options_hash, full_options_hash
             FROM journal_metadata WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            },
        )
        .map_err(|source| JournalError::sqlite("read persisted SQLite identity", source))?;
    if stored.0 != identity.version
        || stored.1 != identity.source_id
        || stored.2 != database_path_digest(path)
        || stored.3 != identity.normalized_options_hash
        || stored.4 != identity.full_options_hash
    {
        return Err(JournalError::SqliteIdentity(
            "persisted SQLite build identity differs from this runtime".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn verify_schema_manifest(connection: &Connection) -> Result<(), JournalError> {
    let expected = expected_schema_manifest()?;
    let expected_digest = schema_manifest_digest(&expected)?;
    if expected_digest != EXPECTED_SCHEMA_MANIFEST_DIGEST {
        return Err(JournalError::Integrity(format!(
            "compiled journal schema manifest digest drifted: {}",
            hex(&expected_digest)
        )));
    }

    let mut statement = connection
        .prepare(
            "SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
               AND (name GLOB 'journal_*' OR tbl_name GLOB 'journal_*')
             ORDER BY type, name, tbl_name",
        )
        .map_err(|source| JournalError::sqlite("prepare schema-manifest query", source))?;
    let actual = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                table_name: row.get(2)?,
                // SQLite returns the SQL using the line endings supplied by
                // the migration. Keep the manifest stable across LF and CRLF
                // checkouts just as we do for the compiled expectation.
                sql: row
                    .get::<_, String>(3)?
                    .replace("\r\n", "\n")
                    .replace('\r', "\n"),
            })
        })
        .map_err(|source| JournalError::sqlite("query schema manifest", source))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| JournalError::sqlite("decode schema manifest", source))?;
    let actual_digest = schema_manifest_digest(&actual)?;
    if actual_digest != EXPECTED_SCHEMA_MANIFEST_DIGEST || actual != expected {
        return Err(JournalError::Integrity(format!(
            "SQLite schema manifest differs: expected {}, found {}",
            hex(&EXPECTED_SCHEMA_MANIFEST_DIGEST),
            hex(&actual_digest)
        )));
    }
    Ok(())
}

pub(crate) fn database_path_digest(path: &Path) -> [u8; 32] {
    let mut bytes = Vec::from(DATABASE_PATH_DOMAIN);
    append_platform_path_bytes(&mut bytes, path);
    bytes_digest(&bytes)
}

fn expected_schema_manifest() -> Result<Vec<SchemaObject>, JournalError> {
    // Every migration contributes to the canonical manifest, not just the
    // first. Reading only the initial file would let a later migration add a
    // table the manifest never mentions, which is precisely the drift this
    // check exists to catch.
    let statements = MIGRATIONS
        .iter()
        .flat_map(|(_, sql)| migration_statements(sql))
        .collect::<Vec<_>>();
    SCHEMA_OBJECT_IDENTITIES
        .iter()
        .map(|(object_type, name, table_name)| {
            let prefix = format!("CREATE {} {name}", object_type.to_ascii_uppercase());
            let sql = statements
                .iter()
                .find(|statement| statement.starts_with(&prefix))
                .ok_or_else(|| {
                    JournalError::Integrity(format!(
                        "canonical migration omits schema object {name}"
                    ))
                })?
                // `include_str!` preserves the checkout's line endings. The
                // schema identity is the SQL, not whether Git materialized it
                // as LF or CRLF, so canonicalize before hashing. Without this a
                // clean Windows checkout compiled a host that refused its own
                // pinned manifest before reading the first frame.
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .trim_end_matches(';')
                .to_owned();
            Ok(SchemaObject {
                object_type: (*object_type).to_owned(),
                name: (*name).to_owned(),
                table_name: (*table_name).to_owned(),
                sql,
            })
        })
        .collect()
}

fn schema_manifest_digest(objects: &[SchemaObject]) -> Result<[u8; 32], JournalError> {
    let mut bytes = Vec::from(SCHEMA_MANIFEST_DOMAIN);
    for object in objects {
        for value in [
            object.object_type.as_bytes(),
            object.name.as_bytes(),
            object.table_name.as_bytes(),
            object.sql.as_bytes(),
        ] {
            let length = u32::try_from(value.len()).map_err(|_| {
                JournalError::Integrity("schema manifest value is too large".to_owned())
            })?;
            bytes.extend_from_slice(&length.to_be_bytes());
            bytes.extend_from_slice(value);
        }
    }
    Ok(bytes_digest(&bytes))
}

#[cfg(unix)]
fn append_platform_path_bytes(output: &mut Vec<u8>, path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    output.extend_from_slice(path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn append_platform_path_bytes(output: &mut Vec<u8>, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    for unit in path.as_os_str().encode_wide() {
        output.extend_from_slice(&unit.to_le_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn append_platform_path_bytes(output: &mut Vec<u8>, path: &Path) {
    output.extend_from_slice(path.to_string_lossy().as_bytes());
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

#[cfg(feature = "test-hooks")]
/// Statement counts per migration version, in order.
///
/// The crash gate enumerates its points from this, so adding a migration
/// automatically adds its interruption points. A count that only ever described
/// the first migration would leave every later one untested while the gate
/// still reported green.
pub(crate) fn migration_statement_counts() -> Vec<(u32, usize)> {
    MIGRATIONS
        .iter()
        .map(|(version, sql)| (*version, migration_statements(sql).count()))
        .collect()
}

fn migration_statements(sql: &str) -> impl Iterator<Item = &str> {
    // A migration file may carry a header explaining itself. That header is not
    // a statement: counting it would inflate the crash-point enumeration and
    // hand the canonical manifest a chunk with no object in it.
    sql.split(STATEMENT_MARKER)
        .map(str::trim)
        .filter(|statement| {
            statement
                .lines()
                .map(str::trim)
                .any(|line| !line.is_empty() && !line.starts_with("--"))
        })
}

fn read_pragma_u32(connection: &Connection, pragma: &'static str) -> Result<u32, JournalError> {
    connection
        .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
        .map_err(|source| JournalError::sqlite("read schema pragma", source))
}

fn crash(path: &Path, point: &str) {
    #[cfg(feature = "test-hooks")]
    crate::test_support::maybe_crash(path, point);

    #[cfg(not(feature = "test-hooks"))]
    let _ = (path, point);
}
