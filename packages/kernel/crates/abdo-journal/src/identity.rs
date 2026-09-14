use rusqlite::config::DbConfig;
use rusqlite::Connection;

use crate::hash::option_digest;
use crate::JournalError;

pub const PINNED_SQLITE_VERSION: &str = "3.53.2";
pub const PINNED_SQLITE_SOURCE_ID: &str =
    "2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24";

const REQUIRED_COMPILE_OPTIONS: &[&str] = &[
    "DEFAULT_FOREIGN_KEYS",
    "ENABLE_API_ARMOR",
    "MAX_COLUMN=2000",
    "MAX_EXPR_DEPTH=1000",
    "MAX_VARIABLE_NUMBER=32766",
    "THREADSAFE=1",
];

const FORBIDDEN_COMPILE_OPTIONS: &[&str] = &[
    "OMIT_FOREIGN_KEY",
    "OMIT_TRIGGER",
    "OMIT_WAL",
    "THREADSAFE=0",
];

const PLATFORM_DIAGNOSTIC_PREFIXES: &[&str] = &[
    "ATOMIC_INTRINSICS=",
    "COMPILER=",
    "MAX_MMAP_SIZE=",
    "MUTEX_",
];

// Filled from the exact bundled SQLite source after platform/compiler-only
// diagnostics are separated. The dependency graph and build environment guard
// prevent accepting a build merely because it is the first one to open a DB.
pub const PINNED_NORMALIZED_COMPILE_OPTIONS: &[&str] = &[
    "DEFAULT_AUTOVACUUM",
    "DEFAULT_CACHE_SIZE=-2000",
    "DEFAULT_FILE_FORMAT=4",
    "DEFAULT_FOREIGN_KEYS",
    "DEFAULT_JOURNAL_SIZE_LIMIT=-1",
    "DEFAULT_MMAP_SIZE=0",
    "DEFAULT_PAGE_SIZE=4096",
    "DEFAULT_PCACHE_INITSZ=20",
    "DEFAULT_RECURSIVE_TRIGGERS",
    "DEFAULT_SECTOR_SIZE=4096",
    "DEFAULT_SYNCHRONOUS=2",
    "DEFAULT_WAL_AUTOCHECKPOINT=1000",
    "DEFAULT_WAL_SYNCHRONOUS=2",
    "DEFAULT_WORKER_THREADS=0",
    "DIRECT_OVERFLOW_READ",
    "ENABLE_API_ARMOR",
    "ENABLE_COLUMN_METADATA",
    "ENABLE_DBSTAT_VTAB",
    "ENABLE_FTS3",
    "ENABLE_FTS3_PARENTHESIS",
    "ENABLE_FTS5",
    "ENABLE_LOAD_EXTENSION",
    "ENABLE_MEMORY_MANAGEMENT",
    "ENABLE_RTREE",
    "ENABLE_STAT4",
    "HAVE_ISNAN",
    "MALLOC_SOFT_LIMIT=1024",
    "MAX_ATTACHED=10",
    "MAX_COLUMN=2000",
    "MAX_COMPOUND_SELECT=500",
    "MAX_DEFAULT_PAGE_SIZE=8192",
    "MAX_EXPR_DEPTH=1000",
    "MAX_FUNCTION_ARG=1000",
    "MAX_LENGTH=1000000000",
    "MAX_LIKE_PATTERN_LENGTH=50000",
    "MAX_PAGE_COUNT=0xfffffffe",
    "MAX_PAGE_SIZE=65536",
    "MAX_SQL_LENGTH=1000000000",
    "MAX_TRIGGER_DEPTH=1000",
    "MAX_VARIABLE_NUMBER=32766",
    "MAX_VDBE_OP=250000000",
    "MAX_WORKER_THREADS=8",
    "SOUNDEX",
    "SYSTEM_MALLOC",
    "TEMP_STORE=1",
    "THREADSAFE=1",
    "USE_URI",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteIdentity {
    pub version: String,
    pub source_id: String,
    pub journal_mode: String,
    pub schema_version: u32,
    pub compile_options: Vec<String>,
    pub normalized_compile_options: Vec<String>,
    pub platform_compile_options: Vec<String>,
    pub normalized_options_hash: [u8; 32],
    pub full_options_hash: [u8; 32],
}

impl SqliteIdentity {
    pub(crate) fn inspect(connection: &Connection) -> Result<Self, JournalError> {
        let version: String = connection
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .map_err(|source| JournalError::sqlite("read SQLite version", source))?;
        let source_id: String = connection
            .query_row("SELECT sqlite_source_id()", [], |row| row.get(0))
            .map_err(|source| JournalError::sqlite("read SQLite source id", source))?;

        if version != PINNED_SQLITE_VERSION {
            return Err(JournalError::SqliteIdentity(format!(
                "version {version:?} does not match {PINNED_SQLITE_VERSION:?}"
            )));
        }
        if source_id != PINNED_SQLITE_SOURCE_ID {
            return Err(JournalError::SqliteIdentity(format!(
                "source id {source_id:?} does not match the bundled source"
            )));
        }

        let mut statement = connection
            .prepare("PRAGMA compile_options")
            .map_err(|source| JournalError::sqlite("prepare compile-options query", source))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|source| JournalError::sqlite("read compile options", source))?;
        let mut compile_options = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|source| JournalError::sqlite("decode compile options", source))?;
        compile_options.sort();
        compile_options.dedup();

        for required in REQUIRED_COMPILE_OPTIONS {
            if !compile_options.iter().any(|option| option == required) {
                return Err(JournalError::SqliteIdentity(format!(
                    "required compile option {required:?} is absent"
                )));
            }
        }
        for forbidden in FORBIDDEN_COMPILE_OPTIONS {
            if compile_options.iter().any(|option| option == forbidden) {
                return Err(JournalError::SqliteIdentity(format!(
                    "forbidden compile option {forbidden:?} is present"
                )));
            }
        }
        reject_overridden_limit(&compile_options, "MAX_COLUMN=", "MAX_COLUMN=2000")?;
        reject_overridden_limit(&compile_options, "MAX_EXPR_DEPTH=", "MAX_EXPR_DEPTH=1000")?;
        reject_overridden_limit(
            &compile_options,
            "MAX_VARIABLE_NUMBER=",
            "MAX_VARIABLE_NUMBER=32766",
        )?;

        let (platform_compile_options, normalized_compile_options): (Vec<_>, Vec<_>) =
            compile_options.iter().cloned().partition(|option| {
                PLATFORM_DIAGNOSTIC_PREFIXES
                    .iter()
                    .any(|prefix| option.starts_with(prefix))
            });

        if normalized_compile_options
            != PINNED_NORMALIZED_COMPILE_OPTIONS
                .iter()
                .map(|item| (*item).to_owned())
                .collect::<Vec<_>>()
        {
            return Err(JournalError::SqliteIdentity(format!(
                "normalized compile options differ: {normalized_compile_options:?}"
            )));
        }

        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .map_err(|source| JournalError::sqlite("read journal mode", source))?
            .to_ascii_lowercase();
        let schema_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .map_err(|source| JournalError::sqlite("read schema version", source))?;

        Ok(Self {
            version,
            source_id,
            journal_mode,
            schema_version,
            normalized_options_hash: option_digest(&normalized_compile_options),
            full_options_hash: option_digest(&compile_options),
            compile_options,
            normalized_compile_options,
            platform_compile_options,
        })
    }
}

