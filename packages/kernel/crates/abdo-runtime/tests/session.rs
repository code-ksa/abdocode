#![forbid(unsafe_code)]

//! One writer, one cursor, and a configuration that moves only at step
//! boundaries.

mod support;

use abdo_contracts::{Digest, KernelSessionId, PolicyHandle, StateHandle};
use abdo_journal::{ChainHash, StreamId};
use abdo_runtime::{RuntimeError, SessionConfig, SessionRegistry, StepCursor, SNAPSHOT_VERSION};

fn session(seed: u128) -> KernelSessionId {
    KernelSessionId::try_from_u128(seed).expect("session id is non-zero")
}

fn stream(seed: u128) -> StreamId {
    StreamId::try_from_u128(seed).expect("stream id is non-zero")
}

fn config(fill: u8) -> SessionConfig {
    SessionConfig {
        config_digest: Digest::from_bytes([fill; 32]),
        policy: PolicyHandle::from_bytes([fill ^ 0x0f; 32]),
        policy_digest: Digest::from_bytes([fill ^ 0xf0; 32]),
    }
}

fn open(registry: &mut SessionRegistry, seed: u128) -> abdo_runtime::SessionActor {
    registry
        .open(
            session(seed),
            stream(seed),
            config(0x11),
            StateHandle::from_bytes([0x22; 32]),
            Digest::from_bytes([0x33; 32]),
            ChainHash::from_bytes([0x44; 32]),
        )
        .expect("a fresh session opens")
}

#[test]
fn a_session_admits_exactly_one_writer() {
    let mut registry = SessionRegistry::new();
    let actor = open(&mut registry, 1);
    assert_eq!(registry.open_sessions(), 1);
    assert!(registry.is_open(session(1)));

    let second = registry.open(
        session(1),
        stream(1),
        config(0x55),
        StateHandle::from_bytes([0x22; 32]),
        Digest::from_bytes([0x33; 32]),
        ChainHash::from_bytes([0x44; 32]),
    );
    assert!(matches!(
        second,
        Err(RuntimeError::SessionAlreadyOpen { .. })
    ));

    // Closing consumes the actor, so no writer can outlive its registry entry.
    registry.close(actor);
    assert_eq!(registry.open_sessions(), 0);
    let reopened = registry.open(
        session(1),
        stream(1),
        config(0x55),
        StateHandle::from_bytes([0x22; 32]),
        Digest::from_bytes([0x33; 32]),
        ChainHash::from_bytes([0x44; 32]),
    );
    assert!(reopened.is_ok(), "a closed session can be reopened");
}

#[test]
fn a_staged_configuration_takes_effect_at_the_next_step_and_not_before() {
    let mut registry = SessionRegistry::new();
    let mut actor = open(&mut registry, 2);
    actor.begin_turn().expect("turn");
    actor.begin_step().expect("step");

    let before = actor.snapshot(1_000);
    assert_eq!(before.config, config(0x11));

    actor.stage_config(config(0x99));
    assert!(actor.has_staged_config());

    // The step already in flight is untouched, and so is a snapshot of it.
    let during = actor.snapshot(1_100);
    assert_eq!(during.config, config(0x11), "a live step changed its rules");
    assert_eq!(actor.active_config(), config(0x11));

    // A retry of the same step is still the same step.
    actor.begin_round().expect("round");
    assert_eq!(
        actor.snapshot(1_150).config,
        config(0x11),
        "a retry applied a configuration the original request never saw"
    );
    assert!(
        actor.has_staged_config(),
        "the staged change was consumed by a round"
    );

    // Only the next step boundary moves the rules.
    actor.begin_step().expect("step");
    assert_eq!(actor.active_config(), config(0x99));
    assert!(!actor.has_staged_config());
    assert_eq!(actor.snapshot(1_200).config, config(0x99));
}

#[test]
fn turn_step_and_round_count_what_their_names_say() {
    let mut registry = SessionRegistry::new();
    let mut actor = open(&mut registry, 3);
    assert_eq!(actor.cursor(), StepCursor::default());

    assert_eq!(
        actor.begin_turn().expect("turn"),
        StepCursor {
            turn: 1,
            step: 0,
            round: 0
        }
    );
    assert_eq!(
        actor.begin_step().expect("step"),
        StepCursor {
            turn: 1,
            step: 1,
            round: 1
        }
    );
    assert_eq!(
        actor.begin_round().expect("round"),
        StepCursor {
            turn: 1,
            step: 1,
            round: 2
        }
    );
    assert_eq!(
        actor.begin_step().expect("step"),
        StepCursor {
            turn: 1,
            step: 2,
            round: 1
        },
        "a new step restarts the round count"
    );
    assert_eq!(
        actor.begin_turn().expect("turn"),
        StepCursor {
            turn: 2,
            step: 0,
            round: 0
        },
        "a new turn restarts the step count"
    );
}

#[test]
fn a_step_outside_a_turn_and_a_round_outside_a_step_are_refused() {
    let mut registry = SessionRegistry::new();
    let mut actor = open(&mut registry, 4);
    assert!(matches!(actor.begin_step(), Err(RuntimeError::Corrupt(_))));
    actor.begin_turn().expect("turn");
    assert!(matches!(actor.begin_round(), Err(RuntimeError::Corrupt(_))));
}

#[test]
fn the_snapshot_fingerprint_depends_on_everything_it_reports() {
    let mut registry = SessionRegistry::new();
    let mut actor = open(&mut registry, 5);
    actor.begin_turn().expect("turn");
    actor.begin_step().expect("step");

    let snapshot = actor.snapshot(2_000);
    let repeated = actor.snapshot(2_000);
    assert_eq!(
        snapshot.fingerprint(),
        repeated.fingerprint(),
        "the same step fingerprinted differently twice"
    );
    assert_eq!(
        u16::from_le_bytes([snapshot.canonical_bytes()[0], snapshot.canonical_bytes()[1]]),
        SNAPSHOT_VERSION
    );

    // Every field is load-bearing: change one and the fingerprint must move.
    let later = actor.snapshot(2_001);
    assert_ne!(snapshot.fingerprint(), later.fingerprint());

    actor.begin_round().expect("round");
    let next_round = actor.snapshot(2_000);
    assert_ne!(
        snapshot.fingerprint(),
        next_round.fingerprint(),
        "a different round produced the same fingerprint"
    );

    actor.set_state(
        StateHandle::from_bytes([0x77; 32]),
        Digest::from_bytes([0x88; 32]),
        ChainHash::from_bytes([0x99; 32]),
    );
    assert_ne!(
        next_round.fingerprint(),
        actor.snapshot(2_000).fingerprint()
    );
}

#[test]
fn a_snapshot_is_a_value_and_survives_the_actor_moving_on() {
    // The engine may hold a snapshot for as long as a model call takes. If the
    // actor could edit it in place, the engine would be reasoning about a step
    // that no longer exists.
    let mut registry = SessionRegistry::new();
    let mut actor = open(&mut registry, 6);
    actor.begin_turn().expect("turn");
    actor.begin_step().expect("step");
    let held = actor.snapshot(3_000);
    let held_bytes = held.canonical_bytes();

    actor.stage_config(config(0xaa));
    actor.begin_step().expect("step");
    actor.set_state(
        StateHandle::from_bytes([0xbb; 32]),
        Digest::from_bytes([0xcc; 32]),
        ChainHash::from_bytes([0xdd; 32]),
    );

    assert_eq!(held.canonical_bytes(), held_bytes);
    assert_eq!(held.cursor.step, 1);
    assert_eq!(held.config, config(0x11));
}
