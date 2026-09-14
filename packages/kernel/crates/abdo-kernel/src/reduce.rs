//! The reducer itself: `reduce(state, event) -> state + effect intents`.

use std::fmt;

use abdo_contracts::{AdmissionEvent, EventId, ProposalId};

use crate::effect::EffectIntent;
use crate::state::{KernelState, ProposalPhase, ProposalRecord};

/// The result of folding one event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reduction {
    pub state: KernelState,
    pub effects: Vec<EffectIntent>,
}

/// Why an event could not legitimately be applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IllegalTransition {
    /// A proposal was announced twice.
    ProposalAlreadyKnown,
    /// An event referred to a proposal the kernel never received.
    UnknownProposal,
    /// The proposal is in a phase this event may not follow.
    PhaseForbidsEvent { from: ProposalPhase },
    /// Time carried by the event precedes the recorded history of the proposal.
    NonMonotonicTime { last_at_ms: u64, at_ms: u64 },
}

/// A rejected fold: the untouched state, handed back with the reason.
///
/// The reducer takes its state by value, so returning the state inside the
/// rejection is what makes "never partially advanced" a fact of the type rather
/// than a promise in a comment. A caller cannot accidentally keep a state that
/// half-applied a rejected event, because no such value is ever constructed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rejection {
    pub state: KernelState,
    pub error: ReduceError,
}

/// Why a fold was rejected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReduceError {
    pub proposal_id: ProposalId,
    pub event_id: EventId,
    pub reason: IllegalTransition,
}

impl fmt::Display for ReduceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "illegal kernel transition for proposal {}: {:?}",
            self.proposal_id.get(),
            self.reason
        )
    }
}

impl std::error::Error for ReduceError {}

/// Fold one admission event into the kernel state.
///
/// Pure: no I/O, no clock, no randomness, no task, no interior mutability. The
/// only time it observes is `event.at_ms`, which is data carried by the event.
///
/// The state moves in and out by value. Cloning it per event would make one
/// fold cost O(live proposals), which the reducer budget of p99 under one
/// millisecond does not survive on a long-running session; moving it keeps a
/// fold at one map lookup and one insert.
///
/// An effect intent is emitted on exactly one transition, `Validated` to
/// `Admitted`, and never on any other, never twice for the same proposal, and
/// never on a rejected event. That single rule is what "no illegitimate
/// commitment" means, and it is the property the one-million-transition gate
/// measures.
pub fn reduce(state: KernelState, event: &AdmissionEvent) -> Result<Reduction, Rejection> {
    let mut next = state;
    let mut effects = Vec::new();

    match event {
        AdmissionEvent::Received(received) => {
            if next.proposal(received.proposal_id).is_some() {
                return Err(Rejection {
                    state: next,
                    error: ReduceError {
                        proposal_id: received.proposal_id,
                        event_id: received.event_id,
                        reason: IllegalTransition::ProposalAlreadyKnown,
                    },
                });
            }
            next.insert(
                received.proposal_id,
                ProposalRecord {
                    phase: ProposalPhase::Received,
                    command_id: received.command_id,
                    received_at_ms: received.at_ms,
                    claim_digest: None,
                    intent_id: None,
                    last_event_id: received.event_id,
                    last_at_ms: received.at_ms,
                },
            );
            next.record_applied(received.at_ms, 0);
        }
        AdmissionEvent::Validated(validated) => {
            let mut record = match existing(
                &next,
                validated.proposal_id,
                validated.event_id,
                validated.at_ms,
                &[ProposalPhase::Received],
            ) {
                Ok(record) => record,
                Err(error) => return Err(Rejection { state: next, error }),
            };
            record.phase = ProposalPhase::Validated;
            record.claim_digest = Some(validated.claim_digest);
            record.last_event_id = validated.event_id;
            record.last_at_ms = validated.at_ms;
            next.insert(validated.proposal_id, record);
            next.record_applied(validated.at_ms, 0);
        }
        AdmissionEvent::Admitted(admitted) => {
            let intent = &admitted.intent;
            let mut record = match existing(
                &next,
                intent.proposal_id,
                admitted.event_id,
                admitted.at_ms,
                &[ProposalPhase::Validated],
            ) {
                Ok(record) => record,
                Err(error) => return Err(Rejection { state: next, error }),
            };
            if intent.admitted_at_ms < record.last_at_ms {
                return Err(Rejection {
                    state: next,
                    error: ReduceError {
                        proposal_id: intent.proposal_id,
                        event_id: admitted.event_id,
                        reason: IllegalTransition::NonMonotonicTime {
                            last_at_ms: record.last_at_ms,
                            at_ms: intent.admitted_at_ms,
                        },
                    },
                });
            }
            record.phase = ProposalPhase::Admitted;
            record.intent_id = Some(intent.intent_id);
            record.last_event_id = admitted.event_id;
            record.last_at_ms = admitted.at_ms;
            next.insert(intent.proposal_id, record);
            effects.push(EffectIntent {
                intent_id: intent.intent_id,
                proposal_id: intent.proposal_id,
                cause_event: admitted.event_id,
                scope: intent.scope.clone(),
                target: intent.target.clone(),
                operation_digest: intent.operation_digest,
                admitted_at_ms: intent.admitted_at_ms,
                expires_at_ms: intent.expires_at_ms,
            });
            next.record_applied(admitted.at_ms, 1);
        }
        AdmissionEvent::Refused(refused) => {
            if let Err(error) = terminate(
                &mut next,
                refused.proposal_id,
                refused.event_id,
                refused.at_ms,
                ProposalPhase::Refused,
            ) {
                return Err(Rejection { state: next, error });
            }
        }
        AdmissionEvent::Expired(expired) => {
            if let Err(error) = terminate(
                &mut next,
                expired.proposal_id,
                expired.event_id,
                expired.at_ms,
                ProposalPhase::Expired,
            ) {
                return Err(Rejection { state: next, error });
            }
        }
        AdmissionEvent::Cancelled(cancelled) => {
            if let Err(error) = terminate(
                &mut next,
                cancelled.proposal_id,
                cancelled.event_id,
                cancelled.at_ms,
                ProposalPhase::Cancelled,
            ) {
                return Err(Rejection { state: next, error });
            }
        }
    }

    Ok(Reduction {
        state: next,
        effects,
    })
}

