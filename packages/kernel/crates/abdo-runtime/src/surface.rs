//! Surfaces: a reference that stops being valid when the world moves.
//!
//! # What this is not
//!
//! There is no CDP here, no UIA, no vision, and no notion of what a page
//! *means*. Deciding what to click is strategy and lives in Bun. What lives
//! here is the one thing strategy cannot be trusted with: whether the surface a
//! decision was made against is still the surface in front of us.
//!
//! # Three counters, because they fail differently
//!
//! A navigation replaces the document. A window generation replaces the frame
//! coordinates mean anything in. A view generation moves what is on screen
//! without changing either. An action that was correct against one can be wrong
//! against another, and one counter could not say which — so
//! [`abdo_contracts::SurfaceGenerations`] carries all three and any of them
//! moving is enough.
//!
//! # The action carries what the caller believed
//!
//! [`abdo_contracts::SurfaceAction`] holds the generations it was decided
//! against, rather than looking them up when it runs. Looking them up at
//! execution would read the world as it is now and lose the only fact that
//! matters — what was true when the choice was made — which is exactly the
//! comparison that catches a stale target.

use std::collections::BTreeMap;

use abdo_contracts::{SurfaceAction, SurfaceGenerations, SurfaceKind, SurfaceTargetRef};

/// Why an action was not admitted against its surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Staleness {
    /// The document was replaced.
    Navigated { seen: u64, current: u64 },
    /// The frame the coordinates were expressed in was replaced.
    Reframed { seen: u64, current: u64 },
    /// What is on screen moved.
    Scrolled { seen: u64, current: u64 },
    /// The surface was never registered, or has been withdrawn.
    Unknown,
    /// The action names a different kind of surface than the one registered.
    ///
    /// A browser action against a desktop, or the reverse. Refused rather than
    /// coerced: the two agree about almost nothing except that they have
    /// coordinates.
    WrongKind,
}

/// What the kernel currently believes about one surface.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Live {
    kind: SurfaceKind,
    generations: SurfaceGenerations,
}

/// The surfaces this kernel will admit actions against.
///
/// Ordered, and holding no clock: whether an action is stale is a comparison of
/// numbers the caller and the registry both hold, not a question about how much
/// time has passed.
#[derive(Debug, Default)]
pub struct SurfaceRegistry {
    live: BTreeMap<[u8; 32], Live>,
    admitted: u64,
    refused: u64,
}

impl SurfaceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub const fn admitted(&self) -> u64 {
        self.admitted
    }

    pub const fn refused(&self) -> u64 {
        self.refused
    }

    pub fn len(&self) -> usize {
        self.live.len()
    }

    pub fn is_empty(&self) -> bool {
        self.live.is_empty()
    }

    /// Record a surface, or move it forward.
    pub fn observe(
        &mut self,
        kind: SurfaceKind,
        target: &SurfaceTargetRef,
        generations: SurfaceGenerations,
    ) {
        self.live
            .insert(*target.surface.as_bytes(), Live { kind, generations });
    }

    /// Withdraw a surface entirely.
    ///
    /// Distinct from moving its generations: a closed window is not a window
    /// that scrolled, and a caller told the wrong one of those would retry
    /// against something that no longer exists.
    pub fn withdraw(&mut self, target: &SurfaceTargetRef) -> bool {
        self.live.remove(target.surface.as_bytes()).is_some()
    }

    /// The generations this surface is at now, if it is still here.
    pub fn generations(&self, target: &SurfaceTargetRef) -> Option<SurfaceGenerations> {
        self.live
            .get(target.surface.as_bytes())
            .map(|entry| entry.generations.clone())
    }

    /// May this action run?
    ///
    /// The comparison is exact and in a fixed order, so a caller told
    /// "navigated" learns the most consequential thing first: everything it
    /// believed about the document is void, not merely its coordinates.
    pub fn admit(&mut self, action: &SurfaceAction) -> Result<(), Staleness> {
        let Some(live) = self.live.get(action.target.surface.as_bytes()) else {
            self.refused += 1;
            return Err(Staleness::Unknown);
        };
        if live.kind != action.kind {
            self.refused += 1;
            return Err(Staleness::WrongKind);
        }
        let seen = &action.generations;
        let current = &live.generations;
        if seen.navigation != current.navigation {
            self.refused += 1;
            return Err(Staleness::Navigated {
                seen: seen.navigation,
                current: current.navigation,
            });
        }
        if seen.window != current.window {
            self.refused += 1;
            return Err(Staleness::Reframed {
                seen: seen.window,
                current: current.window,
            });
        }
        if seen.view != current.view {
            self.refused += 1;
            return Err(Staleness::Scrolled {
                seen: seen.view,
                current: current.view,
            });
        }
        self.admitted += 1;
        Ok(())
    }
}
