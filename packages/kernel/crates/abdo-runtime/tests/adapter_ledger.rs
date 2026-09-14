#![forbid(unsafe_code)]

mod support;

use abdo_contracts::Digest;
use abdo_journal::{EffectId, Journal};
use abdo_runtime::{AdapterEffect, AdapterLedger, EffectPhase, RuntimeError};
use support::TestDirectory;

fn effect(seed: u128, at_ms: u64) -> AdapterEffect {
    AdapterEffect {
        effect_id: EffectId::try_from_u128(seed).expect("effect id"),
        operation_digest: Digest::from_bytes([seed as u8; 32]),
        at_ms,
    }
}

fn phases(path: &std::path::Path, effect_id: EffectId) -> Vec<u8> {
    Journal::open(path)
        .expect("journal")
        .effect_history(effect_id)
        .expect("history")
        .into_iter()
        .map(|record| record.phase_tag.get())
        .collect()
}

#[test]
fn external_adapter_is_barriered_then_verified_in_the_shared_journal() {
    let directory = TestDirectory::new("adapter-ledger-complete");
    let item = effect(0xa11, 1_000);
    {
        let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
        ledger.begin(item).expect("durable dispatch barrier");
    }
    assert_eq!(
        phases(&directory.journal_path(), item.effect_id),
        vec![1, 12, 2, 3],
        "the adapter permit is returned only after Dispatching"
    );
    {
        let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
        ledger
            .settle(
                AdapterEffect {
                    at_ms: 2_000,
                    ..item
                },
                Digest::from_bytes([0x44; 32]),
            )
            .expect("known outcome closes");
    }
    assert_eq!(
        phases(&directory.journal_path(), item.effect_id),
        vec![1, 12, 2, 3, 4, 5, 7]
    );
}

#[test]
fn startup_recovery_marks_post_barrier_crash_unknown_without_retry() {
    let directory = TestDirectory::new("adapter-ledger-recover");
    let item = effect(0xa12, 1_000);
    {
        let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
        ledger.begin(item).expect("begin");
    }
    let first = {
        let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
        ledger.recover(2_000).expect("recover")
    };
    assert_eq!(first.unresolved, 1);
    assert_eq!(first.marked_unknown, 1);
    assert_eq!(
        phases(&directory.journal_path(), item.effect_id),
        vec![1, 12, 2, 3, 6]
    );

    let second = {
        let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
        ledger.recover(3_000).expect("recover again")
    };
    assert_eq!(second.unresolved, 1);
    assert_eq!(
        second.marked_unknown, 0,
        "recovery observes; it never dispatches or duplicates"
    );
}

#[test]
fn an_effect_identity_cannot_be_rebound_to_other_arguments() {
    let directory = TestDirectory::new("adapter-ledger-binding");
    let item = effect(0xa13, 1_000);
    let mut ledger = AdapterLedger::open(&directory.journal_path()).expect("ledger");
    ledger.begin(item).expect("begin");
    let error = ledger
        .mark_unknown(
            AdapterEffect {
                operation_digest: Digest::from_bytes([0xee; 32]),
                at_ms: 2_000,
                ..item
            },
            Digest::from_bytes([0xdd; 32]),
        )
        .expect_err("digest rebinding must fail");
    assert!(matches!(error, RuntimeError::Corrupt(_)));
    drop(ledger);
    assert_eq!(
        phases(&directory.journal_path(), item.effect_id),
        vec![1, 12, 2, 3]
    );
    assert_eq!(EffectPhase::Dispatching.tag(), 3);
}
