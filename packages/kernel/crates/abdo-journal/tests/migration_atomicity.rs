#![cfg(feature = "test-hooks")]
#![forbid(unsafe_code)]

mod support;

use std::collections::HashSet;
use std::env;
use std::io::Read;
use std::process::{Command as ProcessCommand, Stdio};
use std::time::Instant;

use abdo_journal::test_support::{
    inspect_migration_state, migration_crash_points, MigrationState, CRASH_EXIT_CODE,
    TEST_CHILD_DIR_ENV, TEST_CHILD_ROLE_ENV, TEST_CRASH_POINT_ENV, TEST_CRASH_TOKEN_ENV,
};
use abdo_journal::Journal;

use support::{
    exact_invocation_role, wait_for_child, ExactInvocationRole, ScopedChildren, TestDirectory,
    CHILD_TIMEOUT, CRASH_PARENT_GATE_ENV, MIGRATION_PARENT_GATE_ENV, RESTORE_PARENT_GATE_ENV,
};

const CHILD_BINARY: &str = env!("CARGO_BIN_EXE_abdo-journal-test-child");

#[test]
#[ignore = "S105 atomic migration process-death gate"]
fn migration_interruption_is_atomic() {
    assert_hostile_environment_is_rejected();
    let started = Instant::now();
    let token = forced_parent_token();
    let directory = TestDirectory::new("migration");
    directory.write_handshake(&token);
    let crash_points = migration_crash_points();
    assert_migration_inventory_complete(&crash_points);
    let mut reached = HashSet::with_capacity(crash_points.len());

    for (index, point) in crash_points.iter().map(String::as_str).enumerate() {
        assert!(
            reached.insert(point),
            "migration crash point is duplicated: {point}"
        );
        let database = directory.join(&format!("migration-{index:03}.sqlite"));
        let child = ProcessCommand::new(CHILD_BINARY)
            .arg("migrate")
            .arg(&database)
            .env_remove(MIGRATION_PARENT_GATE_ENV)
            .env(TEST_CHILD_ROLE_ENV, "1")
            .env(TEST_CHILD_DIR_ENV, directory.path())
            .env(TEST_CRASH_TOKEN_ENV, &token)
            .env(TEST_CRASH_POINT_ENV, point)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("migration crash child must start");
        let mut children = ScopedChildren::with_capacity(1);
        children.push(child);
        // Borrow the child in place. Moving it out of `ScopedChildren` would
        // strip the drop guard that kills and reaps anything still alive.
        let child = &mut children.as_mut_slice()[0];
        let status = wait_for_child(child, CHILD_TIMEOUT);
        if status.code() != Some(CRASH_EXIT_CODE) {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                pipe.read_to_string(&mut stderr)
                    .expect("failed migration stderr must be readable");
            }
            panic!("migration child at {point} exited as {status:?}: {stderr}");
        }

        let interrupted_state = inspect_migration_state(&database).unwrap_or_else(|error| {
            panic!("migration at {point} left mixed/corrupt schema: {error:?}")
        });
        assert!(
            matches!(
                interrupted_state,
                MigrationState::Empty
                    | MigrationState::Current
                    | MigrationState::Intermediate { .. }
            ),
            "migration at {point} left a state that is not wholly at any version: {interrupted_state:?}"
        );

        let journal = Journal::open(&database).unwrap_or_else(|error| {
            panic!("migration retry after {point} must succeed: {error:?}")
        });
        drop(journal);
        assert_eq!(
            inspect_migration_state(&database).expect("completed migration must be inspectable"),
            MigrationState::Current,
            "migration retry after {point} did not reach the exact current schema"
        );
        Journal::open(&database)
            .expect("reopening and verifying the current schema must be idempotent");
    }

    assert_eq!(reached.len(), crash_points.len());
    directory.remove();
    println!(
        "S105_MIGRATION_ATOMICITY points={} elapsed_ms={}",
        reached.len(),
        started.elapsed().as_millis()
    );
}

fn assert_migration_inventory_complete(points: &[String]) {
    for required in [
        "migration.before_begin",
        "migration.after_begin",
        "migration.before_record",
        "migration.after_record",
        "migration.before_commit",
        "migration.after_commit",
    ] {
        assert!(
            points.iter().any(|point| point == required),
            "migration crash-point inventory omitted {required}"
        );
    }
    let statement_indices: Vec<usize> = points
        .iter()
        .filter_map(|point| {
            point
                .strip_prefix("migration.after_statement.1.")
                .map(|index| {
                    index
                        .parse()
                        .expect("migration statement index must be decimal")
                })
        })
        .collect();
    assert!(
        !statement_indices.is_empty(),
        "every migration SQL statement needs an interruption point"
    );
    assert_eq!(
        statement_indices,
        (1..=statement_indices.len()).collect::<Vec<_>>(),
        "migration statement interruption points must be contiguous and ordered"
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
        env::var(CRASH_PARENT_GATE_ENV).ok(),
        env::var(RESTORE_PARENT_GATE_ENV).ok(),
    ];
    match exact_invocation_role(
        env::var(MIGRATION_PARENT_GATE_ENV).ok(),
        &child_markers,
        &sibling_parent_markers,
    )
    .unwrap_or_else(|message| panic!("{message}"))
    {
        ExactInvocationRole::Parent(token) => token,
        ExactInvocationRole::Child => {
            panic!("the integration-test process cannot run as a migration child")
        }
    }
}

fn assert_hostile_environment_is_rejected() {
    let token = "cd".repeat(32);
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
            &[None, Some("forged".to_owned()), None, None],
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
            Some("cd".repeat(32)),
            &[None, None, None, None],
            &[None, Some("forged".to_owned())],
        ),
        Err("sibling S105 parent gate marker is forbidden")
    );
}
