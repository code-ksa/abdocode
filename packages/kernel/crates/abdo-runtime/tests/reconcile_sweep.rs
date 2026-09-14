#![forbid(unsafe_code)]

//! The exact S108 gate: a mixed population reconciled twice, with zero
//! dispatches and nothing lost.
//!
//! The population is deliberately mixed. A sweep over effects that were all
//! stuck the same way would prove the reconciler can handle one case; the
//! interesting failure is a sweep that quietly drops a state it did not expect,
//! and only a mixture can catch that.

mod support;

use std::time::Instant;

use abdo_contracts::{Digest, IntentId};
use abdo_runtime::{
    CompensationPolicy, EffectPhase, EffectSupervisor, ObservedOutcome, OutcomeOracle, Reconciler,
    ReconciliationContext, Settlement,
};
use support::{
    cause_hash, effect_id_of, intent, open, stream, CountingDispatcher, GrantingAuthority,
    TestDirectory,
};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_RECONCILE_PARENT_GATE";
const POPULATION: u128 = 600;

/// Answers for one in three effects, and shrugs at the rest.
///
/// A gate whose oracle always answered would never exercise escalation, which
/// is the only branch where the kernel has to admit it does not know.
#[derive(Clone, Copy, Debug)]
struct PartialOracle;

impl OutcomeOracle for PartialOracle {
    fn observe(&self, intent_id: IntentId, _operation_digest: Digest) -> Option<ObservedOutcome> {
        match intent_id.get() % 3 {
            0 => Some(ObservedOutcome::Happened(Settlement {
                outcome_digest: Digest::from_bytes([0x5c; 32]),
                settled_at_ms: 5_000,
            })),
            1 => Some(ObservedOutcome::DidNotHappen {
                observed_at_ms: 5_000,
            }),
            _ => None,
        }
    }
}

/// Compensates a fixed slice of what ran.
#[derive(Clone, Copy, Debug)]
struct EveryOtherCompensates;

impl CompensationPolicy for EveryOtherCompensates {
    fn requires_compensation(&self, intent_id: IntentId, _settlement: Settlement) -> bool {
        // Seeded intent identifiers are always odd, so a predicate on an even
        // divisor would never fire and the branch would go untested while the
        // gate still reported green. Odd multiples of three it is.
        intent_id.get() % 6 == 3
    }
}

#[test]
#[ignore = "S108 exact reconciliation sweep gate"]
fn a_mixed_population_reconciles_once_and_never_dispatches() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S108 reconciliation gate requires its exact parent marker"
    );

    let started = Instant::now();
    let directory = TestDirectory::new("sweep");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();

    // One dispatcher for the whole gate. Its counter is the measurement: the
    // reconciler is never handed it, so if this number moves during a sweep,
    // something reached the world through a path that should not exist.
    let mut dispatcher = CountingDispatcher::silent();
    let mut settled_dispatcher = CountingDispatcher::settling(1_300);
    let mut unresolved_count = 0_u32;
    let mut finished_count = 0_u32;

    for seed in 1..=POPULATION {
        let effect = intent(10_000 + seed);
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
        if seed % 4 == 0 {
            // A quarter of the population finishes normally and must be left
            // untouched by every sweep.
            supervisor
                .run(
                    &mut journal,
                    dispatching,
                    &effect,
                    &mut settled_dispatcher,
                    1_250,
                )
                .expect("run");
            finished_count += 1;
        } else {
            supervisor
                .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_250)
                .expect("run");
            unresolved_count += 1;
        }
    }

    let dispatches_before_sweep = dispatcher.invocations + settled_dispatcher.invocations;
    assert_eq!(dispatches_before_sweep as u128, POPULATION);

    let outstanding_before = reconciler.outstanding(&journal).expect("outstanding");
    assert_eq!(
        outstanding_before
            .iter()
            .filter(|entry| entry.unconfirmed)
            .count() as u32,
        unresolved_count,
        "every unconfirmed action must be visible before reconciliation"
    );

    let digest = intent(10_001).operation_digest;
    let first = reconciler
        .sweep(
            &mut journal,
            &supervisor,
            &ReconciliationContext {
                oracle: &PartialOracle,
                policy: &EveryOtherCompensates,
                operation_digest: digest,
                at_ms: 5_000,
            },
        )
        .expect("first sweep");

    // Nothing reached the world during reconciliation.
    let dispatches_after_sweep = dispatcher.invocations + settled_dispatcher.invocations;
    assert_eq!(
        dispatches_before_sweep, dispatches_after_sweep,
        "reconciliation dispatched"
    );

    // Settled-but-unverified effects are outstanding too, so the sweep examines
    // the whole population and simply finds nothing to reconcile in a quarter.
    assert_eq!(first.examined as u32, unresolved_count + finished_count);
    assert!(first.escalated > 0, "the sweep must exercise escalation");
    assert!(
        first.resolved_by_evidence > 0,
        "the sweep must exercise evidence"
    );
    assert!(
        first.compensations_requested > 0,
        "the sweep must exercise compensation"
    );

    // Snapshot every ledger length, then sweep again.
    let lengths_after_first = ledger_lengths(&journal);
    let second = reconciler
        .sweep(
            &mut journal,
            &supervisor,
            &ReconciliationContext {
                oracle: &PartialOracle,
                policy: &EveryOtherCompensates,
                operation_digest: digest,
                at_ms: 6_000,
            },
        )
        .expect("second sweep");
    let lengths_after_second = ledger_lengths(&journal);

    assert_eq!(
        lengths_after_first, lengths_after_second,
        "the second sweep advanced the ledger"
    );
    assert_eq!(
        dispatches_before_sweep,
        dispatcher.invocations + settled_dispatcher.invocations,
        "the second sweep dispatched"
    );
    assert_eq!(
        second.escalated, first.escalated,
        "escalations must keep being reported, not cleared by being seen"
    );

    // Every escalation is still outstanding, and every one carries the phase
    // that says a person owes an answer.
    let remaining = reconciler.outstanding(&journal).expect("outstanding");
    let escalated_remaining = remaining
        .iter()
        .filter(|entry| entry.phase == EffectPhase::Escalated)
        .count();
    assert_eq!(escalated_remaining, first.escalated);
    assert!(
        remaining.iter().all(|entry| !entry.phase.is_resolved()),
        "a resolved effect is being reported as outstanding"
    );

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S108_RECONCILE_SWEEP effects={POPULATION} unconfirmed={unresolved_count} examined={} evidenced={} compensated={} escalated={} outstanding={} dispatches_during_sweep=0 idempotent=1 elapsed_ms={elapsed_ms}",
        first.examined,
        first.resolved_by_evidence,
        first.compensations_requested,
        first.escalated,
        remaining.len()
    );
}

fn ledger_lengths(journal: &abdo_journal::Journal) -> Vec<usize> {
    (1..=POPULATION)
        .map(|seed| {
            journal
                .effect_history(effect_id_of(&intent(10_000 + seed)))
                .expect("history")
                .len()
        })
        .collect()
}
