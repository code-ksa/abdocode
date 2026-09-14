//! The authority itself: issues receipts, grants capabilities, refuses the rest.

use std::collections::BTreeMap;

use abdo_contracts::{
    ContractVersion, Digest, Nonce, ReceiptId, Scope, TargetRef, TrustDecision, TrustReceipt,
    WireEncode, Writer,
};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::capability::{Capability, CapabilityId, CapabilityRequest, Use};
use crate::error::{AuthorityError, Denial};
use crate::identity::{BootIdentity, ProcessIdentity};

type Seal = Hmac<Sha256>;

/// The contract caps a receipt at sixty seconds. Stated here so the refusal
/// names a number rather than pointing at an encoding failure.
pub const MAX_RECEIPT_TTL_MS: u64 = 60_000;

const SEAL_DOMAIN: &[u8] = b"ABDO/AUTHORITY/RECEIPT-SEAL/1\0";

/// The key that seals receipts.
///
/// One per boot, never leaving the kernel. It is not `Clone` and prints nothing:
/// a key that turns up in a log or a debug dump is a key that has left.
pub struct SealingKey {
    bytes: [u8; 32],
}

impl SealingKey {
    /// Take a key from bytes the caller obtained. This crate draws no
    /// randomness of its own, so a test can be deterministic and production can
    /// use a real source without either pretending to be the other.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }
}

impl std::fmt::Debug for SealingKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("SealingKey").finish_non_exhaustive()
    }
}

/// What a receipt is about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiptSubject {
    pub receipt_id: ReceiptId,
    pub nonce: Nonce,
    pub source_digest: Digest,
    pub entrypoint_digest: Digest,
    pub issuer_digest: Digest,
    pub artifact_digest: Digest,
    pub trust_policy_digest: Digest,
    pub reason_digest: Digest,
}

/// The answer to any authority question.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    Granted,
    Denied(Denial),
}

impl Verdict {
    pub const fn is_granted(self) -> bool {
        matches!(self, Self::Granted)
    }
}

/// The single issuer and validator of trust in this kernel.
#[derive(Debug)]
pub struct Authority {
    key: SealingKey,
    boot: BootIdentity,
    process: ProcessIdentity,
    generation: u64,
    granted: BTreeMap<u128, Capability>,
}

impl Authority {
    /// Start an authority for one boot.
    ///
    /// The generation begins at one and only ever rises. Nothing here resets it,
    /// because a counter that can go backwards is a revocation that can be
    /// undone by whoever caused it.
    pub fn new(boot: BootIdentity, process: ProcessIdentity, key: SealingKey) -> Self {
        Self {
            key,
            boot,
            process,
            generation: 1,
            granted: BTreeMap::new(),
        }
    }

    pub const fn boot(&self) -> BootIdentity {
        self.boot
    }

