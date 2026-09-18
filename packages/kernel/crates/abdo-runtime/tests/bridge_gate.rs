#![forbid(unsafe_code)]

//! The exact S142 gate: the bridge carries one effect, and a kill in the gap.
//!
//! Everything here is measured against a real `abdo-kernel` process,
//! because the claim is about a boundary and a boundary that is crossed
//! in-process has not been crossed. The three things it establishes:
//!
//! 1. One read goes out as a contract frame, comes back as a contract frame,
//!    and leaves all seven of its phases in the ledger — in order. "It worked"
//!    means the journal says so, not that the call returned.
//! 2. A frame the host cannot read is refused rather than guessed at, and a
//!    frame that declares more payload than the protocol allows is refused
//!    before those bytes are read. A memory budget the other end sets is not a
//!    budget.
//! 3. A host killed between `commit_dispatch` and the adapter is recovered by a
//!    *second process* as `UnknownOutcome`, and replaying the same request gets
//!    that answer rather than a second dispatch. Two processes, because one
//!    process dropping its handles proves the protocol and not the crash.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use abdo_contracts::{
    decode_frame, decode_frame_header, encode_frame, label_digest, Digest, EffectOutcome,
    EffectRequest, EventId, FilesystemHandle, FilesystemTargetRef, IntentId, ProposalId, Scope,
    TargetRef, WorkspaceScope, FRAME_HEADER_LEN,
};
use abdo_journal::{EffectId, Journal};
use abdo_runtime::EffectPhase;
use sha2::{Digest as _, Sha256};

const PARENT_GATE_ENV: &str = "ABDO_BRIDGE_PARENT_GATE";

/// The same domain the host separates its read digests with.
const READ_CONTENT_DOMAIN: &[u8] = b"ABDO/KERNEL-HOST/READ-OBJECT/1\0";

/// The handle the object is bound under. Opaque, and chosen by whoever starts
/// the host rather than derived from the path: a caller that could compute a
/// handle from a path could name a file.
const OBJECT_HANDLE: [u8; 32] = [0xb1; 32];
const SEALING_KEY: [u8; 32] = [0x5a; 32];

/// What the ledger must hold after one successful effect, in order.
const SEVEN_PHASES: [EffectPhase; 7] = [
    EffectPhase::Prepared,
    EffectPhase::Cleared,
    EffectPhase::Authorized,
    EffectPhase::Dispatching,
    EffectPhase::Started,
    EffectPhase::Settled,
    EffectPhase::Verified,
];

/// What the ledger must hold after a host was killed in the gap.
const FOUR_PHASES: [EffectPhase; 4] = [
    EffectPhase::Prepared,
    EffectPhase::Cleared,
    EffectPhase::Authorized,
    EffectPhase::Dispatching,
];

