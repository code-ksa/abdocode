#![forbid(unsafe_code)]

//! Classified input, bounded mailboxes, and cancellation that reaches the
//! whole tree.

mod support;

use abdo_contracts::{Digest, KernelSessionId, TaskId};
use abdo_runtime::{
    Boundary, ChannelSemantics, ControlPlane, Delivery, Envelope, InputChannel, RuntimeError,
    TaskState, INPUT_CHANNELS,
};

fn session(seed: u128) -> KernelSessionId {
    KernelSessionId::try_from_u128(seed).expect("session id is non-zero")
}

fn task(seed: u128) -> TaskId {
    TaskId::try_from_u128(seed).expect("task id is non-zero")
}

fn envelope(seed: u128, channel: InputChannel, at_ms: u64) -> Envelope {
    Envelope {
        session_id: session(seed),
        channel,
        payload_digest: Digest::from_bytes([channel.tag(); 32]),
        at_ms,
    }
}

#[test]
fn every_channel_declares_whether_it_wakes_and_only_one_does_not() {
    let sleeping: Vec<_> = INPUT_CHANNELS
        .into_iter()
        .filter(|channel| !channel.wakes())
        .collect();
    assert_eq!(
        sleeping,
        vec![InputChannel::SystemInject],
        "waking is a declared property; exactly one channel may add context without restarting anything"
    );
    assert_eq!(
        InputChannel::UserFollowup.applies_at(),
        Boundary::NextTurn,
        "a user reply belongs to the next turn, not the middle of this one"
    );
    for channel in INPUT_CHANNELS {
        assert_eq!(InputChannel::from_tag(channel.tag()), Some(channel));
    }
    assert_eq!(InputChannel::from_tag(0), None);
    assert_eq!(InputChannel::from_tag(7), None);
}

#[test]
fn a_full_mailbox_refuses_rather_than_grows() {
    let mut plane = ControlPlane::new(4).expect("capacity");
    plane.register(session(1)).expect("register");

    for index in 0..4 {
        assert!(matches!(
            plane
                .route(envelope(1, InputChannel::UserFollowup, index))
                .expect("route"),
            Delivery::Accepted { .. }
        ));
    }
    let refused = plane
        .route(envelope(1, InputChannel::UserFollowup, 4))
        .expect("route");
    assert_eq!(refused, Delivery::Backpressure { capacity: 4 });

    let mailbox = plane.mailbox(session(1)).expect("mailbox");
    assert_eq!(mailbox.depth(), 4);
    assert_eq!(mailbox.high_water(), 4);
    assert_eq!(mailbox.refused(), 1);
    assert_eq!(plane.refused(), 1);
}

#[test]
fn a_policy_interrupt_is_never_shed_under_load() {
    // The kernel would otherwise be most likely to miss a withdrawal of
    // permission exactly when it is busiest.
    let mut plane = ControlPlane::new(3).expect("capacity");
    plane.register(session(2)).expect("register");
    for index in 0..3 {
        plane
            .route(envelope(2, InputChannel::UserFollowup, index))
            .expect("route");
    }

    let delivery = plane
        .route(envelope(2, InputChannel::PolicyInterrupt, 10))
        .expect("route");
    assert!(matches!(delivery, Delivery::Accepted { wake: true, .. }));

    let mailbox = plane.mailbox(session(2)).expect("mailbox");
    assert_eq!(mailbox.depth(), 3, "the bound held");
    assert!(
        mailbox.high_water() <= 3,
        "an unsheddable channel grew the queue past its capacity"
    );

    // Exactly the oldest sheddable message made way, and the survivors kept
    // their order. "Three messages, one of them the interrupt" would also hold
    // if the newest had been dropped, or if the queue had been reshuffled.
    let mut seen = Vec::new();
    while let Some(taken) = plane.take(session(2)) {
        seen.push((taken.channel, taken.at_ms));
    }
    assert_eq!(
        seen,
        vec![
            (InputChannel::UserFollowup, 1),
            (InputChannel::UserFollowup, 2),
            (InputChannel::PolicyInterrupt, 10),
        ],
        "the wrong message was displaced, or the survivors were reordered"
    );
}

