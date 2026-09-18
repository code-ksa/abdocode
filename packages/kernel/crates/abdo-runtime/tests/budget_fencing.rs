#![forbid(unsafe_code)]

//! The exact S112 gate: many holders competing for many scopes, budgets that
//! refuse before anything dispatches, and accounting that adds up exactly.
//!
//! The number that matters is stale mutations, and it is only meaningful if
//! stale holders actually tried. So the gate counts attempts as well as
//! refusals: a run where nobody was ever fenced out would report zero stale
//! mutations while proving nothing at all.

mod support;

use std::time::Instant;

use abdo_journal::{HolderId, ScopeId};
use abdo_runtime::{Admission, BudgetDimension, Charge, Governor, Refusal};
use support::{open, SplitMix64, TestDirectory};

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_BUDGET_PARENT_GATE";
const SCOPES: u128 = 48;
const ROUNDS: u64 = 400;
const TOKENS_PER_ACTION: u64 = 200;
/// Half the scopes run out of actions, half run out of tokens.
///
/// A single shared ceiling would exercise whichever dimension happened to bind
/// first and leave the other refusal path untested while the gate still passed.
const TIGHT_ACTIONS: u64 = 4;
const LOOSE_ACTIONS: u64 = 1_000;
const TIGHT_TOKENS: u64 = TOKENS_PER_ACTION * 3;
const LOOSE_TOKENS: u64 = TOKENS_PER_ACTION * 1_000;

const fn action_limit(index: usize) -> u64 {
    if index.is_multiple_of(2) {
        TIGHT_ACTIONS
    } else {
        LOOSE_ACTIONS
    }
}

const fn token_limit(index: usize) -> u64 {
    if index.is_multiple_of(2) {
        LOOSE_TOKENS
    } else {
        TIGHT_TOKENS
    }
}