#[test]
#[ignore = "S142 exact bridge gate"]
fn the_bridge_carries_one_effect_and_recovers_a_kill_as_an_unknown_outcome() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S142 bridge gate requires its exact parent marker"
    );

    let started = Instant::now();
    let host = host_path();
    let directory = TestDirectory::new("bridge");

    // --- one effect, end to end ------------------------------------------
    let object = directory.path().join("object.txt");
    std::fs::write(&object, b"the kernel read this").expect("the bound object must be writable");
    let expected = content_digest(b"the kernel read this");

    let journal_path = directory.path().join("effects.sqlite");
    let mut child = spawn_host(&host, &journal_path, &object, false);
    let request = read_request(1);
    write_frame(
        &mut child,
        &encode_frame(&request).expect("the request encodes"),
    );
    let outcome = read_outcome(&mut child);
    let EffectOutcome::Verified(verified) = outcome else {
        panic!("the bridge did not carry the read to a verified outcome: {outcome:?}");
    };
    assert_eq!(
        verified.intent_id, request.intent_id,
        "the outcome named another effect"
    );
    assert_eq!(
        verified.outcome_digest, expected,
        "the host settled on a digest that is not the object's content"
    );
    assert_eq!(
        verified.postcondition_digest, expected,
        "verification agreed with the settlement without recomputing it"
    );
    assert!(
        verified.settled_at_ms > 0 && verified.verified_at_ms >= verified.settled_at_ms,
        "an outcome cannot be checked before it settled"
    );
    finish(child);

    let phases = ledger_phases(&journal_path, request.intent_id);
    assert_eq!(
        phases,
        SEVEN_PHASES.to_vec(),
        "the ledger does not hold the seven phases in order"
    );

    // --- refusal, not repair ---------------------------------------------
    let mut malformations = 0_u32;
    let mut refusals = 0_u32;
    let canonical = encode_frame(&read_request(2)).expect("the request encodes");

    // A fingerprint from another schema.
    let mut wrong_schema = canonical.clone();
    wrong_schema[6] ^= 0x80;
    malformations += 1;
    refusals += u32::from(refuses(&host, &directory, &object, &wrong_schema, 3));

    // A message tag this host does not serve.
    let mut wrong_message = canonical.clone();
    wrong_message[22..24].copy_from_slice(&2_u16.to_le_bytes());
    malformations += 1;
    refusals += u32::from(refuses(&host, &directory, &object, &wrong_message, 4));

    // A payload the contract's own rules forbid: an identifier of zero. The
    // frame is well formed, so this is refused by the decoder rather than by
    // the framing, which are two different refusals worth having both of.
    let mut zero_intent = canonical.clone();
    zero_intent[FRAME_HEADER_LEN..FRAME_HEADER_LEN + 16].fill(0);
    malformations += 1;
    refusals += u32::from(refuses(&host, &directory, &object, &zero_intent, 5));

    // A header claiming more payload than the protocol permits. The bytes it
    // promises are never sent, so a host that read first and checked afterwards
    // would block here rather than refuse.
    let mut oversized = canonical.clone();
    oversized.truncate(FRAME_HEADER_LEN);
    oversized[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
    malformations += 1;
    refusals += u32::from(refuses(&host, &directory, &object, &oversized, 6));

    // --- killed in the gap ------------------------------------------------
    let killed_directory = TestDirectory::new("bridge-kill");
    let killed_object = killed_directory.path().join("object.txt");
    std::fs::write(&killed_object, b"never read").expect("the bound object must be writable");
    let killed_journal = killed_directory.path().join("effects.sqlite");
    let killed_request = read_request(7);

    let mut halting = spawn_host(&host, &killed_journal, &killed_object, true);
    write_frame(
        &mut halting,
        &encode_frame(&killed_request).expect("the request encodes"),
    );
    let announcement = wait_for_halt(&mut halting);
    assert!(
        announcement.contains("halted after committing a dispatch"),
        "the host did not reach the gap it was asked to stop in: {announcement}"
    );
    halting.kill().expect("a halted host must be killable");
    let status = halting.wait().expect("a killed host must be reapable");
    assert!(
        !status.success(),
        "the host exited of its own accord instead of being killed there"
    );

    let killed_phases = ledger_phases(&killed_journal, killed_request.intent_id);
    assert_eq!(
        killed_phases,
        FOUR_PHASES.to_vec(),
        "the killed host did not leave a committed dispatch behind"
    );

    // A second process, reading the ledger the first one left. Sending the same
    // request again is the thing a caller would naturally do, and the answer it
    // must get is that nobody can say — not a second dispatch.
    let mut recovering = spawn_host(&host, &killed_journal, &killed_object, false);
    write_frame(
        &mut recovering,
        &encode_frame(&killed_request).expect("the request encodes"),
    );
    let recovered = read_outcome(&mut recovering);
    let EffectOutcome::Unresolved(unresolved) = recovered else {
        panic!("a replay after a kill was answered with {recovered:?}");
    };
    assert_eq!(
        unresolved.reason_digest,
        label_digest(b"unknown-outcome"),
        "the host gave a different reason for an unresolved effect"
    );
    finish(recovering);

    let replayed_phases = ledger_phases(&killed_journal, killed_request.intent_id);
    assert_eq!(
        replayed_phases,
        FOUR_PHASES.to_vec(),
        "the replay advanced a ledger it was supposed to only read"
    );

    println!(
        "S142_BRIDGE phases={} verified=1 outcome_matched=1 malformations={} refusals={} killed_phases={} replayed_phases={} elapsed_ms={}",
        phases.len(),
        malformations,
        refusals,
        killed_phases.len(),
        replayed_phases.len(),
        started.elapsed().as_millis(),
    );
}

/// Send one frame to a fresh host and require it to refuse without answering.
fn refuses(host: &Path, parent: &TestDirectory, object: &Path, frame: &[u8], seed: u32) -> bool {
    let journal = parent.path().join(format!("refusal-{seed}.sqlite"));
    let mut child = spawn_host(host, &journal, object, false);
    write_frame(&mut child, frame);
    // Standard input closes, so a host that was waiting for more bytes stops
    // waiting. One that refused already has exited.
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .expect("a refusing host must be reapable");
    let answered = !output.stdout.is_empty();
    let complained = !output.stderr.is_empty();
    !output.status.success() && !answered && complained
}

