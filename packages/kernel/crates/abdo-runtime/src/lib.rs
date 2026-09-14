#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! The trusted effect supervisor.
//!
//! The reducer in `abdo-kernel` decides that an effect is *owed*. This
//! crate decides how that debt is discharged exactly once, across crashes, on
//! the far side of a boundary the engine does not control.
//!
//! The lifecycle is deliberately longer than "run it and see":
//!
//! ```text
//! Prepared(durable) -> Authorized -> Dispatching(durable) -> Started
//!                                        -> Settled | UnknownOutcome -> Verified
//! ```
//!
//! Two of those steps are durable *before* anything observable happens, and the
//! reason is the only interesting part of the design. A dispatch that is
//! recorded after it runs cannot be distinguished, after a crash, from one that
//! never ran; a dispatch recorded before it runs can. So `Dispatching` commits
//! first, and a recovery that finds it resolves to [`Recovered::UnknownOutcome`]
//! rather than dispatching again. Blind retry is not merely discouraged here,
//! it is unreachable: no API accepts an unknown outcome and produces a dispatch.
//!
//! `Settlement` and `Verification` are separate types on purpose. An effect
//! that finished is not an effect that did what it promised, and collapsing the
//! two into one "done" flag is how a runtime comes to believe its own
//! optimism. Only both together produce [`Verified`].
//!
//! Budgets are consulted before a dispatch is committed, not after it reports,
//! and fencing tokens come from the durable lease table so they survive the
//! crash they exist to defend against. See [`Governor`].
//!
//! Effects that touch nothing in common run together; effects that share a
//! write are serialized. [`Scheduler`] applies that one rule deterministically
//! and rotates across lanes so none starves.
//!
//! Input arriving mid-run is classified by [`InputChannel`] rather than treated
//! as one more prompt, mailboxes are bounded and refuse rather than grow, and
//! cancellation descends a task tree in one operation.
//!
//! A session has one actor and one writer, and hands the engine an immutable
//! [`StepSnapshot`]. Turn, step and round are defined there rather than left to
//! usage, because configuration moves at step boundaries and a retry must not
//! be able to change the rules under a request already in flight.
//!
//! An effect whose outcome never arrived is reconciled, never repeated. See
//! [`Reconciler`]: it is given no dispatcher, so the retry that would break
//! exactly-once is not a rule it follows but a call it cannot make.
//!
//! Authorisation goes to [`abdo_authority::Authority`], which is the one issuer
//! and validator of trust in the kernel. [`KernelAuthority`] is an adapter, not
//! a second opinion: there is no implementation here that answers without
//! asking. Effectful dispatch stays behind the `effectful-dispatch` feature,
//! which is off.

mod adapter_ledger;
mod authority;
mod budget;
mod control;
mod error;
mod gatekeeper;
mod host;
mod phase;
mod reconcile;
mod schedule;
mod session;
mod supervisor;
mod surface;
mod vault;

pub use abdo_tools::{
    class_tag, Brief, CatalogSnapshot, CompiledBoundary, Disclosed, NoSandbox, RegistrationError,
    Sandbox, SearchQuery, SearchResult, ToolCatalog, ToolLease,
};
pub use adapter_ledger::{
    adapter_digest_from_hex, AdapterEffect, AdapterLedger, AdapterRecoveryReport,
};
pub use authority::{AuthorityDecision, AuthorityPort, AuthorityRequest, KernelAuthority};
pub use budget::{
    Admission, BudgetDimension, Charge, FencedHolder, Governor, Refusal, BUDGET_DIMENSIONS,
};
pub use control::{
    Boundary, CancelReport, ChannelSemantics, ControlPlane, Delivery, Envelope, InputChannel,
    Mailbox, TaskState, INPUT_CHANNELS,
};
pub use error::{RuntimeError, TransitionError};
pub use gatekeeper::{ApprovalPort, ApprovalQuestion, Clearance, Gatekeeper, NoOperator};
pub use host::run_host;
pub use phase::{EffectPhase, PHASE_ORDER};
pub use reconcile::{
    BlindOracle, CompensationPolicy, CompensationRequest, KeepWhatRan, ObservedOutcome,
    OutcomeOracle, Outstanding, Reconciler, ReconciliationContext, Resolution, SweepReport,
};
pub use schedule::{Access, Batch, Demand, LaneId, ResourceClaim, ResourceRef, Scheduler};
pub use session::{
    SessionActor, SessionConfig, SessionRegistry, SessionWriter, StepCursor, StepSnapshot,
    SNAPSHOT_VERSION,
};
pub use supervisor::{
    AdapterReport, Authorized, DispatchOutcome, Dispatcher, Dispatching, EffectSupervisor,
    Prepared, Recovered, Settled, Settlement, Started, Verification, Verified,
};
pub use surface::{Staleness, SurfaceRegistry};
pub use vault::{LeaseRefusal, Presentation, SecretHandle, SecretLease, Vault};
pub mod blueprint_facades;
