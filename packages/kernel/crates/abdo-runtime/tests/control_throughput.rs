#![forbid(unsafe_code)]

//! The exact S110 gate: sustained routing with nothing lost, cancellation
//! latency measured rather than asserted, and memory that stays bounded.
//!
//! "No loss" is the interesting claim, and it is easy to fake by making the
//! queue unbounded. So the gate makes the numbers add up exactly: everything
//! offered is either accepted or refused, and everything accepted is either
//! drained, still queued, or displaced. A refusal is not a loss; a message that
//! is in none of those buckets is.

mod support;

use std::time::Instant;

use abdo_contracts::{Digest, KernelSessionId, TaskId};
use abdo_runtime::{ChannelSemantics, ControlPlane, Delivery, Envelope, INPUT_CHANNELS};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_CONTROL_PARENT_GATE";
const SESSIONS: u128 = 32;
const MESSAGES: u64 = 200_000;
const MAILBOX_CAPACITY: usize = 64;
/// The floor the sprint asks for. Anything at or above it passes; the measured
/// number is reported so a regression is visible while it still passes.
const REQUIRED_PER_SECOND: u64 = 500;
const CANCEL_TREES: u64 = 2_000;
const CANCEL_P95_CEILING_US: u128 = 100_000;
/// Root, three children, nine grandchildren.
const NODES_PER_TREE: u64 = 13;

#[test]
#[ignore = "S110 exact control-plane throughput and cancellation gate"]
fn routing_loses_nothing_and_cancellation_stays_inside_its_budget() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S110 control gate requires its exact parent marker"
    );

    let mut plane = ControlPlane::new(MAILBOX_CAPACITY).expect("capacity");
    for seed in 1..=SESSIONS {
        plane
            .register(KernelSessionId::try_from_u128(seed).expect("session id"))
            .expect("register");
    }

    // --- routing ---------------------------------------------------------
    let mut offered = 0_u64;
    let mut accepted = 0_u64;
    let mut refused = 0_u64;
    let mut drained = 0_u64;
    let started = Instant::now();

    for index in 0..MESSAGES {
        let seed = (index as u128 % SESSIONS) + 1;
        let session_id = KernelSessionId::try_from_u128(seed).expect("session id");
        let channel = INPUT_CHANNELS[(index as usize) % INPUT_CHANNELS.len()];
        offered += 1;
        match plane
            .route(Envelope {
                session_id,
                channel,
                payload_digest: Digest::from_bytes([channel.tag(); 32]),
                at_ms: index,
            })
            .expect("route")
        {
            Delivery::Accepted { .. } => accepted += 1,
            Delivery::Backpressure { .. } => refused += 1,
        }
        // Drain slower than arrival, so backpressure is genuinely exercised
        // rather than avoided by keeping the queues empty.
        if index % 2 == 0 && plane.take(session_id).is_some() {
            drained += 1;
        }
    }
    let routing_us = started.elapsed().as_micros().max(1);
    let per_second = (u128::from(offered) * 1_000_000 / routing_us) as u64;

    assert_eq!(
        accepted + refused,
        offered,
        "a message was neither accepted nor refused, which is what loss looks like"
    );
    assert!(refused > 0, "backpressure was never exercised");
    assert!(
        per_second >= REQUIRED_PER_SECOND,
        "routing managed {per_second}/s, below the {REQUIRED_PER_SECOND}/s floor"
    );

    // Memory is bounded by construction: no mailbox may ever have exceeded its
    // capacity, no matter how far arrival outran drain.
    let high_water = plane.high_water();
    assert!(
        high_water <= MAILBOX_CAPACITY,
        "a mailbox reached {high_water}, past its capacity of {MAILBOX_CAPACITY}"
    );

    // A mailbox counts two kinds of refusal: the offer it turned away, and the
    // older sheddable message it displaced to make room for an unsheddable one.
    // Only the first reaches the plane-level counter, so the difference is
    // exactly what was displaced.
    let mailbox_refusals: u64 = (1..=SESSIONS)
        .map(|seed| {
            plane
                .mailbox(KernelSessionId::try_from_u128(seed).expect("session id"))
                .expect("mailbox")
                .refused()
        })
        .sum();
    let displaced = mailbox_refusals - refused;

    let mut remaining = 0_u64;
    for seed in 1..=SESSIONS {
        let session_id = KernelSessionId::try_from_u128(seed).expect("session id");
        while plane.take(session_id).is_some() {
            remaining += 1;
        }
    }
    assert_eq!(
        drained + remaining + displaced,
        accepted,
        "accepted messages went missing between the queue and the drain"
    );

    // --- cancellation ----------------------------------------------------
    // A wide, deep tree per iteration, so the measurement is of descending a
    // real tree rather than of touching one node.
    let mut latencies_us = Vec::with_capacity(CANCEL_TREES as usize);
    let mut cancelled_total = 0_usize;
    let mut deepest = 0_usize;
    for tree in 0..CANCEL_TREES {
        let base = tree * 16 + 1_000_000;
        let root = TaskId::try_from_u128(u128::from(base)).expect("task id");
        for child in 1..=3_u64 {
            let child_id = TaskId::try_from_u128(u128::from(base + child)).expect("task id");
            plane.attach(root, child_id).expect("attach");
            for grandchild in 1..=3_u64 {
                let grandchild_id =
                    TaskId::try_from_u128(u128::from(base + child * 4 + grandchild))
                        .expect("task id");
                plane.attach(child_id, grandchild_id).expect("attach");
            }
        }
        let began = Instant::now();
        let report = plane.cancel_tree(root);
        latencies_us.push(began.elapsed().as_micros());
        cancelled_total += report.cancelled;
        deepest = deepest.max(report.depth);
    }

    latencies_us.sort_unstable();
    let p95 = latencies_us[(latencies_us.len() * 95) / 100];
    let worst = *latencies_us.last().expect("at least one cancellation");
    assert!(
        p95 <= CANCEL_P95_CEILING_US,
        "cancellation p95 was {p95}us, past the {CANCEL_P95_CEILING_US}us ceiling"
    );
    assert_eq!(
        cancelled_total as u64,
        CANCEL_TREES * NODES_PER_TREE,
        "a cancellation missed part of its tree"
    );
    assert_eq!(deepest, 3);

    println!(
        "S110_CONTROL offered={offered} accepted={accepted} refused={refused} displaced={displaced} lost=0 per_second={per_second} sessions={SESSIONS} capacity={MAILBOX_CAPACITY} high_water={high_water} cancel_trees={CANCEL_TREES} cancel_nodes={cancelled_total} cancel_p95_us={p95} cancel_max_us={worst} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
