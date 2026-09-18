#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! Tamper-evident evidence owned by the Rust kernel.
//!
//! A receipt binds its position, predecessor and payload digest. Verification
//! recomputes every link from the beginning and fails closed on a gap, a
//! changed payload, or a changed predecessor.

use abdo_contracts::Digest;
use sha2::{Digest as _, Sha256};

const CHAIN_DOMAIN: &[u8] = b"ABDO/EVIDENCE/CHAIN/1\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvidenceReceipt {
    sequence: u64,
    payload_digest: Digest,
    previous: Digest,
    chain_digest: Digest,
}

impl EvidenceReceipt {
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn payload_digest(&self) -> Digest {
        self.payload_digest
    }

    pub const fn previous(&self) -> Digest {
        self.previous
    }

    pub const fn chain_digest(&self) -> Digest {
        self.chain_digest
    }
}
pub mod blueprint_facades;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceError {
    Sequence { expected: u64, found: u64 },
    Previous { sequence: u64 },
    Digest { sequence: u64 },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EvidenceChain {
    receipts: Vec<EvidenceReceipt>,
}

impl EvidenceChain {
    pub const fn new() -> Self {
        Self {
            receipts: Vec::new(),
        }
    }

    pub fn append(&mut self, payload_digest: Digest) -> EvidenceReceipt {
        let sequence = self.receipts.len() as u64;
        let previous = self
            .receipts
            .last()
            .map_or_else(zero_digest, EvidenceReceipt::chain_digest);
        let receipt = EvidenceReceipt {
            sequence,
            payload_digest,
            previous,
            chain_digest: link_digest(sequence, previous, payload_digest),
        };
        self.receipts.push(receipt);
        receipt
    }

    pub fn receipts(&self) -> &[EvidenceReceipt] {
        &self.receipts
    }

    pub fn head(&self) -> Digest {
        self.receipts
            .last()
            .map_or_else(zero_digest, EvidenceReceipt::chain_digest)
    }

    pub fn verify(&self) -> Result<Digest, EvidenceError> {
        verify_receipts(&self.receipts)
    }
}

pub fn verify_receipts(receipts: &[EvidenceReceipt]) -> Result<Digest, EvidenceError> {
    let mut previous = zero_digest();
    for (index, receipt) in receipts.iter().enumerate() {
        let expected = index as u64;
        if receipt.sequence != expected {
            return Err(EvidenceError::Sequence {
                expected,
                found: receipt.sequence,
            });
        }
        if receipt.previous != previous {
            return Err(EvidenceError::Previous {
                sequence: receipt.sequence,
            });
        }
        if receipt.chain_digest
            != link_digest(receipt.sequence, receipt.previous, receipt.payload_digest)
        {
            return Err(EvidenceError::Digest {
                sequence: receipt.sequence,
            });
        }
        previous = receipt.chain_digest;
    }
    Ok(previous)
}

fn link_digest(sequence: u64, previous: Digest, payload_digest: Digest) -> Digest {
    let mut hasher = Sha256::new();
    hasher.update(CHAIN_DOMAIN);
    hasher.update(sequence.to_be_bytes());
    hasher.update(previous.as_bytes());
    hasher.update(payload_digest.as_bytes());
    Digest::from_bytes(hasher.finalize().into())
}

const fn zero_digest() -> Digest {
    Digest::from_bytes([0_u8; 32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use abdo_contracts::label_digest;

    #[test]
    fn chain_is_deterministic_and_verifiable() {
        let mut chain = EvidenceChain::new();
        chain.append(label_digest(b"prepared"));
        chain.append(label_digest(b"verified"));
        assert_eq!(chain.verify(), Ok(chain.head()));

        let mut replay = EvidenceChain::new();
        replay.append(label_digest(b"prepared"));
        replay.append(label_digest(b"verified"));
        assert_eq!(replay.head(), chain.head());
    }

    #[test]
    fn changed_payload_cannot_reuse_a_receipt() {
        let mut chain = EvidenceChain::new();
        let first = chain.append(label_digest(b"original"));
        let forged = EvidenceReceipt {
            payload_digest: label_digest(b"changed"),
            ..first
        };
        assert_eq!(
            verify_receipts(&[forged]),
            Err(EvidenceError::Digest { sequence: 0 })
        );
    }

    #[test]
    fn removed_link_is_detected() {
        let mut chain = EvidenceChain::new();
        chain.append(label_digest(b"one"));
        let second = chain.append(label_digest(b"two"));
        assert_eq!(
            verify_receipts(&[second]),
            Err(EvidenceError::Sequence {
                expected: 0,
                found: 1
            })
        );
    }
}
