#![forbid(unsafe_code)]

//! The exact S106 gate: one million attempted transitions, zero illegitimate
//! commitments.
//!
//! The stream deliberately contains illegal events as well as legal ones. A run
//! that only ever offered legal events would prove the reducer can count, not
//! that it can refuse.

mod support;

use std::time::Instant;

use abdo_contracts::AdmissionEvent;
use abdo_kernel::{reduce, KernelState, ProposalPhase};
use support::{admitted, cancelled, expired, received, refused, validated, Seeded, SplitMix64};

const PARENT_GATE_ENV: &str = "ABDO_REDUCER_TRANSITIONS_1M_PARENT_GATE";
const TRANSITIONS: u64 = 1_000_000;
const LIVE_POOL: u64 = 512;
const GLOBAL_TIMEOUT_MS: u128 = 10 * 60 * 1_000;

#[test]
#[ignore = "S106 exact 1,000,000-transition legitimacy gate"]
fn one_million_transitions_commit_no_illegitimate_effect() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S106 transition gate requires its exact parent marker"
    );

    let started = Instant::now();
    let mut random = SplitMix64::new(0x5106_0000_5106_0000);
    let mut state = KernelState::new();

    // Independent bookkeeping. If the reducer and this counter ever disagree,
    // one of them committed an effect the other never authorised.
    let mut expected_effects: u64 = 0;
    let mut accepted: u64 = 0;
    let mut rejected: u64 = 0;
    let mut observed_effects: u64 = 0;
    let mut seed_counter: u128 = 0;
    let mut clock_ms: u64 = 1_000;
    let mut live: Vec<Seeded> = Vec::with_capacity(LIVE_POOL as usize);

    for step in 0..TRANSITIONS {
        if step % 4_096 == 0 {
            assert!(
                started.elapsed().as_millis() < GLOBAL_TIMEOUT_MS,
                "S106 transition gate exceeded its global time bound"
            );
        }
        clock_ms += 1;

        let admit_new = live.len() < LIVE_POOL as usize || random.below(4) == 0;
        let event: AdmissionEvent = if admit_new {
            seed_counter += 1;
            let seeded = Seeded::new(seed_counter);
            live.push(seeded);
            received(seeded, clock_ms)
        } else {
            let index = random.below(live.len() as u64) as usize;
            let seeded = live[index];
            match random.below(8) {
                0..=2 => validated(seeded, clock_ms),
                3..=4 => admitted(seeded, clock_ms),
                5 => refused(seeded, clock_ms),
                6 => cancelled(seeded, clock_ms),
                _ => expired(seeded, clock_ms),
            }
        };

        // The pre-state phase decides, alone, whether an effect may be owed.
        let target = proposal_of(&event);
        let phase_before = state.proposal(target).map(|record| record.phase);
        let is_admission = matches!(event, AdmissionEvent::Admitted(_));
        let effect_is_legitimate = is_admission && phase_before == Some(ProposalPhase::Validated);

        match reduce(state, &event) {
            Ok(reduction) => {
                accepted += 1;
                observed_effects += reduction.effects.len() as u64;
                assert!(
                    reduction.effects.len() <= 1,
                    "one event can owe at most one effect"
                );
                assert_eq!(
                    reduction.effects.len() == 1,
                    effect_is_legitimate,
                    "an effect appeared on an edge that does not commit one, at step {step}"
                );
                if effect_is_legitimate {
                    expected_effects += 1;
                    let effect = &reduction.effects[0];
                    assert_eq!(effect.proposal_id, target);
                }
                assert_eq!(
                    reduction.state.committed_effects(),
                    expected_effects,
                    "the committed-effect counter drifted at step {step}"
                );
                state = reduction.state;
            }
            Err(rejection) => {
                rejected += 1;
                assert!(
                    !effect_is_legitimate,
                    "a legitimate admission was refused at step {step}: {:?}",
                    rejection.error
                );
                assert_eq!(
                    rejection.state.committed_effects(),
                    expected_effects,
                    "a rejected event changed the committed-effect count at step {step}"
                );
                state = rejection.state;
            }
        }

        // Retire finished proposals so the live pool keeps turning over.
        if step % 64 == 0 {
            live.retain(|seeded| {
                state
                    .proposal(seeded.proposal_id())
                    .is_none_or(|record| !record.phase.is_terminal())
            });
        }
    }

    assert_eq!(accepted + rejected, TRANSITIONS);
    assert!(
        rejected > 0,
        "the stream must exercise refusal, not only acceptance"
    );
    assert!(accepted > 0, "the stream must exercise acceptance");
    assert_eq!(
        observed_effects, expected_effects,
        "the reducer emitted an effect nobody authorised"
    );
    assert_eq!(
        state.committed_effects(),
        state.count_in_phase(ProposalPhase::Admitted),
        "an effect exists if and only if a proposal reached the admitted phase"
    );

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S106_TRANSITIONS_1M transitions={TRANSITIONS} accepted={accepted} rejected={rejected} effects={observed_effects} proposals={} fingerprint={} elapsed_ms={elapsed_ms}",
        state.proposals().len(),
        state.fingerprint().to_hex()
    );
}

fn proposal_of(event: &AdmissionEvent) -> abdo_contracts::ProposalId {
    match event {
        AdmissionEvent::Received(inner) => inner.proposal_id,
        AdmissionEvent::Validated(inner) => inner.proposal_id,
        AdmissionEvent::Admitted(inner) => inner.intent.proposal_id,
        AdmissionEvent::Refused(inner) => inner.proposal_id,
        AdmissionEvent::Expired(inner) => inner.proposal_id,
        AdmissionEvent::Cancelled(inner) => inner.proposal_id,
    }
}
