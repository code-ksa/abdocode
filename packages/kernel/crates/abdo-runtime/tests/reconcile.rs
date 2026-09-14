#![forbid(unsafe_code)]

//! The three conclusions, and the ones reconciliation refuses to reach.

mod support;

use abdo_contracts::{Digest, IntentId};
use abdo_runtime::{
    BlindOracle, CompensationPolicy, EffectPhase, EffectSupervisor, KeepWhatRan, ObservedOutcome,
    OutcomeOracle, Reconciler, ReconciliationContext, Recovered, Resolution, Settlement,
};
use support::{
    cause_hash, effect_id_of, intent, open, stream, CountingDispatcher, GrantingAuthority,
    TestDirectory,
};

/// An oracle that reports a fixed answer, to exercise each branch.
#[derive(Clone, Copy, Debug)]
struct FixedOracle(Option<ObservedOutcome>);

impl OutcomeOracle for FixedOracle {
    fn observe(&self, _intent_id: IntentId, _operation_digest: Digest) -> Option<ObservedOutcome> {
        self.0
    }
}

#[derive(Clone, Copy, Debug)]
struct AlwaysCompensate;

impl CompensationPolicy for AlwaysCompensate {
    fn requires_compensation(&self, _intent_id: IntentId, _settlement: Settlement) -> bool {
        true
    }
}

