#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! The single semantic journal for the trusted Abdo Code kernel.
//!
//! The journal owns one SQLite database in WAL mode. It admits one live writer,
//! appends canonical [`abdo_contracts::AdmissionEvent`] envelopes, maintains a
//! SHA-256 hash chain, and stores projections and snapshots as derived views of
//! immutable content-addressed blobs. It also holds the durable effect ledger,
//! whose phase tags it stores without interpreting, and the durable leases and
//! budgets whose meaning belongs to the runtime. It is not an authority or an evidence
//! verifier; those responsibilities remain in later kernel layers.

mod effects;
mod error;
mod govern;
mod hash;
mod identity;
mod journal;
mod migration;
mod model;

#[cfg(feature = "test-hooks")]
pub mod test_support;

pub use effects::{
    EffectAppendReceipt, EffectAppendRequest, EffectId, EffectPhaseTag, EffectRecord,
};
pub use error::JournalError;
pub use govern::{BudgetRecord, HolderId, LeaseRecord, ScopeId};
pub use identity::{
    SqliteIdentity, PINNED_NORMALIZED_COMPILE_OPTIONS, PINNED_SQLITE_SOURCE_ID,
    PINNED_SQLITE_VERSION,
};
pub use journal::Journal;
pub use model::MAX_DERIVED_BLOB_BYTES;
pub use model::{
    AppendReceipt, AppendRequest, BlobHash, ChainHash, CheckpointReport, CompactRequest,
    CompactedEntry, CompactionReceipt, CompactionRecord, EventEnvelope, Head, IntegrityReport,
    JournalOptions, ProjectionKey, ProjectionRecord, ProjectionUpdate, RestorePlan, SnapshotInput,
    SnapshotRecord, StreamId,
};
pub mod blueprint_facades;
