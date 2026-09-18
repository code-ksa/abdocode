#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! The kernel's authority: who may act, on what, and for how long.
//!
//! # Why this replaces a caller-supplied verifier
//!
//! Until now a trust receipt could be checked by handing it a closure. That
//! makes every caller its own authority, which is another way of saying there
//! was none. Here the receipt is sealed with a key the kernel alone holds, so
//! issuing and verifying are the same authority's job and forging one is not a
//! matter of calling the right function.
//!
//! # What invalidation actually means
//!
//! Three things end a grant, and each is checked against something an attacker
//! cannot restate:
//!
//! - **A restart.** Every receipt carries the boot it was issued in. A new boot
//!   has a new identity and a new key, so yesterday's receipts do not verify.
//! - **A recycled process.** A process identity is a PID *and* the moment it
//!   started. A PID on its own is handed out again within minutes, and binding
//!   to it alone would let an unrelated process inherit a dead one's authority.
//! - **Revocation.** A generation counter, compared against the current one.
//!
//! Policy decisions live in the sibling `abdo-policy` crate. This crate owns
//! identity, capabilities and sealed authority receipts only, so policy cannot
//! become a second issuer of authority.
//!
//! # What this crate does not do
//!
//! It reads no clock, no file, no environment and no process table. Times and
//! identities arrive as arguments, because an authority that discovered facts
//! for itself would be unable to prove what it was told.

mod authority;
mod capability;
mod error;
mod identity;

pub use authority::{Authority, ReceiptSubject, SealingKey, Verdict};
pub use capability::{Capability, CapabilityId, CapabilityRequest, Use};
pub use error::{AuthorityError, Denial};
pub use identity::{BootIdentity, ProcessIdentity};
pub mod blueprint_facades;