    pub const fn process(&self) -> ProcessIdentity {
        self.process
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub fn granted(&self) -> usize {
        self.granted.len()
    }

    /// Issue a sealed receipt for this boot and this process.
    pub fn issue_receipt(
        &self,
        subject: ReceiptSubject,
        issued_at_ms: u64,
        ttl_ms: u64,
    ) -> Result<TrustReceipt, AuthorityError> {
        if ttl_ms == 0 {
            return Err(AuthorityError::InvalidLifetime {
                issued_at_ms,
                expires_at_ms: issued_at_ms,
            });
        }
        if ttl_ms > MAX_RECEIPT_TTL_MS {
            return Err(AuthorityError::LifetimeTooLong {
                ttl_ms,
                maximum_ms: MAX_RECEIPT_TTL_MS,
            });
        }
        let expires_at_ms =
            issued_at_ms
                .checked_add(ttl_ms)
                .ok_or(AuthorityError::InvalidLifetime {
                    issued_at_ms,
                    expires_at_ms: u64::MAX,
                })?;

        let mut receipt = TrustReceipt {
            contract_version: ContractVersion::V1,
            decision: TrustDecision::Trusted,
            receipt_id: subject.receipt_id,
            os_identity_digest: self.process.digest(),
            nonce: subject.nonce,
            boot_id: self.boot.boot_id,
            run_id: self.boot.run_id,
            generation: self.generation,
            source_digest: subject.source_digest,
            entrypoint_digest: subject.entrypoint_digest,
            issuer_digest: subject.issuer_digest,
            artifact_digest: subject.artifact_digest,
            trust_policy_digest: subject.trust_policy_digest,
            reason_digest: subject.reason_digest,
            issued_at_ms,
            expires_at_ms,
            integrity_digest: Digest::from_bytes([0; 32]),
        };
        receipt.integrity_digest = self.seal(&receipt)?;
        Ok(receipt)
    }

    /// Verify a receipt against this authority, this boot and this process.
    ///
    /// The seal is checked first. Everything after it reads fields, and reading
    /// fields off an unsealed receipt would be reading whatever the presenter
    /// wanted them to say.
    pub fn verify_receipt(&self, receipt: &TrustReceipt, now_ms: u64) -> Verdict {
        let Ok(expected) = self.seal(receipt) else {
            return Verdict::Denied(Denial::ForgedSeal);
        };
        if !constant_time_eq(expected.as_bytes(), receipt.integrity_digest.as_bytes()) {
            return Verdict::Denied(Denial::ForgedSeal);
        }
        if receipt.boot_id != self.boot.boot_id || receipt.run_id != self.boot.run_id {
            return Verdict::Denied(Denial::WrongBoot);
        }
        if receipt.os_identity_digest != self.process.digest() {
            return Verdict::Denied(Denial::WrongProcess);
        }
        if receipt.generation != self.generation {
            return Verdict::Denied(Denial::Revoked {
                held: receipt.generation,
                current: self.generation,
            });
        }
        if receipt.expires_at_ms <= now_ms {
            return Verdict::Denied(Denial::Expired {
                expires_at_ms: receipt.expires_at_ms,
                now_ms,
            });
        }
        Verdict::Granted
    }

    /// Grant a capability to a scope.
    pub fn grant(&mut self, request: CapabilityRequest) -> Result<Capability, AuthorityError> {
        if request.expires_at_ms <= request.issued_at_ms {
            return Err(AuthorityError::InvalidLifetime {
                issued_at_ms: request.issued_at_ms,
                expires_at_ms: request.expires_at_ms,
            });
        }
        if self.granted.contains_key(&request.id.get()) {
            return Err(AuthorityError::DuplicateCapability { id: request.id });
        }
        let capability = Capability {
            id: request.id,
            scope: request.scope,
            target: request.target,
            operation_digest: request.operation_digest,
            generation: self.generation,
            issued_at_ms: request.issued_at_ms,
            expires_at_ms: request.expires_at_ms,
        };
        self.granted.insert(request.id.get(), capability.clone());
        Ok(capability)
    }

    /// Withdraw everything issued so far.
    ///
    /// Bumping one counter is the whole revocation. Walking a list and marking
    /// entries would leave the question of what happens to an entry the walk
    /// missed; there is no such entry here.
    pub fn revoke_all(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.generation
    }

    /// Withdraw one capability.
    pub fn revoke(&mut self, id: CapabilityId) -> bool {
        self.granted.remove(&id.get()).is_some()
    }

    /// May this use proceed?
    pub fn check(&self, attempt: &Use<'_>) -> Verdict {
        let Some(known) = self.granted.get(&attempt.capability.id.get()) else {
            return Verdict::Denied(Denial::UnknownCapability {
                id: attempt.capability.id,
            });
        };
        if known.generation != self.generation {
            return Verdict::Denied(Denial::Revoked {
                held: known.generation,
                current: self.generation,
            });
        }
        // The scope presented and the scope granted must be the same. This is
        // the check that stops a capability being lent to another session.
        if !scope_matches(&known.scope, attempt.by) {
            return Verdict::Denied(Denial::WrongScope);
        }
        if !target_matches(&known.target, attempt.target) {
            return Verdict::Denied(Denial::WrongTarget);
        }
        if known.operation_digest != attempt.operation_digest {
            return Verdict::Denied(Denial::WrongOperation);
        }
        if known.expires_at_ms <= attempt.now_ms {
            return Verdict::Denied(Denial::Expired {
                expires_at_ms: known.expires_at_ms,
                now_ms: attempt.now_ms,
            });
        }
        Verdict::Granted
    }

    fn seal(&self, receipt: &TrustReceipt) -> Result<Digest, AuthorityError> {
        let bytes = receipt
            .canonical_integrity_bytes()
            .map_err(|_| AuthorityError::NotCanonical("trust receipt"))?;
        let mut mac = <Seal as KeyInit>::new_from_slice(&self.key.bytes)
            .map_err(|_| AuthorityError::NotCanonical("sealing key length"))?;
        mac.update(SEAL_DOMAIN);
        mac.update(&bytes);
        Ok(Digest::from_bytes(mac.finalize().into_bytes().into()))
    }
}

/// Compare without leaking where the first difference is.
fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0_u8;
    for index in 0..32 {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

fn scope_matches(granted: &Scope, presented: &Scope) -> bool {
    encoded(granted) == encoded(presented)
}

fn target_matches(granted: &TargetRef, presented: &TargetRef) -> bool {
    encoded(granted) == encoded(presented)
}

/// Compare by canonical bytes rather than by shape.
///
/// Two values that encode identically are the same value on the wire, which is
/// the only place this comparison matters.
fn encoded<T: WireEncode>(value: &T) -> Option<Vec<u8>> {
    let mut writer = Writer::new();
    value.encode_to(&mut writer).ok()?;
    Some(writer.into_inner())
}
