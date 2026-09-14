#![cfg(feature = "test-hooks")]
#![forbid(unsafe_code)]

mod support;

use std::env;
use std::io::Read;
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant};

use abdo_journal::test_support::{
    fold_fixture_digest, seed_fixture as seed_fixture_direct, TEST_CHILD_DIR_ENV,
    TEST_CHILD_ROLE_ENV, TEST_CRASH_POINT_ENV, TEST_CRASH_TOKEN_ENV,
};
use abdo_journal::{Journal, StreamId};

use support::{
    exact_invocation_role, valid_gate_token, wait_for_child, ExactInvocationRole, ScopedChildren,
    TestDirectory, CRASH_PARENT_GATE_ENV, MIGRATION_PARENT_GATE_ENV, RESTORE_PARENT_GATE_ENV,
};

const EVENT_COUNT: u64 = 100_000;
const SNAPSHOT_SEQUENCE: u64 = 90_000;
const TAIL_COUNT: usize = 10_000;
const RESTORE_LIMIT: Duration = Duration::from_secs(2);
const SEED_TIMEOUT: Duration = Duration::from_secs(120);
const CHILD_BINARY: &str = env!("CARGO_BIN_EXE_abdo-journal-test-child");

#[test]
#[ignore = "S105 100,000-event warm-filesystem-cache host benchmark; not a universal latency claim"]
fn restores_hundred_thousand_events_within_two_seconds() {
    assert_hostile_environment_is_rejected();
    let token = forced_parent_token();
    let directory = TestDirectory::new("restore-100k");
    directory.write_handshake(&token);
    assert_seed_child_requires_token(&directory);
    assert_direct_seed_api_requires_child_context(&directory);
    let database = directory.join("restore.sqlite");
    let stream = StreamId::try_from_u128(1).expect("benchmark stream ID must be non-zero");

    let fixture_started = Instant::now();
    let seed = seed_fixture(&directory, &database, stream, &token);
    let fixture_elapsed = fixture_started.elapsed();
    assert_eq!(seed.events, EVENT_COUNT);
    assert_eq!(seed.snapshot_sequence, SNAPSHOT_SEQUENCE);

    let started = Instant::now();
    let journal = Journal::open(&database).expect("100k journal must reopen");
    let open_elapsed = started.elapsed();
    let restore_started = Instant::now();
    let restored = journal
        .restore(stream)
        .expect("100k journal restore plan must load");
    let restore_elapsed = restore_started.elapsed();
    let snapshot = restored
        .snapshot
        .as_ref()
        .expect("100k fixture must retain its 90k snapshot");
    let snapshot_digest: [u8; 32] = snapshot
        .bytes
        .as_slice()
        .try_into()
        .expect("fixture snapshot must contain one rolling SHA-256 digest");
    let fold_started = Instant::now();
    let restored_digest = restored
        .events
        .iter()
        .fold(snapshot_digest, |digest, envelope| {
            fold_fixture_digest(digest, envelope.hash)
        });
    let fold_elapsed = fold_started.elapsed();
    let elapsed = started.elapsed();

    assert!(
        elapsed <= RESTORE_LIMIT,
        "open + full verify + 90k snapshot/10k tail restore took {elapsed:?} (open={open_elapsed:?}, restore={restore_elapsed:?}, fold={fold_elapsed:?}), above {RESTORE_LIMIT:?}"
    );
    assert_eq!(snapshot.through_sequence, SNAPSHOT_SEQUENCE);
    assert_eq!(restored.events.len(), TAIL_COUNT);
    assert_eq!(
        restored.head.expect("restored head must exist").sequence,
        EVENT_COUNT
    );
    assert_eq!(
        restored
            .head
            .expect("restored head must exist")
            .hash
            .to_string(),
        seed.head_hash_hex
    );
    assert_eq!(restored_digest, seed.fixture_digest);
    assert!(
        restored.events.iter().enumerate().all(|(index, envelope)| {
            let expected_sequence = SNAPSHOT_SEQUENCE + index as u64 + 1;
            envelope.global_sequence == expected_sequence
                && envelope.stream_sequence == expected_sequence
                && envelope.event_id.get() == u128::from(expected_sequence + 1)
        }),
        "restored 10k tail must be exact, ordered, contiguous, and free of duplicates/loss"
    );
    drop(journal);
    directory.remove();
    println!(
        "S105_RESTORE_100K events={EVENT_COUNT} snapshot={SNAPSHOT_SEQUENCE} tail={TAIL_COUNT} fixture_ms={} open_ms={} restore_ms={} fold_ms={} total_ms={}",
        fixture_elapsed.as_millis(),
        open_elapsed.as_millis(),
        restore_elapsed.as_millis(),
        fold_elapsed.as_millis(),
        elapsed.as_millis()
    );
}

fn assert_direct_seed_api_requires_child_context(directory: &TestDirectory) {
    let database = directory.join("direct-seed.sqlite");
    let stream = StreamId::try_from_u128(91).expect("negative fixture stream must be valid");
    let mut journal = Journal::open(&database).expect("negative fixture journal must open");
    assert!(
        seed_fixture_direct(&mut journal, stream, 1, 1, 1).is_err(),
        "feature-gated fixture seeding must still require authenticated child context"
    );
    assert_eq!(
        journal
            .verify()
            .expect("rejected fixture seed must leave a valid journal")
            .events,
        0,
        "rejected direct fixture seeding mutated the journal"
    );
}

