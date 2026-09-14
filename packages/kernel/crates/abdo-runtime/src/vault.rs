//! Secret handles: what the kernel may hold, and what it may never write down.
//!
//! # There is no field for a secret here
//!
//! A [`SecretLease`] carries a handle, a consumer, a scope, an expiry and a
//! generation. It does not carry the secret, and no type in this module does.
//! That is not an omission to be filled in later — it is the mechanism. A
//! kernel that never receives secret material cannot leak it through a log, a
//! journal, a projection or a panic message, because there is nothing in it to
//! leak. Redaction is what you need when the value is present and you are
//! hoping to catch it on the way out; absence is what you need when you would
//! rather not hope.
//!
//! The material lives with whoever can actually use it — the broker at
//! `packages/secret-broker` and the redactor the TypeScript side already has.
//! This module is deliberately not a second copy of either.
//!
//! # A lease is bound to who asked and where
//!
//! Consumer and scope are part of what a lease *is*, and both are re-supplied
//! at use and compared. A lease that worked for whoever held it would be a
//! bearer token, and a bearer token is a lease that has stopped being one.
//!
//! # Revocation is a number going up
//!
//! [`Vault::revoke_all`] increments one generation. Every outstanding lease
//! carries the generation it was issued under, so it stops verifying at the
//! moment the counter moves — not when a sweep gets to it, not when a cache
//! expires. There is no list to walk and therefore no list to be halfway
//! through when it matters.

use std::collections::BTreeMap;

use abdo_contracts::{Digest, Scope, WireEncode, Writer};
use sha2::{Digest as _, Sha256};

const HANDLE_DOMAIN: &[u8] = b"ABDO/RUNTIME/SECRET-HANDLE/1\0";

/// Why a lease did not admit the use it was presented for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseRefusal {
    /// Presented by somebody other than the consumer it was issued to.
    WrongConsumer,
    /// Presented from a scope it was not issued for.
    WrongScope,
    /// Issued under a generation that has since been revoked.
    Revoked {
        issued: u64,
        current: u64,
    },
    Expired {
        expires_at_ms: u64,
        now_ms: u64,
    },
    /// No such handle. Distinct from a revoked one on purpose: "never existed"
    /// and "existed and was withdrawn" are different facts about the caller.
    Unknown,
}

/// An opaque reference to a secret this kernel does not have.
///
/// Derived from the secret's *name* and its scope, never from its value. A
/// handle computed over the material would be an oracle: anyone who could guess
/// a value could confirm the guess by comparing handles.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SecretHandle([u8; 32]);

impl SecretHandle {
    /// Build a handle for a named secret in a scope.
    ///
    /// Both parts are length-prefixed, so a name ending where a scope begins
    /// cannot produce the same handle as the other division of the same bytes.
    pub fn for_name(name_digest: Digest, scope: &Scope) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(HANDLE_DOMAIN);
        hasher.update(name_digest.as_bytes());
        let encoded = encoded_bytes(scope);
        hasher.update((encoded.len() as u32).to_be_bytes());
        hasher.update(&encoded);
        Self(hasher.finalize().into())
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Deliberately says nothing.
///
/// The derived form would print the handle bytes into every log line that ever
/// formats a lease. The handle is not the secret, but it is a stable identifier
/// for one, and an identifier that appears in every trace is how you correlate
/// which run touched which credential.
impl std::fmt::Display for SecretHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretHandle(…)")
    }
}

/// Permission to ask the broker for one secret, by one consumer, in one scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecretLease {
    handle: SecretHandle,
    /// Who may present this. A digest, because the kernel does not need to know
    /// what the consumer is called to know it is the same one.
    consumer_digest: Digest,
    scope: Scope,
    issued_at_ms: u64,
    expires_at_ms: u64,
    /// The revocation generation this was issued under.
    generation: u64,
}

impl SecretLease {
    pub const fn handle(&self) -> SecretHandle {
        self.handle
    }

