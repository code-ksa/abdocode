#![forbid(unsafe_code)]

//! The transition table, the commitment rule, and the reconstruction invariant.

mod support;

use abdo_kernel::{
    reduce, reduce_all, IllegalTransition, KernelState, ProposalPhase, CANONICAL_STATE_VERSION,
};
use support::{
    admitted, cancelled, expired, interleaved_trace, received, refused, validated, Seeded,
};

fn fold(events: &[abdo_contracts::AdmissionEvent]) -> KernelState {
    reduce_all(KernelState::new(), events)
        .expect("a legitimate trace folds without rejection")
        .state
}

#[test]
fn one_admitted_proposal_owes_exactly_one_effect() {
    let seeded = Seeded::new(7);
    let events = [
        received(seeded, 1_000),
        validated(seeded, 1_100),
        admitted(seeded, 1_200),
    ];
    let reduction = reduce_all(KernelState::new(), &events).expect("lifecycle is legitimate");

    assert_eq!(
        reduction.effects.len(),
        1,
        "admission owes exactly one effect"
    );
    let effect = &reduction.effects[0];
    assert_eq!(effect.intent_id, seeded.intent_id());
    assert_eq!(effect.proposal_id, seeded.proposal_id());
    assert_eq!(effect.cause_event, seeded.event_id(2));

    let record = reduction
        .state
        .proposal(seeded.proposal_id())
        .expect("the proposal is known");
    assert_eq!(record.phase, ProposalPhase::Admitted);
    assert_eq!(record.intent_id, Some(seeded.intent_id()));
    assert_eq!(reduction.state.committed_effects(), 1);
    assert_eq!(reduction.state.applied_events(), 3);
}

#[test]
fn only_the_validated_to_admitted_edge_commits_an_effect() {
    let seeded = Seeded::new(11);
    let received_only = reduce(KernelState::new(), &received(seeded, 10)).expect("first event");
    assert!(received_only.effects.is_empty());

    let validated_next = reduce(received_only.state, &validated(seeded, 20)).expect("second event");
    assert!(validated_next.effects.is_empty());

    let admitted_next = reduce(validated_next.state, &admitted(seeded, 30)).expect("third event");
    assert_eq!(admitted_next.effects.len(), 1);
    assert_eq!(admitted_next.state.committed_effects(), 1);
}

#[test]
fn every_illegal_transition_is_rejected_with_the_state_untouched() {
    let seeded = Seeded::new(3);
    let live = fold(&[received(seeded, 100)]);
    let before = live.fingerprint();

    // Announcing the same proposal twice.
    let rejection = reduce(live.clone(), &received(seeded, 110)).expect_err("duplicate proposal");
    assert_eq!(
        rejection.error.reason,
        IllegalTransition::ProposalAlreadyKnown
    );
    assert_eq!(rejection.state.fingerprint(), before);

    // Admitting straight from Received, skipping validation.
    let rejection = reduce(live.clone(), &admitted(seeded, 120)).expect_err("skipped validation");
    assert_eq!(
        rejection.error.reason,
        IllegalTransition::PhaseForbidsEvent {
            from: ProposalPhase::Received
        }
    );
    assert_eq!(rejection.state.fingerprint(), before);

    // Time running backwards inside a proposal.
    let rejection = reduce(live.clone(), &validated(seeded, 99)).expect_err("time went backwards");
    assert_eq!(
        rejection.error.reason,
        IllegalTransition::NonMonotonicTime {
            last_at_ms: 100,
            at_ms: 99
        }
    );
    assert_eq!(rejection.state.fingerprint(), before);

    // An event for a proposal that was never received.
    let unknown = Seeded::new(4);
    let rejection = reduce(live, &validated(unknown, 130)).expect_err("unknown proposal");
    assert_eq!(rejection.error.reason, IllegalTransition::UnknownProposal);
    assert_eq!(rejection.state.fingerprint(), before);
}

#[test]
fn a_terminal_proposal_accepts_no_further_event() {
    let seeded = Seeded::new(5);
    for terminal in [
        refused(seeded, 200),
        expired(seeded, 200),
        cancelled(seeded, 200),
    ] {
        let ended = fold(&[received(seeded, 100), validated(seeded, 150), terminal]);
        let fingerprint = ended.fingerprint();
        for follow_up in [
            admitted(seeded, 300),
            validated(seeded, 300),
            refused(seeded, 300),
        ] {
            let rejection = reduce(ended.clone(), &follow_up).expect_err("terminal is terminal");
            assert!(matches!(
                rejection.error.reason,
                IllegalTransition::PhaseForbidsEvent { .. }
            ));
            assert_eq!(rejection.state.fingerprint(), fingerprint);
            assert_eq!(rejection.state.committed_effects(), 0);
        }
    }
}

