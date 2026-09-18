#![forbid(unsafe_code)]

//! The exact S113 gate: many scopes, many capabilities, and not one crossing.
//!
//! The number that matters is cross-scope grants honoured, and zero only means
//! something if crossings were attempted. So the gate counts attempts too: a
//! run where nobody ever presented somebody else's capability would report zero
//! and prove nothing.

use std::time::Instant;

use abdo_authority::{
    Authority, BootIdentity, CapabilityId, CapabilityRequest, Denial, ProcessIdentity,
    ReceiptSubject, SealingKey, Use, Verdict,
};
use abdo_contracts::{
    BootId, Digest, FilesystemHandle, FilesystemTargetRef, KernelSessionId, Nonce, ReceiptId,
    RunId, Scope, SessionScope, TargetRef,
};

const PARENT_GATE_ENV: &str = "ABDO_AUTHORITY_PARENT_GATE";
const SCOPES: u128 = 64;
const CAPABILITIES_PER_SCOPE: u128 = 8;

fn session(seed: u128) -> Scope {
    Scope::Session(Box::new(SessionScope {
        kernel_session_id: KernelSessionId::try_from_u128(seed).expect("session id"),
    }))
}

fn target(seed: u128) -> TargetRef {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = 1;
    TargetRef::Filesystem(Box::new(FilesystemTargetRef {
        object: FilesystemHandle::from_bytes(bytes),
    }))
}

fn operation(seed: u128) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[30] = 1;
    Digest::from_bytes(bytes)
}

