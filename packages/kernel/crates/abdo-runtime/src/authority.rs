//! The provisional authority seam.
//!
//! `abdo-authority` does not exist until S113. Rather than let the runtime
//! authorise its own effects in the meantime, the decision goes through a port
//! whose only shipped implementation refuses everything. A missing authority is
//! not a permissive one.

use abdo_contracts::{Digest, IntentId, Scope, TargetRef};

/// What the runtime asks authority about.
#[derive(Clone, Debug)]
pub struct AuthorityRequest<'a> {
    pub intent_id: IntentId,
    pub scope: &'a Scope,
    pub target: &'a TargetRef,
    pub operation_digest: Digest,
    pub at_ms: u64,
    pub expires_at_ms: u64,
}

/// Authority answers with a decision, never with an absence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorityDecision {
    Granted,
    /// Refused, with a reason digest rather than a reason string: a refusal
    /// must be recordable without leaking what it was about.
    Denied {
        reason_digest: Digest,
    },
}

impl AuthorityDecision {
    pub const fn is_granted(self) -> bool {
        matches!(self, Self::Granted)
    }
}

pub trait AuthorityPort {
    fn authorize(&self, request: &AuthorityRequest<'_>) -> AuthorityDecision;
}

/// The runtime's view of the kernel authority.
///
/// A thin adapter, not a second decision-maker: it asks
/// [`abdo_authority::Authority`] and reports what it said. The runtime does not
/// get an opinion about trust, and there is no longer an implementation here
/// that answers without asking.
#[derive(Debug)]
pub struct KernelAuthority<'a> {
    inner: &'a abdo_authority::Authority,
    /// The scope the caller is acting as. Compared against the grant, never
    /// read off it.
    acting_as: Scope,
    capability: &'a abdo_authority::Capability,
}

impl<'a> KernelAuthority<'a> {
    pub const fn new(
        inner: &'a abdo_authority::Authority,
        acting_as: Scope,
        capability: &'a abdo_authority::Capability,
    ) -> Self {
        Self {
            inner,
            acting_as,
            capability,
        }
    }
}

impl AuthorityPort for KernelAuthority<'_> {
    fn authorize(&self, request: &AuthorityRequest<'_>) -> AuthorityDecision {
        let verdict = self.inner.check(&abdo_authority::Use {
            capability: self.capability,
            by: &self.acting_as,
            target: request.target,
            operation_digest: request.operation_digest,
            now_ms: request.at_ms,
        });
        match verdict {
            abdo_authority::Verdict::Granted => AuthorityDecision::Granted,
            abdo_authority::Verdict::Denied(denial) => AuthorityDecision::Denied {
                reason_digest: denial_digest(denial),
            },
        }
    }
}

/// A refusal reported as a digest rather than a sentence.
///
/// A denial has to be recordable without saying what it was about: the reason
/// is evidence for an operator, not a hint for whoever was refused.
fn denial_digest(denial: abdo_authority::Denial) -> Digest {
    let tag: u8 = match denial {
        abdo_authority::Denial::WrongBoot => 1,
        abdo_authority::Denial::WrongProcess => 2,
        abdo_authority::Denial::Expired { .. } => 3,
        abdo_authority::Denial::Revoked { .. } => 4,
        abdo_authority::Denial::WrongScope => 5,
        abdo_authority::Denial::WrongTarget => 6,
        abdo_authority::Denial::WrongOperation => 7,
        abdo_authority::Denial::ForgedSeal => 8,
        abdo_authority::Denial::UnknownCapability { .. } => 9,
    };
    let mut bytes = [0_u8; 32];
    bytes[0] = 0xd0;
    bytes[1] = tag;
    Digest::from_bytes(bytes)
}
