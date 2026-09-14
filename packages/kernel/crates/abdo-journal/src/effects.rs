//! The durable effect ledger.
//!
//! The journal stores effect phase records and knows nothing about what a phase
//! means. It guarantees three things and no more: a record is append-only, the
//! records of one effect form a hash chain, and the same effect can never store
//! the same phase twice. That last guarantee is held by a SQL uniqueness
//! constraint rather than by a check in Rust, because a crash can skip a check
//! and cannot skip a constraint.
//!
//! Interpreting the tags, and deciding which order they may legitimately occur
//! in, belongs to the runtime.

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest as ShaDigest, Sha256};

use crate::model::{ChainHash, StreamId};
use crate::JournalError;

const EFFECT_DOMAIN: &[u8] = b"ABDO/JOURNAL/EFFECT/1\0";

/// An opaque effect phase tag. The journal never interprets it.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectPhaseTag(u8);

impl EffectPhaseTag {
    pub fn new(tag: u8) -> Result<Self, &'static str> {
        if tag == 0 {
            return Err("effect phase tag must be non-zero");
        }
        Ok(Self(tag))
    }

    pub const fn get(self) -> u8 {
        self.0
    }
}

/// An effect identity: the admitted intent the effect belongs to.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectId(u128);

impl EffectId {
    pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
        if value == 0 {
            return Err("effect id must be non-zero");
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u128 {
        self.0
    }

    pub(crate) fn from_blob(bytes: &[u8]) -> Result<Self, &'static str> {
        let array: [u8; 16] = bytes.try_into().map_err(|_| "effect id is not 16 bytes")?;
        Self::try_from_u128(u128::from_be_bytes(array))
    }
}

impl fmt::Display for EffectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:#034x}", self.0)
    }
}

/// One phase transition, offered for durable storage.
#[derive(Clone, Copy, Debug)]
pub struct EffectAppendRequest<'a> {
    pub effect_id: EffectId,
    pub phase_tag: EffectPhaseTag,
    pub stream_id: StreamId,
    /// The hash of the admission event that caused this effect to exist.
    pub cause_event_hash: ChainHash,
    /// Phase payload. Stored content-addressed in the shared blob table.
    pub payload: &'a [u8],
    pub at_ms: u64,
}

/// A stored phase transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectRecord {
    pub effect_id: EffectId,
    pub phase_sequence: u64,
    pub phase_tag: EffectPhaseTag,
    pub stream_id: StreamId,
    pub cause_event_hash: ChainHash,
    pub previous_hash: ChainHash,
    pub record_hash: ChainHash,
    pub at_ms: u64,
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectAppendReceipt {
    pub effect_id: EffectId,
    pub phase_sequence: u64,
    pub phase_tag: EffectPhaseTag,
    pub record_hash: ChainHash,
}

/// Everything one effect record commits to.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EffectHashInput<'a> {
    pub effect_id: EffectId,
    pub phase_sequence: u64,
    pub phase_tag: EffectPhaseTag,
    pub stream_id: StreamId,
    pub cause_event_hash: ChainHash,
    pub previous_hash: ChainHash,
    pub payload: &'a [u8],
    pub at_ms: u64,
}

pub(crate) fn effect_record_hash(input: EffectHashInput<'_>) -> ChainHash {
    let mut hasher = Sha256::new();
    hasher.update(EFFECT_DOMAIN);
    hasher.update(abdo_contracts::PROTOCOL_DESCRIPTOR.schema_fingerprint);
    hasher.update(input.effect_id.get().to_be_bytes());
    hasher.update(input.phase_sequence.to_be_bytes());
    hasher.update([input.phase_tag.get()]);
    hasher.update(input.stream_id.to_be_bytes());
    hasher.update(input.cause_event_hash.as_bytes());
    hasher.update(input.previous_hash.as_bytes());
    hasher.update((input.payload.len() as u32).to_be_bytes());
    hasher.update(input.payload);
    hasher.update(input.at_ms.to_be_bytes());
    ChainHash::from_bytes(hasher.finalize().into())
}

