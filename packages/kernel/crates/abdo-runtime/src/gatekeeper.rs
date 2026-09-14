//! Asking a person, and writing down that they were asked.
//!
//! [`abdo_policy::Policy`] decides *whether* somebody must answer. This
//! module carries the question out and the answer back, and records both in the
//! effect ledger.
//!
//! # The ledger, not a side log
//!
//! `approval/asked` and `approval/decided` are phases of the effect, stored in
//! the same hash-chained table as every other phase. A separate approvals log
//! would be a second record that can disagree with the first, and the first
//! disagreement is an effect the ledger says ran with an approval nobody can
//! find. Here there is one chain, and the question is a link in it.
//!
//! # Asked is written before asking
//!
//! [`EffectPhase::ApprovalAsked`] is durable before the handler is called. A
//! crash in the gap then leaves a ledger saying a question is outstanding,
//! which recovery can act on by asking again. Recording it afterwards would
//! leave a ledger saying nobody was ever asked, which is indistinguishable from
//! an effect that never needed asking.
//!
//! # Nobody answering is a refusal
//!
//! There is no path here that treats an absent, failed or silent handler as a
//! grant. The refusal is recorded with its reason, so "we could not reach the
//! operator" and "the operator said no" stay different facts even though they
//! have the same consequence.

use abdo_contracts::{Digest, IntentId};
use abdo_journal::{ChainHash, EffectId, Journal, StreamId};
use abdo_kernel::EffectIntent;
use abdo_policy::{Approval, ApprovalRefusal, Policy, PolicyOutcome, PolicyRequest, Risk};

use crate::error::RuntimeError;
use crate::phase::EffectPhase;
// Reused rather than reimplemented. This module used to carry its own copy of
// the phase writer -- the same transition check, the same append, the same
// error mapping, and its own byte-identical payload encoder. Two writers meant
// the rule about when a phase may be written lived in two places, and neither
// could be taught about resumption without the other drifting in silence.
use crate::supervisor::effect_id_of;

/// What the person is shown. Digests, never prose.
///
/// A question rendered from the model's own words would be a question the model
/// writes. The operator's client renders these; the kernel only binds them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApprovalQuestion {
    pub intent_id: IntentId,
    pub binding: Digest,
    pub risk: Risk,
    pub asked_at_ms: u64,
    pub expires_at_ms: u64,
}

/// Whoever answers approval questions.
pub trait ApprovalPort {
    /// Answer, or do not.
    ///
    /// `None` means no answer arrived. It is not a hook for "allow by default":
    /// there is nothing the caller can return that makes silence a grant.
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval>;
}

/// A port that answers nothing.
///
/// The default when no operator is attached, and it exists so that "unattended"
/// is a configuration rather than a missing field that happens to be permissive.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoOperator;

impl ApprovalPort for NoOperator {
    fn ask(&self, _question: &ApprovalQuestion) -> Option<Approval> {
        None
    }
}

/// How an effect got past policy, or did not.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Clearance {
    /// Policy allowed it outright. Nobody was asked because nobody needed to be.
    Allowed,
    /// A person was asked and said yes, for this exact binding.
    Approved { risk: Risk },
    /// Refused, with the reason kept.
    Refused {
        risk: Risk,
        refusal: ApprovalRefusal,
    },
}

impl Clearance {
    /// May the effect proceed to authorisation?
    pub const fn is_cleared(self) -> bool {
        matches!(self, Self::Allowed | Self::Approved { .. })
    }
}

/// Policy plus the ledger it writes to.
#[derive(Debug, Default)]
pub struct Gatekeeper {
    policy: Policy,
    asked: u64,
    allowed: u64,
    granted: u64,
    refused: u64,
}