#[test]
#[ignore = "S113 exact capability and trust gate"]
fn no_capability_crosses_a_scope_and_no_receipt_outlives_its_boot() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S113 authority gate requires its exact parent marker"
    );

    let started = Instant::now();
    let boot = BootIdentity {
        boot_id: BootId::try_from_u128(0x5113).expect("boot id"),
        run_id: RunId::try_from_u128(0x5113_0007).expect("run id"),
    };
    let process = ProcessIdentity::new(4_242, 1_700_000);
    let mut authority = Authority::new(boot, process, SealingKey::from_bytes([0x5a; 32]));

    // --- grants -----------------------------------------------------------
    let mut held = Vec::new();
    for scope_seed in 1..=SCOPES {
        for index in 0..CAPABILITIES_PER_SCOPE {
            let id = scope_seed * 1_000 + index + 1;
            let capability = authority
                .grant(CapabilityRequest {
                    id: CapabilityId::try_from_u128(id).expect("capability id"),
                    scope: session(scope_seed),
                    target: target(id),
                    operation_digest: operation(id),
                    issued_at_ms: 0,
                    expires_at_ms: 1_000_000,
                })
                .expect("grant");
            held.push((scope_seed, id, capability));
        }
    }
    let granted_total = held.len() as u64;
    assert_eq!(authority.granted() as u64, granted_total);

    // --- every capability presented by every scope --------------------------
    let mut own_use_granted = 0_u64;
    let mut cross_attempts = 0_u64;
    let mut cross_honoured = 0_u64;
    for (owner, id, capability) in &held {
        for presenter in 1..=SCOPES {
            let by = session(presenter);
            let attempt = Use {
                capability,
                by: &by,
                target: &target(*id),
                operation_digest: operation(*id),
                now_ms: 1_000,
            };
            let verdict = authority.check(&attempt);
            if presenter == *owner {
                assert_eq!(
                    verdict,
                    Verdict::Granted,
                    "an owner was refused its own grant"
                );
                own_use_granted += 1;
            } else {
                cross_attempts += 1;
                match verdict {
                    Verdict::Denied(Denial::WrongScope) => {}
                    Verdict::Granted => cross_honoured += 1,
                    other => panic!("a crossing was refused for the wrong reason: {other:?}"),
                }
            }
        }
    }

    assert_eq!(own_use_granted, granted_total);
    assert!(
        cross_attempts > 0,
        "no crossing was ever attempted, so zero crossings proves nothing"
    );
    assert_eq!(cross_honoured, 0, "a capability crossed a scope boundary");

    // --- receipts -----------------------------------------------------------
    let mut receipts = Vec::new();
    for index in 0..SCOPES {
        let receipt = authority
            .issue_receipt(
                ReceiptSubject {
                    receipt_id: ReceiptId::try_from_u128(index + 1).expect("receipt id"),
                    nonce: Nonce::from_bytes([(index as u8) | 1; 32]),
                    source_digest: operation(index + 1),
                    entrypoint_digest: operation(index + 2),
                    issuer_digest: operation(index + 3),
                    artifact_digest: operation(index + 4),
                    trust_policy_digest: operation(index + 5),
                    reason_digest: operation(index + 6),
                },
                1_000,
                30_000,
            )
            .expect("issue");
        assert_eq!(authority.verify_receipt(&receipt, 2_000), Verdict::Granted);
        receipts.push(receipt);
    }

    // A different boot, a recycled PID, and a different key are three separate
    // ways to be a different authority. None of them may accept these.
    let other_boot = Authority::new(
        BootIdentity {
            boot_id: BootId::try_from_u128(0x5114).expect("boot id"),
            run_id: boot.run_id,
        },
        process,
        SealingKey::from_bytes([0x5a; 32]),
    );
    let recycled_pid = Authority::new(
        boot,
        ProcessIdentity::new(4_242, 9_900_000),
        SealingKey::from_bytes([0x5a; 32]),
    );
    let other_key = Authority::new(boot, process, SealingKey::from_bytes([0x5b; 32]));

    let mut boot_refusals = 0_u64;
    let mut pid_refusals = 0_u64;
    let mut seal_refusals = 0_u64;
    let mut tamper_refusals = 0_u64;
    for receipt in &receipts {
        if other_boot.verify_receipt(receipt, 2_000) == Verdict::Denied(Denial::WrongBoot) {
            boot_refusals += 1;
        }
        if recycled_pid.verify_receipt(receipt, 2_000) == Verdict::Denied(Denial::WrongProcess) {
            pid_refusals += 1;
        }
        if other_key.verify_receipt(receipt, 2_000) == Verdict::Denied(Denial::ForgedSeal) {
            seal_refusals += 1;
        }
        let mut altered = receipt.clone();
        altered.expires_at_ms += 1;
        if authority.verify_receipt(&altered, 2_000) == Verdict::Denied(Denial::ForgedSeal) {
            tamper_refusals += 1;
        }
    }
    let issued = receipts.len() as u64;
    assert_eq!(boot_refusals, issued, "a receipt survived a restart");
    assert_eq!(pid_refusals, issued, "a receipt survived a recycled PID");
    assert_eq!(
        seal_refusals, issued,
        "another key's authority was accepted"
    );
    assert_eq!(tamper_refusals, issued, "an altered receipt verified");

    // --- revocation ---------------------------------------------------------
    let generation = authority.revoke_all();
    let mut survived_revocation = 0_u64;
    for receipt in &receipts {
        if authority.verify_receipt(receipt, 2_000).is_granted() {
            survived_revocation += 1;
        }
    }
    for (owner, id, capability) in &held {
        let by = session(*owner);
        let attempt = Use {
            capability,
            by: &by,
            target: &target(*id),
            operation_digest: operation(*id),
            now_ms: 1_000,
        };
        if authority.check(&attempt).is_granted() {
            survived_revocation += 1;
        }
    }
    assert_eq!(survived_revocation, 0, "revocation left something usable");

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S113_AUTHORITY scopes={SCOPES} capabilities={granted_total} own_use={own_use_granted} cross_attempts={cross_attempts} cross_honoured={cross_honoured} receipts={issued} boot_refusals={boot_refusals} pid_refusals={pid_refusals} seal_refusals={seal_refusals} tamper_refusals={tamper_refusals} survived_revocation={survived_revocation} generation={generation} elapsed_ms={elapsed_ms}"
    );
}
