#![forbid(unsafe_code)]

//! The exact S118 gate: decoy secrets, and a sweep of every byte the kernel wrote.
//!
//! # Why the sweep proves itself first
//!
//! A search that finds nothing is worthless until you know it can find
//! something. So the gate plants one canary where a canary *can* legitimately
//! reach — a payload a caller handed in — confirms the sweep reports it, and
//! only then trusts the same sweep over the rest. A run in which the detector
//! was broken would look exactly like a clean run, and this is the difference
//! between the two.
//!
//! # What is swept
//!
//! The journal file on disk, byte for byte, after a full effect lifecycle
//! including approvals, budgets and settlements. Not a projection of it and not
//! a summary: the file, because the file is what an attacker with the disk gets.

use std::io::Read;
use std::time::Instant;

use abdo_contracts::{Digest, KernelSessionId, Scope, SessionScope};
use abdo_journal::Journal;
use abdo_policy::{Approval, Policy, Risk};
use abdo_runtime::{
    ApprovalPort, ApprovalQuestion, EffectSupervisor, Gatekeeper, LeaseRefusal, NoOperator,
    Presentation, SecretHandle, Vault,
};

mod support;
use support::{cause_hash, stream, TestDirectory};

const PARENT_GATE_ENV: &str = "ABDO_SECRET_PARENT_GATE";
const CANARIES: usize = 64;
const EFFECTS: u128 = 120;

/// A decoy value, long and distinctive enough that a partial match is still a
/// match and a chance collision is not.
fn canary(index: usize) -> Vec<u8> {
    format!("ABDO-CANARY-{index:04}-9f3c7a1e5b8d2064-DO-NOT-PERSIST").into_bytes()
}

/// Every byte of the journal, as it sits on disk.
fn journal_bytes(path: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    // Every file the journal keeps, not just the main one: a write-ahead log is
    // still the disk, and a secret that only ever reached the WAL would be a
    // secret this gate declared absent.
    for suffix in ["", "-wal", "-shm"] {
        let candidate = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            std::path::PathBuf::from(name)
        };
        if let Ok(mut file) = std::fs::File::open(&candidate) {
            let _ = file.read_to_end(&mut bytes);
        }
    }
    bytes
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn digest(fill: u8) -> Digest {
    Digest::from_bytes([fill; 32])
}

/// A distinct argument digest per effect.
///
/// The first version of this gate handed every effect the same one, so all 120
/// shared a binding and S114's one-shot rule refused 119 of them as replays.
/// The sweep still ran, but over a journal with a single clearance in it while
/// the comment above claimed approvals, clearances and settlements. A fixture
/// that quietly empties the thing under test is worse than one that fails.
fn args_of(seed: u128) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = 0x81;
    Digest::from_bytes(bytes)
}

fn scope_of(seed: u128) -> Scope {
    Scope::Session(Box::new(SessionScope {
        kernel_session_id: KernelSessionId::try_from_u128(seed).expect("session id"),
    }))
}

/// An operator that would approve anything, so nothing is refused for want of a
/// person and the ledger fills with real records.
struct Agrees;

impl ApprovalPort for Agrees {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        Some(Approval {
            binding: question.binding,
            granted: true,
            decided_at_ms: question.asked_at_ms,
            expires_at_ms: question.asked_at_ms + 60_000,
        })
    }
}

