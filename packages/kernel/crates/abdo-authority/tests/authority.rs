#![forbid(unsafe_code)]

//! Cross-scope use, restart, PID reuse, revocation and forgery.

use abdo_authority::{
    Authority, BootIdentity, Capability, CapabilityId, CapabilityRequest, Denial, ProcessIdentity,
    ReceiptSubject, SealingKey, Use, Verdict,
};
use abdo_contracts::{
    BootId, Digest, FilesystemHandle, FilesystemTargetRef, KernelSessionId, Nonce, ProcessHandle,
    ProcessTargetRef, ReceiptId, RunId, Scope, SessionScope, TargetRef, TaskId, TaskScope,
    WorkspaceScope,
};

fn boot(seed: u128) -> BootIdentity {
    BootIdentity {
        boot_id: BootId::try_from_u128(seed).expect("boot id is non-zero"),
        run_id: RunId::try_from_u128(seed * 7).expect("run id is non-zero"),
    }
}

fn key(fill: u8) -> SealingKey {
    SealingKey::from_bytes([fill; 32])
}

fn session(seed: u128) -> Scope {
    Scope::Session(Box::new(SessionScope {
        kernel_session_id: KernelSessionId::try_from_u128(seed).expect("session id is non-zero"),
    }))
}

fn task(seed: u128) -> Scope {
    Scope::Task(Box::new(TaskScope {
        task_id: TaskId::try_from_u128(seed).expect("task id is non-zero"),
    }))
}

fn filesystem(fill: u8) -> TargetRef {
    TargetRef::Filesystem(Box::new(FilesystemTargetRef {
        object: FilesystemHandle::from_bytes([fill; 32]),
    }))
}

fn process_target(fill: u8) -> TargetRef {
    TargetRef::Process(Box::new(ProcessTargetRef {
        process: ProcessHandle::from_bytes([fill; 32]),
    }))
}

fn subject(fill: u8) -> ReceiptSubject {
    ReceiptSubject {
        receipt_id: ReceiptId::try_from_u128(u128::from(fill) + 1).expect("receipt id"),
        nonce: Nonce::from_bytes([fill | 1; 32]),
        source_digest: Digest::from_bytes([fill ^ 0x11 | 1; 32]),
        entrypoint_digest: Digest::from_bytes([fill ^ 0x22 | 1; 32]),
        issuer_digest: Digest::from_bytes([fill ^ 0x33 | 1; 32]),
        artifact_digest: Digest::from_bytes([fill ^ 0x44 | 1; 32]),
        trust_policy_digest: Digest::from_bytes([fill ^ 0x55 | 1; 32]),
        reason_digest: Digest::from_bytes([fill ^ 0x66 | 1; 32]),
    }
}

/// An operation digest.
///
/// No bit-setting here. `0x60 | 1` and `0x61 | 1` are the same byte, and a
/// fixture that quietly collapses two values it was asked to keep apart turns
/// the test that uses them into a comparison of something with itself.
fn operation(value: u8) -> Digest {
    assert!(value != 0, "an operation digest must not be all zeroes");
    Digest::from_bytes([value; 32])
}

fn request(id: u128, scope: Scope, target: TargetRef, op: u8) -> CapabilityRequest {
    CapabilityRequest {
        id: CapabilityId::try_from_u128(id).expect("capability id is non-zero"),
        scope,
        target,
        operation_digest: operation(op),
        issued_at_ms: 1_000,
        expires_at_ms: 61_000,
    }
}

fn attempt<'a>(
    capability: &'a Capability,
    by: &'a Scope,
    target: &'a TargetRef,
    op: u8,
    now_ms: u64,
) -> Use<'a> {
    Use {
        capability,
        by,
        target,
        operation_digest: operation(op),
        now_ms,
    }
}

#[test]
fn a_capability_granted_to_one_session_is_refused_to_another() {
    // The whole point of binding a grant to a scope. A capability that worked
    // for whoever held it would be a bearer token, and a bearer token is a
    // capability that has stopped being one.
    let mut authority = Authority::new(boot(1), ProcessIdentity::new(4_242, 1_700), key(0xa1));
    let granted = authority
        .grant(request(1, session(10), filesystem(0x30), 0x40))
        .expect("grant");

    let mine = session(10);
    let theirs = session(11);
    let target = filesystem(0x30);

    assert_eq!(
        authority.check(&attempt(&granted, &mine, &target, 0x40, 2_000)),
        Verdict::Granted
    );
    assert_eq!(
        authority.check(&attempt(&granted, &theirs, &target, 0x40, 2_000)),
        Verdict::Denied(Denial::WrongScope)
    );

    // Nor may a task borrow a session's grant, or the reverse.
    let other_kind = task(10);
    assert_eq!(
        authority.check(&attempt(&granted, &other_kind, &target, 0x40, 2_000)),
        Verdict::Denied(Denial::WrongScope),
        "a task used a capability granted to a session with the same number"
    );
}