fn spawn_host(host: &Path, journal: &Path, object: &Path, stop_after_commit: bool) -> Child {
    let binding = format!("{}={}", hex(&OBJECT_HANDLE), object.display());
    let mut command = Command::new(host);
    command
        .arg("--journal")
        .arg(journal)
        .arg("--sealing-key")
        .arg(hex(&SEALING_KEY))
        .arg("--bind")
        .arg(binding)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stop_after_commit {
        command.arg("--stop-after-commit");
    }
    command.spawn().expect("the kernel host must be spawnable")
}

fn write_frame(child: &mut Child, frame: &[u8]) {
    let stdin = child.stdin.as_mut().expect("the host has an input pipe");
    stdin.write_all(frame).expect("a frame must be writable");
    stdin.flush().expect("a frame must be flushable");
}

fn read_outcome(child: &mut Child) -> EffectOutcome {
    let stdout = child.stdout.as_mut().expect("the host has an output pipe");
    let mut header = [0_u8; FRAME_HEADER_LEN];
    stdout
        .read_exact(&mut header)
        .expect("the host must answer with a frame header");
    let parsed = decode_frame_header(&header).expect("the host must answer with a readable header");
    let mut frame = header.to_vec();
    frame.resize(parsed.frame_length, 0);
    stdout
        .read_exact(&mut frame[FRAME_HEADER_LEN..])
        .expect("the host must answer with a whole frame");
    decode_frame::<EffectOutcome>(&frame).expect("the answer must decode as an outcome")
}

/// Block until the halted host says where it stopped.
///
/// A read that returns is the synchronisation. Sleeping for a while and hoping
/// would make the boundary this gate measures a matter of timing.
fn wait_for_halt(child: &mut Child) -> String {
    let stderr = child.stderr.as_mut().expect("the host has an error pipe");
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("a halted host must say so before it is killed");
    line
}

fn finish(mut child: Child) {
    drop(child.stdin.take());
    let status = child.wait().expect("a host must be reapable");
    assert!(
        status.success(),
        "the host did not shut down cleanly: {status:?}"
    );
}

fn ledger_phases(journal: &Path, intent_id: IntentId) -> Vec<EffectPhase> {
    let journal = Journal::open(journal).expect("the ledger must be readable");
    let effect_id = EffectId::try_from_u128(intent_id.get()).expect("effect id");
    journal
        .effect_history(effect_id)
        .expect("the effect must have a history")
        .iter()
        .map(|record| {
            EffectPhase::from_tag(record.phase_tag.get()).expect("every recorded phase is known")
        })
        .collect()
}

fn read_request(seed: u128) -> EffectRequest {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after the epoch")
        .as_millis() as u64;
    EffectRequest {
        intent_id: IntentId::try_from_u128(seed * 8 + 1).expect("intent id"),
        proposal_id: ProposalId::try_from_u128(seed * 8 + 2).expect("proposal id"),
        cause_event_id: EventId::try_from_u128(seed * 8 + 3).expect("event id"),
        // The host grants against the workspace, so anything else is a scope it
        // holds no capability for.
        scope: Scope::Workspace(Box::new(WorkspaceScope)),
        target: TargetRef::Filesystem(Box::new(FilesystemTargetRef {
            object: FilesystemHandle::from_bytes(OBJECT_HANDLE),
        })),
        operation_digest: label_digest(b"read-bound-object"),
        args_digest: label_digest(b"no-arguments"),
        requested_at_ms: now,
        expires_at_ms: now + 60_000,
    }
}

fn content_digest(bytes: &[u8]) -> Digest {
    let mut hasher = Sha256::new();
    hasher.update(READ_CONTENT_DOMAIN);
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    Digest::from_bytes(hasher.finalize().into())
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from_digit(u32::from(byte >> 4), 16).expect("a nibble is a hex digit"));
        text.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("a nibble is a hex digit"));
    }
    text
}

/// Where Cargo put the host for this profile.
///
/// Derived from the test binary's own path rather than assumed, so the gate
/// drives the artefact this build produced instead of one a previous profile
/// left behind.
fn host_path() -> PathBuf {
    let mut path = std::env::current_exe().expect("the test binary knows where it is");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.push(format!("abdo-kernel{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "the bridge gate found no host binary at {}",
        path.display()
    );
    path
}

/// A scoped temporary directory that removes itself.
#[derive(Debug)]
struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let parent =
            std::fs::canonicalize(std::env::temp_dir()).expect("temporary directory must exist");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        let path = parent.join(format!("abdo-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).expect("scoped gate directory must be creatable");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
