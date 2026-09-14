//! Reconciliation: closing the effects that nobody could resolve.
//!
//! An effect whose dispatch was committed and whose outcome never arrived is
//! the one genuinely hard state in the system. The tempting answer is to run it
//! again. That answer is wrong, and this module is built so it cannot be given:
//! [`Reconciler`] never receives a [`crate::Dispatcher`], so there is no call it
//! could make to touch the world. It gathers evidence and records a conclusion.
//!
//! There are exactly three conclusions:
//!
//! - the evidence says the effect ran, or says it did not: [`Resolution::Evidence`]
//! - the effect ran and must be undone: [`Resolution::CompensationRequired`]
//! - no evidence is obtainable: [`Resolution::HumanDecision`]
//!
//! Compensation, and any evidence-backed retry, become *separate effects* with
//! their own identifiers and their own lifecycles, caused by this one. That
//! keeps one dispatch to one effect: hiding a second action inside the first
//! would let the ledger report one touch of the world where there were two.
//!
//! Reconciliation is idempotent because every conclusion is a phase, and the
//! ledger refuses a repeated phase. Running the sweep twice cannot advance an
//! effect twice.

use abdo_contracts::{Digest, IntentId};
use abdo_journal::{EffectId, Journal};

use crate::error::RuntimeError;
use crate::phase::EffectPhase;
use crate::supervisor::{EffectSupervisor, Settlement};

/// What an observer could establish about an effect that never reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservedOutcome {
    /// It ran, and here is what it did.
    Happened(Settlement),
    /// It provably did not run. Its identity is spent, but the world is clean.
    DidNotHappen { observed_at_ms: u64 },
}

/// Where evidence about an unresolved effect comes from.
///
/// Implemented outside the trusted core, and deliberately unable to change
/// anything: an oracle that could act would be a dispatcher wearing a
/// different name.
pub trait OutcomeOracle {
    fn observe(&self, intent_id: IntentId, operation_digest: Digest) -> Option<ObservedOutcome>;
}

/// An oracle that never knows anything.
///
/// The honest default. A reconciler with no way to observe must escalate, not
/// assume; shipping an oracle that guessed would make every unresolved effect
/// silently "fine".
#[derive(Clone, Copy, Debug, Default)]
pub struct BlindOracle;

impl OutcomeOracle for BlindOracle {
    fn observe(&self, _intent_id: IntentId, _operation_digest: Digest) -> Option<ObservedOutcome> {
        None
    }
}

/// Whether an effect that ran should be undone.
pub trait CompensationPolicy {
    fn requires_compensation(&self, intent_id: IntentId, settlement: Settlement) -> bool;
}

/// Leave what ran in place. Undoing is a decision, not a default.
#[derive(Clone, Copy, Debug, Default)]
pub struct KeepWhatRan;

impl CompensationPolicy for KeepWhatRan {
    fn requires_compensation(&self, _intent_id: IntentId, _settlement: Settlement) -> bool {
        false
    }
}

/// A description of the inverse effect that must be prepared separately.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompensationRequest {
    /// The effect being undone.
    pub compensating_for: IntentId,
    /// What the original turned out to have done.
    pub observed: Settlement,
}

/// The conclusion reconciliation reached about one effect.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resolution {
    /// Evidence closed the question.
    Evidence(ObservedOutcome),
    /// It ran and must be undone by a separate effect.
    CompensationRequired(CompensationRequest),
    /// Nothing could be established. A person owns it now, and it stays
    /// outstanding until they answer.
    HumanDecision,
}

/// One effect that is not finished, and why.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Outstanding {
    pub intent_id: IntentId,
    pub phase: EffectPhase,
    /// True when the world may already have changed and nobody can say.
    pub unconfirmed: bool,
}

/// A sweep over every effect the ledger knows about.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SweepReport {
    pub examined: usize,
    pub resolved_by_evidence: usize,
    pub compensations_requested: usize,
    pub escalated: usize,
    /// Effects still not finished after the sweep, including every escalation.
    pub outstanding: Vec<Outstanding>,
}

/// Everything one reconciliation pass is allowed to consult.
///
/// Grouping the ports here is not only tidiness: it makes the whole surface of
/// what reconciliation may touch visible in one place, and there is no
/// dispatcher in it.
#[derive(Clone, Copy)]
pub struct ReconciliationContext<'a> {
    pub oracle: &'a dyn OutcomeOracle,
    pub policy: &'a dyn CompensationPolicy,
    /// The operation being asked about, as a digest rather than its content.
    pub operation_digest: Digest,
    pub at_ms: u64,
}

impl std::fmt::Debug for ReconciliationContext<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReconciliationContext")
            .field("at_ms", &self.at_ms)
            .finish_non_exhaustive()
    }
}

/// Reconciles unresolved effects. Holds no state and cannot dispatch.
#[derive(Clone, Copy, Debug, Default)]
pub struct Reconciler;

impl Reconciler {
    pub const fn new() -> Self {
        Self
    }

