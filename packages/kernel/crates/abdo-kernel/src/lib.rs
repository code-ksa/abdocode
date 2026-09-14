#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! The single deterministic reducer for the Abdo Code trusted kernel.
//!
//! [`reduce`] is a pure function of `(state, event)`. It performs no I/O, reads
//! no clock, draws no randomness, spawns no task and owns no async runtime. The
//! only time it observes is the time carried inside the event it is folding, so
//! two folds of the same event sequence are byte-identical on any machine, in
//! any process, in any order of wall-clock time.
//!
//! The reducer is also the definition of a derived view. A projection or
//! snapshot of a stream *is* [`KernelState::canonical_bytes`] of the state
//! reached by folding that stream's events. Nothing else may author one. That is
//! what makes a stored derivation recomputable rather than merely labelled: to
//! check it, fold the range it names and compare bytes.
//!
//! The reducer decides *whether* an effect is owed, never *how* it runs. Effect
//! preparation, dispatch, settlement and verification arrive in later sprints
//! and stay outside this crate.

mod effect;
mod fingerprint;
mod reduce;
mod state;

pub use effect::EffectIntent;
pub use fingerprint::{Fingerprint, CANONICAL_STATE_VERSION};
pub use reduce::{reduce, reduce_all, IllegalTransition, ReduceError, Reduction, Rejection};
pub use state::{KernelState, ProposalPhase, ProposalRecord};
pub mod blueprint_facades;
