//! The deterministic effect scheduler.
//!
//! Two effects may run together exactly when nothing they touch overlaps in a
//! way that matters: shared reads are fine, a shared write is not. That single
//! rule is the whole scheduler, and everything else here exists to apply it
//! without introducing a second source of truth about ordering.
//!
//! # Deterministic
//!
//! Given the same demands in the same order, the same batches come out, on any
//! machine. There is no clock inside the scheduler, no hash container, and no
//! reliance on the order a caller happened to insert things into a map. The
//! only time it sees is the time a caller passes in, and it is used for
//! deadlines, never for ordering.
//!
//! # Fair
//!
//! Lanes are the caller's serialization domains: within a lane, order is
//! preserved. Across lanes, service rotates, so no lane waits behind another
//! indefinitely. A lane whose head is blocked blocks that lane and nothing
//! else, which is the point of having lanes at all.
//!
//! Deadlines are honoured without letting them break fairness: a batch is built
//! in two rotations, overdue lane heads first and the rest second. An urgent
//! demand jumps the round, never the queue inside its own lane.

use std::collections::{BTreeMap, VecDeque};

use abdo_contracts::IntentId;
use abdo_kernel::Fingerprint;

use crate::error::RuntimeError;

/// An opaque resource identity. The scheduler never interprets it.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ResourceRef([u8; 32]);

impl ResourceRef {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// How an effect touches a resource.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Access {
    Read = 1,
    Write = 2,
}

impl Access {
    pub const fn tag(self) -> u8 {
        self as u8
    }

    /// Do these two accesses to the same resource conflict?
    ///
    /// Only reads share. Everything else is a conflict, including two writes,
    /// which some schedulers quietly allow when the writes "look independent".
    pub const fn conflicts_with(self, other: Self) -> bool {
        !matches!((self, other), (Self::Read, Self::Read))
    }
}

/// A lane is a caller-chosen serialization domain.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LaneId(u32);

impl LaneId {
    pub const fn new(lane: u32) -> Self {
        Self(lane)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// One resource an effect claims, and how.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceClaim {
    pub resource: ResourceRef,
    pub access: Access,
}

/// One effect asking to be scheduled.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Demand {
    pub intent_id: IntentId,
    pub lane: LaneId,
    /// When this becomes overdue. Used for urgency, never for ordering inside a
    /// lane: a deadline may let a demand jump the round, never the queue.
    pub deadline_ms: u64,
    pub claims: Vec<ResourceClaim>,
}

impl Demand {
    fn conflicts_with(&self, other: &Self) -> bool {
        self.claims.iter().any(|mine| {
            other.claims.iter().any(|theirs| {
                mine.resource == theirs.resource && mine.access.conflicts_with(theirs.access)
            })
        })
    }
}

/// Resources currently held by running work.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Holders {
    readers: u32,
    writers: u32,
}

/// One batch of effects that may run at the same time.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Batch {
    pub admitted: Vec<IntentId>,
    /// Lane heads that were eligible but conflicted with something already in
    /// this batch. Reported so serialization is visible rather than inferred.
    pub deferred_by_conflict: usize,
    pub overdue_admitted: usize,
}

/// The scheduler.
#[derive(Debug, Default)]
pub struct Scheduler {
    lanes: BTreeMap<u32, VecDeque<Demand>>,
    running: BTreeMap<u128, Demand>,
    held: BTreeMap<[u8; 32], Holders>,
    /// Rotation cursor. Advancing it every batch is what keeps a busy lane from
    /// permanently outrunning a quiet one.
    cursor: usize,
    admitted: u64,
    batches: u64,
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub const fn admitted(&self) -> u64 {
        self.admitted
    }

    pub const fn batches(&self) -> u64 {
        self.batches
    }

    pub fn queued(&self) -> usize {
        self.lanes.values().map(VecDeque::len).sum()
    }

    pub fn running(&self) -> usize {
        self.running.len()
    }

    /// Queue a demand at the back of its lane.
    pub fn submit(&mut self, demand: Demand) -> Result<(), RuntimeError> {
        if demand.claims.is_empty() {
            return Err(RuntimeError::Corrupt(
                "a demand that claims nothing cannot be scheduled".into(),
            ));
        }
        if self.running.contains_key(&demand.intent_id.get()) {
            return Err(RuntimeError::Corrupt(
                "an effect already running cannot be resubmitted".into(),
            ));
        }
        self.lanes
            .entry(demand.lane.get())
            .or_default()
            .push_back(demand);
        Ok(())
    }

