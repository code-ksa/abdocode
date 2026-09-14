//! Durable leases and budgets.
//!
//! The journal stores both and interprets neither. It guarantees three things:
//! a lease generation is append-only and therefore monotone, a budget's
//! consumption may only grow, and a budget's limit may not move at all. All
//! three are held by the schema, so a crash cannot skip them and a caller
//! cannot talk its way past them.
//!
//! What a dimension means, when a lease is stale, and what to do about either,
//! belongs to the runtime.

use rusqlite::{params, Connection, OptionalExtension};

use crate::JournalError;

/// The scope a lease or budget applies to: a session, a task, whatever the
/// runtime chooses. Sixteen opaque bytes.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ScopeId(u128);

impl ScopeId {
    pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
        if value == 0 {
            return Err("scope id must be non-zero");
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u128 {
        self.0
    }
}

/// Who holds a lease.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HolderId(u128);

impl HolderId {
    pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
        if value == 0 {
            return Err("holder id must be non-zero");
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u128 {
        self.0
    }
}

/// A lease as stored.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeaseRecord {
    pub scope: ScopeId,
    /// The fencing token. Monotone per scope, and durable, so a restart cannot
    /// hand out a number a previous run already used.
    pub generation: u64,
    pub holder: HolderId,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

/// A budget line as stored.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BudgetRecord {
    pub scope: ScopeId,
    pub dimension: u8,
    pub limit: u64,
    pub consumed: u64,
}

impl BudgetRecord {
    pub const fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.consumed)
    }
}

pub(crate) fn insert_lease(
    connection: &Connection,
    scope: ScopeId,
    generation: u64,
    holder: HolderId,
    issued_at_ms: u64,
    expires_at_ms: u64,
) -> Result<(), JournalError> {
    connection
        .execute(
            "INSERT INTO journal_leases (scope_id, generation, holder_id, issued_at_ms, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                scope.get().to_be_bytes().as_slice(),
                sequence_i64(generation)?,
                holder.get().to_be_bytes().as_slice(),
                sequence_i64(issued_at_ms)?,
                sequence_i64(expires_at_ms)?,
            ],
        )
        .map(|_| ())
        .map_err(|source| JournalError::sqlite("insert lease generation", source))
}

pub(crate) fn read_current_lease(
    connection: &Connection,
    scope: ScopeId,
) -> Result<Option<LeaseRecord>, JournalError> {
    connection
        .query_row(
            "SELECT generation, holder_id, issued_at_ms, expires_at_ms FROM journal_leases
             WHERE scope_id = ?1 ORDER BY generation DESC LIMIT 1",
            [scope.get().to_be_bytes().as_slice()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read current lease", source))?
        .map(|(generation, holder, issued, expires)| {
            let invalid = |reason: &str| JournalError::Integrity(format!("stored lease {reason}"));
            let holder: [u8; 16] = holder
                .as_slice()
                .try_into()
                .map_err(|_| invalid("holder is not 16 bytes"))?;
            Ok(LeaseRecord {
                scope,
                generation: u64::try_from(generation)
                    .map_err(|_| invalid("generation is negative"))?,
                holder: HolderId::try_from_u128(u128::from_be_bytes(holder)).map_err(invalid)?,
                issued_at_ms: u64::try_from(issued)
                    .map_err(|_| invalid("issue time is negative"))?,
                expires_at_ms: u64::try_from(expires).map_err(|_| invalid("expiry is negative"))?,
            })
        })
        .transpose()
}

pub(crate) fn upsert_budget(
    connection: &Connection,
    scope: ScopeId,
    dimension: u8,
    limit: u64,
) -> Result<(), JournalError> {
    // A limit is set once. Re-setting it to the same value is harmless; moving
    // it is refused by the trigger, which is where that rule belongs.
    connection
        .execute(
            "INSERT OR IGNORE INTO journal_budgets (scope_id, dimension, limit_value, consumed)
             VALUES (?1, ?2, ?3, 0)",
            params![
                scope.get().to_be_bytes().as_slice(),
                i64::from(dimension),
                sequence_i64(limit)?,
            ],
        )
        .map(|_| ())
        .map_err(|source| JournalError::sqlite("insert budget line", source))
}

pub(crate) fn read_budget(
    connection: &Connection,
    scope: ScopeId,
    dimension: u8,
) -> Result<Option<BudgetRecord>, JournalError> {
    connection
        .query_row(
            "SELECT limit_value, consumed FROM journal_budgets
             WHERE scope_id = ?1 AND dimension = ?2",
            params![scope.get().to_be_bytes().as_slice(), i64::from(dimension)],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read budget line", source))?
        .map(|(limit, consumed)| {
            let invalid = |reason: &str| JournalError::Integrity(format!("stored budget {reason}"));
            Ok(BudgetRecord {
                scope,
                dimension,
                limit: u64::try_from(limit).map_err(|_| invalid("limit is negative"))?,
                consumed: u64::try_from(consumed)
                    .map_err(|_| invalid("consumption is negative"))?,
            })
        })
        .transpose()
}

/// Charge a budget, refusing rather than overspending.
///
/// The `consumed <= limit_value` check lives in the schema, so an attempt to
/// overspend fails at the database even if a caller computed the arithmetic
/// wrongly on the way in.
pub(crate) fn charge_budget(
    connection: &Connection,
    scope: ScopeId,
    dimension: u8,
    amount: u64,
) -> Result<bool, JournalError> {
    let changed = connection
        .execute(
            "UPDATE journal_budgets SET consumed = consumed + ?3
             WHERE scope_id = ?1 AND dimension = ?2 AND consumed + ?3 <= limit_value",
            params![
                scope.get().to_be_bytes().as_slice(),
                i64::from(dimension),
                sequence_i64(amount)?,
            ],
        )
        .map_err(|source| JournalError::sqlite("charge budget", source))?;
    Ok(changed == 1)
}

fn sequence_i64(value: u64) -> Result<i64, JournalError> {
    i64::try_from(value).map_err(|_| {
        JournalError::Integrity("governance value exceeds the SQLite integer range".into())
    })
}
