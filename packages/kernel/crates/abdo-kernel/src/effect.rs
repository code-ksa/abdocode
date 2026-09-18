//! What the reducer decides is owed.

use abdo_contracts::{Digest, EventId, IntentId, ProposalId, Scope, TargetRef};

/// One effect the kernel has committed to owing.
///
/// An effect intent is a decision, not an execution: it says an admitted intent
/// must eventually be prepared, dispatched, settled and verified. None of that
/// happens in this crate. The reducer emits an intent exactly once, on the one
/// legitimate transition into [`crate::ProposalPhase::Admitted`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectIntent {
    pub intent_id: IntentId,
    pub proposal_id: ProposalId,
    pub cause_event: EventId,
    pub scope: Scope,
    pub target: TargetRef,
    pub operation_digest: Digest,
    pub admitted_at_ms: u64,
    pub expires_at_ms: u64,
}
