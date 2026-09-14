#![forbid(unsafe_code)]

//! The exact S107 gate: a crash at every lifecycle boundary, and the adapter
//! still runs at most once.
//!
//! The crash is modelled by abandoning every in-memory handle and reopening the
//! journal from disk, which is what a restarted kernel actually sees. SQLite
//! surviving real process death is already settled by the S105 gate and ten
//! thousand killed children; what is unproven, and what this gate measures, is
//! the protocol on top: that resuming from each boundary never dispatches a
//! second time and never reports an unresolved effect as finished.
//!
//! Each boundary must be a state the gate can actually stop at. It proves that
//! by requiring the situations it observes to be distinct: two boundaries that
//! always produce the same recovery verdict, the same adapter count and the
//! same ledger depth are one boundary wearing two names, and this gate fails
//! rather than flattering itself.

mod support;

use std::collections::BTreeSet;
use std::time::Instant;

use abdo_runtime::{EffectSupervisor, Recovered};
use support::{
    cause_hash, effect_id_of, intent, open, stream, CountingDispatcher, GrantingAuthority,
    TestDirectory,
};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_CRASH_BOUNDARIES_PARENT_GATE";

/// Every point at which the kernel can lose its memory.
const BOUNDARIES: [&str; 7] = [
    "before-prepare",
    "after-prepare",
    "after-authorize",
    "after-dispatch-commit",
    "after-adapter",
    "after-started",
    "after-settled",
];

/// How many times the adapter may run, per boundary, over the whole recovery.
const AT_MOST_ONCE: u32 = 1;

/// A short name for what recovery concluded.
fn verdict(recovered: &Recovered) -> &'static str {
    match recovered {
        Recovered::Fresh => "fresh",
        Recovered::Resumable { .. } => "resumable",
        Recovered::UnknownOutcome => "unknown",
        Recovered::AwaitingVerification { .. } => "awaiting",
        Recovered::Reconciled => "reconciled",
        Recovered::Escalated => "escalated",
        Recovered::AwaitingApproval => "awaiting-approval",
        Recovered::Refused => "refused",
        Recovered::Complete => "complete",
    }
}

