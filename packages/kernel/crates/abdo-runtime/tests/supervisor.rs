#![forbid(unsafe_code)]

//! The lifecycle, the durable barriers, and the two-part completion rule.

mod support;

use abdo_runtime::{
    EffectPhase, EffectSupervisor, KernelAuthority, Recovered, RuntimeError, Verification,
    PHASE_ORDER,
};
use support::{
    cause_hash, intent, open, stream, CountingDispatcher, GrantingAuthority, TestDirectory,
};

use abdo_contracts::Digest;

#[test]
fn an_effect_presented_by_the_wrong_scope_is_refused_before_anything_is_durable() {
    // The authority is asked, and it compares the scope acting against the
    // scope the capability was granted to. A capability that worked for whoever
    // held it would be a bearer token.
    let directory = TestDirectory::new("wrong-scope");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(1);

    let (authority, capability) = support::authority_granting(&effect, support::scope_of(10));
    // Acting as a scope the capability was not granted to.
    let port = KernelAuthority::new(&authority, support::scope_of(11), &capability);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("preparing is always allowed");
    let error = supervisor
        .authorize(&mut journal, prepared, &effect, &port, 1_100)
        .expect_err("the authority refuses a scope that was never granted");
    assert!(matches!(error, RuntimeError::Denied { .. }));

    let history = journal
        .effect_history(support::effect_id_of(&effect))
        .expect("history is readable");
    assert_eq!(history.len(), 1, "only the prepare is durable");
    assert_eq!(history[0].phase_tag.get(), EffectPhase::Prepared.tag());
}

#[test]
fn production_dispatch_stays_closed_until_authority_exists() {
    let directory = TestDirectory::new("gated");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(2);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("fixture authority grants");

    let mut dispatcher = CountingDispatcher::settling(1_200);
    let error = supervisor
        .dispatch(&mut journal, authorized, &effect, &mut dispatcher, 1_200)
        .expect_err("effectful dispatch is compiled out");
    assert!(matches!(error, RuntimeError::DispatchDisabled { .. }));
    assert_eq!(
        dispatcher.invocations, 0,
        "a disabled dispatch must not reach the adapter"
    );
}

#[test]
fn the_full_lifecycle_records_every_phase_once_and_in_order() {
    let directory = TestDirectory::new("lifecycle");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(3);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(&mut journal, authorized, &effect, 1_200)
        .expect("commit dispatch");
    let mut dispatcher = CountingDispatcher::settling(1_300);
    let outcome = supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_200)
        .expect("run");
    assert_eq!(dispatcher.invocations, 1);

    let settled = match outcome {
        abdo_runtime::DispatchOutcome::Settled(settled) => settled,
        other => panic!("expected a settlement, saw {other:?}"),
    };
    let verified = supervisor
        .verify(
            &mut journal,
            settled,
            Verification {
                postcondition_digest: Digest::from_bytes([0x44; 32]),
                verified_at_ms: 1_400,
            },
        )
        .expect("verify");

    assert_eq!(verified.settlement().settled_at_ms, 1_300);
    assert_eq!(verified.verification().verified_at_ms, 1_400);

    let history = journal
        .effect_history(support::effect_id_of(&effect))
        .expect("history");
    let tags: Vec<u8> = history
        .iter()
        .map(|record| record.phase_tag.get())
        .collect();
    assert_eq!(
        tags,
        vec![
            EffectPhase::Prepared.tag(),
            EffectPhase::Cleared.tag(),
            EffectPhase::Authorized.tag(),
            EffectPhase::Dispatching.tag(),
            EffectPhase::Started.tag(),
            EffectPhase::Settled.tag(),
            EffectPhase::Verified.tag(),
        ]
    );
    assert_eq!(
        supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover"),
        Recovered::Complete
    );
}

