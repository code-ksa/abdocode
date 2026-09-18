#![forbid(unsafe_code)]

//! The exact S109 gate: many sessions driven through many steps, with the
//! configuration never moving under a live request and never a second writer.

mod support;

use std::time::Instant;

use abdo_contracts::{Digest, KernelSessionId, PolicyHandle, StateHandle};
use abdo_journal::{ChainHash, StreamId};
use abdo_kernel::Fingerprint;
use abdo_runtime::{RuntimeError, SessionConfig, SessionRegistry};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_SESSION_PARENT_GATE";
const SESSIONS: u128 = 64;
const TURNS: u64 = 4;
const STEPS_PER_TURN: u64 = 4;
const ROUNDS_PER_STEP: u64 = 2;

/// The aggregate fingerprint the whole run must produce.
///
/// Pinned, because sixty-four sessions agreeing with each other inside one
/// process would agree just as well if the encoding changed underneath them.
const EXPECTED_RUN_FINGERPRINT: &str =
    "ea612b179f72623574a743abf74b7c27bc0220ff46ba7a1c38a64d09e6a4b4d7";

fn config(fill: u8) -> SessionConfig {
    SessionConfig {
        config_digest: Digest::from_bytes([fill; 32]),
        policy: PolicyHandle::from_bytes([fill ^ 0x0f; 32]),
        policy_digest: Digest::from_bytes([fill ^ 0xf0; 32]),
    }
}

#[test]
#[ignore = "S109 exact session actor and snapshot gate"]
fn sessions_step_deterministically_with_one_writer_each() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S109 session gate requires its exact parent marker"
    );

    let started = Instant::now();
    let mut registry = SessionRegistry::new();
    let mut snapshots = 0_u64;
    let mut rounds = 0_u64;
    let mut steps = 0_u64;
    let mut turns = 0_u64;
    let mut double_writers = 0_u64;
    let mut config_applied_mid_step = 0_u64;
    let mut fingerprints = std::collections::BTreeSet::new();
    // A monotone stage counter, because an arithmetic fill can collide on
    // consecutive steps and then the boundary assertion silently proves nothing.
    let mut stage_counter = 0_u64;
    let mut staged_changes = 0_u64;
    let mut chained = Fingerprint::of(b"S109/run/1");

    for seed in 1..=SESSIONS {
        let session_id = KernelSessionId::try_from_u128(seed).expect("session id");
        let stream_id = StreamId::try_from_u128(seed).expect("stream id");
        let mut actor = registry
            .open(
                session_id,
                stream_id,
                config(0x10),
                StateHandle::from_bytes([0x20; 32]),
                Digest::from_bytes([0x30; 32]),
                ChainHash::from_bytes([0x40; 32]),
            )
            .expect("a fresh session opens");

        // A second writer must be impossible, not merely unlikely.
        match registry.open(
            session_id,
            stream_id,
            config(0x10),
            StateHandle::from_bytes([0x20; 32]),
            Digest::from_bytes([0x30; 32]),
            ChainHash::from_bytes([0x40; 32]),
        ) {
            Err(RuntimeError::SessionAlreadyOpen { .. }) => {}
            _ => double_writers += 1,
        }

        for _turn in 1..=TURNS {
            actor.begin_turn().expect("turn");
            turns += 1;
            for _step in 1..=STEPS_PER_TURN {
                // Stage a new configuration in the middle of the previous step,
                // which is exactly when a careless implementation would apply it.
                stage_counter += 1;
                let staged = config((stage_counter % 250 + 3) as u8);
                actor.stage_config(staged);
                let before_boundary = actor.active_config();
                // Staging must not have moved anything yet.
                assert!(actor.has_staged_config());
                if before_boundary != staged {
                    staged_changes += 1;
                }

                actor.begin_step().expect("step");
                steps += 1;
                let at_step_start = actor.active_config();

                for round in 1..=ROUNDS_PER_STEP {
                    if round > 1 {
                        actor.begin_round().expect("round");
                        rounds += 1;
                    }
                    let snapshot = actor.snapshot(1_000 + snapshots);
                    if snapshot.config != at_step_start {
                        config_applied_mid_step += 1;
                    }
                    let fingerprint = snapshot.fingerprint();
                    fingerprints.insert(fingerprint.to_hex());
                    chained = Fingerprint::of(
                        &[
                            chained.as_bytes().as_slice(),
                            fingerprint.as_bytes().as_slice(),
                        ]
                        .concat(),
                    );
                    snapshots += 1;
                }

                // The staged configuration arrived at the boundary, and nowhere
                // else. Asserting that it *differs* from the previous one would
                // be a weaker claim that also happens to be flaky: two unrelated
                // fills can collide, and then the assertion passes by luck.
                assert_eq!(
                    at_step_start, staged,
                    "the staged configuration did not take effect at the step boundary"
                );
                assert!(
                    !actor.has_staged_config(),
                    "the staged configuration outlived its boundary"
                );
            }
        }
        registry.close(actor);
    }

    assert_eq!(registry.open_sessions(), 0, "a session outlived its actor");
    assert_eq!(double_writers, 0, "a session admitted a second writer");
    assert_eq!(
        config_applied_mid_step, 0,
        "a configuration changed under a live step"
    );
    assert!(
        staged_changes > 0,
        "no staged configuration actually differed from the one in force"
    );
    assert_eq!(
        fingerprints.len() as u64,
        snapshots,
        "two different steps produced the same snapshot fingerprint"
    );
    assert_eq!(
        chained.to_hex(),
        EXPECTED_RUN_FINGERPRINT,
        "the snapshot encoding drifted; bump SNAPSHOT_VERSION deliberately or fix the change"
    );

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S109_SESSION_STEPS sessions={SESSIONS} turns={turns} steps={steps} rounds={rounds} snapshots={snapshots} distinct_fingerprints={} staged_changes={staged_changes} double_writers=0 config_applied_mid_step=0 fingerprint={} elapsed_ms={elapsed_ms}",
        fingerprints.len(),
        chained.to_hex()
    );
}
