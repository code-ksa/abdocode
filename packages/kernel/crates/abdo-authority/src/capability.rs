//! Capabilities: a named permission, bound to a scope and a lifetime.

use abdo_contracts::{Digest, Scope, TargetRef};

/// A capability identity.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CapabilityId(u128);

impl CapabilityId {
    pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
        if value == 0 {
            return Err("capability id must be non-zero");
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u128 {
        self.0
    }
}

/// What is being asked for.
#[derive(Clone, Debug)]
pub struct CapabilityRequest {
    pub id: CapabilityId,
    /// Who may use it. A capability is never simply "granted"; it is granted to
    /// somebody, and that binding is what makes lending one impossible.
    pub scope: Scope,
    pub target: TargetRef,
    /// What may be done, as a digest rather than a string.
    pub operation_digest: Digest,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

/// A granted capability.
///
/// Constructed only by [`crate::Authority`]: the fields are private and there is
/// no public builder, so a capability cannot be assembled by whoever wants one.
#[derive(Clone, Debug)]
pub struct Capability {
    pub(crate) id: CapabilityId,
    pub(crate) scope: Scope,
    pub(crate) target: TargetRef,
    pub(crate) operation_digest: Digest,
    pub(crate) generation: u64,
    pub(crate) issued_at_ms: u64,
    pub(crate) expires_at_ms: u64,
}

impl Capability {
    pub const fn id(&self) -> CapabilityId {
        self.id
    }

    pub const fn scope(&self) -> &Scope {
        &self.scope
    }

    pub const fn target(&self) -> &TargetRef {
        &self.target
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub const fn issued_at_ms(&self) -> u64 {
        self.issued_at_ms
    }

    pub const fn operation_digest(&self) -> Digest {
        self.operation_digest
    }
}

/// An attempt to use a capability.
///
/// The scope is supplied by the *caller* rather than read off the capability,
/// which is the entire check: a capability presented by somebody it was not
/// granted to is refused precisely because these two must match.
#[derive(Clone, Debug)]
pub struct Use<'a> {
    pub capability: &'a Capability,
    pub by: &'a Scope,
    pub target: &'a TargetRef,
    pub operation_digest: Digest,
    pub now_ms: u64,
}