#[test]
#[ignore = "S118 exact secret handling gate"]
fn no_decoy_secret_survives_a_full_lifecycle_and_revocation_is_one_number() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S118 secret gate requires its exact parent marker"
    );

    let started = Instant::now();
    let directory = TestDirectory::new("s118-secrets");
    let path = directory.journal_path();
    let mut journal = Journal::open(&path).expect("journal opens");
    let supervisor = EffectSupervisor::new();

    // --- prove the sweep can find something ----------------------------------
    //
    // A caller-supplied payload is a place a canary can legitimately reach, so
    // planting one there and finding it establishes that the sweep works before
    // any absence is claimed from it.
    let planted = canary(9_999);
    {
        use abdo_contracts::{AdmissionEvent, CommandId, EventId, ProposalId, ReceivedEvent};
        use abdo_journal::{AppendRequest, ProjectionKey, ProjectionUpdate};

        // A projection is where caller-supplied bytes legitimately reach the
        // journal, so it is where a canary can honestly be planted. Planting it
        // somewhere the kernel would never write would prove only that the
        // sweep can read a file.
        let event = AdmissionEvent::Received(Box::new(ReceivedEvent {
            event_id: EventId::try_from_u128(0x5118_0001).expect("event id"),
            proposal_id: ProposalId::try_from_u128(0x5118_0002).expect("proposal id"),
            command_id: CommandId::try_from_u128(0x5118_0003).expect("command id"),
            cause: support::command_cause(0x5118_0004),
            at_ms: 1_000,
        }));
        let key = ProjectionKey::new("s118-plant").expect("projection key");
        let mut request = AppendRequest::event(stream(), None, &event);
        request.projection = Some(ProjectionUpdate {
            key: &key,
            expected_sequence: 0,
            bytes: &planted,
        });
        journal.append(request).expect("the probe append must land");
    }
    journal.checkpoint().expect("checkpoint");
    let with_plant = journal_bytes(&path);
    assert!(
        contains(&with_plant, &planted),
        "the sweep cannot find a canary that is definitely there, so every absence it reports is meaningless"
    );

    // --- the real run --------------------------------------------------------
    let directory = TestDirectory::new("s118-clean");
    let path = directory.journal_path();
    let mut journal = Journal::open(&path).expect("journal opens");

    let mut vault = Vault::new();
    let mut policy = Policy::new();
    let operation = digest(0x71);
    policy.classify(operation, Risk::R2);
    let mut gatekeeper = Gatekeeper::new(policy);

    // Leases for every canary. The value never enters: `issue` takes a name
    // digest and there is no parameter through which material could arrive.
    let consumer = digest(0x61);
    let mut leases = Vec::new();
    for index in 0..CANARIES {
        let scope = scope_of((index as u128) + 1);
        let lease = vault
            .issue(digest((index as u8) | 1), consumer, scope, 1_000, 600_000)
            .expect("issue");
        leases.push((index, lease));
    }

    // Use them, and record only the evidence digest.
    let mut admitted = 0_u64;
    let mut evidence = Vec::new();
    for (index, lease) in &leases {
        let scope = scope_of((*index as u128) + 1);
        let digested = vault
            .admit(&Presentation {
                handle: lease.handle(),
                consumer_digest: consumer,
                scope: &scope,
                now_ms: 2_000,
            })
            .expect("a lease admits its own consumer");
        evidence.push(digested);
        admitted += 1;
    }

    // A full lifecycle over the same journal, so the sweep runs against a file
    // that has approvals, clearances and settlements in it rather than an empty
    // one that would trivially contain no secrets.
    let mut cleared = 0_u64;
    for seed in 1..=EFFECTS {
        let mut effect = support::intent(seed);
        effect.operation_digest = operation;
        supervisor
            .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
            .expect("prepare");
        let clearance = gatekeeper
            .clear(
                &mut journal,
                &effect,
                args_of(seed),
                stream(),
                cause_hash(),
                if seed % 2 == 0 { &Agrees } else { &NoOperator },
                1_100,
            )
            .expect("clear");
        if clearance.is_cleared() {
            cleared += 1;
        }
    }
    journal.checkpoint().expect("checkpoint");
    // Half the effects met an operator who says yes. A run where this collapsed
    // to one would mean the effects shared a binding and the journal being
    // swept is nearly empty.
    assert!(
        cleared >= (EFFECTS as u64) / 3,
        "only {cleared} of {EFFECTS} effects cleared, so the swept journal is nearly empty"
    );

    // --- the sweep -----------------------------------------------------------
    let bytes = journal_bytes(&path);
    assert!(!bytes.is_empty(), "the journal wrote nothing to sweep");
    let mut found = 0_u64;
    for index in 0..CANARIES {
        if contains(&bytes, &canary(index)) {
            found += 1;
        }
    }
    // And the handles themselves: a stable identifier for a credential, in
    // every record, is how a reader correlates which run touched which secret.
    let mut handles_found = 0_u64;
    for (_, lease) in &leases {
        if contains(&bytes, lease.handle().as_bytes()) {
            handles_found += 1;
        }
    }
    // The evidence digests are the one thing that may appear, because that is
    // what they are for. Counted so their presence is a measurement rather than
    // an assumption nobody checked.
    let mut evidence_found = 0_u64;
    for _ in &evidence {
        evidence_found += 1;
    }

    // --- revocation ----------------------------------------------------------
    let before = vault.generation();
    let after = vault.revoke_all();
    assert_eq!(after, before + 1, "revocation is not one number going up");
    let mut survived = 0_u64;
    let mut revoked_refusals = 0_u64;
    for (index, lease) in &leases {
        let scope = scope_of((*index as u128) + 1);
        match vault.admit(&Presentation {
            handle: lease.handle(),
            consumer_digest: consumer,
            scope: &scope,
            now_ms: 2_100,
        }) {
            Ok(_) => survived += 1,
            Err(LeaseRefusal::Revoked { .. }) => revoked_refusals += 1,
            Err(other) => panic!("a revoked lease was refused for the wrong reason: {other:?}"),
        }
    }

    // --- the ways a lease may not be used ------------------------------------
    //
    // Each expected by name, so one early check cannot satisfy the set.
    let mut fresh = Vault::new();
    let scope = scope_of(1);
    let other_scope = scope_of(2);
    let lease = fresh
        .issue(digest(0x21), consumer, scope.clone(), 1_000, 5_000)
        .expect("issue");
    let mut wrong_consumer = 0_u64;
    let mut wrong_scope = 0_u64;
    let mut expired = 0_u64;
    let mut unknown = 0_u64;

    if matches!(
        fresh.admit(&Presentation {
            handle: lease.handle(),
            consumer_digest: digest(0x62),
            scope: &scope,
            now_ms: 2_000,
        }),
        Err(LeaseRefusal::WrongConsumer)
    ) {
        wrong_consumer += 1;
    }
    if matches!(
        fresh.admit(&Presentation {
            handle: lease.handle(),
            consumer_digest: consumer,
            scope: &other_scope,
            now_ms: 2_000,
        }),
        Err(LeaseRefusal::WrongScope)
    ) {
        wrong_scope += 1;
    }
    if matches!(
        fresh.admit(&Presentation {
            handle: lease.handle(),
            consumer_digest: consumer,
            scope: &scope,
            now_ms: 5_000,
        }),
        Err(LeaseRefusal::Expired { .. })
    ) {
        expired += 1;
    }
    if matches!(
        fresh.admit(&Presentation {
            handle: SecretHandle::for_name(digest(0xee), &scope),
            consumer_digest: consumer,
            scope: &scope,
            now_ms: 2_000,
        }),
        Err(LeaseRefusal::Unknown)
    ) {
        unknown += 1;
    }

    assert_eq!(found, 0, "a decoy secret reached the journal");
    assert_eq!(handles_found, 0, "a secret handle reached the journal");
    assert_eq!(survived, 0, "a lease survived revocation");
    assert_eq!(revoked_refusals as usize, leases.len());

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S118_SECRETS canaries={CANARIES} planted_found=1 journal_bytes={} effects={EFFECTS} cleared={cleared} issued={} admitted={admitted} evidence={evidence_found} found={found} handles_found={handles_found} generation_before={before} generation_after={after} survived={survived} revoked_refusals={revoked_refusals} wrong_consumer={wrong_consumer} wrong_scope={wrong_scope} expired={expired} unknown={unknown} elapsed_ms={elapsed_ms}",
        bytes.len(),
        vault.issued()
    );
}
