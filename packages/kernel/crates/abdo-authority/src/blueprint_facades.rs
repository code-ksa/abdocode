//! Generated compiled registry for original blueprint compatibility facades.

#[path = "capabilities/attenuation.rs"]
pub mod element_001;
#[path = "capabilities/revocation.rs"]
pub mod element_002;
#[path = "capabilities/typed_scopes.rs"]
pub mod element_003;
#[path = "grants/one_shot.rs"]
pub mod element_004;
#[path = "grants/opaque.rs"]
pub mod element_005;
#[path = "grants/target_bound.rs"]
pub mod element_006;
#[path = "grants/ttl.rs"]
pub mod element_007;
#[path = "leases/human_takeover.rs"]
pub mod element_008;
#[path = "leases/surface_lease.rs"]
pub mod element_009;
#[path = "leases/worker_lease.rs"]
pub mod element_010;
#[path = "secrets/audience_binding.rs"]
pub mod element_011;
#[path = "secrets/oidc.rs"]
pub mod element_012;
#[path = "secrets/secret_handle.rs"]
pub mod element_013;
#[path = "workspace_trust/config_attestation.rs"]
pub mod element_014;
#[path = "workspace_trust/gate.rs"]
pub mod element_015;
#[path = "workspace_trust/receipt.rs"]
pub mod element_016;

pub type BlueprintFacade = (&'static str, &'static str, fn() -> bool);
pub const FACADES: &[BlueprintFacade] = &[
    (
        element_001::BLUEPRINT_ELEMENT,
        element_001::CANONICAL_SOURCE,
        element_001::connected,
    ),
    (
        element_002::BLUEPRINT_ELEMENT,
        element_002::CANONICAL_SOURCE,
        element_002::connected,
    ),
    (
        element_003::BLUEPRINT_ELEMENT,
        element_003::CANONICAL_SOURCE,
        element_003::connected,
    ),
    (
        element_004::BLUEPRINT_ELEMENT,
        element_004::CANONICAL_SOURCE,
        element_004::connected,
    ),
    (
        element_005::BLUEPRINT_ELEMENT,
        element_005::CANONICAL_SOURCE,
        element_005::connected,
    ),
    (
        element_006::BLUEPRINT_ELEMENT,
        element_006::CANONICAL_SOURCE,
        element_006::connected,
    ),
    (
        element_007::BLUEPRINT_ELEMENT,
        element_007::CANONICAL_SOURCE,
        element_007::connected,
    ),
    (
        element_008::BLUEPRINT_ELEMENT,
        element_008::CANONICAL_SOURCE,
        element_008::connected,
    ),
    (
        element_009::BLUEPRINT_ELEMENT,
        element_009::CANONICAL_SOURCE,
        element_009::connected,
    ),
    (
        element_010::BLUEPRINT_ELEMENT,
        element_010::CANONICAL_SOURCE,
        element_010::connected,
    ),
    (
        element_011::BLUEPRINT_ELEMENT,
        element_011::CANONICAL_SOURCE,
        element_011::connected,
    ),
    (
        element_012::BLUEPRINT_ELEMENT,
        element_012::CANONICAL_SOURCE,
        element_012::connected,
    ),
    (
        element_013::BLUEPRINT_ELEMENT,
        element_013::CANONICAL_SOURCE,
        element_013::connected,
    ),
    (
        element_014::BLUEPRINT_ELEMENT,
        element_014::CANONICAL_SOURCE,
        element_014::connected,
    ),
    (
        element_015::BLUEPRINT_ELEMENT,
        element_015::CANONICAL_SOURCE,
        element_015::connected,
    ),
    (
        element_016::BLUEPRINT_ELEMENT,
        element_016::CANONICAL_SOURCE,
        element_016::connected,
    ),
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_facade_is_connected() {
        assert!(!super::FACADES.is_empty());
        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));
    }
}
