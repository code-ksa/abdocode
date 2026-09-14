#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! Canonical policy for the Abdo Code kernel.
//!
//! Policy is separated from authority so identity/capability verification and
//! risk decisions remain independently testable, while every admission still
//! consumes an authority-issued subject. Requests cannot lower their risk and
//! approvals remain bound to the exact scope, target, operation and arguments.
//!
use std::collections::BTreeSet;

use abdo_contracts::{Digest, Scope, TargetRef, WireEncode, Writer};
use sha2::{Digest as _, Sha256};

const BINDING_DOMAIN: &[u8] = b"ABDO/AUTHORITY/APPROVAL-BINDING/1\0";

/// How much is at stake.
///
/// The discriminants are ordered and compared, so renumbering one reorders the
/// policy. They are fixed.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Risk {
    /// Observes, changes nothing.
    R0 = 0,
    /// Changes something inside the workspace, undoably.
    R1 = 1,
    /// Changes something outside the workspace, undoably.
    R2 = 2,
    /// Reaches another system, or spends.
    R3 = 3,
    /// Irreversible.
    R4 = 4,
}

pub const RISK_BANDS: [Risk; 5] = [Risk::R0, Risk::R1, Risk::R2, Risk::R3, Risk::R4];

impl Risk {
    pub const fn band(self) -> u8 {
        self as u8
    }

    pub fn from_band(band: u8) -> Option<Self> {
        RISK_BANDS.into_iter().find(|risk| risk.band() == band)
    }

    /// May a standing "always allow" cover this?
    ///
    /// Not for the irreversible. A blanket answer given once, to a question
    /// that cannot be taken back, is the one case where remembering the answer
    /// is worse than asking again.
    pub const fn allows_standing_approval(self) -> bool {
        !matches!(self, Self::R4)
    }
}

/// What is being asked of policy.
///
/// Everything is a digest or an opaque reference. Policy never sees a command
/// line or a prompt, so there is nothing in it for a model to argue with.
#[derive(Clone, Debug)]
pub struct PolicyRequest<'a> {
    pub scope: &'a Scope,
    pub target: &'a TargetRef,
    pub operation_digest: Digest,
    /// The arguments, as a digest. Changing them changes this.
    pub args_digest: Digest,
    pub now_ms: u64,
    /// When the intent this is for stops being valid.
    pub expires_at_ms: u64,
}

/// What policy decided.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyOutcome {
    Allow,
    /// A person must answer, for this exact binding.
    RequireApproval {
        risk: Risk,
        binding: Digest,
    },
    Deny {
        risk: Risk,
    },
}

/// Why an approval did not admit the thing it was shown.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalRefusal {
    /// The approval was granted for something else. Editing the payload after
    /// approval lands here.
    BindingMismatch,
    /// Already used. An approval is one answer to one question.
    Replayed,
    Expired {
        expires_at_ms: u64,
        now_ms: u64,
    },
    /// The person said no.
    Refused,
    /// Nobody answered.
    ///
    /// The default, and deliberately not "allow". A missing handler is a
    /// missing answer, and a missing answer is not a yes.
    NoDecision,
}

/// What an approval is bound to.
#[derive(Clone, Debug)]
pub struct ApprovalBinding<'a> {
    pub scope: &'a Scope,
    pub target: &'a TargetRef,
    pub operation_digest: Digest,
    pub args_digest: Digest,
}

impl ApprovalBinding<'_> {
    /// The digest an approval carries.
    ///
    /// Every part is length-prefixed before hashing, so a change that moves a
    /// byte from one field to the next cannot leave the digest unchanged.
    pub fn digest(&self) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(BINDING_DOMAIN);
        for part in [encoded(self.scope), encoded(self.target)] {
            let bytes = part.unwrap_or_default();
            hasher.update((bytes.len() as u32).to_be_bytes());
            hasher.update(&bytes);
        }
        hasher.update(self.operation_digest.as_bytes());
        hasher.update(self.args_digest.as_bytes());
        Digest::from_bytes(hasher.finalize().into())
    }
}

