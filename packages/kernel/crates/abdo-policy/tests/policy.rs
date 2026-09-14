#![forbid(unsafe_code)]

//! Risk that cannot be argued down, and approvals that fit one thing only.

use abdo_contracts::{
    Digest, FilesystemHandle, FilesystemTargetRef, KernelSessionId, Scope, SessionScope, TargetRef,
};
use abdo_policy::{
    Approval, ApprovalBinding, ApprovalRefusal, Policy, PolicyOutcome, PolicyRequest, Risk,
    RISK_BANDS,
};

fn session(seed: u128) -> Scope {
    Scope::Session(Box::new(SessionScope {
        kernel_session_id: KernelSessionId::try_from_u128(seed).expect("session id"),
    }))
}

fn target(fill: u8) -> TargetRef {
    TargetRef::Filesystem(Box::new(FilesystemTargetRef {
        object: FilesystemHandle::from_bytes([fill; 32]),
    }))
}

fn digest(fill: u8) -> Digest {
    assert!(fill != 0, "a fixture digest must not be all zeroes");
    Digest::from_bytes([fill; 32])
}

fn request<'a>(
    scope: &'a Scope,
    target: &'a TargetRef,
    operation: u8,
    args: u8,
    now_ms: u64,
) -> PolicyRequest<'a> {
    PolicyRequest {
        scope,
        target,
        operation_digest: digest(operation),
        args_digest: digest(args),
        now_ms,
        expires_at_ms: now_ms + 60_000,
    }
}

#[test]
fn an_unclassified_operation_is_treated_as_the_worst_case() {
    // Defaulting an unknown operation to harmless is how a new tool ships with
    // no supervision at all.
    let policy = Policy::new();
    assert_eq!(policy.risk_of(digest(0x11)), Risk::R4);

    let scope = session(1);
    let object = target(0x20);
    assert!(matches!(
        policy.evaluate(&request(&scope, &object, 0x11, 0x12, 1_000)),
        PolicyOutcome::RequireApproval { risk: Risk::R4, .. }
    ));
}

#[test]
fn nothing_in_the_request_can_lower_the_risk() {
    // The band comes from the policy, keyed by the operation. Two requests that
    // differ in every other way get the same band, so there is nothing for a
    // model or a shell to say that changes it.
    let mut policy = Policy::new();
    policy.classify(digest(0x30), Risk::R3);

    let first_scope = session(1);
    let second_scope = session(999);
    let first_target = target(0x40);
    let second_target = target(0x41);

    for (scope, object, args) in [
        (&first_scope, &first_target, 0x50),
        (&second_scope, &second_target, 0x51),
    ] {
        match policy.evaluate(&request(scope, object, 0x30, args, 1_000)) {
            PolicyOutcome::RequireApproval { risk, .. } => assert_eq!(risk, Risk::R3),
            other => panic!("risk moved with the request: {other:?}"),
        }
    }
}

#[test]
fn a_denied_operation_is_refused_before_anybody_is_asked() {
    let mut policy = Policy::new();
    policy.classify(digest(0x60), Risk::R1);
    policy.deny(digest(0x60));
    // Also on the allow list, to prove denial is checked first and cannot be
    // talked past by adding a permission next to it.
    policy.allow_without_approval(digest(0x60));

    let scope = session(1);
    let object = target(0x61);
    assert!(matches!(
        policy.evaluate(&request(&scope, &object, 0x60, 0x62, 1_000)),
        PolicyOutcome::Deny { risk: Risk::R1 }
    ));
}

#[test]
fn an_expired_intent_is_refused_rather_than_put_to_a_person() {
    // Approving something that has already run out approves nothing, and asking
    // trains an operator to click through questions that do not matter.
    let mut policy = Policy::new();
    policy.classify(digest(0x70), Risk::R2);
    let scope = session(1);
    let object = target(0x71);

    let mut expired = request(&scope, &object, 0x70, 0x72, 1_000);
    expired.expires_at_ms = 1_000;
    assert!(matches!(
        policy.evaluate(&expired),
        PolicyOutcome::Deny { .. }
    ));
}

#[test]
fn read_only_work_needs_nobody() {
    let mut policy = Policy::new();
    policy.classify(digest(0x80), Risk::R0);
    let scope = session(1);
    let object = target(0x81);
    assert_eq!(
        policy.evaluate(&request(&scope, &object, 0x80, 0x82, 1_000)),
        PolicyOutcome::Allow
    );
}