    pub const fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    /// What a ledger may record about this lease.
    ///
    /// A digest over the binding, and nothing that identifies the secret. Two
    /// uses of the same lease produce the same value, so a reader can tell that
    /// two effects used one credential without learning which.
    pub fn evidence_digest(&self) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(b"ABDO/RUNTIME/SECRET-EVIDENCE/1\0");
        hasher.update(self.handle.as_bytes());
        hasher.update(self.consumer_digest.as_bytes());
        hasher.update(self.generation.to_be_bytes());
        Digest::from_bytes(hasher.finalize().into())
    }
}

/// What a caller presents when it wants to use a lease.
#[derive(Clone, Copy, Debug)]
pub struct Presentation<'a> {
    pub handle: SecretHandle,
    /// Re-supplied rather than read off the lease. Reading it off would make
    /// the lease vouch for its own holder.
    pub consumer_digest: Digest,
    pub scope: &'a Scope,
    pub now_ms: u64,
}

/// Issues leases and withdraws them all at once.
#[derive(Debug, Default)]
pub struct Vault {
    leases: BTreeMap<[u8; 32], SecretLease>,
    generation: u64,
    issued: u64,
    refused: u64,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            leases: BTreeMap::new(),
            generation: 1,
            issued: 0,
            refused: 0,
        }
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn issued(&self) -> u64 {
        self.issued
    }

    pub const fn refused(&self) -> u64 {
        self.refused
    }

    pub fn outstanding(&self) -> usize {
        self.leases.len()
    }

    /// Issue a lease for a named secret.
    ///
    /// Takes a name digest, not a name, and never a value. There is no
    /// parameter here through which material could arrive.
    pub fn issue(
        &mut self,
        name_digest: Digest,
        consumer_digest: Digest,
        scope: Scope,
        issued_at_ms: u64,
        expires_at_ms: u64,
    ) -> Result<SecretLease, LeaseRefusal> {
        if expires_at_ms <= issued_at_ms {
            return Err(LeaseRefusal::Expired {
                expires_at_ms,
                now_ms: issued_at_ms,
            });
        }
        let handle = SecretHandle::for_name(name_digest, &scope);
        let lease = SecretLease {
            handle,
            consumer_digest,
            scope,
            issued_at_ms,
            expires_at_ms,
            generation: self.generation,
        };
        self.leases.insert(handle.0, lease.clone());
        self.issued += 1;
        Ok(lease)
    }

    /// May this presentation use this lease?
    ///
    /// Checked in the order a reader would want the reason reported: who, then
    /// where, then whether it still exists, then whether it has run out.
    pub fn admit(&mut self, presentation: &Presentation<'_>) -> Result<Digest, LeaseRefusal> {
        let Some(lease) = self.leases.get(presentation.handle.as_bytes()) else {
            self.refused += 1;
            return Err(LeaseRefusal::Unknown);
        };
        if lease.consumer_digest != presentation.consumer_digest {
            self.refused += 1;
            return Err(LeaseRefusal::WrongConsumer);
        }
        if &lease.scope != presentation.scope {
            self.refused += 1;
            return Err(LeaseRefusal::WrongScope);
        }
        if lease.generation != self.generation {
            self.refused += 1;
            return Err(LeaseRefusal::Revoked {
                issued: lease.generation,
                current: self.generation,
            });
        }
        if lease.expires_at_ms <= presentation.now_ms {
            self.refused += 1;
            return Err(LeaseRefusal::Expired {
                expires_at_ms: lease.expires_at_ms,
                now_ms: presentation.now_ms,
            });
        }
        Ok(lease.evidence_digest())
    }

    /// Withdraw everything, at once.
    ///
    /// One increment. Nothing is walked, so there is no half-finished state a
    /// crash can leave behind and no window in which some leases are dead and
    /// others are not.
    pub fn revoke_all(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }
}

fn encoded_bytes<T: WireEncode>(value: &T) -> Vec<u8> {
    let mut writer = Writer::new();
    value
        .encode_to(&mut writer)
        .expect("a scope from the contract encodes");
    writer.into_inner()
}