#[test]
fn a_silent_adapter_produces_an_unknown_outcome_not_a_retry() {
    let directory = TestDirectory::new("unknown");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(4);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(&mut journal, authorized, &effect, 1_200)
        .expect("commit dispatch");
    let mut dispatcher = CountingDispatcher::silent();
    let outcome = supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_200)
        .expect("run");

    assert!(matches!(
        outcome,
        abdo_runtime::DispatchOutcome::Unknown { .. }
    ));
    assert_eq!(dispatcher.invocations, 1, "the adapter ran exactly once");
    assert_eq!(
        supervisor
            .recover(&journal, effect.intent_id)
            .expect("recover"),
        Recovered::UnknownOutcome,
        "an unresolved effect stays unresolved instead of looking finished"
    );
}

#[test]
fn settlement_alone_never_reads_as_complete() {
    // A settled effect claims it finished. Nothing has checked that claim, and
    // the recovery view must say so rather than reporting completion.
    let directory = TestDirectory::new("settled-only");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(5);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(&mut journal, authorized, &effect, 1_200)
        .expect("commit dispatch");
    let mut dispatcher = CountingDispatcher::settling(1_300);
    supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_200)
        .expect("run");

    match supervisor
        .recover(&journal, effect.intent_id)
        .expect("recover")
    {
        Recovered::AwaitingVerification { settlement } => {
            assert_eq!(settlement.settled_at_ms, 1_300);
        }
        other => panic!("a settled effect must await verification, saw {other:?}"),
    }
}

#[test]
fn the_ledger_refuses_a_repeated_phase() {
    // Exactly-once is held by the schema, not by a check the caller could skip.
    let directory = TestDirectory::new("repeat");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(6);

    supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    let error = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_050)
        .expect_err("the same effect cannot be prepared twice");
    assert!(matches!(error, RuntimeError::Transition(_)));

    let history = journal
        .effect_history(support::effect_id_of(&effect))
        .expect("history");
    assert_eq!(history.len(), 1);
}

#[test]
fn the_lifecycle_admits_only_its_declared_edges() {
    let mut edges = 0;
    for from in PHASE_ORDER {
        for to in PHASE_ORDER {
            if from.may_precede(to) {
                edges += 1;
            }
        }
    }
    // Seven dispatch edges, six reconciliation edges, five approval edges. The
    // number is pinned so that adding a transition is a deliberate act rather
    // than a side effect of editing a match arm.
    assert_eq!(edges, 18, "the lifecycle graph gained or lost an edge");

    // The one that matters most: a refusal is a dead end. Not "we do not call
    // dispatch after a refusal" but "there is no edge to call it along".
    for to in PHASE_ORDER {
        assert!(
            !EffectPhase::ApprovalRefused.may_precede(to),
            "a refused effect can still move to {to:?}"
        );
    }
    // And there is exactly one door into authorisation. `Prepared -> Authorized`
    // is absent on purpose: with it, a caller holding a `Prepared` token could
    // reach the world without policy ever being consulted.
    let into_authorized: Vec<_> = PHASE_ORDER
        .into_iter()
        .filter(|phase| phase.may_precede(EffectPhase::Authorized))
        .collect();
    assert_eq!(into_authorized, vec![EffectPhase::Cleared]);
    assert!(!EffectPhase::Prepared.may_precede(EffectPhase::Authorized));

    assert!(EffectPhase::Prepared.is_durable_barrier());
    assert!(EffectPhase::Dispatching.is_durable_barrier());
    for phase in PHASE_ORDER {
        if phase.is_durable_barrier() {
            continue;
        }
        assert!(
            matches!(
                phase,
                EffectPhase::Authorized
                    | EffectPhase::ApprovalAsked
                    | EffectPhase::Cleared
                    | EffectPhase::ApprovalRefused
                    | EffectPhase::Started
                    | EffectPhase::Settled
                    | EffectPhase::UnknownOutcome
                    | EffectPhase::Verified
                    | EffectPhase::Reconciled
                    | EffectPhase::Compensated
                    | EffectPhase::Escalated
            ),
            "an unexpected phase claims not to be a barrier: {phase:?}"
        );
    }

    // Nothing observable may precede the dispatch commitment.
    assert!(!EffectPhase::Prepared.is_observable());
    assert!(!EffectPhase::Authorized.is_observable());
    assert!(EffectPhase::Dispatching.is_observable());

    // Only three phases end an effect, and escalation is not one of them: a
    // person still owes an answer.
    let resolved: Vec<_> = PHASE_ORDER
        .into_iter()
        .filter(|phase| phase.is_resolved())
        .collect();
    assert_eq!(
        resolved,
        vec![
            EffectPhase::ApprovalRefused,
            EffectPhase::Verified,
            EffectPhase::Compensated
        ]
    );

    // Asking is invisible from outside. A question that counted as an
    // observable step would make the ledger claim the world may have changed
    // because somebody was consulted.
    for phase in PHASE_ORDER.into_iter().filter(|phase| phase.is_approval()) {
        assert!(!phase.is_observable(), "{phase:?} claims to be observable");
        assert!(!phase.needs_reconciliation());
    }
    assert!(!EffectPhase::Escalated.is_resolved());
    assert!(EffectPhase::Escalated.needs_reconciliation());

    // Nothing can leave a resolved phase.
    for from in PHASE_ORDER.into_iter().filter(|phase| phase.is_resolved()) {
        for to in PHASE_ORDER {
            assert!(
                !from.may_precede(to),
                "a resolved effect can still move from {from:?} to {to:?}"
            );
        }
    }
}

