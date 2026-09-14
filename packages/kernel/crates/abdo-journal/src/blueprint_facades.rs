//! Generated compiled registry for original blueprint compatibility facades.

#[path = "snapshots/branch_history.rs"]
pub mod element_001;
#[path = "snapshots/checkpoint_manifest.rs"]
pub mod element_002;
#[path = "snapshots/kernel_snapshot.rs"]
pub mod element_003;
#[path = "sqlite/begin_immediate.rs"]
pub mod element_004;
#[path = "sqlite/checkpoint_policy.rs"]
pub mod element_005;
#[path = "sqlite/defensive.rs"]
pub mod element_006;
#[path = "sqlite/version_gate.rs"]
pub mod element_007;
#[path = "sqlite/wal_full.rs"]
pub mod element_008;

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
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_facade_is_connected() {
        assert!(!super::FACADES.is_empty());
        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));
    }
}
