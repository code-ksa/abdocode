#![forbid(unsafe_code)]

//! Independent work runs together, conflicting work does not, and no lane
//! starves.

mod support;

use abdo_contracts::IntentId;
use abdo_runtime::{Access, Demand, LaneId, ResourceClaim, ResourceRef, RuntimeError, Scheduler};

fn intent(seed: u128) -> IntentId {
    IntentId::try_from_u128(seed).expect("intent id is non-zero")
}

fn resource(seed: u8) -> ResourceRef {
    ResourceRef::from_bytes([seed; 32])
}

fn demand(seed: u128, lane: u32, deadline_ms: u64, claims: &[(u8, Access)]) -> Demand {
    Demand {
        intent_id: intent(seed),
        lane: LaneId::new(lane),
        deadline_ms,
        claims: claims
            .iter()
            .map(|(id, access)| ResourceClaim {
                resource: resource(*id),
                access: *access,
            })
            .collect(),
    }
}

#[test]
fn only_two_reads_of_one_resource_are_compatible() {
    assert!(!Access::Read.conflicts_with(Access::Read));
    assert!(Access::Read.conflicts_with(Access::Write));
    assert!(Access::Write.conflicts_with(Access::Read));
    // Two writes conflict. Some schedulers let these through when the writes
    // "look independent"; there is no way to know that from here.
    assert!(Access::Write.conflicts_with(Access::Write));
}

#[test]
fn independent_effects_share_a_batch() {
    let mut scheduler = Scheduler::new();
    scheduler
        .submit(demand(1, 1, 1_000, &[(10, Access::Write)]))
        .expect("submit");
    scheduler
        .submit(demand(2, 2, 1_000, &[(20, Access::Write)]))
        .expect("submit");
    scheduler
        .submit(demand(3, 3, 1_000, &[(30, Access::Read)]))
        .expect("submit");

    let batch = scheduler.next_batch(0);
    assert_eq!(batch.admitted.len(), 3, "independent work was serialized");
    assert_eq!(batch.deferred_by_conflict, 0);
    assert_eq!(scheduler.running(), 3);
}

#[test]
fn many_readers_share_but_a_writer_waits_for_all_of_them() {
    let mut scheduler = Scheduler::new();
    for seed in 1..=4 {
        scheduler
            .submit(demand(seed, seed as u32, 1_000, &[(7, Access::Read)]))
            .expect("submit");
    }
    scheduler
        .submit(demand(9, 9, 1_000, &[(7, Access::Write)]))
        .expect("submit");

    let first = scheduler.next_batch(0);
    assert_eq!(first.admitted.len(), 4, "readers failed to share");
    assert!(!first.admitted.contains(&intent(9)));
    assert_eq!(first.deferred_by_conflict, 1);

    // The writer stays out while any reader holds the resource.
    for seed in 1..=3 {
        scheduler.complete(intent(seed)).expect("complete");
    }
    let blocked = scheduler.next_batch(0);
    assert!(
        blocked.admitted.is_empty(),
        "a writer joined while a reader still held the resource"
    );

    scheduler.complete(intent(4)).expect("complete");
    let released = scheduler.next_batch(0);
    assert_eq!(released.admitted, vec![intent(9)]);
}

#[test]
fn conflicting_effects_never_appear_in_the_same_batch() {
    // Checked against the conflict rule directly, not against the scheduler's
    // own bookkeeping: a scheduler that miscounted its holders would otherwise
    // agree with itself.
    let mut scheduler = Scheduler::new();
    let demands: Vec<Demand> = (1..=12)
        .map(|seed| {
            let resource_id = (seed % 3) as u8;
            let access = if seed % 2 == 0 {
                Access::Write
            } else {
                Access::Read
            };
            demand(seed as u128, seed as u32, 1_000, &[(resource_id, access)])
        })
        .collect();
    for entry in &demands {
        scheduler.submit(entry.clone()).expect("submit");
    }

    let mut guard = 0;
    while scheduler.queued() > 0 && guard < 100 {
        guard += 1;
        let batch = scheduler.next_batch(0);
        let in_batch: Vec<&Demand> = batch
            .admitted
            .iter()
            .map(|intent_id| {
                demands
                    .iter()
                    .find(|entry| entry.intent_id == *intent_id)
                    .expect("every admitted demand was submitted")
            })
            .collect();
        for (index, left) in in_batch.iter().enumerate() {
            for right in in_batch.iter().skip(index + 1) {
                assert!(
                    !Scheduler::conflicts(left, right),
                    "batch {guard} put conflicting work together"
                );
            }
        }
        for entry in in_batch {
            scheduler.complete(entry.intent_id).expect("complete");
        }
    }
    assert_eq!(scheduler.queued(), 0, "the scheduler stalled");
}