impl Gatekeeper {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            asked: 0,
            allowed: 0,
            granted: 0,
            refused: 0,
        }
    }

    pub fn policy_mut(&mut self) -> &mut Policy {
        &mut self.policy
    }

    pub const fn asked(&self) -> u64 {
        self.asked
    }

    /// Cleared without anybody being asked, because policy allowed it.
    ///
    /// Kept apart from [`Gatekeeper::granted`]: a person saying yes and a rule
    /// saying nobody needs to are both clearances, and counting them together
    /// would make an unattended run look supervised.
    pub const fn allowed(&self) -> u64 {
        self.allowed
    }

    /// Cleared because a person said yes.
    pub const fn granted(&self) -> u64 {
        self.granted
    }

    pub const fn refused(&self) -> u64 {
        self.refused
    }

    /// Put an intent to policy, ask a person if policy says so, and record it.
    ///
    /// The `args_digest` is supplied by the caller rather than read off the
    /// intent, because what a person approves is the arguments they were shown.
    /// An intent whose arguments changed after the question was put produces a
    /// different binding, and the answer no longer fits it.
    #[allow(clippy::too_many_arguments)]
    pub fn clear(
        &mut self,
        journal: &mut Journal,
        intent: &EffectIntent,
        args_digest: Digest,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        operator: &dyn ApprovalPort,
        at_ms: u64,
    ) -> Result<Clearance, RuntimeError> {
        self.clear_with(
            journal,
            intent,
            args_digest,
            stream_id,
            cause_event_hash,
            operator,
            at_ms,
            crate::supervisor::Write::Fresh,
        )
    }

    /// Clearance, re-entered after a crash.
    ///
    /// Policy is consulted AGAIN rather than inherited from the ledger, for the
    /// same reason authority is: a rule can change while a host is down, and a
    /// resume that skipped the question would carry a stale permission
    /// forward. Only the WRITE is forgiving — a `Cleared` already standing in
    /// the ledger satisfies the step instead of colliding with it.
    #[allow(clippy::too_many_arguments)]
    pub fn resume_clear(
        &mut self,
        journal: &mut Journal,
        intent: &EffectIntent,
        args_digest: Digest,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        operator: &dyn ApprovalPort,
        at_ms: u64,
    ) -> Result<Clearance, RuntimeError> {
        self.clear_with(
            journal,
            intent,
            args_digest,
            stream_id,
            cause_event_hash,
            operator,
            at_ms,
            crate::supervisor::Write::Resume,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn clear_with(
        &mut self,
        journal: &mut Journal,
        intent: &EffectIntent,
        args_digest: Digest,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        operator: &dyn ApprovalPort,
        at_ms: u64,
        mode: crate::supervisor::Write,
    ) -> Result<Clearance, RuntimeError> {
        let effect_id = effect_id_of(intent.intent_id)?;
        let request = PolicyRequest {
            scope: &intent.scope,
            target: &intent.target,
            operation_digest: intent.operation_digest,
            args_digest,
            now_ms: at_ms,
            expires_at_ms: intent.expires_at_ms,
        };

        let (risk, binding) = match self.policy.evaluate(&request) {
            PolicyOutcome::Allow => {
                // Recorded even though nobody was asked. The alternative is a
                // second way into `Authorized` that skips this module, and one
                // extra row per effect is a cheap price for the graph having
                // exactly one door.
                self.record(
                    mode,
                    journal,
                    effect_id,
                    stream_id,
                    cause_event_hash,
                    EffectPhase::Cleared,
                    Some(EffectPhase::Prepared),
                    intent.operation_digest,
                    at_ms,
                    intent.intent_id,
                )?;
                self.allowed += 1;
                return Ok(Clearance::Allowed);
            }
            PolicyOutcome::Deny { risk } => {
                // Nobody is asked, because policy already answered. The refusal
                // is still written down: an effect refused without a trace is
                // one nobody can audit.
                self.refuse(
                    journal,
                    effect_id,
                    stream_id,
                    cause_event_hash,
                    EffectPhase::Prepared,
                    intent.operation_digest,
                    at_ms,
                    intent.intent_id,
                )?;
                return Ok(Clearance::Refused {
                    risk,
                    refusal: ApprovalRefusal::Refused,
                });
            }
            PolicyOutcome::RequireApproval { risk, binding } => (risk, binding),
        };

        // Durable before the question goes out.
        self.record(
            mode,
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            EffectPhase::ApprovalAsked,
            Some(EffectPhase::Prepared),
            binding,
            at_ms,
            intent.intent_id,
        )?;
        self.asked += 1;

        let answer = operator.ask(&ApprovalQuestion {
            intent_id: intent.intent_id,
            binding,
            risk,
            asked_at_ms: at_ms,
            expires_at_ms: intent.expires_at_ms,
        });

        // A missing answer is refused here, before `admit` is ever reached, so
        // there is no code path where an absent operator meets the admission
        // rules at all.
        let Some(approval) = answer else {
            self.refuse(
                journal,
                effect_id,
                stream_id,
                cause_event_hash,
                EffectPhase::ApprovalAsked,
                intent.operation_digest,
                at_ms,
                intent.intent_id,
            )?;
            return Ok(Clearance::Refused {
                risk,
                refusal: ApprovalRefusal::NoDecision,
            });
        };

        // Recomputed from the request, not read off the approval. This is where
        // an edited payload stops.
        if let Err(refusal) = self.policy.admit(&approval, &request) {
            self.refuse(
                journal,
                effect_id,
                stream_id,
                cause_event_hash,
                EffectPhase::ApprovalAsked,
                intent.operation_digest,
                at_ms,
                intent.intent_id,
            )?;
            return Ok(Clearance::Refused { risk, refusal });
        }

        self.record(
            mode,
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            EffectPhase::Cleared,
            Some(EffectPhase::ApprovalAsked),
            binding,
            at_ms,
            intent.intent_id,
        )?;
        self.granted += 1;
        Ok(Clearance::Approved { risk })
    }

    #[allow(clippy::too_many_arguments)]
    /// A refusal is always written fresh. There is no resuming a refusal — the
    /// phase is terminal and has no edge out of it.
    fn refuse(
        &mut self,
        journal: &mut Journal,
        effect_id: EffectId,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        from: EffectPhase,
        payload_digest: Digest,
        at_ms: u64,
        intent_id: IntentId,
    ) -> Result<(), RuntimeError> {
        self.record(
            crate::supervisor::Write::Fresh,
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            EffectPhase::ApprovalRefused,
            Some(from),
            payload_digest,
            at_ms,
            intent_id,
        )?;
        self.refused += 1;
        Ok(())
    }

    /// One phase, written by the one writer.
    ///
    /// This used to be a second copy of `supervisor::append_phase`, identical
    /// down to the payload encoder — the same transition check, the same
    /// append, the same error mapping, and its own `approval_payload` building
    /// the same bytes. Two writers meant the rule about when a phase may be
    /// written lived in two places, and resumption could not be added to one of
    /// them without the other drifting away from it in silence.
    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        mode: crate::supervisor::Write,
        journal: &mut Journal,
        effect_id: EffectId,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        phase: EffectPhase,
        expected_previous: Option<EffectPhase>,
        payload_digest: Digest,
        at_ms: u64,
        intent_id: IntentId,
    ) -> Result<(), RuntimeError> {
        crate::supervisor::append_phase(
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            phase,
            expected_previous,
            &crate::supervisor::phase_payload(phase, payload_digest, at_ms),
            at_ms,
            intent_id,
            mode,
        )
    }
}