#[test]
fn a_capability_is_bound_to_its_target_and_its_operation() {
    let mut authority = Authority::new(boot(2), ProcessIdentity::new(1, 1), key(0xa2));
    let granted = authority
        .grant(request(2, session(20), filesystem(0x51), 0x60))
        .expect("grant");
    let scope = session(20);

    // The two operations this test relies on must actually differ, or the
    // wrong-operation branch is never reached and the test passes for nothing.
    assert_ne!(operation(0x60), operation(0x61));
    assert_ne!(filesystem(0x51), filesystem(0x52));

    assert_eq!(
        authority.check(&attempt(&granted, &scope, &filesystem(0x52), 0x60, 2_000)),
        Verdict::Denied(Denial::WrongTarget)
    );
    assert_eq!(
        authority.check(&attempt(
            &granted,
            &scope,
            &process_target(0x51),
            0x60,
            2_000
        )),
        Verdict::Denied(Denial::WrongTarget),
        "a different kind of target with the same bytes was accepted"
    );
    assert_eq!(
        authority.check(&attempt(&granted, &scope, &filesystem(0x51), 0x61, 2_000)),
        Verdict::Denied(Denial::WrongOperation)
    );
}

#[test]
fn a_receipt_from_a_previous_boot_does_not_verify() {
    // A restart is the cheapest way to lose every in-memory guarantee, so it
    // must invalidate by itself, without a revocation list to consult.
    let first = Authority::new(boot(3), ProcessIdentity::new(900, 5_000), key(0xa3));
    let receipt = first
        .issue_receipt(subject(0x11), 1_000, 30_000)
        .expect("issue");
    assert_eq!(first.verify_receipt(&receipt, 2_000), Verdict::Granted);

    let next_boot = Authority::new(boot(4), ProcessIdentity::new(900, 5_000), key(0xa3));
    assert_eq!(
        next_boot.verify_receipt(&receipt, 2_000),
        Verdict::Denied(Denial::WrongBoot)
    );

    // Even with the same boot identity, a different key is a different
    // authority, and its receipts are not this one's to accept.
    let impostor = Authority::new(boot(3), ProcessIdentity::new(900, 5_000), key(0xff));
    assert_eq!(
        impostor.verify_receipt(&receipt, 2_000),
        Verdict::Denied(Denial::ForgedSeal)
    );
}

#[test]
fn a_recycled_pid_does_not_inherit_the_dead_process_authority() {
    // Operating systems hand the same PID out again. Binding to the number
    // alone would let an unrelated process pick up whatever the last one had.
    let original = ProcessIdentity::new(1_234, 10_000);
    let recycled = ProcessIdentity::new(1_234, 90_000);
    assert!(!original.is_same_as(&recycled));
    assert_ne!(original.digest(), recycled.digest());

    let authority = Authority::new(boot(5), original, key(0xa5));
    let receipt = authority
        .issue_receipt(subject(0x22), 1_000, 30_000)
        .expect("issue");
    assert_eq!(authority.verify_receipt(&receipt, 2_000), Verdict::Granted);

    let successor = Authority::new(boot(5), recycled, key(0xa5));
    assert_eq!(
        successor.verify_receipt(&receipt, 2_000),
        Verdict::Denied(Denial::WrongProcess),
        "a recycled PID inherited a dead process's receipt"
    );
}

#[test]
fn an_altered_receipt_is_refused_field_by_field() {
    let authority = Authority::new(boot(6), ProcessIdentity::new(7, 7), key(0xa6));
    let receipt = authority
        .issue_receipt(subject(0x33), 1_000, 30_000)
        .expect("issue");
    assert_eq!(authority.verify_receipt(&receipt, 2_000), Verdict::Granted);

    // Each of these is a field somebody would want to move.
    let mut later_expiry = receipt.clone();
    later_expiry.expires_at_ms += 1;
    assert_eq!(
        authority.verify_receipt(&later_expiry, 2_000),
        Verdict::Denied(Denial::ForgedSeal),
        "extending a receipt's life went unnoticed"
    );

    let mut other_issuer = receipt.clone();
    other_issuer.issuer_digest = Digest::from_bytes([0x7e; 32]);
    assert_eq!(
        authority.verify_receipt(&other_issuer, 2_000),
        Verdict::Denied(Denial::ForgedSeal)
    );

    let mut restamped = receipt.clone();
    restamped.integrity_digest = Digest::from_bytes([0x01; 32]);
    assert_eq!(
        authority.verify_receipt(&restamped, 2_000),
        Verdict::Denied(Denial::ForgedSeal)
    );
}

#[test]
fn an_expired_receipt_is_refused_even_though_it_is_genuine() {
    let authority = Authority::new(boot(7), ProcessIdentity::new(8, 8), key(0xa7));
    let receipt = authority
        .issue_receipt(subject(0x44), 1_000, 5_000)
        .expect("issue");
    assert_eq!(authority.verify_receipt(&receipt, 5_999), Verdict::Granted);
    assert_eq!(
        authority.verify_receipt(&receipt, 6_000),
        Verdict::Denied(Denial::Expired {
            expires_at_ms: 6_000,
            now_ms: 6_000
        })
    );
}

