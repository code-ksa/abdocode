#![forbid(unsafe_code)]

//! The exact S111 gate: a hundred thousand scheduling decisions with zero
//! conflicting writes, real parallelism, and no starved lane.
//!
//! Conflicts are checked against the rule directly, on every pair in every
//! batch, rather than against the scheduler's own bookkeeping. A scheduler that
//! miscounted its held resources would otherwise agree with itself perfectly.

mod support;

use std::collections::BTreeMap;
use std::time::Instant;

use abdo_contracts::IntentId;
use abdo_runtime::{Access, Demand, LaneId, ResourceClaim, ResourceRef, Scheduler};
use support::SplitMix64;

const PARENT_GATE_ENV: &str = "ABDO_RUNTIME_SCHEDULE_PARENT_GATE";
const DEMANDS: u64 = 100_000;
const LANES: u32 = 24;
const RESOURCES: u8 = 48;
const GLOBAL_TIMEOUT_MS: u128 = 5 * 60 * 1_000;

#[test]
#[ignore = "S111 exact 100,000-decision scheduling gate"]
fn a_hundred_thousand_decisions_never_overlap_a_write() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S111 scheduling gate requires its exact parent marker"
    );

    let started = Instant::now();
    let mut random = SplitMix64::new(0x5111_0000_5111_0000);
    let mut scheduler = Scheduler::new();
    let mut catalogue: BTreeMap<u128, Demand> = BTreeMap::new();

    for seed in 1..=u128::from(DEMANDS) {
        // Between one and three claims, so demands genuinely overlap sometimes
        // and genuinely do not at other times.
        let claim_count = 1 + random.below(3) as usize;
        let mut claims = Vec::with_capacity(claim_count);
        let mut used = Vec::with_capacity(claim_count);
        for _ in 0..claim_count {
            let resource_id = random.below(u64::from(RESOURCES)) as u8;
            if used.contains(&resource_id) {
                continue;
            }
            used.push(resource_id);
            claims.push(ResourceClaim {
                resource: ResourceRef::from_bytes([resource_id; 32]),
                // One in three writes: enough contention to force real
                // serialization, not so much that nothing ever shares.
                access: if random.below(3) == 0 {
                    Access::Write
                } else {
                    Access::Read
                },
            });
        }
        let demand = Demand {
            intent_id: IntentId::try_from_u128(seed).expect("intent id"),
            lane: LaneId::new((random.below(u64::from(LANES))) as u32),
            deadline_ms: random.below(2_000),
            claims,
        };
        catalogue.insert(seed, demand.clone());
        scheduler.submit(demand).expect("submit");
    }

    let mut batches = 0_u64;
    let mut admitted = 0_u64;
    let mut widest = 0_usize;
    let mut parallel_batches = 0_u64;
    let mut checked_pairs = 0_u64;
    let mut serialized = 0_u64;
    let mut lane_first_service: BTreeMap<u32, u64> = BTreeMap::new();
    let mut now_ms = 0_u64;
    let mut decisions = Vec::new();

    while scheduler.queued() > 0 {
        assert!(
            started.elapsed().as_millis() < GLOBAL_TIMEOUT_MS,
            "S111 gate exceeded its global time bound"
        );
        now_ms += 1;
        let batch = scheduler.next_batch(now_ms);
        if batch.admitted.is_empty() {
            panic!("the scheduler stalled with {} queued", scheduler.queued());
        }
        batches += 1;
        admitted += batch.admitted.len() as u64;
        widest = widest.max(batch.admitted.len());
        if batch.admitted.len() > 1 {
            parallel_batches += 1;
        }
        serialized += batch.deferred_by_conflict as u64;

        let members: Vec<&Demand> = batch
            .admitted
            .iter()
            .map(|intent_id| catalogue.get(&intent_id.get()).expect("submitted"))
            .collect();
        for (index, left) in members.iter().enumerate() {
            lane_first_service.entry(left.lane.get()).or_insert(batches);
            for right in members.iter().skip(index + 1) {
                checked_pairs += 1;
                assert!(
                    !Scheduler::conflicts(left, right),
                    "batch {batches} scheduled conflicting work together"
                );
            }
        }

        decisions.push(batch.clone());
        for admitted_id in batch.admitted {
            scheduler.complete(admitted_id).expect("complete");
        }
    }

    assert_eq!(admitted, DEMANDS, "the scheduler lost a demand");
    assert_eq!(scheduler.admitted(), DEMANDS);
    assert!(
        parallel_batches > 0 && widest > 1,
        "nothing ever ran in parallel, so the scheduler only proved it can serialize"
    );
    assert!(
        serialized > 0,
        "nothing was ever deferred, so no conflict was ever exercised"
    );
    assert!(
        checked_pairs > 0,
        "no pair was ever checked, so zero conflicts proves nothing"
    );

    // Every lane that had work was served, and none waited an unbounded number
    // of rounds behind the others.
    assert_eq!(
        lane_first_service.len() as u32,
        LANES,
        "a lane was never served at all"
    );
    let slowest_first_service = *lane_first_service
        .values()
        .max()
        .expect("at least one lane ran");
    assert!(
        slowest_first_service <= u64::from(LANES),
        "a lane waited {slowest_first_service} rounds for its first service"
    );

    let fingerprint = Scheduler::decision_fingerprint(&decisions);
    let mean_width = admitted as f64 / batches as f64;
    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S111_SCHEDULE demands={DEMANDS} admitted={admitted} batches={batches} widest={widest} parallel_batches={parallel_batches} mean_width={mean_width:.3} checked_pairs={checked_pairs} conflicting_pairs=0 serialized={serialized} lanes={LANES} slowest_first_service={slowest_first_service} fingerprint={} elapsed_ms={elapsed_ms}",
        fingerprint.to_hex()
    );
}
