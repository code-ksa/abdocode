//! The durable effect phases and the only transitions between them.

use abdo_journal::EffectPhaseTag;

/// One step of the effect lifecycle.
///
/// The discriminants are written into the durable ledger. Renumbering one would
/// silently reinterpret every effect already recorded, so they are fixed.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EffectPhase {
    /// Durable. The kernel has taken responsibility for the effect. Nothing
    /// observable has happened yet.
    Prepared = 1,
    /// Authority granted the effect. Still nothing observable.
    Authorized = 2,
    /// Durable, and written *before* the adapter is invoked. Past this point
    /// the world may already have changed.
    Dispatching = 3,
    /// The adapter returned control. The effect definitely started.
    Started = 4,
    /// The adapter reported an outcome.
    Settled = 5,
    /// The adapter did not report an outcome and the kernel cannot tell whether
    /// it ran. This is a real result, not an error to be retried away.
    UnknownOutcome = 6,
    /// The outcome was checked against the postconditions it promised.
    Verified = 7,
    /// Reconciliation obtained evidence about an unknown outcome and closed it.
    ///
    /// The evidence says either that the effect ran, or that it did not. Both
    /// are conclusions; neither is a retry.
    Reconciled = 8,
    /// An effect that ran was undone by a separate compensating effect.
    ///
    /// The compensation is its own effect with its own lifecycle. Hiding it
    /// inside this one would make the ledger claim a single action where two
    /// touched the world.
    Compensated = 9,
    /// No evidence was obtainable. A human owns this now.
    ///
    /// Deliberately not terminal: an escalated effect stays outstanding, and
    /// keeps being reported as such, until somebody decides. A kernel that
    /// closed the file on "we could not tell" would be inventing certainty.
    Escalated = 10,
    /// A person was asked, and has not answered yet.
    ///
    /// Written *before* the question is put, not after the answer comes back.
    /// A crash in between then leaves a ledger that says a question is
    /// outstanding, which is recoverable; the other order leaves one that says
    /// nobody was ever asked, which is not.
    ApprovalAsked = 11,
    /// Policy let this through: either it needed nobody, or a person answered
    /// yes for this exact binding.
    ///
    /// The only phase [`EffectPhase::Authorized`] may follow. An effect that
    /// never passed the gatekeeper has no edge into authorisation at all, so
    /// "policy spoke first" is a property of the graph rather than a rule the
    /// callers are asked to keep.
    Cleared = 12,
    /// Refused: by policy outright, or by the person, or because nobody
    /// answered at all.
    ///
    /// Terminal, and there is no edge out of it. A refusal that could be walked
    /// forward into a dispatch would not be a refusal.
    ApprovalRefused = 13,
}

/// Every phase, in lifecycle order.
pub const PHASE_ORDER: [EffectPhase; 13] = [
    EffectPhase::Prepared,
    EffectPhase::ApprovalAsked,
    EffectPhase::Cleared,
    EffectPhase::ApprovalRefused,
    EffectPhase::Authorized,
    EffectPhase::Dispatching,
    EffectPhase::Started,
    EffectPhase::Settled,
    EffectPhase::UnknownOutcome,
    EffectPhase::Verified,
    EffectPhase::Reconciled,
    EffectPhase::Compensated,
    EffectPhase::Escalated,
];

impl EffectPhase {
    pub const fn tag(self) -> u8 {
        self as u8
    }

    pub fn journal_tag(self) -> EffectPhaseTag {
        EffectPhaseTag::new(self.tag()).expect("effect phase tags are non-zero by construction")
    }

    pub fn from_tag(tag: u8) -> Option<Self> {
        PHASE_ORDER.into_iter().find(|phase| phase.tag() == tag)
    }

    /// Is this phase durable before the step it guards is allowed to proceed?
    ///
    /// Only two are, and they are the two that bracket the moment the outside
    /// world can change.
    pub const fn is_durable_barrier(self) -> bool {
        matches!(self, Self::Prepared | Self::Dispatching)
    }

    /// May `next` legitimately follow `self`?
    pub const fn may_precede(self, next: Self) -> bool {
        matches!(
            (self, next),
            // Approval sits between taking responsibility and being allowed to
            // act, and there is no way around it: `Prepared -> Authorized` is
            // deliberately absent, so every path to authorisation goes through
            // `Cleared`.
            (Self::Prepared, Self::ApprovalAsked)
                // Policy allowed it outright, so nobody was asked.
                | (Self::Prepared, Self::Cleared)
                // Policy denied it outright, so nobody was asked.
                | (Self::Prepared, Self::ApprovalRefused)
                | (Self::ApprovalAsked, Self::Cleared)
                | (Self::ApprovalAsked, Self::ApprovalRefused)
                | (Self::Cleared, Self::Authorized)
                | (Self::Authorized, Self::Dispatching)
                | (Self::Dispatching, Self::Started)
                | (Self::Dispatching, Self::UnknownOutcome)
                | (Self::Started, Self::Settled)
                | (Self::Started, Self::UnknownOutcome)
                | (Self::Settled, Self::Verified)
                // Reconciliation acts only on what nobody could resolve.
                | (Self::UnknownOutcome, Self::Reconciled)
                | (Self::UnknownOutcome, Self::Compensated)
                | (Self::UnknownOutcome, Self::Escalated)
                // A human decision resolves an escalation, in either direction.
                | (Self::Escalated, Self::Reconciled)
                | (Self::Escalated, Self::Compensated)
                // Evidence that the effect ran still has to be checked against
                // what it promised.
                | (Self::Reconciled, Self::Verified)
        )
    }

    /// Is this effect finished, with nothing left for anyone to decide?
    ///
    /// `Escalated` is not resolved. That is the point of it.
    pub const fn is_resolved(self) -> bool {
        // A refusal ends the effect with nothing owed: nothing ran, so there is
        // nothing to compensate and nobody left to ask.
        matches!(
            self,
            Self::Verified | Self::Compensated | Self::ApprovalRefused
        )
    }

    /// Is this phase part of asking a person?
    pub const fn is_approval(self) -> bool {
        matches!(
            self,
            Self::ApprovalAsked | Self::Cleared | Self::ApprovalRefused
        )
    }

    /// Does this phase need reconciliation rather than more dispatching?
    pub const fn needs_reconciliation(self) -> bool {
        matches!(
            self,
            Self::Dispatching | Self::Started | Self::UnknownOutcome | Self::Escalated
        )
    }

    /// Past this phase, the world may already have been changed.
    pub const fn is_observable(self) -> bool {
        matches!(
            self,
            Self::Dispatching
                | Self::Started
                | Self::Settled
                | Self::UnknownOutcome
                | Self::Verified
                | Self::Reconciled
                | Self::Compensated
                | Self::Escalated
        )
    }
}