#[test]
fn an_admitted_proposal_cannot_be_cancelled_away() {
    // Cancelling an admitted proposal would silently drop a committed effect.
    // Withdrawing one is compensation, which is a different mechanism and a
    // later sprint; here it must simply be refused.
    let seeded = Seeded::new(9);
    let admitted_state = fold(&[
        received(seeded, 10),
        validated(seeded, 20),
        admitted(seeded, 30),
    ]);
    assert_eq!(admitted_state.committed_effects(), 1);

    let rejection =
        reduce(admitted_state, &cancelled(seeded, 40)).expect_err("admitted is not cancellable");
    assert_eq!(
        rejection.error.reason,
        IllegalTransition::PhaseForbidsEvent {
            from: ProposalPhase::Admitted
        }
    );
    assert_eq!(rejection.state.committed_effects(), 1);
}

#[test]
fn committed_effects_always_equal_the_proposals_in_the_admitted_phase() {
    let events = interleaved_trace(64);
    let state = fold(&events);
    assert_eq!(
        state.committed_effects(),
        state.count_in_phase(ProposalPhase::Admitted),
        "an effect exists if and only if a proposal was admitted"
    );
    assert!(state.committed_effects() > 0, "the trace admits something");
}

#[test]
fn a_derived_view_is_the_fold_of_the_exact_range_it_names() {
    // The reconstruction invariant. A projection is not a labelled blob: it is
    // whatever folding the named range produces, byte for byte. Two independent
    // folds of the same range must agree, and any other range must not.
    let events = interleaved_trace(32);
    let range = &events[..events.len() / 2];

    let first = fold(range).canonical_bytes();
    let second = fold(range).canonical_bytes();
    assert_eq!(first, second, "the same range rebuilds byte for byte");

    let longer = fold(&events[..events.len() / 2 + 1]).canonical_bytes();
    assert_ne!(
        first, longer,
        "a different range must not reproduce the same view"
    );

    let state = fold(range);
    assert_eq!(
        state.fingerprint(),
        abdo_kernel::Fingerprint::of(&first),
        "the fingerprint is the hash of the canonical bytes and nothing else"
    );
    assert_eq!(
        u16::from_le_bytes([first[0], first[1]]),
        CANONICAL_STATE_VERSION,
        "the encoding announces its own version"
    );
}

#[test]
fn the_canonical_encoding_orders_proposals_by_identity_not_arrival() {
    // Insertion order must not leak into the bytes, or two kernels that saw the
    // same facts in a different order would disagree about their own state.
    let ascending = [Seeded::new(1), Seeded::new(2), Seeded::new(3)];
    let descending = [Seeded::new(3), Seeded::new(2), Seeded::new(1)];

    let forward: Vec<_> = ascending
        .iter()
        .enumerate()
        .map(|(index, seeded)| received(*seeded, 100 + index as u64))
        .collect();
    let backward: Vec<_> = descending
        .iter()
        .enumerate()
        .map(|(index, seeded)| received(*seeded, 100 + index as u64))
        .collect();

    let forward_bytes = fold(&forward).canonical_bytes();
    let backward_bytes = fold(&backward).canonical_bytes();

    // Identifier order in the encoding is ascending in both cases; only the
    // per-record timestamps differ. Rather than hard-coding a record stride,
    // which would silently mis-parse the day the layout changes, derive it and
    // assert it: a layout change then fails loudly here instead of quietly
    // reading the wrong bytes and still passing.
    const HEADER: usize = 2 + 8;
    const FOOTER: usize = 8 + 8 + 8;

    let keys = |bytes: &[u8]| -> Vec<u128> {
        let count = u64::from_le_bytes(bytes[2..10].try_into().expect("count is eight bytes"));
        assert!(count > 0, "the fixture must encode at least one proposal");
        let body = bytes.len() - HEADER - FOOTER;
        assert_eq!(
            body % count as usize,
            0,
            "the record layout changed: {body} bytes do not divide into {count} records"
        );
        let stride = body / count as usize;
        assert_eq!(
            stride,
            16 + 1 + 16 + 8 + 33 + 17 + 16 + 8,
            "the per-proposal record layout changed; update this test deliberately"
        );
        (0..count as usize)
            .map(|index| {
                let at = HEADER + index * stride;
                let mut key = [0_u8; 16];
                key.copy_from_slice(&bytes[at..at + 16]);
                u128::from_be_bytes(key)
            })
            .collect()
    };

    let forward_keys = keys(&forward_bytes);
    assert_eq!(forward_keys, keys(&backward_bytes));
    let mut sorted = forward_keys.clone();
    sorted.sort_unstable();
    assert_eq!(forward_keys, sorted, "keys are encoded in ascending order");

    // The bytes must also agree with the public iterator, or the encoding and
    // the accessor are two different answers to the same question.
    let iterated: Vec<u128> = fold(&forward).proposals().map(|(id, _)| id.get()).collect();
    assert_eq!(iterated, forward_keys);
}

#[test]
fn rejecting_an_event_never_commits_an_effect() {
    let seeded = Seeded::new(13);
    let live = fold(&[received(seeded, 10)]);
    for illegal in [
        admitted(seeded, 20),
        received(seeded, 20),
        admitted(Seeded::new(14), 20),
    ] {
        let rejection = reduce(live.clone(), &illegal).expect_err("illegal event");
        assert_eq!(
            rejection.state.committed_effects(),
            0,
            "a rejected event owes nothing"
        );
        assert_eq!(rejection.state.applied_events(), 1);
    }
}