pub(crate) fn query_effect_tail(
    connection: &Connection,
    effect_id: EffectId,
) -> Result<Option<(u64, ChainHash)>, JournalError> {
    connection
        .query_row(
            "SELECT phase_sequence, record_hash FROM journal_effects
             WHERE intent_id = ?1 ORDER BY phase_sequence DESC LIMIT 1",
            [effect_id.get().to_be_bytes().as_slice()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read effect tail", source))?
        .map(|(sequence, hash)| {
            let sequence = u64::try_from(sequence)
                .map_err(|_| JournalError::Integrity("effect phase sequence is negative".into()))?;
            let hash = ChainHash::from_blob(&hash).map_err(|reason| {
                JournalError::Integrity(format!("stored effect record hash is invalid: {reason}"))
            })?;
            Ok((sequence, hash))
        })
        .transpose()
}

pub(crate) fn read_effect_history(
    connection: &Connection,
    effect_id: EffectId,
) -> Result<Vec<EffectRecord>, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT e.phase_sequence, e.phase_tag, e.stream_id, e.cause_event_hash,
                    e.previous_hash, e.record_hash, e.at_ms, b.bytes
             FROM journal_effects e
             JOIN journal_blobs b ON b.hash = e.payload_hash
             WHERE e.intent_id = ?1
             ORDER BY e.phase_sequence",
        )
        .map_err(|source| JournalError::sqlite("prepare effect history", source))?;
    let rows = statement
        .query_map([effect_id.get().to_be_bytes().as_slice()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, Vec<u8>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Vec<u8>>(7)?,
            ))
        })
        .map_err(|source| JournalError::sqlite("query effect history", source))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| JournalError::sqlite("decode effect history", source))?;

    let mut records = Vec::with_capacity(rows.len());
    let mut expected_previous = ChainHash::ZERO;
    for (index, row) in rows.into_iter().enumerate() {
        let invalid = |reason: &str| JournalError::Integrity(format!("stored effect {reason}"));
        let phase_sequence =
            u64::try_from(row.0).map_err(|_| invalid("phase sequence is negative"))?;
        let phase_tag = u8::try_from(row.1)
            .ok()
            .and_then(|tag| EffectPhaseTag::new(tag).ok())
            .ok_or_else(|| invalid("phase tag is out of range"))?;
        let stream_id =
            StreamId::from_blob(&row.2).map_err(|reason| invalid(&format!("stream: {reason}")))?;
        let cause_event_hash =
            ChainHash::from_blob(&row.3).map_err(|reason| invalid(&format!("cause: {reason}")))?;
        let previous_hash = ChainHash::from_blob(&row.4)
            .map_err(|reason| invalid(&format!("previous hash: {reason}")))?;
        let record_hash = ChainHash::from_blob(&row.5)
            .map_err(|reason| invalid(&format!("record hash: {reason}")))?;
        let at_ms = u64::try_from(row.6).map_err(|_| invalid("timestamp is negative"))?;
        let payload = row.7;

        if phase_sequence != (index as u64) + 1 {
            return Err(invalid("phase sequence has a gap"));
        }
        if previous_hash != expected_previous {
            return Err(invalid("phase chain is broken"));
        }
        let recomputed = effect_record_hash(EffectHashInput {
            effect_id,
            phase_sequence,
            phase_tag,
            stream_id,
            cause_event_hash,
            previous_hash,
            payload: &payload,
            at_ms,
        });
        if recomputed != record_hash {
            return Err(invalid("record hash does not match its own contents"));
        }
        expected_previous = record_hash;
        records.push(EffectRecord {
            effect_id,
            phase_sequence,
            phase_tag,
            stream_id,
            cause_event_hash,
            previous_hash,
            record_hash,
            at_ms,
            payload,
        });
    }
    Ok(records)
}

pub(crate) fn read_effect_ids(connection: &Connection) -> Result<Vec<EffectId>, JournalError> {
    let mut statement = connection
        .prepare("SELECT DISTINCT intent_id FROM journal_effects ORDER BY intent_id")
        .map_err(|source| JournalError::sqlite("prepare effect identity scan", source))?;
    let rows = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|source| JournalError::sqlite("query effect identities", source))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| JournalError::sqlite("decode effect identities", source))?;
    rows.into_iter()
        .map(|bytes| {
            EffectId::from_blob(&bytes).map_err(|reason| {
                JournalError::Integrity(format!("stored effect id is invalid: {reason}"))
            })
        })
        .collect()
}

pub(crate) fn insert_effect_record(
    transaction: &rusqlite::Transaction<'_>,
    request: &EffectAppendRequest<'_>,
    phase_sequence: u64,
    previous_hash: ChainHash,
    record_hash: ChainHash,
    payload_hash: &[u8],
) -> Result<(), JournalError> {
    transaction
        .execute(
            "INSERT INTO journal_effects (
                intent_id, phase_sequence, phase_tag, stream_id, cause_event_hash,
                payload_hash, previous_hash, record_hash, at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                request.effect_id.get().to_be_bytes().as_slice(),
                i64::try_from(phase_sequence).map_err(|_| JournalError::Integrity(
                    "effect phase sequence exceeds the SQLite integer range".into()
                ))?,
                i64::from(request.phase_tag.get()),
                request.stream_id.to_be_bytes().as_slice(),
                request.cause_event_hash.as_bytes().as_slice(),
                payload_hash,
                previous_hash.as_bytes().as_slice(),
                record_hash.as_bytes().as_slice(),
                i64::try_from(request.at_ms).map_err(|_| JournalError::Integrity(
                    "effect timestamp exceeds the SQLite integer range".into()
                ))?,
            ],
        )
        .map(|_| ())
        .map_err(|source| JournalError::sqlite("insert effect record", source))
}