/// Fold a whole range, collecting every effect the range owes.
///
/// This is the function a derived view is defined by: `reduce_all` over the
/// exact events a projection names, then [`KernelState::canonical_bytes`].
pub fn reduce_all<'a>(
    state: KernelState,
    events: impl IntoIterator<Item = &'a AdmissionEvent>,
) -> Result<Reduction, Rejection> {
    let mut current = state;
    let mut effects = Vec::new();
    for event in events {
        let reduction = reduce(current, event)?;
        current = reduction.state;
        effects.extend(reduction.effects);
    }
    Ok(Reduction {
        state: current,
        effects,
    })
}

fn existing(
    state: &KernelState,
    proposal_id: ProposalId,
    event_id: EventId,
    at_ms: u64,
    allowed: &[ProposalPhase],
) -> Result<ProposalRecord, ReduceError> {
    let record = *state.proposal(proposal_id).ok_or(ReduceError {
        proposal_id,
        event_id,
        reason: IllegalTransition::UnknownProposal,
    })?;
    if !allowed.contains(&record.phase) {
        return Err(ReduceError {
            proposal_id,
            event_id,
            reason: IllegalTransition::PhaseForbidsEvent { from: record.phase },
        });
    }
    if at_ms < record.last_at_ms {
        return Err(ReduceError {
            proposal_id,
            event_id,
            reason: IllegalTransition::NonMonotonicTime {
                last_at_ms: record.last_at_ms,
                at_ms,
            },
        });
    }
    Ok(record)
}

/// Move a proposal to a terminal phase that owes no effect.
///
/// Only a live proposal can end this way. A proposal that has already been
/// admitted owes a committed effect, and withdrawing that effect is
/// compensation, not cancellation: a different mechanism, in a later sprint.
fn terminate(
    state: &mut KernelState,
    proposal_id: ProposalId,
    event_id: EventId,
    at_ms: u64,
    phase: ProposalPhase,
) -> Result<(), ReduceError> {
    let mut record = existing(
        state,
        proposal_id,
        event_id,
        at_ms,
        &[ProposalPhase::Received, ProposalPhase::Validated],
    )?;
    record.phase = phase;
    record.last_event_id = event_id;
    record.last_at_ms = at_ms;
    state.insert(proposal_id, record);
    state.record_applied(at_ms, 0);
    Ok(())
}
