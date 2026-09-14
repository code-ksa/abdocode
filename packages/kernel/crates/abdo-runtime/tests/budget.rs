#![forbid(unsafe_code)]

//! Budgets that refuse before the world changes, and fencing that survives a
//! restart.

mod support;

use abdo_journal::{HolderId, ScopeId};
use abdo_runtime::{
    Admission, BudgetDimension, Charge, EffectSupervisor, Governor, Refusal, BUDGET_DIMENSIONS,
};
use support::{
    cause_hash, intent, open, stream, CountingDispatcher, GrantingAuthority, TestDirectory,
};

fn scope(seed: u128) -> ScopeId {
    ScopeId::try_from_u128(seed).expect("scope id is non-zero")
}

fn holder(seed: u128) -> HolderId {
    HolderId::try_from_u128(seed).expect("holder id is non-zero")
}

#[test]
fn every_dimension_round_trips_its_tag() {
    for dimension in BUDGET_DIMENSIONS {
        assert_eq!(BudgetDimension::from_tag(dimension.tag()), Some(dimension));
    }
    assert_eq!(BudgetDimension::from_tag(0), None);
    assert_eq!(BudgetDimension::from_tag(5), None);
}

#[test]
fn a_second_holder_fences_out_the_first() {
    let directory = TestDirectory::new("fence");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();

    let first = governor
        .take_lease(&mut journal, scope(1), holder(10), 1_000, 60_000)
        .expect("first lease");
    assert_eq!(
        governor.check_fence(&journal, first, 1_100).expect("check"),
        Admission::Cleared
    );

    let second = governor
        .take_lease(&mut journal, scope(1), holder(20), 1_200, 60_000)
        .expect("second lease");
    assert!(
        second.generation > first.generation,
        "a new lease must advance the generation"
    );

    // The old holder is stale by comparison with what is stored, not by being
    // asked whether it thinks it is current.
    assert_eq!(
        governor.check_fence(&journal, first, 1_300).expect("check"),
        Admission::Refused(Refusal::StaleLease {
            held: first.generation,
            current: second.generation,
        })
    );
    assert_eq!(
        governor
            .check_fence(&journal, second, 1_300)
            .expect("check"),
        Admission::Cleared
    );
}

#[test]
fn a_generation_never_repeats_across_a_restart() {
    // A counter held in memory is reset by exactly the event fencing exists to
    // defend against, so this reopens the journal between issues.
    let directory = TestDirectory::new("restart-fence");
    let path = directory.journal_path();
    let governor = Governor::new();

    let mut seen = Vec::new();
    for round in 0..4u128 {
        let mut journal = open(&path);
        let held = governor
            .take_lease(
                &mut journal,
                scope(2),
                holder(100 + round),
                1_000 + round as u64,
                60_000,
            )
            .expect("lease");
        seen.push(held.generation);
        // Every handle dropped here: the next iteration is a fresh process as
        // far as memory is concerned.
    }

    assert_eq!(seen, vec![1, 2, 3, 4], "a restart reused a fencing token");
    let mut sorted = seen.clone();
    sorted.dedup();
    assert_eq!(sorted.len(), seen.len());
}

#[test]
fn an_expired_lease_is_refused_even_though_it_is_current() {
    let directory = TestDirectory::new("expiry");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();
    let held = governor
        .take_lease(&mut journal, scope(3), holder(30), 1_000, 500)
        .expect("lease");

    assert_eq!(
        governor.check_fence(&journal, held, 1_400).expect("check"),
        Admission::Cleared
    );
    assert_eq!(
        governor.check_fence(&journal, held, 1_500).expect("check"),
        Admission::Refused(Refusal::LeaseExpired {
            expires_at_ms: 1_500,
            now_ms: 1_500,
        })
    );
}

#[test]
fn exceeding_a_budget_refuses_before_anything_is_dispatched() {
    let directory = TestDirectory::new("budget-stop");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();
    let supervisor = EffectSupervisor::new();
    let held = governor
        .take_lease(&mut journal, scope(4), holder(40), 1_000, 60_000)
        .expect("lease");
    governor
        .set_limit(&mut journal, scope(4), BudgetDimension::Actions, 2)
        .expect("limit");

    let mut dispatcher = CountingDispatcher::settling(1_300);
    let mut dispatched = 0_u32;

    for attempt in 0..5u128 {
        let admission = governor
            .admit(&mut journal, held, Charge::one_action(), 1_100)
            .expect("admit");
        if !admission.is_cleared() {
            // The refusal must arrive before the effect is committed, so the
            // adapter is never reached at all.
            assert!(matches!(
                admission,
                Admission::Refused(Refusal::BudgetExhausted {
                    dimension: BudgetDimension::Actions,
                    limit: 2,
                    ..
                })
            ));
            continue;
        }
        let effect = intent(500 + attempt);
        let prepared = supervisor
            .prepare(&mut journal, &effect, stream(), cause_hash(), 1_100)
            .expect("prepare");
        support::clear(&mut journal, &effect, 1_120);
        let authorized = supervisor
            .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_150)
            .expect("authorize");
        let dispatching = supervisor
            .commit_dispatch(&mut journal, authorized, &effect, 1_200)
            .expect("commit");
        supervisor
            .run(&mut journal, dispatching, &effect, &mut dispatcher, 1_250)
            .expect("run");
        dispatched += 1;
    }

    assert_eq!(dispatched, 2, "the budget did not stop the third dispatch");
    assert_eq!(
        dispatcher.invocations, 2,
        "the adapter ran after the budget was exhausted"
    );
}

