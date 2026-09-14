//! Budgets and fencing: what the kernel refuses, and to whom.
//!
//! # The budget stops the dispatch, not the report
//!
//! A budget checked after an effect ran is an accounting note. This one is
//! consulted before [`crate::EffectSupervisor::commit_dispatch`], so exceeding
//! it prevents the world from changing rather than describing how it changed.
//! The charge is taken at the same moment, and the ceiling is enforced by the
//! database, so a caller that miscomputes the arithmetic still cannot overspend.
//!
//! # The fencing token survives the crash it defends against
//!
//! A generation held in memory is reset by exactly the event it exists to
//! protect against. These come from the durable lease table, so a restarted
//! kernel cannot reissue a number a previous run already used, and a worker
//! that was paused across the restart is stale the moment somebody else takes
//! the lease.
//!
//! "Stale" is decided by comparison with the stored maximum, never by asking
//! the worker whether it thinks it is current.

use abdo_journal::{HolderId, Journal, JournalError, LeaseRecord, ScopeId};

use crate::error::RuntimeError;

/// The four things a run can exhaust.
///
/// The discriminants are stored, so they are fixed.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum BudgetDimension {
    /// Milliseconds of wall clock.
    Wall = 1,
    Tokens = 2,
    /// Cost in millionths of a currency unit, so money is never a float.
    CostMicros = 3,
    /// Effects dispatched.
    Actions = 4,
}

pub const BUDGET_DIMENSIONS: [BudgetDimension; 4] = [
    BudgetDimension::Wall,
    BudgetDimension::Tokens,
    BudgetDimension::CostMicros,
    BudgetDimension::Actions,
];

impl BudgetDimension {
    pub const fn tag(self) -> u8 {
        self as u8
    }

    pub fn from_tag(tag: u8) -> Option<Self> {
        BUDGET_DIMENSIONS
            .into_iter()
            .find(|dimension| dimension.tag() == tag)
    }
}

/// What one dispatch is expected to consume.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Charge {
    pub wall_ms: u64,
    pub tokens: u64,
    pub cost_micros: u64,
    pub actions: u64,
}

impl Charge {
    /// One action and nothing else, the common case.
    pub const fn one_action() -> Self {
        Self {
            wall_ms: 0,
            tokens: 0,
            cost_micros: 0,
            actions: 1,
        }
    }

    pub const fn amount(&self, dimension: BudgetDimension) -> u64 {
        match dimension {
            BudgetDimension::Wall => self.wall_ms,
            BudgetDimension::Tokens => self.tokens,
            BudgetDimension::CostMicros => self.cost_micros,
            BudgetDimension::Actions => self.actions,
        }
    }
}

/// Why a dispatch was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    /// A dimension would have gone past its limit.
    BudgetExhausted {
        dimension: BudgetDimension,
        limit: u64,
        consumed: u64,
        requested: u64,
    },
    /// The holder is not the current generation. It was fenced out.
    StaleLease { held: u64, current: u64 },
    /// The lease ran out of time.
    LeaseExpired { expires_at_ms: u64, now_ms: u64 },
    /// No lease exists for this scope at all.
    NoLease,
}

/// The verdict on one attempted dispatch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Admission {
    /// Cleared, and the charge has been taken.
    Cleared,
    Refused(Refusal),
}

impl Admission {
    pub const fn is_cleared(self) -> bool {
        matches!(self, Self::Cleared)
    }
}

/// A worker's claim to act. Carries the generation it was issued with.
///
/// The generation is the whole point: a worker holds a number, and the kernel
/// compares it against the stored maximum. A worker cannot make itself current
/// by holding on to an old token.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FencedHolder {
    pub scope: ScopeId,
    pub holder: HolderId,
    pub generation: u64,
}

/// Enforces budgets and fencing. Holds no state: the journal does.
#[derive(Clone, Copy, Debug, Default)]
pub struct Governor;

impl Governor {
    pub const fn new() -> Self {
        Self
    }

