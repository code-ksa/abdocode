//! Generated compiled registry for original blueprint compatibility facades.

#[path = "adapter_identity/argv_schema.rs"]
pub mod element_001;
#[path = "adapter_identity/binary_digest.rs"]
pub mod element_002;
#[path = "adapter_identity/capability_set.rs"]
pub mod element_003;
#[path = "adapter_identity/env_names.rs"]
pub mod element_004;
#[path = "brokers/external_protocol.rs"]
pub mod element_005;
#[path = "brokers/filesystem.rs"]
pub mod element_006;
#[path = "brokers/git.rs"]
pub mod element_007;
#[path = "brokers/network.rs"]
pub mod element_008;
#[path = "brokers/package.rs"]
pub mod element_009;
#[path = "brokers/secret.rs"]
pub mod element_010;
#[path = "brokers/shell.rs"]
pub mod element_011;
#[path = "catalog/catalog_hash.rs"]
pub mod element_012;
#[path = "catalog/descriptor.rs"]
pub mod element_013;
#[path = "catalog/deterministic_snapshot.rs"]
pub mod element_014;
#[path = "dispatch/invoke.rs"]
pub mod element_015;
#[path = "dispatch/preflight.rs"]
pub mod element_016;
#[path = "dispatch/reconcile.rs"]
pub mod element_017;
#[path = "dispatch/reserve.rs"]
pub mod element_018;
#[path = "dispatch/settle.rs"]
pub mod element_019;
#[path = "execution/circuit_breaker.rs"]
pub mod element_020;
#[path = "execution/explicit_shell_mode.rs"]
pub mod element_021;
#[path = "execution/structured_argv.rs"]
pub mod element_022;
#[path = "output/artifact_spill.rs"]
pub mod element_023;
#[path = "output/quotas.rs"]
pub mod element_024;
#[path = "output/redaction.rs"]
pub mod element_025;
#[path = "surfaces/act.rs"]
pub mod element_026;
#[path = "surfaces/generation_bound_refs.rs"]
pub mod element_027;
#[path = "surfaces/human_takeover.rs"]
pub mod element_028;
#[path = "surfaces/observe.rs"]
pub mod element_029;
#[path = "surfaces/reconcile.rs"]
pub mod element_030;
#[path = "surfaces/surface_port.rs"]
pub mod element_031;
#[path = "worker/optional_wasi.rs"]
pub mod element_032;
#[path = "worker/out_of_process.rs"]
pub mod element_033;

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
    (
        element_017::BLUEPRINT_ELEMENT,
        element_017::CANONICAL_SOURCE,
        element_017::connected,
    ),
    (
        element_018::BLUEPRINT_ELEMENT,
        element_018::CANONICAL_SOURCE,
        element_018::connected,
    ),
    (
        element_019::BLUEPRINT_ELEMENT,
        element_019::CANONICAL_SOURCE,
        element_019::connected,
    ),
    (
        element_020::BLUEPRINT_ELEMENT,
        element_020::CANONICAL_SOURCE,
        element_020::connected,
    ),
    (
        element_021::BLUEPRINT_ELEMENT,
        element_021::CANONICAL_SOURCE,
        element_021::connected,
    ),
    (
        element_022::BLUEPRINT_ELEMENT,
        element_022::CANONICAL_SOURCE,
        element_022::connected,
    ),
    (
        element_023::BLUEPRINT_ELEMENT,
        element_023::CANONICAL_SOURCE,
        element_023::connected,
    ),
    (
        element_024::BLUEPRINT_ELEMENT,
        element_024::CANONICAL_SOURCE,
        element_024::connected,
    ),
    (
        element_025::BLUEPRINT_ELEMENT,
        element_025::CANONICAL_SOURCE,
        element_025::connected,
    ),
    (
        element_026::BLUEPRINT_ELEMENT,
        element_026::CANONICAL_SOURCE,
        element_026::connected,
    ),
    (
        element_027::BLUEPRINT_ELEMENT,
        element_027::CANONICAL_SOURCE,
        element_027::connected,
    ),
    (
        element_028::BLUEPRINT_ELEMENT,
        element_028::CANONICAL_SOURCE,
        element_028::connected,
    ),
    (
        element_029::BLUEPRINT_ELEMENT,
        element_029::CANONICAL_SOURCE,
        element_029::connected,
    ),
    (
        element_030::BLUEPRINT_ELEMENT,
        element_030::CANONICAL_SOURCE,
        element_030::connected,
    ),
    (
        element_031::BLUEPRINT_ELEMENT,
        element_031::CANONICAL_SOURCE,
        element_031::connected,
    ),
    (
        element_032::BLUEPRINT_ELEMENT,
        element_032::CANONICAL_SOURCE,
        element_032::connected,
    ),
    (
        element_033::BLUEPRINT_ELEMENT,
        element_033::CANONICAL_SOURCE,
        element_033::connected,
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
