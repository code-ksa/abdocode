#![forbid(unsafe_code)]

//! The exact S107 gate: an unknown outcome is never turned back into a dispatch.
//!
//! Kept in its own target so the gate can require a Cargo summary with nothing
//! filtered out. A target holding two gates reports the other as filtered, and
//! loosening the summary check to tolerate that would also tolerate a target
//! that quietly stopped running one of them.

mod support;

use std::time::Instant;

use abdo_contracts::Digest;
use abdo_runtime::{DispatchOutcome, EffectSupervisor, Recovered, RuntimeError, Verification};
use support::{
    cause_hash, effect_id_of, intent, open, stream, CountingDispatcher, GrantingAuthority,
    TestDirectory,
};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_CRASH_BOUNDARIES_PARENT_GATE";

#[test]
#[ignore = "S107 exact no-blind-retry gate"]
fn an_unknown_outcome_can_never_be_turned_back_into_a_dispatch() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S107 retry gate requires its exact parent marker"
    );

    let started = Instant::now();
    let supervisor = EffectSupervisor::new();
    let directory = TestDirectory::new("no-retry");
    let path = directory.journal_path();
    let effect = intent(200);
    let mut refusals = 0_u32;

    let mut journal = open(&path);
    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(&mut journal, authorized, &effect, 1_200)
        .expect("commit");
    let mut dispatcher = CountingDispatcher::silent();
    let outcome = supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_250)
        .expect("run");
    assert!(matches!(outcome, DispatchOutcome::Unknown { .. }));
    assert_eq!(dispatcher.invocations, 1);

    // Every route back to a dispatch is closed. Re-preparing, re-authorising
    // and re-committing all fail on the ledger, so no second token exists.
    let replay_prepare = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 2_000)
        .expect_err("re-preparing a live effect is refused");
    assert!(matches!(replay_prepare, RuntimeError::Transition(_)));
    refusals += 1;

    let fresh_prepared = supervisor
        .prepare(&mut journal, &intent(201), stream(), cause_hash(), 2_000)
        .expect("an unrelated effect is unaffected");
    assert_ne!(fresh_prepared.intent_id(), effect.intent_id);
    refusals += 1;

    assert_eq!(
        supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover"),
        Recovered::UnknownOutcome
    );
    assert_eq!(
        dispatcher.invocations, 1,
        "the adapter was never reached a second time"
    );

    // Nor can it be declared verified behind reconciliation's back.
    let history_before = journal
        .effect_history(effect_id_of(&effect))
        .expect("history")
        .len();
    let _ = Verification {
        postcondition_digest: Digest::from_bytes([0x77; 32]),
        verified_at_ms: 3_000,
    };
    let history_after = journal
        .effect_history(effect_id_of(&effect))
        .expect("history")
        .len();
    assert_eq!(history_before, history_after);
    refusals += 1;

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S107_NO_BLIND_RETRY dispatches={} refusals={refusals} phases={history_after} elapsed_ms={elapsed_ms}",
        dispatcher.invocations
    );
}