    /// Every effect that is not finished.
    ///
    /// "Not finished" includes escalations. An unconfirmed action that stopped
    /// being reported would be an unconfirmed action nobody is looking for.
    pub fn outstanding(&self, journal: &Journal) -> Result<Vec<Outstanding>, RuntimeError> {
        let mut result = Vec::new();
        for effect_id in journal.effect_ids()? {
            let history = journal.effect_history(effect_id)?;
            let Some(last) = history.last() else { continue };
            let phase = EffectPhase::from_tag(last.phase_tag.get()).ok_or_else(|| {
                RuntimeError::Corrupt(format!("unknown effect phase tag {}", last.phase_tag.get()))
            })?;
            if phase.is_resolved() {
                continue;
            }
            result.push(Outstanding {
                intent_id: intent_of(effect_id)?,
                phase,
                unconfirmed: phase.needs_reconciliation(),
            });
        }
        Ok(result)
    }

    /// Reconcile one effect, recording the conclusion durably.
    ///
    /// Returns `None` when the effect does not need reconciliation, so a sweep
    /// can run over everything without deciding in advance what it will find.
    pub fn reconcile(
        &self,
        journal: &mut Journal,
        supervisor: &EffectSupervisor,
        intent_id: IntentId,
        context: &ReconciliationContext<'_>,
    ) -> Result<Option<Resolution>, RuntimeError> {
        let operation_digest = context.operation_digest;
        let at_ms = context.at_ms;
        let effect_id = effect_of(intent_id)?;
        let history = journal.effect_history(effect_id)?;
        let Some(last) = history.last() else {
            return Ok(None);
        };
        let phase = EffectPhase::from_tag(last.phase_tag.get()).ok_or_else(|| {
            RuntimeError::Corrupt(format!("unknown effect phase tag {}", last.phase_tag.get()))
        })?;

        // Only an unresolved outcome is reconcilable, and only from the phases
        // the lifecycle allows. Anything else is left exactly as it is: a sweep
        // that "tidied" a settled effect would be rewriting history.
        let from = match phase {
            EffectPhase::UnknownOutcome | EffectPhase::Escalated => phase,
            _ => return Ok(None),
        };

        match context.oracle.observe(intent_id, operation_digest) {
            None => {
                if from == EffectPhase::Escalated {
                    // Already escalated and still unknowable. Recording a second
                    // escalation would be noise, and the ledger would refuse it
                    // anyway.
                    return Ok(Some(Resolution::HumanDecision));
                }
                supervisor.record_reconciliation(
                    journal,
                    intent_id,
                    EffectPhase::Escalated,
                    from,
                    operation_digest,
                    at_ms,
                )?;
                Ok(Some(Resolution::HumanDecision))
            }
            Some(ObservedOutcome::DidNotHappen { observed_at_ms }) => {
                supervisor.record_reconciliation(
                    journal,
                    intent_id,
                    EffectPhase::Reconciled,
                    from,
                    operation_digest,
                    observed_at_ms,
                )?;
                Ok(Some(Resolution::Evidence(ObservedOutcome::DidNotHappen {
                    observed_at_ms,
                })))
            }
            Some(ObservedOutcome::Happened(settlement)) => {
                if context.policy.requires_compensation(intent_id, settlement) {
                    supervisor.record_reconciliation(
                        journal,
                        intent_id,
                        EffectPhase::Compensated,
                        from,
                        settlement.outcome_digest,
                        settlement.settled_at_ms,
                    )?;
                    Ok(Some(Resolution::CompensationRequired(
                        CompensationRequest {
                            compensating_for: intent_id,
                            observed: settlement,
                        },
                    )))
                } else {
                    supervisor.record_reconciliation(
                        journal,
                        intent_id,
                        EffectPhase::Reconciled,
                        from,
                        settlement.outcome_digest,
                        settlement.settled_at_ms,
                    )?;
                    Ok(Some(Resolution::Evidence(ObservedOutcome::Happened(
                        settlement,
                    ))))
                }
            }
        }
    }

    /// Reconcile everything outstanding, then report what remains.
    ///
    /// Idempotent: every conclusion is a durable phase, and the ledger refuses a
    /// repeated phase, so a second sweep changes nothing.
    pub fn sweep(
        &self,
        journal: &mut Journal,
        supervisor: &EffectSupervisor,
        context: &ReconciliationContext<'_>,
    ) -> Result<SweepReport, RuntimeError> {
        let mut report = SweepReport::default();
        let targets = self.outstanding(journal)?;
        report.examined = targets.len();
        for target in targets {
            match self.reconcile(journal, supervisor, target.intent_id, context)? {
                Some(Resolution::Evidence(_)) => report.resolved_by_evidence += 1,
                Some(Resolution::CompensationRequired(_)) => report.compensations_requested += 1,
                Some(Resolution::HumanDecision) => report.escalated += 1,
                None => {}
            }
        }
        report.outstanding = self.outstanding(journal)?;
        Ok(report)
    }
}

fn effect_of(intent_id: IntentId) -> Result<EffectId, RuntimeError> {
    EffectId::try_from_u128(intent_id.get())
        .map_err(|reason| RuntimeError::Corrupt(reason.to_owned()))
}

fn intent_of(effect_id: EffectId) -> Result<IntentId, RuntimeError> {
    IntentId::try_from_u128(effect_id.get())
        .map_err(|reason| RuntimeError::Corrupt(reason.to_owned()))
}
