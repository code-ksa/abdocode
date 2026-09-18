//! Generated compiled registry for original blueprint compatibility facades.

#[path = "codegen/compatibility_fixtures.rs"]
pub mod element_001;
#[path = "codegen/json_schema.rs"]
pub mod element_002;
#[path = "codegen/typescript_types.rs"]
pub mod element_003;
#[path = "codegen/typescript_validators.rs"]
pub mod element_004;
#[path = "errors/retry_disposition.rs"]
pub mod element_005;
#[path = "errors/taxonomy.rs"]
pub mod element_006;
#[path = "ids/attempt_id.rs"]
pub mod element_007;
#[path = "ids/effect_id.rs"]
pub mod element_008;
#[path = "ids/fencing_token.rs"]
pub mod element_009;
#[path = "ids/grant_id.rs"]
pub mod element_010;
#[path = "ids/lease_id.rs"]
pub mod element_011;
#[path = "ids/operation_id.rs"]
pub mod element_012;
#[path = "ids/run_id.rs"]
pub mod element_013;
#[path = "ids/session_id.rs"]
pub mod element_014;
#[path = "ids/task_id.rs"]
pub mod element_015;
#[path = "intent/admitted.rs"]
pub mod element_016;
#[path = "intent/conditions.rs"]
pub mod element_017;
#[path = "intent/effect_class.rs"]
pub mod element_018;
#[path = "intent/idempotency.rs"]
pub mod element_019;
#[path = "intent/proposed.rs"]
pub mod element_020;
#[path = "intent/reconciliation.rs"]
pub mod element_021;
#[path = "intent/resource_claims.rs"]
pub mod element_022;
#[path = "policy_types/budget.rs"]
pub mod element_023;
#[path = "policy_types/decision.rs"]
pub mod element_024;
#[path = "policy_types/sandbox_strength.rs"]
pub mod element_025;
#[path = "policy_types/trust_label.rs"]
pub mod element_026;
#[path = "protocol/commands.rs"]
pub mod element_027;
#[path = "protocol/events.rs"]
pub mod element_028;
#[path = "protocol/feature_bits.rs"]
pub mod element_029;
#[path = "protocol/frame_limits.rs"]
pub mod element_030;
#[path = "protocol/replies.rs"]
pub mod element_031;
#[path = "protocol/request_meta.rs"]
pub mod element_032;
#[path = "protocol/schema_fingerprint.rs"]
pub mod element_033;
#[path = "protocol/versions.rs"]
pub mod element_034;
#[path = "receipts/action_receipt.rs"]
pub mod element_035;
#[path = "receipts/artifact_ref.rs"]
pub mod element_036;
#[path = "receipts/observation.rs"]
pub mod element_037;
#[path = "receipts/verification_receipt.rs"]
pub mod element_038;
#[path = "target/execution_root.rs"]
pub mod element_039;
#[path = "target/process_identity.rs"]
pub mod element_040;
#[path = "target/state_handle.rs"]
pub mod element_041;
#[path = "target/surface_ref.rs"]
pub mod element_042;
#[path = "target/target_ref.rs"]
pub mod element_043;

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
    (
        element_034::BLUEPRINT_ELEMENT,
        element_034::CANONICAL_SOURCE,
        element_034::connected,
    ),
    (
        element_035::BLUEPRINT_ELEMENT,
        element_035::CANONICAL_SOURCE,
        element_035::connected,
    ),
    (
        element_036::BLUEPRINT_ELEMENT,
        element_036::CANONICAL_SOURCE,
        element_036::connected,
    ),
    (
        element_037::BLUEPRINT_ELEMENT,
        element_037::CANONICAL_SOURCE,
        element_037::connected,
    ),
    (
        element_038::BLUEPRINT_ELEMENT,
        element_038::CANONICAL_SOURCE,
        element_038::connected,
    ),
    (
        element_039::BLUEPRINT_ELEMENT,
        element_039::CANONICAL_SOURCE,
        element_039::connected,
    ),
    (
        element_040::BLUEPRINT_ELEMENT,
        element_040::CANONICAL_SOURCE,
        element_040::connected,
    ),
    (
        element_041::BLUEPRINT_ELEMENT,
        element_041::CANONICAL_SOURCE,
        element_041::connected,
    ),
    (
        element_042::BLUEPRINT_ELEMENT,
        element_042::CANONICAL_SOURCE,
        element_042::connected,
    ),
    (
        element_043::BLUEPRINT_ELEMENT,
        element_043::CANONICAL_SOURCE,
        element_043::connected,
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