pub(crate) fn harden_connection(connection: &Connection) -> Result<(), JournalError> {
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|source| JournalError::sqlite("enable defensive mode", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(|source| JournalError::sqlite("disable trusted schema", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)
        .map_err(|source| JournalError::sqlite("disable DDL double-quoted strings", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)
        .map_err(|source| JournalError::sqlite("disable DML double-quoted strings", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA, false)
        .map_err(|source| JournalError::sqlite("disable writable schema", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true)
        .map_err(|source| JournalError::sqlite("enable foreign keys", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, true)
        .map_err(|source| JournalError::sqlite("enable triggers", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER, false)
        .map_err(|source| JournalError::sqlite("disable FTS3 tokenizer", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)
        .map_err(|source| JournalError::sqlite("disable views", source))?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG, true)
        .map_err(|source| JournalError::sqlite("enable query planner stability", source))?;
    Ok(())
}

pub(crate) fn verify_hardened_connection(connection: &Connection) -> Result<(), JournalError> {
    for (config, expected, name) in [
        (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true, "defensive"),
        (
            DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA,
            false,
            "trusted schema",
        ),
        (DbConfig::SQLITE_DBCONFIG_DQS_DDL, false, "DDL DQS"),
        (DbConfig::SQLITE_DBCONFIG_DQS_DML, false, "DML DQS"),
        (
            DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA,
            false,
            "writable schema",
        ),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true, "foreign keys"),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, true, "triggers"),
        (
            DbConfig::SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER,
            false,
            "FTS3 tokenizer",
        ),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false, "views"),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG, true, "QPSG"),
    ] {
        let actual = connection
            .db_config(config)
            .map_err(|source| JournalError::sqlite("verify database hardening", source))?;
        if actual != expected {
            return Err(JournalError::SqliteIdentity(format!(
                "database config {name} is {actual}, expected {expected}"
            )));
        }
    }
    Ok(())
}

fn reject_overridden_limit(
    compile_options: &[String],
    prefix: &str,
    expected: &str,
) -> Result<(), JournalError> {
    if compile_options
        .iter()
        .any(|option| option.starts_with(prefix) && option != expected)
    {
        return Err(JournalError::SqliteIdentity(format!(
            "compile option {prefix} must be exactly {expected}"
        )));
    }
    Ok(())
}