#[test]
fn an_approval_does_not_fit_an_edited_payload() {
    // The whole point of binding. The approval travels; the thing it was for
    // must not change underneath it.
    let mut policy = Policy::new();
    policy.classify(digest(0x90), Risk::R2);
    let scope = session(1);
    let object = target(0x91);

    let original = request(&scope, &object, 0x90, 0x92, 1_000);
    let binding = match policy.evaluate(&original) {
        PolicyOutcome::RequireApproval { binding, .. } => binding,
        other => panic!("expected an approval requirement, saw {other:?}"),
    };
    let approval = Approval {
        binding,
        granted: true,
        decided_at_ms: 1_100,
        expires_at_ms: 61_000,
    };

    // Same approval, different arguments.
    let edited_args = request(&scope, &object, 0x90, 0x93, 1_200);
    assert_eq!(
        policy.admit(&approval, &edited_args),
        Err(ApprovalRefusal::BindingMismatch)
    );

    // Same approval, different target.
    let other_target = target(0x94);
    let edited_target = request(&scope, &other_target, 0x90, 0x92, 1_200);
    assert_eq!(
        policy.admit(&approval, &edited_target),
        Err(ApprovalRefusal::BindingMismatch)
    );

    // Same approval, different scope.
    let other_scope = session(2);
    let edited_scope = request(&other_scope, &object, 0x90, 0x92, 1_200);
    assert_eq!(
        policy.admit(&approval, &edited_scope),
        Err(ApprovalRefusal::BindingMismatch)
    );

    // Unedited, it fits.
    let unchanged = request(&scope, &object, 0x90, 0x92, 1_200);
    assert_eq!(policy.admit(&approval, &unchanged), Ok(()));
}

#[test]
fn an_approval_answers_once() {
    let mut policy = Policy::new();
    policy.classify(digest(0xa0), Risk::R3);
    let scope = session(1);
    let object = target(0xa1);
    let ask = request(&scope, &object, 0xa0, 0xa2, 1_000);
    let binding = match policy.evaluate(&ask) {
        PolicyOutcome::RequireApproval { binding, .. } => binding,
        other => panic!("expected an approval requirement, saw {other:?}"),
    };
    let approval = Approval {
        binding,
        granted: true,
        decided_at_ms: 1_100,
        expires_at_ms: 61_000,
    };

    assert_eq!(policy.admit(&approval, &ask), Ok(()));
    assert_eq!(
        policy.admit(&approval, &ask),
        Err(ApprovalRefusal::Replayed),
        "an approval was accepted twice"
    );
    assert_eq!(policy.consumed(), 1);
}

#[test]
fn an_expired_or_refused_approval_admits_nothing() {
    let mut policy = Policy::new();
    policy.classify(digest(0xb0), Risk::R2);
    let scope = session(1);
    let object = target(0xb1);
    let ask = request(&scope, &object, 0xb0, 0xb2, 5_000);
    let binding = match policy.evaluate(&ask) {
        PolicyOutcome::RequireApproval { binding, .. } => binding,
        other => panic!("expected an approval requirement, saw {other:?}"),
    };

    let expired = Approval {
        binding,
        granted: true,
        decided_at_ms: 1_000,
        expires_at_ms: 5_000,
    };
    assert_eq!(
        policy.admit(&expired, &ask),
        Err(ApprovalRefusal::Expired {
            expires_at_ms: 5_000,
            now_ms: 5_000
        })
    );

    let refused = Approval {
        binding,
        granted: false,
        decided_at_ms: 1_000,
        expires_at_ms: 61_000,
    };
    assert_eq!(policy.admit(&refused, &ask), Err(ApprovalRefusal::Refused));

    // Neither was spent, so a genuine answer can still be given.
    assert_eq!(policy.consumed(), 0);
}

#[test]
fn only_the_irreversible_refuses_a_standing_answer() {
    for risk in RISK_BANDS {
        assert_eq!(
            risk.allows_standing_approval(),
            risk != Risk::R4,
            "the standing-approval rule changed for {risk:?}"
        );
        assert_eq!(Risk::from_band(risk.band()), Some(risk));
    }
    assert_eq!(Risk::from_band(5), None);
    assert!(Risk::R0 < Risk::R4);
}

#[test]
fn a_binding_separates_fields_rather_than_running_them_together() {
    // Without length prefixes, moving a byte from one field to the next can
    // leave the hash unchanged, and two different requests would share one
    // approval.
    let scope = session(1);
    let object = target(0xc0);
    let left = ApprovalBinding {
        scope: &scope,
        target: &object,
        operation_digest: digest(0x01),
        args_digest: digest(0x02),
    };
    let right = ApprovalBinding {
        scope: &scope,
        target: &object,
        operation_digest: digest(0x02),
        args_digest: digest(0x01),
    };
    assert_ne!(left.digest(), right.digest());
}