#[test]
fn a_receipt_cannot_outlive_the_contract_ceiling() {
    let authority = Authority::new(boot(8), ProcessIdentity::new(9, 9), key(0xa8));
    assert!(authority
        .issue_receipt(subject(0x55), 1_000, 60_000)
        .is_ok());
    assert!(authority
        .issue_receipt(subject(0x55), 1_000, 60_001)
        .is_err());
    assert!(authority.issue_receipt(subject(0x55), 1_000, 0).is_err());
}

#[test]
fn revocation_invalidates_everything_issued_before_it() {
    let mut authority = Authority::new(boot(9), ProcessIdentity::new(10, 10), key(0xa9));
    let receipt = authority
        .issue_receipt(subject(0x66), 1_000, 30_000)
        .expect("issue");
    let granted = authority
        .grant(request(9, session(90), filesystem(0x70), 0x80))
        .expect("grant");
    let scope = session(90);
    let target = filesystem(0x70);
    assert_eq!(authority.verify_receipt(&receipt, 2_000), Verdict::Granted);
    assert_eq!(
        authority.check(&attempt(&granted, &scope, &target, 0x80, 2_000)),
        Verdict::Granted
    );

    let after = authority.revoke_all();
    assert!(after > 1);
    assert_eq!(
        authority.verify_receipt(&receipt, 2_000),
        Verdict::Denied(Denial::Revoked {
            held: 1,
            current: after
        })
    );
    assert_eq!(
        authority.check(&attempt(&granted, &scope, &target, 0x80, 2_000)),
        Verdict::Denied(Denial::Revoked {
            held: 1,
            current: after
        })
    );
}

#[test]
fn a_capability_this_authority_never_granted_is_unknown() {
    // A capability is a value somebody could carry over from elsewhere, so
    // being asked about one is not the same as having issued it.
    let mut issuing = Authority::new(boot(10), ProcessIdentity::new(11, 11), key(0xaa));
    let granted = issuing
        .grant(request(10, session(100), filesystem(0x90), 0x91))
        .expect("grant");

    let stranger = Authority::new(boot(10), ProcessIdentity::new(11, 11), key(0xaa));
    let scope = session(100);
    let target = filesystem(0x90);
    assert_eq!(
        stranger.check(&attempt(&granted, &scope, &target, 0x91, 2_000)),
        Verdict::Denied(Denial::UnknownCapability { id: granted.id() })
    );

    // And revoking one leaves it unknown rather than merely expired.
    assert!(issuing.revoke(granted.id()));
    assert_eq!(
        issuing.check(&attempt(&granted, &scope, &target, 0x91, 2_000)),
        Verdict::Denied(Denial::UnknownCapability { id: granted.id() })
    );
    assert_eq!(issuing.granted(), 0);
}

#[test]
fn a_capability_expires_on_its_own_clock() {
    let mut authority = Authority::new(boot(11), ProcessIdentity::new(12, 12), key(0xab));
    let granted = authority
        .grant(request(11, session(110), filesystem(0xa0), 0xa1))
        .expect("grant");
    let scope = session(110);
    let target = filesystem(0xa0);
    assert_eq!(
        authority.check(&attempt(&granted, &scope, &target, 0xa1, 60_999)),
        Verdict::Granted
    );
    assert_eq!(
        authority.check(&attempt(&granted, &scope, &target, 0xa1, 61_000)),
        Verdict::Denied(Denial::Expired {
            expires_at_ms: 61_000,
            now_ms: 61_000
        })
    );
}

#[test]
fn a_workspace_grant_is_not_a_session_grant() {
    let mut authority = Authority::new(boot(12), ProcessIdentity::new(13, 13), key(0xac));
    let granted = authority
        .grant(request(
            12,
            Scope::Workspace(Box::new(WorkspaceScope)),
            filesystem(0xb0),
            0xb1,
        ))
        .expect("grant");
    let target = filesystem(0xb0);

    let workspace = Scope::Workspace(Box::new(WorkspaceScope));
    assert_eq!(
        authority.check(&attempt(&granted, &workspace, &target, 0xb1, 2_000)),
        Verdict::Granted
    );
    let some_session = session(1);
    assert_eq!(
        authority.check(&attempt(&granted, &some_session, &target, 0xb1, 2_000)),
        Verdict::Denied(Denial::WrongScope)
    );
}

#[test]
fn two_capabilities_cannot_share_an_identity() {
    let mut authority = Authority::new(boot(13), ProcessIdentity::new(14, 14), key(0xad));
    authority
        .grant(request(13, session(130), filesystem(0xc0), 0xc1))
        .expect("grant");
    assert!(
        authority
            .grant(request(13, session(131), filesystem(0xc2), 0xc3))
            .is_err(),
        "a second capability took an identity already in use, which is how one is silently replaced"
    );
}
