//! Generated compiled registry for original blueprint compatibility facades.

#[path = "decisions/ask.rs"]
pub mod element_001;
#[path = "decisions/deny.rs"]
pub mod element_002;
#[path = "decisions/permit.rs"]
pub mod element_003;
#[path = "decisions/stronger_sandbox.rs"]
pub mod element_004;
#[path = "egress/domain.rs"]
pub mod element_005;
#[path = "egress/method.rs"]
pub mod element_006;
#[path = "egress/path.rs"]
pub mod element_007;
#[path = "egress/port.rs"]
pub mod element_008;
#[path = "hooks/guard_contract.rs"]
pub mod element_009;
#[path = "hooks/observer_contract.rs"]
pub mod element_010;
#[path = "lattice/enterprise.rs"]
pub mod element_011;
#[path = "lattice/organization.rs"]
pub mod element_012;
#[path = "lattice/session.rs"]
pub mod element_013;
#[path = "lattice/task.rs"]
pub mod element_014;
#[path = "lattice/user.rs"]
pub mod element_015;
#[path = "lattice/workspace.rs"]
pub mod element_016;
#[path = "phase_profiles/agent.rs"]
pub mod element_017;
#[path = "phase_profiles/setup.rs"]
pub mod element_018;
#[path = "phase_profiles/verification.rs"]
pub mod element_019;

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
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_facade_is_connected() {
        assert!(!super::FACADES.is_empty());
        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));
    }
}
