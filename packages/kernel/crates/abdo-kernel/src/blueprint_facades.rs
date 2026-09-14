//! Generated compiled registry for original blueprint compatibility facades.

#[path = "admission/causation.rs"]
pub mod element_001;
#[path = "admission/deduplication.rs"]
pub mod element_002;
#[path = "admission/state_handle_guard.rs"]
pub mod element_003;
#[path = "admission/version_guard.rs"]
pub mod element_004;
#[path = "state/approval.rs"]
pub mod element_005;
#[path = "state/checkpoint.rs"]
pub mod element_006;
#[path = "state/effect.rs"]
pub mod element_007;
#[path = "state/run.rs"]
pub mod element_008;
#[path = "state/task.rs"]
pub mod element_009;
#[path = "state/worker.rs"]
pub mod element_010;

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
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_facade_is_connected() {
        assert!(!super::FACADES.is_empty());
        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));
    }
}
