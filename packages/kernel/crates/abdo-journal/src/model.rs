use std::fmt;
use std::time::Duration;

use abdo_contracts::{AdmissionEvent, EventId};

pub const MAX_DERIVED_BLOB_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StreamId(u128);

impl StreamId {
    pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
        if value == 0 {
            return Err("stream id must be nonzero");
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u128 {
        self.0
    }

    pub const fn to_be_bytes(self) -> [u8; 16] {
        self.0.to_be_bytes()
    }

    pub(crate) fn from_blob(bytes: &[u8]) -> Result<Self, &'static str> {
        let array: [u8; 16] = bytes.try_into().map_err(|_| "stream id is not 16 bytes")?;
        Self::try_from_u128(u128::from_be_bytes(array))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ChainHash([u8; 32]);

impl ChainHash {
    pub const ZERO: Self = Self([0; 32]);

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 32] {
        self.0
    }

    pub(crate) fn from_blob(bytes: &[u8]) -> Result<Self, &'static str> {
        let array = bytes.try_into().map_err(|_| "chain hash is not 32 bytes")?;
        Ok(Self(array))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BlobHash([u8; 32]);

impl BlobHash {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 32] {
        self.0
    }

    pub(crate) fn from_blob(bytes: &[u8]) -> Result<Self, &'static str> {
        let array = bytes.try_into().map_err(|_| "blob hash is not 32 bytes")?;
        Ok(Self(array))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Head {
    pub sequence: u64,
    pub hash: ChainHash,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProjectionKey(String);

impl ProjectionKey {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty() || value.len() > 64 {
            return Err("projection key length must be 1..=64 bytes");
        }
        if !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        }) {
            return Err(
                "projection key must use lowercase ASCII, digits, dot, dash, or underscore",
            );
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JournalOptions {
    pub writer_wait: Duration,
}

impl Default for JournalOptions {
    fn default() -> Self {
        Self {
            writer_wait: Duration::ZERO,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ProjectionUpdate<'a> {
    pub key: &'a ProjectionKey,
    pub expected_sequence: u64,
    pub bytes: &'a [u8],
}

#[derive(Clone, Copy, Debug)]
pub struct SnapshotInput<'a> {
    pub bytes: &'a [u8],
}

#[derive(Clone, Copy, Debug)]
pub struct AppendRequest<'a> {
    pub stream_id: StreamId,
    pub expected_head: Option<Head>,
    pub event: &'a AdmissionEvent,
    pub projection: Option<ProjectionUpdate<'a>>,
    pub snapshot: Option<SnapshotInput<'a>>,
}

impl<'a> AppendRequest<'a> {
    pub const fn event(
        stream_id: StreamId,
        expected_head: Option<Head>,
        event: &'a AdmissionEvent,
    ) -> Self {
        Self {
            stream_id,
            expected_head,
            event,
            projection: None,
            snapshot: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventEnvelope {
    pub global_sequence: u64,
    pub stream_sequence: u64,
    pub stream_id: StreamId,
    pub event_id: EventId,
    pub previous_hash: ChainHash,
    pub hash: ChainHash,
    pub event: AdmissionEvent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppendReceipt {
    pub global_sequence: u64,
    pub stream_sequence: u64,
    pub event_id: EventId,
    pub head: Head,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRecord {
    pub key: ProjectionKey,
    pub through_sequence: u64,
    pub source_hash: ChainHash,
    pub blob_hash: BlobHash,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotRecord {
    pub through_sequence: u64,
    pub source_hash: ChainHash,
    pub blob_hash: BlobHash,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestorePlan {
    pub head: Option<Head>,
    pub snapshot: Option<SnapshotRecord>,
    pub events: Vec<EventEnvelope>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IntegrityReport {
    pub events: u64,
    pub streams: u64,
    pub blobs: u64,
    pub snapshots: u64,
    pub projections: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CheckpointReport {
    pub busy: u32,
    pub log_frames: u32,
    pub checkpointed_frames: u32,
}

impl fmt::Display for ChainHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// A request to shadow a precise event range with a summary (S130).
///
/// The range is given explicitly rather than inferred from "everything before
/// the head". Inferring it is how a compaction races an in-flight append and
/// swallows an event nobody knew was there; naming it makes the caller state
/// what it read, and the journal verifies that is still what is there.
#[derive(Clone, Copy, Debug)]
pub struct CompactRequest<'a> {
    pub stream_id: StreamId,
    pub from_sequence: u64,
    pub through_sequence: u64,
    /// The summary that stands in for the range. Content-addressed like any blob.
    pub summary: &'a [u8],
    pub tokens_before: u64,
    pub tokens_after: u64,
}

/// What a compaction shadowed, and by how much.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompactionRecord {
    pub from_sequence: u64,
    pub through_sequence: u64,
    pub source_hash: ChainHash,
    pub blob_hash: BlobHash,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub bytes: Vec<u8>,
}

impl CompactionRecord {
    /// Events shadowed by this compaction.
    pub const fn shadowed_events(&self) -> u64 {
        self.through_sequence - self.from_sequence + 1
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompactionReceipt {
    pub from_sequence: u64,
    pub through_sequence: u64,
    pub source_hash: ChainHash,
    pub blob_hash: BlobHash,
    pub tokens_before: u64,
    pub tokens_after: u64,
}

/// One entry of a compacted read: either a live event or a summary standing in
/// for a shadowed range.
///
/// A `Vec<EventEnvelope>` with holes in it would have been simpler and would
/// have lost the only thing a reader needs to know — that something is missing
/// here on purpose, and where to find it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompactedEntry {
    Event(EventEnvelope),
    Summary(CompactionRecord),
}