    /// Take a lease for a scope, fencing out whoever held it before.
    pub fn take_lease(
        &self,
        journal: &mut Journal,
        scope: ScopeId,
        holder: HolderId,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<FencedHolder, RuntimeError> {
        let lease = journal
            .issue_lease(scope, holder, now_ms, now_ms.saturating_add(ttl_ms.max(1)))
            .map_err(RuntimeError::Journal)?;
        Ok(FencedHolder {
            scope,
            holder,
            generation: lease.generation,
        })
    }

    /// Declare a limit. Setting one twice does not move it.
    pub fn set_limit(
        &self,
        journal: &mut Journal,
        scope: ScopeId,
        dimension: BudgetDimension,
        limit: u64,
    ) -> Result<(), RuntimeError> {
        journal
            .set_budget(scope, dimension.tag(), limit)
            .map_err(RuntimeError::Journal)
    }

    pub fn current_lease(
        &self,
        journal: &Journal,
        scope: ScopeId,
    ) -> Result<Option<LeaseRecord>, RuntimeError> {
        journal.current_lease(scope).map_err(RuntimeError::Journal)
    }

    /// Is this holder still the one entitled to act?
    pub fn check_fence(
        &self,
        journal: &Journal,
        held: FencedHolder,
        now_ms: u64,
    ) -> Result<Admission, RuntimeError> {
        let Some(current) = journal
            .current_lease(held.scope)
            .map_err(RuntimeError::Journal)?
        else {
            return Ok(Admission::Refused(Refusal::NoLease));
        };
        if current.generation != held.generation {
            return Ok(Admission::Refused(Refusal::StaleLease {
                held: held.generation,
                current: current.generation,
            }));
        }
        if current.expires_at_ms <= now_ms {
            return Ok(Admission::Refused(Refusal::LeaseExpired {
                expires_at_ms: current.expires_at_ms,
                now_ms,
            }));
        }
        Ok(Admission::Cleared)
    }

    /// Decide whether a dispatch may proceed, and take the charge if so.
    ///
    /// Fencing is checked first, then every budget dimension, and only then is
    /// anything charged. Charging a dimension before knowing the others clear
    /// would leave a refused dispatch having spent part of a budget.
    pub fn admit(
        &self,
        journal: &mut Journal,
        held: FencedHolder,
        charge: Charge,
        now_ms: u64,
    ) -> Result<Admission, RuntimeError> {
        let fence = self.check_fence(journal, held, now_ms)?;
        if !fence.is_cleared() {
            return Ok(fence);
        }

        // Look before charging. A dimension charged while a later one refuses
        // would spend a budget on a dispatch that never happened.
        for dimension in BUDGET_DIMENSIONS {
            let requested = charge.amount(dimension);
            if requested == 0 {
                continue;
            }
            let Some(line) = journal
                .budget(held.scope, dimension.tag())
                .map_err(RuntimeError::Journal)?
            else {
                continue;
            };
            if line.remaining() < requested {
                return Ok(Admission::Refused(Refusal::BudgetExhausted {
                    dimension,
                    limit: line.limit,
                    consumed: line.consumed,
                    requested,
                }));
            }
        }

        for dimension in BUDGET_DIMENSIONS {
            let requested = charge.amount(dimension);
            if requested == 0 {
                continue;
            }
            let taken = journal
                .charge(held.scope, dimension.tag(), requested)
                .map_err(RuntimeError::Journal)?;
            if !taken {
                // The database refused what the look-ahead cleared. That means
                // something else charged in between, and reporting it as a
                // refusal is the honest answer.
                let line = journal
                    .budget(held.scope, dimension.tag())
                    .map_err(RuntimeError::Journal)?
                    .ok_or_else(|| {
                        RuntimeError::Corrupt("a charged budget line vanished".into())
                    })?;
                return Ok(Admission::Refused(Refusal::BudgetExhausted {
                    dimension,
                    limit: line.limit,
                    consumed: line.consumed,
                    requested,
                }));
            }
        }
        Ok(Admission::Cleared)
    }

    /// What a scope has spent, per dimension.
    pub fn accounting(
        &self,
        journal: &Journal,
        scope: ScopeId,
    ) -> Result<Vec<(BudgetDimension, u64, u64)>, RuntimeError> {
        let mut rows = Vec::new();
        for dimension in BUDGET_DIMENSIONS {
            if let Some(line) = journal
                .budget(scope, dimension.tag())
                .map_err(RuntimeError::Journal)?
            {
                rows.push((dimension, line.consumed, line.limit));
            }
        }
        Ok(rows)
    }
}

impl From<JournalError> for Refusal {
    fn from(_: JournalError) -> Self {
        Self::NoLease
    }
}