#[test]
fn a_refused_dimension_never_spends_another_one() {
    // Charging as it goes would let a dispatch that is refused on its last
    // dimension still consume the earlier ones.
    let directory = TestDirectory::new("no-partial-spend");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();
    let held = governor
        .take_lease(&mut journal, scope(5), holder(50), 1_000, 60_000)
        .expect("lease");
    governor
        .set_limit(&mut journal, scope(5), BudgetDimension::Tokens, 1_000)
        .expect("limit");
    governor
        .set_limit(&mut journal, scope(5), BudgetDimension::Actions, 0)
        .expect("limit");

    let admission = governor
        .admit(
            &mut journal,
            held,
            Charge {
                tokens: 100,
                actions: 1,
                ..Charge::default()
            },
            1_100,
        )
        .expect("admit");
    assert!(matches!(
        admission,
        Admission::Refused(Refusal::BudgetExhausted {
            dimension: BudgetDimension::Actions,
            ..
        })
    ));

    let accounting = governor.accounting(&journal, scope(5)).expect("accounting");
    let tokens = accounting
        .iter()
        .find(|(dimension, _, _)| *dimension == BudgetDimension::Tokens)
        .expect("a token line");
    assert_eq!(
        tokens.1, 0,
        "a refused dispatch spent tokens on its way to being refused"
    );
}

#[test]
fn a_stale_holder_cannot_spend_a_budget_at_all() {
    let directory = TestDirectory::new("stale-spend");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();
    let first = governor
        .take_lease(&mut journal, scope(6), holder(60), 1_000, 60_000)
        .expect("lease");
    governor
        .set_limit(&mut journal, scope(6), BudgetDimension::Actions, 10)
        .expect("limit");
    governor
        .take_lease(&mut journal, scope(6), holder(61), 1_100, 60_000)
        .expect("second lease");

    let admission = governor
        .admit(&mut journal, first, Charge::one_action(), 1_200)
        .expect("admit");
    assert!(matches!(
        admission,
        Admission::Refused(Refusal::StaleLease { .. })
    ));

    let accounting = governor.accounting(&journal, scope(6)).expect("accounting");
    assert_eq!(
        accounting
            .iter()
            .find(|(dimension, _, _)| *dimension == BudgetDimension::Actions)
            .expect("an action line")
            .1,
        0,
        "a fenced-out holder still spent from the budget"
    );
}

#[test]
fn accounting_survives_reopening_the_journal() {
    let directory = TestDirectory::new("accounting");
    let path = directory.journal_path();
    let governor = Governor::new();

    let held = {
        let mut journal = open(&path);
        let held = governor
            .take_lease(&mut journal, scope(7), holder(70), 1_000, 600_000)
            .expect("lease");
        governor
            .set_limit(&mut journal, scope(7), BudgetDimension::Tokens, 500)
            .expect("limit");
        for _ in 0..3 {
            assert_eq!(
                governor
                    .admit(
                        &mut journal,
                        held,
                        Charge {
                            tokens: 100,
                            ..Charge::default()
                        },
                        1_100,
                    )
                    .expect("admit"),
                Admission::Cleared
            );
        }
        held
    };

    let mut journal = open(&path);
    let accounting = governor.accounting(&journal, scope(7)).expect("accounting");
    let tokens = accounting
        .iter()
        .find(|(dimension, _, _)| *dimension == BudgetDimension::Tokens)
        .expect("a token line");
    assert_eq!(tokens.1, 300, "spending was forgotten across a restart");
    assert_eq!(tokens.2, 500);

    // And the remaining budget is what is left, not the whole limit again.
    let admission = governor
        .admit(
            &mut journal,
            held,
            Charge {
                tokens: 250,
                ..Charge::default()
            },
            1_200,
        )
        .expect("admit");
    assert!(matches!(
        admission,
        Admission::Refused(Refusal::BudgetExhausted {
            dimension: BudgetDimension::Tokens,
            consumed: 300,
            ..
        })
    ));
}

#[test]
fn a_limit_cannot_be_raised_after_the_fact() {
    let directory = TestDirectory::new("fixed-limit");
    let mut journal = open(&directory.journal_path());
    let governor = Governor::new();
    governor
        .set_limit(&mut journal, scope(8), BudgetDimension::Actions, 1)
        .expect("limit");
    governor
        .set_limit(&mut journal, scope(8), BudgetDimension::Actions, 1_000)
        .expect("second set is ignored, not applied");

    let accounting = governor.accounting(&journal, scope(8)).expect("accounting");
    assert_eq!(
        accounting
            .iter()
            .find(|(dimension, _, _)| *dimension == BudgetDimension::Actions)
            .expect("an action line")
            .2,
        1,
        "a budget ceiling was raised in place, which makes it a suggestion"
    );
}