#[test]
fn a_settlement_and_its_verification_are_recorded_as_separate_facts() {
    // The earlier version of this test compared two struct literals and then
    // wrote two type annotations. That proves the compiler accepted the file,
    // not that the kernel keeps the adapter's claim apart from its own verdict.
    // This one reads the ledger.
    let directory = TestDirectory::new("distinct");
    let mut journal = open(&directory.journal_path());
    let supervisor = EffectSupervisor::new();
    let effect = intent(7);

    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
    support::clear(&mut journal, &effect, 1_050);
    let authorized = supervisor
        .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_100)
        .expect("authorize");
    let dispatching = supervisor
        .commit_dispatch(&mut journal, authorized, &effect, 1_200)
        .expect("commit dispatch");
    let mut dispatcher = CountingDispatcher::settling(1_300);
    let outcome = supervisor
        .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_250)
        .expect("run");
    let settled = match outcome {
        abdo_runtime::DispatchOutcome::Settled(settled) => settled,
        other => panic!("expected a settlement, saw {other:?}"),
    };

    let claim = settled.settlement();
    let verdict = Verification {
        postcondition_digest: Digest::from_bytes([0xab; 32]),
        verified_at_ms: 1_400,
    };
    assert_ne!(
        claim.outcome_digest, verdict.postcondition_digest,
        "the fixture must distinguish the claim from the verdict"
    );
    let verified = supervisor
        .verify(&mut journal, settled, verdict)
        .expect("verify");

    // Both halves survive independently on the finished effect.
    assert_eq!(verified.settlement(), claim);
    assert_eq!(verified.verification(), verdict);

    // And the ledger holds them as two phases carrying two different payloads,
    // so nothing collapsed one into the other on the way to disk.
    let history = journal
        .effect_history(support::effect_id_of(&effect))
        .expect("history");
    let settled_payload = history
        .iter()
        .find(|record| record.phase_tag.get() == EffectPhase::Settled.tag())
        .expect("a settled phase")
        .payload
        .clone();
    let verified_payload = history
        .iter()
        .find(|record| record.phase_tag.get() == EffectPhase::Verified.tag())
        .expect("a verified phase")
        .payload
        .clone();
    assert_ne!(
        settled_payload, verified_payload,
        "the settlement and its verification were recorded as the same fact"
    );
    assert_eq!(
        history
            .iter()
            .filter(|record| record.phase_tag.get() == EffectPhase::Verified.tag())
            .count(),
        1,
        "verification was recorded more than once"
    );
}
