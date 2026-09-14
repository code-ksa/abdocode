//! Deterministic event builders shared by the reducer tests.
//!
//! Nothing here reads a clock, a file, an environment variable or a random
//! source. Every value is a pure function of its seed, so a trace built on one
//! machine is byte-identical to the same trace built anywhere else. A test that
//! seeded itself from the system clock could not prove determinism at all.

#![allow(dead_code)]

use abdo_contracts::{
    AdmissionEvent, AdmittedEvent, AdmittedIntent, ArtifactHandle, CancelledEvent, CatalogHandle,
    CauseRef, CommandCause, CommandId, Digest, EventId, ExpiredEvent, FilesystemHandle,
    FilesystemTargetRef, IntentId, PolicyHandle, ProposalId, ReceivedEvent, RefusedEvent,
    RootCause, Scope, StateHandle, TargetRef, ValidatedEvent, WorkspaceScope,
};

/// A proposal and the identifiers derived from it.
///
/// One seed fixes every identifier a proposal will ever use, so the same seed
/// always produces the same trace.
#[derive(Clone, Copy, Debug)]
pub struct Seeded {
    pub seed: u128,
}

impl Seeded {
    pub const fn new(seed: u128) -> Self {
        Self { seed }
    }

    pub fn proposal_id(self) -> ProposalId {
        ProposalId::try_from_u128(self.seed * 8 + 1)
            .expect("seeded proposal identifier is non-zero")
    }

    pub fn command_id(self) -> CommandId {
        CommandId::try_from_u128(self.seed * 8 + 2).expect("seeded command identifier is non-zero")
    }

    pub fn intent_id(self) -> IntentId {
        IntentId::try_from_u128(self.seed * 8 + 3).expect("seeded intent identifier is non-zero")
    }

    pub fn event_id(self, step: u128) -> EventId {
        EventId::try_from_u128(self.seed * 8 + 4 + step)
            .expect("seeded event identifier is non-zero")
    }
}

pub fn digest(fill: u8) -> Digest {
    Digest::from_bytes([fill.max(1); 32])
}

fn artifact(fill: u8) -> ArtifactHandle {
    ArtifactHandle::from_bytes([fill.max(1); 32])
}

fn state_handle(fill: u8) -> StateHandle {
    StateHandle::from_bytes([fill.max(1); 32])
}

fn policy(fill: u8) -> PolicyHandle {
    PolicyHandle::from_bytes([fill.max(1); 32])
}

fn catalog(fill: u8) -> CatalogHandle {
    CatalogHandle::from_bytes([fill.max(1); 32])
}

fn filesystem_target(fill: u8) -> TargetRef {
    TargetRef::Filesystem(Box::new(FilesystemTargetRef {
        object: FilesystemHandle::from_bytes([fill.max(1); 32]),
    }))
}

pub fn received(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: seeded.event_id(0),
        proposal_id: seeded.proposal_id(),
        command_id: seeded.command_id(),
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms,
    }))
}

pub fn validated(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    AdmissionEvent::Validated(Box::new(ValidatedEvent {
        event_id: seeded.event_id(1),
        proposal_id: seeded.proposal_id(),
        cause: CauseRef::Command(Box::new(CommandCause {
            command_id: seeded.command_id(),
        })),
        claim_digest: digest(seeded.seed as u8 | 0x40),
        at_ms,
    }))
}

pub fn admitted(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    let fill = seeded.seed as u8 | 0x20;
    AdmissionEvent::Admitted(Box::new(AdmittedEvent {
        event_id: seeded.event_id(2),
        intent: AdmittedIntent {
            intent_id: seeded.intent_id(),
            proposal_id: seeded.proposal_id(),
            scope: Scope::Workspace(Box::new(WorkspaceScope)),
            cause: CauseRef::Command(Box::new(CommandCause {
                command_id: seeded.command_id(),
            })),
            target: filesystem_target(fill),
            proposed_digest: digest(fill),
            operation_digest: digest(fill ^ 0x0f),
            artifact: artifact(fill),
            state: state_handle(fill),
            state_digest: digest(fill ^ 0x33),
            policy: policy(fill),
            policy_digest: digest(fill ^ 0x55),
            catalog: catalog(fill),
            catalog_digest: digest(fill ^ 0x77),
            trust_receipt_id: abdo_contracts::ReceiptId::try_from_u128(seeded.seed * 8 + 7)
                .expect("seeded receipt identifier is non-zero"),
            trust_receipt_digest: digest(fill ^ 0x11),
            admitted_at_ms: at_ms,
            expires_at_ms: at_ms.saturating_add(60_000),
        },
        at_ms,
    }))
}

pub fn refused(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    AdmissionEvent::Refused(Box::new(RefusedEvent {
        event_id: seeded.event_id(3),
        proposal_id: seeded.proposal_id(),
        cause: CauseRef::Root(Box::new(RootCause)),
        reason_digest: digest(0x9a),
        at_ms,
    }))
}

pub fn expired(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    AdmissionEvent::Expired(Box::new(ExpiredEvent {
        event_id: seeded.event_id(4),
        proposal_id: seeded.proposal_id(),
        cause: CauseRef::Root(Box::new(RootCause)),
        reason_digest: digest(0xa9),
        at_ms,
    }))
}

pub fn cancelled(seeded: Seeded, at_ms: u64) -> AdmissionEvent {
    AdmissionEvent::Cancelled(Box::new(CancelledEvent {
        event_id: seeded.event_id(5),
        proposal_id: seeded.proposal_id(),
        cancellation_id: abdo_contracts::CancellationId::try_from_u128(seeded.seed * 8 + 6)
            .expect("seeded cancellation identifier is non-zero"),
        cause: CauseRef::Root(Box::new(RootCause)),
        reason_digest: digest(0xc3),
        at_ms,
    }))
}

/// A deterministic trace: `count` proposals, each carried through a lifecycle
/// chosen by its own seed, interleaved so no proposal is ever folded alone.
pub fn interleaved_trace(count: u128) -> Vec<AdmissionEvent> {
    let mut events = Vec::new();
    for seed in 1..=count {
        let seeded = Seeded::new(seed);
        let base = 1_000 + (seed as u64) * 10;
        events.push(received(seeded, base));
    }
    for seed in 1..=count {
        let seeded = Seeded::new(seed);
        let base = 1_000 + (seed as u64) * 10 + 1;
        match seed % 4 {
            0 => events.push(refused(seeded, base)),
            _ => events.push(validated(seeded, base)),
        }
    }
    for seed in 1..=count {
        if seed % 4 == 0 {
            continue;
        }
        let seeded = Seeded::new(seed);
        let base = 1_000 + (seed as u64) * 10 + 2;
        match seed % 4 {
            1 => events.push(admitted(seeded, base)),
            2 => events.push(cancelled(seeded, base)),
            _ => events.push(expired(seeded, base)),
        }
    }
    events
}

/// A tiny reproducible generator. `rand` is not a dependency of the kernel and
/// a test that needs randomness needs it to be replayable, not unpredictable.
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64(u64);

impl SplitMix64 {
    pub const fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}