#[test]
fn a_blocked_lane_blocks_only_itself() {
    let mut scheduler = Scheduler::new();
    // Lane 1 holds a write on resource 5 and has a second demand behind it.
    scheduler
        .submit(demand(1, 1, 1_000, &[(5, Access::Write)]))
        .expect("submit");
    scheduler
        .submit(demand(2, 1, 1_000, &[(5, Access::Write)]))
        .expect("submit");
    // Lane 2 is unrelated.
    scheduler
        .submit(demand(3, 2, 1_000, &[(6, Access::Write)]))
        .expect("submit");

    let first = scheduler.next_batch(0);
    assert!(first.admitted.contains(&intent(1)));
    assert!(
        first.admitted.contains(&intent(3)),
        "an unrelated lane waited behind a blocked one"
    );
    assert!(!first.admitted.contains(&intent(2)));
}

#[test]
fn no_lane_starves_behind_a_busy_one() {
    // A lane that always has work must not permanently outrun a quiet one.
    let mut scheduler = Scheduler::new();
    for seed in 1..=20u128 {
        // Lane 1 is saturated; every demand writes the same resource, so only
        // one can run at a time.
        scheduler
            .submit(demand(seed, 1, 1_000, &[(1, Access::Write)]))
            .expect("submit");
    }
    scheduler
        .submit(demand(100, 2, 1_000, &[(2, Access::Write)]))
        .expect("submit");

    let mut quiet_lane_served_within = None;
    for round in 1..=5 {
        let batch = scheduler.next_batch(0);
        if batch.admitted.contains(&intent(100)) {
            quiet_lane_served_within = Some(round);
        }
        for admitted in batch.admitted {
            scheduler.complete(admitted).expect("complete");
        }
    }
    assert_eq!(
        quiet_lane_served_within,
        Some(1),
        "the quiet lane waited behind a saturated one"
    );
}

#[test]
fn an_overdue_demand_jumps_the_round_but_never_its_own_lane() {
    let mut scheduler = Scheduler::new();
    // Lane 1: two demands on independent resources, the second overdue.
    scheduler
        .submit(demand(1, 1, 9_000, &[(11, Access::Write)]))
        .expect("submit");
    scheduler
        .submit(demand(2, 1, 10, &[(12, Access::Write)]))
        .expect("submit");
    // Lane 2: one demand, not overdue.
    scheduler
        .submit(demand(3, 2, 9_000, &[(13, Access::Write)]))
        .expect("submit");

    let batch = scheduler.next_batch(1_000);
    // The overdue demand is behind a non-overdue one in its own lane, so it
    // does not jump it. Urgency reorders rounds, never a lane.
    assert!(batch.admitted.contains(&intent(1)));
    assert!(!batch.admitted.contains(&intent(2)));
    assert_eq!(batch.overdue_admitted, 0);

    // With the head cleared, the overdue demand is served and counted.
    scheduler.complete(intent(1)).expect("complete");
    let next = scheduler.next_batch(1_000);
    assert!(next.admitted.contains(&intent(2)));
    assert_eq!(next.overdue_admitted, 1);
}

#[test]
fn the_same_demands_produce_the_same_schedule_every_time() {
    let build = || {
        let mut scheduler = Scheduler::new();
        for seed in 1..=24u128 {
            let resource_id = (seed % 5) as u8;
            let access = if seed % 3 == 0 {
                Access::Write
            } else {
                Access::Read
            };
            scheduler
                .submit(demand(
                    seed,
                    (seed % 4) as u32,
                    1_000,
                    &[(resource_id, access)],
                ))
                .expect("submit");
        }
        let mut batches = Vec::new();
        let mut guard = 0;
        while scheduler.queued() > 0 && guard < 200 {
            guard += 1;
            let batch = scheduler.next_batch(0);
            for admitted in &batch.admitted {
                scheduler.complete(*admitted).expect("complete");
            }
            batches.push(batch);
        }
        batches
    };

    let first = build();
    let second = build();
    assert_eq!(
        Scheduler::decision_fingerprint(&first),
        Scheduler::decision_fingerprint(&second),
        "the same demands scheduled differently twice"
    );
    assert!(first.iter().any(|batch| batch.admitted.len() > 1));
}

#[test]
fn a_demand_that_claims_nothing_is_refused() {
    // Otherwise it would be trivially compatible with everything, which is a
    // way of saying the scheduler has no idea what it touches.
    let mut scheduler = Scheduler::new();
    let empty = Demand {
        intent_id: intent(1),
        lane: LaneId::new(1),
        deadline_ms: 0,
        claims: Vec::new(),
    };
    assert!(matches!(
        scheduler.submit(empty),
        Err(RuntimeError::Corrupt(_))
    ));
}

#[test]
fn completing_something_that_is_not_running_is_refused() {
    let mut scheduler = Scheduler::new();
    assert!(matches!(
        scheduler.complete(intent(1)),
        Err(RuntimeError::Corrupt(_))
    ));
}
