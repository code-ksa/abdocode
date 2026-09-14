#![forbid(unsafe_code)]

//! The exact S106 determinism gate: one trace, one thousand folds, one
//! fingerprint.
//!
//! Ignored by default and admitted only by an exact parent marker, so a bare
//! `cargo test` cannot report this gate as passed without the harness that
//! bounds and checks it.

mod support;

use std::time::Instant;

use abdo_kernel::{reduce_all, KernelState};
use support::interleaved_trace;

const PARENT_GATE_ENV: &str = "ABDO_REDUCER_DETERMINISM_PARENT_GATE";
const REPLAYS: usize = 1_000;
const PROPOSALS: u128 = 256;

/// The fingerprint the trace must produce, on every machine, in every build.
///
/// Pinned rather than merely self-consistent: a thousand identical folds inside
/// one process would still agree if the encoding silently changed, so agreeing
/// with each other proves nothing about stability over time. This constant is
/// what makes the gate a regression test instead of a tautology.
const EXPECTED_FINGERPRINT: &str =
    "d9193c48991b31ce762f2edcd64d37a2a3e9d6abc8731df718a81d405ce18a25";

#[test]
#[ignore = "S106 exact 1,000-replay determinism gate"]
fn folding_one_trace_one_thousand_times_yields_one_fingerprint() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S106 determinism gate requires its exact parent marker"
    );

    let events = interleaved_trace(PROPOSALS);
    let started = Instant::now();

    let mut fingerprints = Vec::with_capacity(REPLAYS);
    let mut effect_counts = Vec::with_capacity(REPLAYS);
    for _ in 0..REPLAYS {
        let reduction =
            reduce_all(KernelState::new(), &events).expect("the seeded trace is legitimate");
        fingerprints.push(reduction.state.fingerprint());
        effect_counts.push(reduction.effects.len());
    }

    let first = fingerprints[0];
    assert!(
        fingerprints.iter().all(|value| *value == first),
        "one trace must fold to one fingerprint"
    );
    assert!(
        effect_counts.iter().all(|value| *value == effect_counts[0]),
        "one trace must owe one set of effects"
    );
    assert_eq!(
        first.to_hex(),
        EXPECTED_FINGERPRINT,
        "the canonical encoding drifted; bump CANONICAL_STATE_VERSION deliberately or fix the change"
    );

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S106_DETERMINISM replays={REPLAYS} events={} proposals={PROPOSALS} effects={} fingerprint={} elapsed_ms={elapsed_ms}",
        events.len(),
        effect_counts[0],
        first.to_hex()
    );
}