#[test]
#[ignore = "S107 exact crash-at-every-boundary gate"]
fn a_crash_at_every_boundary_never_dispatches_twice() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S107 crash gate requires its exact parent marker"
    );

    let started = Instant::now();
    let supervisor = EffectSupervisor::new();
    let mut resumed_without_dispatch = 0_u32;
    let mut unknown_outcomes = 0_u32;
    let mut awaiting = 0_u32;
    // (verdict, adapter runs before the crash, durable phases). Two boundaries
    // that agree on all three are the same boundary.
    let mut signatures: BTreeSet<(&str, u32, usize)> = BTreeSet::new();

    for (index, boundary) in BOUNDARIES.iter().enumerate() {
        let directory = TestDirectory::new(&format!("crash-{index}"));
        let path = directory.journal_path();
        let effect = intent(100 + index as u128);
        let mut adapter_runs = 0_u32;

        // --- the run that gets interrupted -------------------------------
        {
            let mut journal = open(&path);
            if *boundary != "before-prepare" {
                let prepared = supervisor
                    .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
                    .expect("prepare");
                if *boundary != "after-prepare" {
                    support::clear(&mut journal, &effect, 1_050);
                    let authorized = supervisor
                        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
                        .expect("authorize");
                    if *boundary != "after-authorize" {
                        let dispatching = supervisor
                            .commit_dispatch(&mut journal, authorized, &effect, 1_200)
                            .expect("commit dispatch");
                        if *boundary != "after-dispatch-commit" {
                            // The adapter runs here and nothing is written yet.
                            // Stopping between these two calls is the boundary
                            // a single fused call could never reach, and it is
                            // why they are two calls.
                            let mut dispatcher = if *boundary == "after-settled" {
                                CountingDispatcher::settling(1_300)
                            } else {
                                CountingDispatcher::silent()
                            };
                            let report = supervisor.invoke(&dispatching, &effect, &mut dispatcher);
                            adapter_runs += dispatcher.invocations;
                            if *boundary != "after-adapter" {
                                supervisor
                                    .record_started(
                                        &mut journal,
                                        dispatching,
                                        &effect,
                                        report,
                                        1_250,
                                    )
                                    .expect("record started");
                            }
                        }
                    }
                }
            }
            // Every handle is dropped here. Nothing in memory survives.
        }

        // --- the restarted kernel ----------------------------------------
        let mut journal = open(&path);
        let recovered = supervisor
            .recover(&journal, effect.intent_id)
            .expect("recovery reads the ledger");

        // Recovery is a read. Ask twice, before resuming anything, and the
        // answer and the ledger must both be unchanged: a recovery that
        // advanced the ledger would be one that can double-dispatch by being
        // run twice.
        let before = journal
            .effect_history(effect_id_of(&effect))
            .expect("history")
            .len();
        let again = supervisor
            .recover(&journal, effect.intent_id)
            .expect("second recovery");
        let after = journal
            .effect_history(effect_id_of(&effect))
            .expect("history")
            .len();
        assert_eq!(before, after, "recovery mutated the ledger");
        assert_eq!(
            std::mem::discriminant(&recovered),
            std::mem::discriminant(&again),
            "recovery is not stable at boundary {boundary}"
        );

        signatures.insert((verdict(&recovered), adapter_runs, before));

        match recovered {
            Recovered::Fresh => {
                assert_eq!(*boundary, "before-prepare");
                assert_eq!(adapter_runs, 0);
                // Nothing durable: starting over is safe and touches the world
                // for the first time.
                let prepared = supervisor
                    .prepare(&mut journal, &effect, stream(), cause_hash(), 2_000)
                    .expect("prepare after a clean crash");
                support::clear(&mut journal, &effect, 2_050);
                let authorized = supervisor
                    .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 2_100)
                    .expect("authorize");
                let dispatching = supervisor
                    .commit_dispatch(&mut journal, authorized, &effect, 2_200)
                    .expect("commit");
                let mut dispatcher = CountingDispatcher::settling(2_300);
                supervisor
                    .run(&mut journal, dispatching, &effect, &mut dispatcher, 2_250)
                    .expect("run");
                adapter_runs += dispatcher.invocations;
                resumed_without_dispatch += 1;
            }
            Recovered::Resumable { phase } => {
                // Durable, but nothing observable happened. Continuing is safe
                // and must reach the adapter exactly once in total.
                assert!(
                    matches!(
                        phase,
                        abdo_runtime::EffectPhase::Prepared | abdo_runtime::EffectPhase::Authorized
                    ),
                    "resumable must mean nothing observable happened, saw {phase:?}"
                );
                assert_eq!(
                    adapter_runs, 0,
                    "the adapter cannot have run before {phase:?}"
                );
                resumed_without_dispatch += 1;
            }
            Recovered::UnknownOutcome => {
                // The adapter may or may not have run. The kernel must not
                // guess, and there is no API that turns this into a dispatch.
                unknown_outcomes += 1;
                let history = journal
                    .effect_history(effect_id_of(&effect))
                    .expect("history");
                assert!(
                    history.iter().any(|record| record.phase_tag.get()
                        == abdo_runtime::EffectPhase::Dispatching.tag()),
                    "an unknown outcome must be backed by a durable dispatch commitment"
                );
                assert!(
                    adapter_runs <= AT_MOST_ONCE,
                    "the adapter ran {adapter_runs} times before the crash"
                );
            }
            Recovered::AwaitingVerification { settlement } => {
                assert_eq!(*boundary, "after-settled");
                assert_eq!(adapter_runs, AT_MOST_ONCE);
                let history = journal
                    .effect_history(effect_id_of(&effect))
                    .expect("history");
                assert!(
                    !history.iter().any(|record| record.phase_tag.get()
                        == abdo_runtime::EffectPhase::Verified.tag()),
                    "a settled effect must not already look verified"
                );
                assert_eq!(settlement.settled_at_ms, 1_300);
                awaiting += 1;
            }
            // Reconciliation has not run in this gate, and this gate never asks
            // anybody, so no boundary can end reconciled, escalated, completed,
            // or anywhere in the approval states.
            Recovered::Reconciled
            | Recovered::Escalated
            | Recovered::Complete
            | Recovered::AwaitingApproval
            | Recovered::Refused => {
                panic!("no boundary in this gate reaches {recovered:?}")
            }
        }

        // Whatever happened, the world was touched at most once.
        assert!(
            adapter_runs <= AT_MOST_ONCE,
            "boundary {boundary} dispatched {adapter_runs} times"
        );
    }

    assert!(resumed_without_dispatch > 0);
    assert!(
        unknown_outcomes > 0,
        "the gate must exercise the unknown case"
    );
    assert!(awaiting > 0);

    // The claim of seven boundaries has to survive inspection: seven distinct
    // observable situations, not seven names for five.
    assert_eq!(
        signatures.len(),
        BOUNDARIES.len(),
        "two declared boundaries are indistinguishable, so the gate covers fewer than it claims: {signatures:?}"
    );

    // ------------------------------------------------------------------
    // Two hosts resume the same effect. Exactly one dispatches it.
    // ------------------------------------------------------------------
    //
    // Folded into this test rather than added beside it, because the gate pins
    // `0 filtered out` on this target — which is the rule that stops anybody
    // adding a test here that never runs under the gate. Two tests in one
    // gated target would have been one test the gate measures and one it
    // silently skips.
    //
    // The property itself is what S134 needed. An effect that crashed between
    // authorisation and dispatch used to be stranded forever: the ledger said
    // `Resumable` — durable, nothing observable happened, continuing is safe —
    // and nothing anywhere continued it. Letting a host re-enter the
    // pre-dispatch doors raises the obvious question, and this answers it:
    // `Dispatching` is written FRESH, and UNIQUE(intent_id, phase_tag) is a
    // barrier the database holds rather than a check in code a crash can skip.
    // So no lease is needed to make resumption safe, and one layered on top
    // would be a second answer to a question the schema already answers.
    let directory = TestDirectory::new("resume-race");
    let path = directory.path().join("effects.sqlite");
    let supervisor = EffectSupervisor::new();
    let authority = GrantingAuthority;
    let effect = intent(1);
    let stream_id = stream();
    let cause = cause_hash();

    // One host authorises and then dies before committing a dispatch.
    {
        let mut journal = open(&path);
        let prepared = supervisor
            .prepare(&mut journal, &effect, stream_id, cause, 1_000)
            .expect("prepare");
        // Clearance first. S114 deleted the `Prepared -> Authorized` edge so
        // that policy could not be walked around, and a resume has to respect
        // the same graph the fresh path does.
        support::clear(&mut journal, &effect, 1_050);
        supervisor
            .authorize(&mut journal, prepared, &effect, &authority, 1_100)
            .expect("authorize");
    }

    // The ledger agrees that continuing is safe. Recovery is a READ, and the
    // borrow says so — this file already asserts elsewhere that recovery does
    // not move the ledger, and taking it by shared reference is that assertion
    // made by the compiler instead.
    {
        let journal = open(&path);
        let recovered = supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover");
        assert!(
            matches!(recovered, Recovered::Resumable { .. }),
            "an effect killed before dispatch must be resumable, saw {}",
            verdict(&recovered)
        );
    }

    // Two hosts resume it. Both walk the pre-dispatch doors; both reach the
    // barrier; the adapter is counted across both.
    let mut adapter_runs = 0_u32;
    let mut dispatched = 0_u32;
    let mut refused = 0_u32;

    for host in 0..2_u32 {
        let mut journal = open(&path);
        let prepared = supervisor
            .resume_prepare(
                &mut journal,
                &effect,
                stream_id,
                cause,
                2_000 + u64::from(host),
            )
            .expect("a durable prepare must not block a resume");
        support::resume_clear(&mut journal, &effect, 2_050 + u64::from(host));
        let authorized = supervisor
            .resume_authorize(
                &mut journal,
                prepared,
                &effect,
                &authority,
                2_100 + u64::from(host),
            )
            .expect("a durable authorisation must not block a resume");

        let mut dispatcher = CountingDispatcher::settling(2_300 + u64::from(host));
        match supervisor.dispatch(
            &mut journal,
            authorized,
            &effect,
            &mut dispatcher,
            2_200 + u64::from(host),
        ) {
            Ok(_) => dispatched += 1,
            Err(_) => refused += 1,
        }
        adapter_runs += dispatcher.invocations;
    }

    // The property that must hold however this binary was built: at most one
    // host crosses, both get an answer, and the adapter runs at most once.
    //
    // Written this way because the first version asserted `dispatched == 1`
    // and passed locally under `effectful-dispatch` while failing under the
    // gate, which runs S107 with `test-hooks` alone — a host built without the
    // dispatch feature declines every dispatch BY NAME, so zero crossings is
    // the correct behaviour there. A test that assumes the features its author
    // happened to enable is measuring the author's shell.
    assert!(
        dispatched <= 1,
        "{dispatched} hosts crossed the barrier; it exists so that at most one can"
    );
    assert_eq!(
        dispatched + refused,
        2,
        "both resuming hosts must get an answer, never silence"
    );
    assert!(
        adapter_runs <= AT_MOST_ONCE,
        "the adapter ran {adapter_runs} times across two resuming hosts"
    );

    // And where dispatch is compiled in, "at most one" has to be exactly one.
    // Otherwise the barrier would be satisfied by nothing ever getting
    // through, which is the cheapest way to pass this and proves nothing.
    #[cfg(feature = "effectful-dispatch")]
    {
        assert_eq!(dispatched, 1, "exactly one host may cross the barrier");
        assert_eq!(
            refused, 1,
            "the other must be refused, not silently ignored"
        );
        assert_eq!(
            adapter_runs, AT_MOST_ONCE,
            "the adapter must run exactly once in total"
        );
    }

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S107_CRASH_BOUNDARIES boundaries={} distinct_states={} resumable={resumed_without_dispatch} unknown={unknown_outcomes} awaiting={awaiting} max_dispatches={AT_MOST_ONCE} elapsed_ms={elapsed_ms}",
        BOUNDARIES.len(),
        signatures.len()
    );
}
