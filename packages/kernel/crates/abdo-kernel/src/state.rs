//! The reduced kernel state and its canonical encoding.

use std::collections::BTreeMap;

use abdo_contracts::{CommandId, Digest, EventId, IntentId, ProposalId, Writer};

use crate::fingerprint::{Fingerprint, CANONICAL_STATE_VERSION};

/// Where a proposal sits in the admission lifecycle.
///
/// The discriminants are part of the canonical encoding: renumbering one
/// rewrites every historical fingerprint, so they are fixed forever.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ProposalPhase {
    Received = 1,
    Validated = 2,
    Admitted = 3,
    Refused = 4,
    Expired = 5,
    Cancelled = 6,
}

impl ProposalPhase {
    pub const fn tag(self) -> u8 {
        self as u8
    }

    /// A terminal phase admits no further event for that proposal.
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Admitted | Self::Refused | Self::Expired | Self::Cancelled
        )
    }
}

/// Everything the kernel remembers about one proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProposalRecord {
    pub phase: ProposalPhase,
    pub command_id: CommandId,
    pub received_at_ms: u64,
    pub claim_digest: Option<Digest>,
    pub intent_id: Option<IntentId>,
    pub last_event_id: EventId,
    pub last_at_ms: u64,
}

/// The reduced state of one kernel stream.
///
/// Proposals are keyed by their identifier in a [`BTreeMap`], so iteration order
/// is a property of the data and not of insertion history or hasher seeding.
/// A `HashMap` here would make the canonical encoding depend on process-local
/// randomness and silently destroy the determinism this crate exists to provide.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct KernelState {
    proposals: BTreeMap<u128, ProposalRecord>,
    committed_effects: u64,
    applied_events: u64,
    last_at_ms: u64,
}

impl KernelState {
    /// The empty state every fold begins from.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn proposal(&self, proposal_id: ProposalId) -> Option<&ProposalRecord> {
        self.proposals.get(&proposal_id.get())
    }

    pub fn proposals(&self) -> impl ExactSizeIterator<Item = (ProposalId, &ProposalRecord)> {
        self.proposals.iter().map(|(key, record)| {
            (
                ProposalId::try_from_u128(*key).expect("stored proposal identifiers are non-zero"),
                record,
            )
        })
    }

    /// How many effect intents this state has committed. One admitted proposal
    /// owes exactly one effect, forever.
    pub const fn committed_effects(&self) -> u64 {
        self.committed_effects
    }

    pub const fn applied_events(&self) -> u64 {
        self.applied_events
    }

    /// The timestamp carried by the most recently applied event. This is read
    /// from the event, never from a clock.
    pub const fn last_at_ms(&self) -> u64 {
        self.last_at_ms
    }

    pub fn count_in_phase(&self, phase: ProposalPhase) -> u64 {
        self.proposals
            .values()
            .filter(|record| record.phase == phase)
            .count() as u64
    }

    pub(crate) fn insert(&mut self, proposal_id: ProposalId, record: ProposalRecord) {
        self.proposals.insert(proposal_id.get(), record);
    }

    pub(crate) fn record_applied(&mut self, at_ms: u64, committed_effects: u64) {
        self.applied_events = self.applied_events.saturating_add(1);
        self.committed_effects = self.committed_effects.saturating_add(committed_effects);
        if at_ms > self.last_at_ms {
            self.last_at_ms = at_ms;
        }
    }

    /// The canonical byte encoding of this state.
    ///
    /// This *is* the projection and snapshot payload. Storing anything else as a
    /// derived view of a stream breaks the reconstruction invariant, because the
    /// only way to reproduce a stored view is to fold the range it names and
    /// call this function.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(64 + self.proposals.len() * 96);
        writer.write_bytes(&CANONICAL_STATE_VERSION.to_le_bytes());
        writer.write_bytes(&(self.proposals.len() as u64).to_le_bytes());
        for (key, record) in &self.proposals {
            writer.write_bytes(&key.to_be_bytes());
            writer.write_bytes(&[record.phase.tag()]);
            write_id(&mut writer, record.command_id.get());
            writer.write_bytes(&record.received_at_ms.to_le_bytes());
            match record.claim_digest {
                Some(digest) => {
                    writer.write_bytes(&[1]);
                    writer.write_bytes(digest.as_bytes());
                }
                None => writer.write_bytes(&[0; 33]),
            }
            match record.intent_id {
                Some(intent_id) => {
                    writer.write_bytes(&[1]);
                    write_id(&mut writer, intent_id.get());
                }
                None => writer.write_bytes(&[0; 17]),
            }
            write_id(&mut writer, record.last_event_id.get());
            writer.write_bytes(&record.last_at_ms.to_le_bytes());
        }
        writer.write_bytes(&self.committed_effects.to_le_bytes());
        writer.write_bytes(&self.applied_events.to_le_bytes());
        writer.write_bytes(&self.last_at_ms.to_le_bytes());
        writer.into_inner()
    }

    /// The SHA-256 of [`KernelState::canonical_bytes`].
    ///
    /// Same digest family as the journal's blob hash, so a fingerprint computed
    /// here is directly comparable to the hash of a stored projection blob.
    pub fn fingerprint(&self) -> Fingerprint {
        Fingerprint::of(&self.canonical_bytes())
    }
}

fn write_id(writer: &mut Writer, value: u128) {
    writer.write_bytes(&value.to_be_bytes());
}
