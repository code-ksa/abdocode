#![cfg(feature = "test-hooks")]
#![forbid(unsafe_code)]

mod support;

use std::collections::HashSet;
use std::env;
use std::io::Read;
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant};

use abdo_journal::test_support::{
    CRASH_EXIT_CODE, TEST_CHILD_DIR_ENV, TEST_CHILD_ROLE_ENV, TEST_CRASH_POINT_ENV,
    TEST_CRASH_TOKEN_ENV,
};
use abdo_journal::{AppendRequest, Journal, StreamId};

use support::{
    exact_invocation_role, received_event, wait_for_children, ExactInvocationRole, ScopedChildren,
    TestDirectory, CRASH_PARENT_GATE_ENV, MIGRATION_PARENT_GATE_ENV, RESTORE_PARENT_GATE_ENV,
};

const INJECTION_COUNT: usize = 10_000;
const LANE_COUNT: usize = 16;
const BATCH_TIMEOUT: Duration = Duration::from_secs(30);
const GLOBAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CHILD_BINARY: &str = env!("CARGO_BIN_EXE_abdo-journal-test-child");

#[derive(Clone, Copy, Debug)]
struct CrashPhase {
    name: &'static str,
    operation: Operation,
    append_commits: bool,
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    Append,
    Checkpoint,
}

const CRASH_PHASES: [CrashPhase; 10] = [
    CrashPhase {
        name: "append.before_begin",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_begin",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_event_insert",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_projection",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_snapshot",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_head_cas",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.before_commit",
        operation: Operation::Append,
        append_commits: false,
    },
    CrashPhase {
        name: "append.after_commit_before_ack",
        operation: Operation::Append,
        append_commits: true,
    },
    CrashPhase {
        name: "checkpoint.before",
        operation: Operation::Checkpoint,
        append_commits: false,
    },
    CrashPhase {
        name: "checkpoint.after",
        operation: Operation::Checkpoint,
        append_commits: false,
    },
];

