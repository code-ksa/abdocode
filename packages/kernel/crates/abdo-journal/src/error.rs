use std::error::Error;
use std::fmt;

use crate::{Head, ProjectionKey};

#[derive(Debug)]
pub enum JournalError {
    WriterBusy {
        wait_ms: u64,
    },
    CasConflict {
        expected: Option<Head>,
        actual: Option<Head>,
    },
    ProjectionCasConflict {
        key: ProjectionKey,
        expected_sequence: u64,
        actual_sequence: Option<u64>,
    },
    DuplicateEvent {
        event_id: u128,
    },
    InvalidInput(&'static str),
    SequenceExhausted,
    ContractEncode(abdo_contracts::EncodeError),
    ContractDecode(abdo_contracts::DecodeError),
    Sqlite {
        context: &'static str,
        source: rusqlite::Error,
    },
    SqliteIdentity(String),
    UnsupportedSchema {
        found: u32,
        supported: u32,
    },
    Integrity(String),
}

impl JournalError {
    pub(crate) fn sqlite(context: &'static str, source: rusqlite::Error) -> Self {
        Self::Sqlite { context, source }
    }
}

impl fmt::Display for JournalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WriterBusy { wait_ms } => {
                write!(formatter, "journal writer is busy after {wait_ms}ms")
            }
            Self::CasConflict { expected, actual } => {
                write!(
                    formatter,
                    "journal head CAS conflict: expected {expected:?}, actual {actual:?}"
                )
            }
            Self::ProjectionCasConflict {
                key,
                expected_sequence,
                actual_sequence,
            } => write!(
                formatter,
                "projection {} CAS conflict: expected sequence {}, actual {:?}",
                key.as_str(),
                expected_sequence,
                actual_sequence
            ),
            Self::DuplicateEvent { event_id } => {
                write!(formatter, "event id {event_id} is already journaled")
            }
            Self::InvalidInput(reason) => write!(formatter, "invalid journal input: {reason}"),
            Self::SequenceExhausted => formatter.write_str("journal sequence space is exhausted"),
            Self::ContractEncode(source) => write!(formatter, "cannot encode event: {source}"),
            Self::ContractDecode(source) => write!(formatter, "cannot decode event: {source}"),
            Self::Sqlite { context, source } => {
                write!(formatter, "SQLite failure during {context}: {source}")
            }
            Self::SqliteIdentity(reason) => write!(formatter, "SQLite identity rejected: {reason}"),
            Self::UnsupportedSchema { found, supported } => write!(
                formatter,
                "journal schema version {found} is not supported; expected {supported}"
            ),
            Self::Integrity(reason) => write!(formatter, "journal integrity failure: {reason}"),
        }
    }
}

impl Error for JournalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ContractEncode(source) => Some(source),
            Self::ContractDecode(source) => Some(source),
            Self::Sqlite { source, .. } => Some(source),
            _ => None,
        }
    }
}