    /// Build the next batch of effects that may run together.
    ///
    /// Two rotations: overdue lane heads first, then everything else. Both
    /// rotate from the same advancing cursor, so urgency never becomes a way
    /// for one lane to monopolise the scheduler.
    pub fn next_batch(&mut self, now_ms: u64) -> Batch {
        let mut batch = Batch::default();
        let lane_ids: Vec<u32> = self.lanes.keys().copied().collect();
        if lane_ids.is_empty() {
            return batch;
        }
        let start = self.cursor % lane_ids.len();

        for pass in 0..2 {
            let overdue_pass = pass == 0;
            for offset in 0..lane_ids.len() {
                let lane = lane_ids[(start + offset) % lane_ids.len()];
                // At most one admission per lane per pass. Draining a lane
                // greedily here is precisely how a busy lane starves a quiet
                // one, so this is deliberately not a loop.
                let Some(head) = self.lanes.get(&lane).and_then(VecDeque::front) else {
                    continue;
                };
                let is_overdue = head.deadline_ms <= now_ms;
                if is_overdue != overdue_pass {
                    continue;
                }
                if !self.is_compatible(head) {
                    // Head-of-line: this lane waits, and only this lane.
                    batch.deferred_by_conflict += 1;
                    continue;
                }
                let demand = self
                    .lanes
                    .get_mut(&lane)
                    .and_then(VecDeque::pop_front)
                    .expect("the head was just observed");
                self.acquire(&demand);
                batch.admitted.push(demand.intent_id);
                if is_overdue {
                    batch.overdue_admitted += 1;
                }
                self.admitted += 1;
                self.running.insert(demand.intent_id.get(), demand);
            }
        }

        self.lanes.retain(|_, queue| !queue.is_empty());
        self.cursor = self.cursor.wrapping_add(1);
        if !batch.admitted.is_empty() {
            self.batches += 1;
        }
        batch
    }

    /// Release an effect and everything it held.
    pub fn complete(&mut self, intent_id: IntentId) -> Result<(), RuntimeError> {
        let demand = self.running.remove(&intent_id.get()).ok_or_else(|| {
            RuntimeError::Corrupt("completing an effect that is not running".into())
        })?;
        for claim in &demand.claims {
            if let Some(holders) = self.held.get_mut(claim.resource.as_bytes()) {
                match claim.access {
                    Access::Read => holders.readers = holders.readers.saturating_sub(1),
                    Access::Write => holders.writers = holders.writers.saturating_sub(1),
                }
                if holders.readers == 0 && holders.writers == 0 {
                    self.held.remove(claim.resource.as_bytes());
                }
            }
        }
        Ok(())
    }

    /// Is anything currently running incompatible with this demand?
    fn is_compatible(&self, demand: &Demand) -> bool {
        demand
            .claims
            .iter()
            .all(|claim| match self.held.get(claim.resource.as_bytes()) {
                None => true,
                Some(holders) => match claim.access {
                    Access::Read => holders.writers == 0,
                    Access::Write => holders.readers == 0 && holders.writers == 0,
                },
            })
    }

    fn acquire(&mut self, demand: &Demand) {
        for claim in &demand.claims {
            let holders = self.held.entry(*claim.resource.as_bytes()).or_default();
            match claim.access {
                Access::Read => holders.readers += 1,
                Access::Write => holders.writers += 1,
            }
        }
    }

    /// Do these two demands conflict? Exposed so a checker can verify a batch
    /// independently of the scheduler that produced it.
    pub fn conflicts(left: &Demand, right: &Demand) -> bool {
        left.conflicts_with(right)
    }

    /// A fingerprint of the scheduler's decisions so far.
    ///
    /// Two runs over the same demands must agree. Without this, "deterministic"
    /// would be a claim nobody checks.
    pub fn decision_fingerprint(batches: &[Batch]) -> Fingerprint {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"S111/schedule/1");
        for batch in batches {
            bytes.extend_from_slice(&(batch.admitted.len() as u64).to_be_bytes());
            for intent in &batch.admitted {
                bytes.extend_from_slice(&intent.get().to_be_bytes());
            }
        }
        Fingerprint::of(&bytes)
    }
}