#[test]
#[ignore = "S112 exact budget and fencing gate"]
fn stale_holders_never_mutate_and_budgets_stop_before_dispatch() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S112 budget gate requires its exact parent marker"
    );

    let started = Instant::now();
    let directory = TestDirectory::new("govern");
    let path = directory.journal_path();
    let governor = Governor::new();
    let mut random = SplitMix64::new(0x5112_0000_5112_0000);

    // Every scope starts with one holder and a declared ceiling.
    let mut current: Vec<(ScopeId, abdo_runtime::FencedHolder)> = Vec::new();
    {
        let mut journal = open(&path);
        for seed in 1..=SCOPES {
            let index = (seed - 1) as usize;
            let scope = ScopeId::try_from_u128(seed).expect("scope id");
            let held = governor
                .take_lease(
                    &mut journal,
                    scope,
                    HolderId::try_from_u128(seed * 1_000).expect("holder id"),
                    1_000,
                    10_000_000,
                )
                .expect("lease");
            governor
                .set_limit(
                    &mut journal,
                    scope,
                    BudgetDimension::Actions,
                    action_limit(index),
                )
                .expect("action limit");
            governor
                .set_limit(
                    &mut journal,
                    scope,
                    BudgetDimension::Tokens,
                    token_limit(index),
                )
                .expect("token limit");
            current.push((scope, held));
        }
    }

    // Holders that were current once and are not any more. Every one of them
    // keeps trying, which is what makes the stale-mutation count mean anything.
    let mut stale: Vec<abdo_runtime::FencedHolder> = Vec::new();

    let mut cleared = 0_u64;
    let mut action_refusals = 0_u64;
    let mut token_refusals = 0_u64;
    let mut stale_attempts = 0_u64;
    let mut stale_mutations = 0_u64;
    let mut expected_actions = vec![0_u64; SCOPES as usize];
    let mut expected_tokens = vec![0_u64; SCOPES as usize];
    let mut revocations = 0_u64;
    let mut now_ms = 2_000_u64;

    // Reopen periodically: a fencing token that only holds inside one process
    // is not a fencing token.
    let mut journal = open(&path);
    for round in 0..ROUNDS {
        now_ms += 1;
        if round % 50 == 49 {
            drop(journal);
            journal = open(&path);
        }

        // Every stale holder tries again, every round.
        for held in &stale {
            stale_attempts += 1;
            let admission = governor
                .admit(&mut journal, *held, Charge::one_action(), now_ms)
                .expect("admit");
            match admission {
                Admission::Refused(Refusal::StaleLease { .. }) => {}
                Admission::Cleared => stale_mutations += 1,
                other => panic!("a stale holder was refused for the wrong reason: {other:?}"),
            }
        }

        // A live holder tries.
        let index = random.below(SCOPES as u64) as usize;
        let (scope, held) = current[index];
        let admission = governor
            .admit(
                &mut journal,
                held,
                Charge {
                    tokens: TOKENS_PER_ACTION,
                    actions: 1,
                    ..Charge::default()
                },
                now_ms,
            )
            .expect("admit");
        match admission {
            Admission::Cleared => {
                cleared += 1;
                expected_actions[index] += 1;
                expected_tokens[index] += TOKENS_PER_ACTION;
            }
            Admission::Refused(Refusal::BudgetExhausted { dimension, .. }) => match dimension {
                BudgetDimension::Actions => action_refusals += 1,
                BudgetDimension::Tokens => token_refusals += 1,
                other => panic!("an unexpected dimension bound first: {other:?}"),
            },
            other => panic!("a live holder was refused unexpectedly: {other:?}"),
        }

        // Occasionally revoke, which fences the current holder out.
        if random.below(6) == 0 {
            let replacement = governor
                .take_lease(
                    &mut journal,
                    scope,
                    HolderId::try_from_u128(scope.get() * 1_000 + round as u128 + 1)
                        .expect("holder id"),
                    now_ms,
                    10_000_000,
                )
                .expect("lease");
            stale.push(held);
            current[index] = (scope, replacement);
            revocations += 1;
        }
    }

    assert!(revocations > 0, "nothing was ever revoked");
    assert!(
        stale_attempts > 0,
        "no stale holder ever tried, so zero stale mutations proves nothing"
    );
    assert_eq!(stale_mutations, 0, "a fenced-out holder mutated state");
    // Both refusal paths, not just whichever bound first.
    assert!(
        action_refusals > 0,
        "no action budget was ever exhausted, so that refusal path went untested"
    );
    assert!(
        token_refusals > 0,
        "no token budget was ever exhausted, so that refusal path went untested"
    );
    assert!(cleared > 0);

    // Exact accounting, checked against an independent tally kept here, and
    // read back from a freshly opened journal so nothing rests on memory.
    drop(journal);
    let journal = open(&path);
    let mut total_actions = 0_u64;
    let mut total_tokens = 0_u64;
    for (index, (scope, _)) in current.iter().enumerate() {
        let rows = governor.accounting(&journal, *scope).expect("accounting");
        let actions = rows
            .iter()
            .find(|(dimension, _, _)| *dimension == BudgetDimension::Actions)
            .expect("an action line");
        let tokens = rows
            .iter()
            .find(|(dimension, _, _)| *dimension == BudgetDimension::Tokens)
            .expect("a token line");
        assert_eq!(
            actions.1,
            expected_actions[index],
            "action accounting drifted for scope {}",
            scope.get()
        );
        assert_eq!(
            tokens.1,
            expected_tokens[index],
            "token accounting drifted for scope {}",
            scope.get()
        );
        assert!(
            actions.1 <= action_limit(index),
            "an action budget was overspent"
        );
        assert!(
            tokens.1 <= token_limit(index),
            "a token budget was overspent"
        );
        total_actions += actions.1;
        total_tokens += tokens.1;
    }
    assert_eq!(
        total_actions, cleared,
        "cleared dispatches and charges disagree"
    );
    assert_eq!(total_tokens, cleared * TOKENS_PER_ACTION);

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S112_BUDGET_FENCING scopes={SCOPES} rounds={ROUNDS} revocations={revocations} stale_attempts={stale_attempts} stale_mutations={stale_mutations} cleared={cleared} action_refusals={action_refusals} token_refusals={token_refusals} charged_actions={total_actions} charged_tokens={total_tokens} elapsed_ms={elapsed_ms}"
    );
}