#[test]
#[ignore = "S105 exact 10,000 process-death/WAL recovery gate; not a power-loss claim"]
fn crash_injection_ten_thousand_process_deaths() {
    assert_hostile_environment_is_rejected();
    let token = forced_parent_token();
    let started = Instant::now();
    let directory = TestDirectory::new("crash-10k");
    let handshake = directory.write_handshake(&token);
    assert_eq!(
        handshake.file_name().and_then(|name| name.to_str()),
        Some(".abdo-journal-test-token")
    );

    let databases: Vec<_> = (0..LANE_COUNT)
        .map(|lane| directory.join(&format!("lane-{lane:02}.sqlite")))
        .collect();
    let streams: Vec<_> = (0..LANE_COUNT)
        .map(|lane| {
            StreamId::try_from_u128(lane as u128 + 1).expect("lane stream ID must be non-zero")
        })
        .collect();
    let mut expected_sequences = [0_u64; LANE_COUNT];
    for lane in 0..LANE_COUNT {
        let mut journal = Journal::open(&databases[lane])
            .expect("each crash lane must initialize and verify cleanly");
        let acknowledged = received_event(1_000_000 + lane as u64);
        let receipt = journal
            .append(AppendRequest::event(streams[lane], None, &acknowledged))
            .expect("each lane needs one acknowledged baseline event");
        expected_sequences[lane] = receipt.stream_sequence;
    }
    let mut reached = vec![false; INJECTION_COUNT];
    let mut phase_counts = [0_usize; CRASH_PHASES.len()];

    for batch_start in (0..INJECTION_COUNT).step_by(LANE_COUNT) {
        assert!(
            started.elapsed() < GLOBAL_TIMEOUT,
            "exact 10,000 process-death gate exceeded its global time bound"
        );
        let mut children = ScopedChildren::with_capacity(LANE_COUNT);
        let mut trials = Vec::with_capacity(LANE_COUNT);
        for (lane, database) in databases.iter().enumerate().take(LANE_COUNT) {
            let trial = batch_start + lane;
            if trial >= INJECTION_COUNT {
                break;
            }
            let phase = CRASH_PHASES[trial % CRASH_PHASES.len()];
            let mut command = ProcessCommand::new(CHILD_BINARY);
            match phase.operation {
                Operation::Append => {
                    command
                        .arg("append")
                        .arg(database)
                        .arg(u128::from(lane as u64 + 1).to_string())
                        .arg(u128::from(trial as u64 + 1).to_string());
                }
                Operation::Checkpoint => {
                    command.arg("checkpoint").arg(database);
                }
            }
            let child = command
                .env_remove(CRASH_PARENT_GATE_ENV)
                .env(TEST_CHILD_ROLE_ENV, "1")
                .env(TEST_CHILD_DIR_ENV, directory.path())
                .env(TEST_CRASH_TOKEN_ENV, &token)
                .env(TEST_CRASH_POINT_ENV, phase.name)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .expect("journal crash child must start");
            children.push(child);
            trials.push((trial, lane, phase));
        }

        let active_lanes = trials.len();
        let statuses = wait_for_children(children.as_mut_slice(), BATCH_TIMEOUT);
        let reaped_children = children.take();
        for (((mut child, status), (trial, lane, phase)), status_index) in reaped_children
            .into_iter()
            .zip(statuses)
            .zip(trials)
            .zip(0_usize..)
        {
            if status.code() != Some(CRASH_EXIT_CODE) {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    pipe.read_to_string(&mut stderr)
                        .expect("failed child stderr must be readable");
                }
                panic!(
                    "crash child {status_index} for trial {trial} at {} exited as {status:?}: {stderr}",
                    phase.name
                );
            }
            reached[trial] = true;
            phase_counts[trial % CRASH_PHASES.len()] += 1;
            if phase.append_commits {
                expected_sequences[lane] += 1;
            }
        }

        for lane in 0..active_lanes {
            let journal = Journal::open(&databases[lane]).expect(
                "writer ownership and full integrity verification must recover after every death",
            );
            let actual = journal
                .head(streams[lane])
                .expect("stream head lookup must succeed")
                .map_or(0, |head| head.sequence);
            assert_eq!(
                actual, expected_sequences[lane],
                "trial batch {batch_start} changed stream {lane} outside the committed outcome"
            );
        }
    }

    assert_eq!(
        reached.iter().filter(|value| **value).count(),
        INJECTION_COUNT
    );
    assert!(reached.into_iter().all(|value| value));
    assert_eq!(
        phase_counts,
        [INJECTION_COUNT / CRASH_PHASES.len(); CRASH_PHASES.len()]
    );
    assert_eq!(
        expected_sequences.iter().sum::<u64>(),
        LANE_COUNT as u64 + (INJECTION_COUNT / CRASH_PHASES.len()) as u64,
        "all acknowledged baselines and only post-commit crash outcomes must remain"
    );

    for lane in 0..LANE_COUNT {
        let journal = Journal::open(&databases[lane]).expect("final recovery reopen must succeed");
        let events = journal
            .read_from(streams[lane], 0)
            .expect("final recovered event scan must succeed");
        assert_eq!(events.len() as u64, expected_sequences[lane]);
        assert!(
            events
                .iter()
                .enumerate()
                .all(|(index, envelope)| envelope.global_sequence == index as u64 + 1),
            "recovered global sequence must be contiguous with no loss"
        );
        let unique_ids: HashSet<_> = events.iter().map(|envelope| envelope.event_id).collect();
        assert_eq!(
            unique_ids.len(),
            events.len(),
            "recovery must not duplicate an event"
        );
        journal.verify().expect("final recovered chain must verify");
    }

    directory.remove();
    println!(
        "S105_RECOVERY_10K injections={INJECTION_COUNT} lanes={LANE_COUNT} phase_counts={phase_counts:?} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

fn forced_parent_token() -> String {
    let child_markers = [
        env::var(TEST_CHILD_ROLE_ENV).ok(),
        env::var(TEST_CHILD_DIR_ENV).ok(),
        env::var(TEST_CRASH_TOKEN_ENV).ok(),
        env::var(TEST_CRASH_POINT_ENV).ok(),
    ];
    let sibling_parent_markers = [
        env::var(MIGRATION_PARENT_GATE_ENV).ok(),
        env::var(RESTORE_PARENT_GATE_ENV).ok(),
    ];
    match exact_invocation_role(
        env::var(CRASH_PARENT_GATE_ENV).ok(),
        &child_markers,
        &sibling_parent_markers,
    )
    .unwrap_or_else(|message| panic!("{message}"))
    {
        ExactInvocationRole::Parent(token) => token,
        ExactInvocationRole::Child => {
            panic!("the integration-test process cannot run as a crash child")
        }
    }
}

fn assert_hostile_environment_is_rejected() {
    let token = "ab".repeat(32);
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
            &[Some("1".to_owned()), None, None, None],
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
            None,
            &[Some("1".to_owned()), None, None, None],
            &[None, None],
        ),
        Err("partial child environment is forbidden")
    );
    assert_eq!(
        exact_invocation_role(
            Some("AB".repeat(32)),
            &[None, None, None, None],
            &[None, None],
        ),
        Err("forced parent gate token is invalid")
    );
    assert_eq!(
        exact_invocation_role(
            Some("ab".repeat(32)),
            &[None, None, None, None],
            &[Some("forged".to_owned()), None],
        ),
        Err("sibling S105 parent gate marker is forbidden")
    );
}