/// A person's answer, bound to what they were shown.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Approval {
    pub binding: Digest,
    pub granted: bool,
    pub decided_at_ms: u64,
    pub expires_at_ms: u64,
}

/// The rules, and the answers already given.
#[derive(Debug, Default)]
pub struct Policy {
    /// Operations that need no person, by digest.
    allowed: BTreeSet<[u8; 32]>,
    /// Operations refused outright, by digest. Checked first.
    denied: BTreeSet<[u8; 32]>,
    /// Risk per operation. Anything unlisted is treated as the highest band,
    /// because an operation nobody classified is one nobody has thought about.
    risk: std::collections::BTreeMap<[u8; 32], Risk>,
    /// Bindings already spent. An approval answers once.
    consumed: BTreeSet<[u8; 32]>,
}

impl Policy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn classify(&mut self, operation_digest: Digest, risk: Risk) {
        self.risk.insert(*operation_digest.as_bytes(), risk);
    }

    pub fn allow_without_approval(&mut self, operation_digest: Digest) {
        self.allowed.insert(*operation_digest.as_bytes());
    }

    pub fn deny(&mut self, operation_digest: Digest) {
        self.denied.insert(*operation_digest.as_bytes());
    }

    /// The band this operation carries.
    ///
    /// Unclassified means highest. Defaulting an unknown operation to harmless
    /// is how a new tool ships with no supervision at all.
    pub fn risk_of(&self, operation_digest: Digest) -> Risk {
        self.risk
            .get(operation_digest.as_bytes())
            .copied()
            .unwrap_or(Risk::R4)
    }

    /// Decide.
    pub fn evaluate(&self, request: &PolicyRequest<'_>) -> PolicyOutcome {
        let risk = self.risk_of(request.operation_digest);
        // Denial first, so nothing later can talk its way past it.
        if self.denied.contains(request.operation_digest.as_bytes()) {
            return PolicyOutcome::Deny { risk };
        }
        // An intent that has run out of time is refused before anybody is
        // asked, because approving something already expired approves nothing.
        if request.expires_at_ms <= request.now_ms {
            return PolicyOutcome::Deny { risk };
        }
        if risk == Risk::R0 || self.allowed.contains(request.operation_digest.as_bytes()) {
            return PolicyOutcome::Allow;
        }
        PolicyOutcome::RequireApproval {
            risk,
            binding: ApprovalBinding {
                scope: request.scope,
                target: request.target,
                operation_digest: request.operation_digest,
                args_digest: request.args_digest,
            }
            .digest(),
        }
    }

    /// Admit an approval against the exact thing it was granted for.
    ///
    /// Takes the request again rather than trusting the approval to describe
    /// itself: the binding is recomputed here and compared, so an approval that
    /// travelled with an edited payload does not fit.
    pub fn admit(
        &mut self,
        approval: &Approval,
        request: &PolicyRequest<'_>,
    ) -> Result<(), ApprovalRefusal> {
        let expected = ApprovalBinding {
            scope: request.scope,
            target: request.target,
            operation_digest: request.operation_digest,
            args_digest: request.args_digest,
        }
        .digest();
        if approval.binding != expected {
            return Err(ApprovalRefusal::BindingMismatch);
        }
        if !approval.granted {
            return Err(ApprovalRefusal::Refused);
        }
        if approval.expires_at_ms <= request.now_ms {
            return Err(ApprovalRefusal::Expired {
                expires_at_ms: approval.expires_at_ms,
                now_ms: request.now_ms,
            });
        }
        if !self.consumed.insert(*expected.as_bytes()) {
            return Err(ApprovalRefusal::Replayed);
        }
        Ok(())
    }

    pub fn consumed(&self) -> usize {
        self.consumed.len()
    }
}

fn encoded<T: WireEncode>(value: &T) -> Option<Vec<u8>> {
    let mut writer = Writer::new();
    value.encode_to(&mut writer).ok()?;
    Some(writer.into_inner())
}
pub mod blueprint_facades;
