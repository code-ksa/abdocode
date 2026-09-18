//! Runtime failures.

use std::fmt;

use abdo_contracts::{Digest, IntentId, KernelSessionId};
use abdo_journal::JournalError;

use crate::phase::EffectPhase;

/// An attempt to move an effect along an edge that does not exist.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransitionError {
    pub intent_id: IntentId,
    pub from: Option<EffectPhase>,
    pub to: EffectPhase,
}

#[derive(Debug)]
pub enum RuntimeError {
    /// The durable ledger refused or failed.
    Journal(JournalError),
    /// The lifecycle has no such edge.
    Transition(TransitionError),
    /// Authority refused. Recorded, never retried into a grant.
    Denied {
        intent_id: IntentId,
        reason_digest: Digest,
    },
    /// The effect already recorded this phase. The ledger caught a repeat.
    AlreadyRecorded {
        intent_id: IntentId,
        phase: EffectPhase,
    },
    /// Dispatch was attempted while effectful dispatch is compiled out.
    DispatchDisabled { intent_id: IntentId },
    /// A second writer was requested for a session that already has one.
    SessionAlreadyOpen { session_id: KernelSessionId },
    /// Input arrived for a session the control plane does not know.
    UnknownSession { session_id: KernelSessionId },
    /// A stored ledger could not be interpreted as a lifecycle.
    Corrupt(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Journal(source) => write!(formatter, "effect ledger failed: {source}"),
            Self::Transition(error) => write!(
                formatter,
                "effect {} cannot move from {:?} to {:?}",
                error.intent_id.get(),
                error.from,
                error.to
            ),
            Self::Denied { intent_id, .. } => {
                write!(formatter, "authority denied effect {}", intent_id.get())
            }
            Self::AlreadyRecorded { intent_id, phase } => write!(
                formatter,
                "effect {} already recorded {phase:?}",
                intent_id.get()
            ),
            Self::DispatchDisabled { intent_id } => write!(
                formatter,
                "effectful dispatch is disabled; effect {} was not dispatched",
                intent_id.get()
            ),
            Self::SessionAlreadyOpen { session_id } => write!(
                formatter,
                "session {} already has a writer",
                session_id.get()
            ),
            Self::UnknownSession { session_id } => {
                write!(formatter, "session {} is not registered", session_id.get())
            }
            Self::Corrupt(reason) => {
                write!(formatter, "effect ledger is not a lifecycle: {reason}")
            }
        }
    }
}

impl std::error::Error for RuntimeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Journal(source) => Some(source),
            _ => None,
        }
    }
}

impl From<JournalError> for RuntimeError {
    fn from(source: JournalError) -> Self {
        Self::Journal(source)
    }
}