#[test]
fn a_waking_channel_resumes_a_paused_session_as_part_of_delivery() {
    let mut plane = ControlPlane::new(8).expect("capacity");
    plane.register(session(3)).expect("register");

    plane.pause(session(3));
    assert!(plane.is_paused(session(3)));

    // The one channel that does not wake leaves the session asleep.
    let delivery = plane
        .route(envelope(3, InputChannel::SystemInject, 1))
        .expect("route");
    assert!(matches!(delivery, Delivery::Accepted { wake: false, .. }));
    assert!(
        plane.is_paused(session(3)),
        "context alone restarted a session"
    );

    let delivery = plane
        .route(envelope(3, InputChannel::OperatorSteer, 2))
        .expect("route");
    assert!(matches!(delivery, Delivery::Accepted { wake: true, .. }));
    assert!(
        !plane.is_paused(session(3)),
        "a waking channel left the session asleep"
    );
}

#[test]
fn input_for_an_unregistered_session_is_refused_not_queued_somewhere() {
    let mut plane = ControlPlane::new(4).expect("capacity");
    let error = plane
        .route(envelope(9, InputChannel::UserFollowup, 1))
        .expect_err("unknown session");
    assert!(matches!(error, RuntimeError::UnknownSession { .. }));
    assert_eq!(plane.routed(), 0);
}

#[test]
fn cancelling_a_parent_reaches_every_descendant() {
    let mut plane = ControlPlane::new(4).expect("capacity");
    // A three-level tree: 1 -> {2, 3}, 2 -> {4, 5}, 4 -> {6}
    plane.attach(task(1), task(2)).expect("attach");
    plane.attach(task(1), task(3)).expect("attach");
    plane.attach(task(2), task(4)).expect("attach");
    plane.attach(task(2), task(5)).expect("attach");
    plane.attach(task(4), task(6)).expect("attach");

    let report = plane.cancel_tree(task(1));
    assert_eq!(report.cancelled, 6, "an orphan survived its parent");
    assert_eq!(report.already_cancelled, 0);
    assert_eq!(report.depth, 4);
    for id in 1..=6 {
        assert_eq!(plane.task_state(task(id)), Some(TaskState::Cancelled));
    }

    // Cancelling again reaches the same tasks and counts none of them twice.
    let repeat = plane.cancel_tree(task(1));
    assert_eq!(repeat.cancelled, 0);
    assert_eq!(repeat.already_cancelled, 6);
}

#[test]
fn cancelling_a_subtree_leaves_its_siblings_running() {
    let mut plane = ControlPlane::new(4).expect("capacity");
    plane.attach(task(10), task(11)).expect("attach");
    plane.attach(task(10), task(12)).expect("attach");
    plane.attach(task(11), task(13)).expect("attach");

    let report = plane.cancel_tree(task(11));
    assert_eq!(report.cancelled, 2);
    assert_eq!(plane.task_state(task(12)), Some(TaskState::Running));
    assert_eq!(plane.task_state(task(10)), Some(TaskState::Running));
}

#[test]
fn a_cycle_in_task_parentage_is_refused_when_it_is_built() {
    // A cycle would make cancellation non-terminating. Refusing to build one is
    // cheaper and safer than defending against it on every traversal.
    let mut plane = ControlPlane::new(4).expect("capacity");
    plane.attach(task(20), task(21)).expect("attach");
    plane.attach(task(21), task(22)).expect("attach");

    assert!(matches!(
        plane.attach(task(22), task(20)),
        Err(RuntimeError::Corrupt(_))
    ));
    assert!(matches!(
        plane.attach(task(20), task(20)),
        Err(RuntimeError::Corrupt(_))
    ));
}