/// Drive one effect to an unresolved outcome, the state reconciliation exists
/// for.
fn unresolved(
    journal: &mut abdo_journal::Journal,
    supervisor: &EffectSupervisor,
    effect: &abdo_kernel::EffectIntent,
) {
    let prepared = supervisor
        .prepare(journal, effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(journal, effect, 1_050);
    let authorized = supervisor
        .authorize(journal, prepared, effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(journal, authorized, effect, 1_200)
        .expect("commit");
    let mut dispatcher = CountingDispatcher::silent();
    supervisor
        .run(journal, dispatching, effect, &mut dispatcher, 1_250)
        .expect("run");
    assert_eq!(dispatcher.invocations, 1);
}

#[test]
fn no_evidence_escalates_and_the_effect_stays_outstanding() {
    let directory = TestDirectory::new("escalate");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();
    let effect = intent(300);
    unresolved(&mut journal, &supervisor, &effect);

    let resolution = reconciler
        .reconcile(
            &mut journal,
            &supervisor,
            effect.intent_id,
            &ReconciliationContext {
                oracle: &BlindOracle,
                policy: &KeepWhatRan,
                operation_digest: effect.operation_digest,
                at_ms: 2_000,
            },
        )
        .expect("reconcile")
        .expect("an unresolved effect is reconcilable");
    assert_eq!(resolution, Resolution::HumanDecision);

    // Escalation is not closure. The effect must still be reported.
    let outstanding = reconciler.outstanding(&journal).expect("outstanding");
    assert_eq!(outstanding.len(), 1);
    assert_eq!(outstanding[0].intent_id, effect.intent_id);
    assert_eq!(outstanding[0].phase, EffectPhase::Escalated);
    assert!(outstanding[0].unconfirmed);
    assert_eq!(
        supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover"),
        Recovered::Escalated
    );
}

#[test]
fn evidence_that_it_ran_closes_the_question_without_dispatching() {
    let directory = TestDirectory::new("ran");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();
    let effect = intent(301);
    unresolved(&mut journal, &supervisor, &effect);

    let settlement = Settlement {
        outcome_digest: Digest::from_bytes([0x66; 32]),
        settled_at_ms: 2_100,
    };
    let resolution = reconciler
        .reconcile(
            &mut journal,
            &supervisor,
            effect.intent_id,
            &ReconciliationContext {
                oracle: &FixedOracle(Some(ObservedOutcome::Happened(settlement))),
                policy: &KeepWhatRan,
                operation_digest: effect.operation_digest,
                at_ms: 2_100,
            },
        )
        .expect("reconcile")
        .expect("reconcilable");
    assert_eq!(
        resolution,
        Resolution::Evidence(ObservedOutcome::Happened(settlement))
    );

    let history = journal
        .effect_history(effect_id_of(&effect))
        .expect("history");
    assert_eq!(
        history.last().expect("a phase").phase_tag.get(),
        EffectPhase::Reconciled.tag()
    );
    // Reconciled is established, not verified: the promise is still unchecked.
    assert_eq!(
        supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover"),
        Recovered::Reconciled
    );
    assert_eq!(
        reconciler.outstanding(&journal).expect("outstanding").len(),
        1,
        "an established but unverified effect is not finished"
    );
}

#[test]
fn evidence_that_it_never_ran_is_a_conclusion_not_a_retry() {
    let directory = TestDirectory::new("never-ran");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();
    let effect = intent(302);
    unresolved(&mut journal, &supervisor, &effect);

    let resolution = reconciler
        .reconcile(
            &mut journal,
            &supervisor,
            effect.intent_id,
            &ReconciliationContext {
                oracle: &FixedOracle(Some(ObservedOutcome::DidNotHappen {
                    observed_at_ms: 2_200,
                })),
                policy: &KeepWhatRan,
                operation_digest: effect.operation_digest,
                at_ms: 2_200,
            },
        )
        .expect("reconcile")
        .expect("reconcilable");
    assert!(matches!(
        resolution,
        Resolution::Evidence(ObservedOutcome::DidNotHappen { .. })
    ));

    // The identity is spent. Retrying is a new effect, not this one again: the
    // ledger will not accept a second dispatch for this identifier.
    let history = journal
        .effect_history(effect_id_of(&effect))
        .expect("history");
    assert_eq!(
        history
            .iter()
            .filter(|record| record.phase_tag.get() == EffectPhase::Dispatching.tag())
            .count(),
        1
    );
}

#[test]
fn compensation_is_requested_as_a_separate_effect() {
    let directory = TestDirectory::new("compensate");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();
    let effect = intent(303);
    unresolved(&mut journal, &supervisor, &effect);

    let settlement = Settlement {
        outcome_digest: Digest::from_bytes([0x77; 32]),
        settled_at_ms: 2_300,
    };
    let resolution = reconciler
        .reconcile(
            &mut journal,
            &supervisor,
            effect.intent_id,
            &ReconciliationContext {
                oracle: &FixedOracle(Some(ObservedOutcome::Happened(settlement))),
                policy: &AlwaysCompensate,
                operation_digest: effect.operation_digest,
                at_ms: 2_300,
            },
        )
        .expect("reconcile")
        .expect("reconcilable");

    match resolution {
        Resolution::CompensationRequired(request) => {
            assert_eq!(request.compensating_for, effect.intent_id);
            assert_eq!(request.observed, settlement);
        }
        other => panic!("expected a compensation request, saw {other:?}"),
    }

    // The request is a description, not an action: nothing else has been
    // dispatched, and the inverse effect will have its own identity.
    let outstanding = reconciler.outstanding(&journal).expect("outstanding");
    assert!(
        outstanding.is_empty(),
        "the compensated effect is closed; its inverse is a separate effect"
    );
}

#[test]
fn a_settled_effect_is_left_exactly_as_it_is() {
    // A sweep that tidied resolved effects would be rewriting history.
    let directory = TestDirectory::new("untouched");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();
    let effect = intent(304);

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
    let mut dispatcher = CountingDispatcher::settling(1_300);
    supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_250)
        .expect("run");

    let before = journal
        .effect_history(effect_id_of(&effect))
        .expect("history")
        .len();
    let resolution = reconciler
        .reconcile(
            &mut journal,
            &supervisor,
            effect.intent_id,
            &ReconciliationContext {
                oracle: &FixedOracle(Some(ObservedOutcome::DidNotHappen {
                    observed_at_ms: 9_999,
                })),
                policy: &AlwaysCompensate,
                operation_digest: effect.operation_digest,
                at_ms: 9_999,
            },
        )
        .expect("reconcile");
    assert_eq!(resolution, None, "a settled effect is not reconcilable");
    assert_eq!(
        journal
            .effect_history(effect_id_of(&effect))
            .expect("history")
            .len(),
        before
    );
}

#[test]
fn sweeping_twice_changes_nothing() {
    let directory = TestDirectory::new("idempotent");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let reconciler = Reconciler::new();

    for seed in 400..406 {
        let effect = intent(seed);
        unresolved(&mut journal, &supervisor, &effect);
    }

    let digest = intent(400).operation_digest;
    let first = reconciler
        .sweep(
            &mut journal,
            &supervisor,
            &ReconciliationContext {
                oracle: &BlindOracle,
                policy: &KeepWhatRan,
                operation_digest: digest,
                at_ms: 3_000,
            },
        )
        .expect("first sweep");
    assert_eq!(first.examined, 6);
    assert_eq!(first.escalated, 6);
    assert_eq!(first.outstanding.len(), 6);

    let phases_after_first: Vec<usize> = (400..406)
        .map(|seed| {
            journal
                .effect_history(effect_id_of(&intent(seed)))
                .expect("history")
                .len()
        })
        .collect();

    let second = reconciler
        .sweep(
            &mut journal,
            &supervisor,
            &ReconciliationContext {
                oracle: &BlindOracle,
                policy: &KeepWhatRan,
                operation_digest: digest,
                at_ms: 4_000,
            },
        )
        .expect("second sweep");

    let phases_after_second: Vec<usize> = (400..406)
        .map(|seed| {
            journal
                .effect_history(effect_id_of(&intent(seed)))
                .expect("history")
                .len()
        })
        .collect();

    assert_eq!(
        phases_after_first, phases_after_second,
        "a second sweep advanced the ledger"
    );
    assert_eq!(second.outstanding.len(), first.outstanding.len());
    assert_eq!(
        second.escalated, 6,
        "escalations stay reported, not cleared"
    );
}
