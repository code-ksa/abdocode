//! Compiled admission table for the public product adapters.
//!
//! A caller supplies a bounded `ToolSpec`, never an executable. The worker
//! admits only one of these names with its expected effect class; an unknown
//! name or a mismatched class fails closed before catalog registration.

use abdo_contracts::{label_digest, EffectClass, ToolSpec};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterKind {
    Write,
    GitRead,
    GitChange,
    Package,
    Network,
    /// Arbitrary shell execution. Its class is `Irreversible`: a command line can
    /// delete, publish or pay, and there is no compensating operation to name —
    /// only evidence of what ran. So the catalog refuses it on a host without
    /// enforceable isolation, exactly as it refuses any irreversible work, and
    /// the product answers that refusal with an explicit operator decision
    /// rather than by pretending a recovery plan exists.
    Shell,
}

impl AdapterKind {
    #[must_use]
    pub fn label(self) -> &'static [u8] {
        match self {
            Self::Write => b"abdo-write-adapter",
            Self::GitRead => b"abdo-git-read-adapter",
            Self::GitChange => b"abdo-git-change-adapter",
            Self::Package => b"abdo-package-adapter",
            Self::Network => b"abdo-network-adapter",
            Self::Shell => b"abdo-shell-adapter",
        }
    }

    #[must_use]
    pub fn accepts(self, effect: &EffectClass) -> bool {
        matches!(
            (self, effect),
            (Self::Write | Self::GitChange, EffectClass::Mutate(_))
                | (Self::GitRead, EffectClass::Read(_))
                | (Self::Package | Self::Network, EffectClass::Reach(_))
                | (Self::Shell, EffectClass::Irreversible(_))
        )
    }
}

#[must_use]
pub fn adapter_kind(spec: &ToolSpec) -> Option<AdapterKind> {
    let candidates = [
        AdapterKind::Write,
        AdapterKind::GitRead,
        AdapterKind::GitChange,
        AdapterKind::Package,
        AdapterKind::Network,
        AdapterKind::Shell,
    ];
    candidates
        .into_iter()
        .find(|kind| spec.name_digest == label_digest(kind.label()) && kind.accepts(&spec.effect))
}

#[cfg(test)]
mod tests {
    use super::*;
    use abdo_contracts::{
        Digest, IrreversibleEffect, MutatingEffect, ReadEffect, RecoveryPlan, ResourceLimits,
        ToolId,
    };

    fn digest(seed: u8) -> Digest {
        let mut bytes = [0_u8; 32];
        bytes[0] = seed;
        bytes[31] = 1;
        Digest::from_bytes(bytes)
    }

    fn spec(kind: AdapterKind, effect: EffectClass) -> ToolSpec {
        ToolSpec {
            tool_id: ToolId::try_from_u128(1).expect("tool id"),
            name_digest: label_digest(kind.label()),
            input_schema_digest: digest(2),
            output_schema_digest: digest(3),
            effect,
            resources: ResourceLimits {
                wall_ms: 1_000,
                memory_bytes: 1_024,
                output_bytes: 1_024,
                open_handles: 4,
            },
            postcondition_digest: digest(4),
            handler_digest: label_digest(b"abdo-bounded-tool"),
        }
    }

    #[test]
    fn names_and_effects_are_both_compiled() {
        let read = spec(
            AdapterKind::GitRead,
            EffectClass::Read(Box::new(ReadEffect)),
        );
        assert_eq!(adapter_kind(&read), Some(AdapterKind::GitRead));
        let mismatch = spec(
            AdapterKind::GitRead,
            EffectClass::Mutate(Box::new(MutatingEffect {
                recovery: RecoveryPlan {
                    compensating_operation_digest: digest(5),
                    evidence_operation_digest: digest(6),
                    max_attempts: 1,
                },
            })),
        );
        assert_eq!(adapter_kind(&mismatch), None);
    }

    #[test]
    fn shell_is_admitted_only_as_irreversible() {
        let honest = spec(
            AdapterKind::Shell,
            EffectClass::Irreversible(Box::new(IrreversibleEffect {
                evidence_operation_digest: digest(7),
            })),
        );
        assert_eq!(adapter_kind(&honest), Some(AdapterKind::Shell));
        // A recovery plan for an arbitrary command line would be a fiction the
        // catalog then trusts; the table refuses the shape rather than the claim.
        let pretends_recoverable = spec(
            AdapterKind::Shell,
            EffectClass::Mutate(Box::new(MutatingEffect {
                recovery: RecoveryPlan {
                    compensating_operation_digest: digest(5),
                    evidence_operation_digest: digest(6),
                    max_attempts: 1,
                },
            })),
        );
        assert_eq!(adapter_kind(&pretends_recoverable), None);
        let read = spec(AdapterKind::Shell, EffectClass::Read(Box::new(ReadEffect)));
        assert_eq!(adapter_kind(&read), None);
    }
}