fn assert_seed_child_requires_token(directory: &TestDirectory) {
    let database = directory.join("untrusted-seed.sqlite");
    let child = ProcessCommand::new(CHILD_BINARY)
        .arg("seed")
        .arg(&database)
        .arg("1")
        .arg("1")
        .arg("1")
        .arg("1")
        .env_remove(RESTORE_PARENT_GATE_ENV)
        .env(TEST_CHILD_ROLE_ENV, "1")
        .env(TEST_CHILD_DIR_ENV, directory.path())
        .env_remove(TEST_CRASH_TOKEN_ENV)
        .env_remove(TEST_CRASH_POINT_ENV)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("untrusted fixture child must start for the negative gate");
    let mut children = ScopedChildren::with_capacity(1);
    children.push(child);
    let status = wait_for_child(&mut children.as_mut_slice()[0], SEED_TIMEOUT);
    let _ = children.take();
    assert!(
        !status.success(),
        "fixture child accepted a missing crash token"
    );
    assert!(
        !database.exists(),
        "fixture child created a journal before authenticating its parent token"
    );
}

#[derive(Debug)]
struct SeedReport {
    events: u64,
    snapshot_sequence: u64,
    head_hash_hex: String,
    fixture_digest: [u8; 32],
}

fn seed_fixture(
    directory: &TestDirectory,
    database: &std::path::Path,
    stream: StreamId,
    token: &str,
) -> SeedReport {
    let child = ProcessCommand::new(CHILD_BINARY)
        .arg("seed")
        .arg(database)
        .arg(stream.get().to_string())
        .arg("1")
        .arg(EVENT_COUNT.to_string())
        .arg(SNAPSHOT_SEQUENCE.to_string())
        .env_remove(RESTORE_PARENT_GATE_ENV)
        .env(TEST_CHILD_ROLE_ENV, "1")
        .env(TEST_CHILD_DIR_ENV, directory.path())
        .env(TEST_CRASH_TOKEN_ENV, token)
        .env_remove(TEST_CRASH_POINT_ENV)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("100k fixture child must start");
    let mut children = ScopedChildren::with_capacity(1);
    children.push(child);
    // Borrow the child in place. Moving it out of `ScopedChildren` would strip
    // the drop guard that kills and reaps anything still alive.
    let child = &mut children.as_mut_slice()[0];
    let status = wait_for_child(child, SEED_TIMEOUT);
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .expect("fixture child stdout must be piped")
        .read_to_string(&mut stdout)
        .expect("fixture child stdout must be readable");
    child
        .stderr
        .take()
        .expect("fixture child stderr must be piped")
        .read_to_string(&mut stderr)
        .expect("fixture child stderr must be readable");
    assert!(
        status.success(),
        "100k fixture child failed as {status:?}: {stderr}"
    );
    assert!(
        stderr.is_empty(),
        "100k fixture child wrote stderr: {stderr}"
    );
    parse_seed_report(stdout.trim())
}

fn parse_seed_report(line: &str) -> SeedReport {
    let fields: Vec<_> = line.split_ascii_whitespace().collect();
    assert_eq!(
        fields.len(),
        5,
        "seed acknowledgement must contain exactly five fields"
    );
    assert_eq!(fields[0], "SEED_ACK");
    let events = fields[1].parse().expect("seed event count must be decimal");
    let snapshot_sequence = fields[2]
        .parse()
        .expect("seed snapshot sequence must be decimal");
    assert!(
        valid_gate_token(fields[3]),
        "seed head hash must be lowercase SHA-256 hex"
    );
    assert!(
        valid_gate_token(fields[4]),
        "seed fixture digest must be lowercase SHA-256 hex"
    );
    SeedReport {
        events,
        snapshot_sequence,
        head_hash_hex: fields[3].to_owned(),
        fixture_digest: decode_sha256(fields[4]),
    }
}

fn decode_sha256(value: &str) -> [u8; 32] {
    assert!(valid_gate_token(value), "SHA-256 hex must be canonical");
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .expect("SHA-256 hex byte must decode");
    }
    bytes
}

fn forced_parent_token() -> String {
    let child_markers = [
        env::var(TEST_CHILD_ROLE_ENV).ok(),
        env::var(TEST_CHILD_DIR_ENV).ok(),
        env::var(TEST_CRASH_TOKEN_ENV).ok(),
        env::var(TEST_CRASH_POINT_ENV).ok(),
    ];
    let sibling_parent_markers = [
        env::var(CRASH_PARENT_GATE_ENV).ok(),
        env::var(MIGRATION_PARENT_GATE_ENV).ok(),
    ];
    match exact_invocation_role(
        env::var(RESTORE_PARENT_GATE_ENV).ok(),
        &child_markers,
        &sibling_parent_markers,
    )
    .unwrap_or_else(|message| panic!("{message}"))
    {
        ExactInvocationRole::Parent(token) => token,
        ExactInvocationRole::Child => panic!("the benchmark process cannot run as a fixture child"),
    }
}

fn assert_hostile_environment_is_rejected() {
    let token = "ef".repeat(32);
    assert_eq!(
        exact_invocation_role(
            Some(token.clone()),
            &[None, None, None, None],
            &[None, None]
        ),
        Ok(ExactInvocationRole::Parent(token.clone()))
    );
    assert_eq!(
        exact_invocation_role(
            Some(token),
            &[None, None, None, Some("append.before_begin".to_owned())],
            &[None, None],
        ),
        Err("parent and child gate markers cannot coexist")
    );
    assert_eq!(
        exact_invocation_role(None, &[None, None, None, None], &[None, None]),
        Err("exact S105 test requires the forced parent gate")
    );
    assert_eq!(
        exact_invocation_role(
            Some("ef".repeat(32)),
            &[None, None, None, None],
            &[Some("forged".to_owned()), None],
        ),
        Err("sibling S105 parent gate marker is forbidden")
    );
}
