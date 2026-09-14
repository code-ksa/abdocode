//! Catalog snapshots, and showing a model less than everything.
//!
//! # A snapshot is a copy, not a view
//!
//! [`CatalogSnapshot`] owns its contents. It holds no reference to the
//! [`crate::ToolCatalog`] it came from, so a registration that lands mid-step
//! cannot reach it — not because anything declines to look, but because there
//! is nothing to look at. "The catalog a step sees does not shift under it" is
//! therefore a fact about the type rather than a discipline the callers keep.
//!
//! The same property is what makes an update safe: a run that took a snapshot
//! yesterday still resolves exactly the tools it saw, and still hashes to the
//! same digest, however far the live catalog has moved since.
//!
//! # Progressive disclosure
//!
//! Every tool contributes a [`Brief`] — its identifier, its name digest and
//! what class of effect it is. Nothing else. The full schema is disclosed only
//! for the handful a search returned, so the cost of a step is
//! `all briefs + a few schemas` rather than `all schemas`.
//!
//! What is measured here is **characters**, not tokens. Every token estimate in
//! this product divides a character count by one constant, which lives in
//! `packages/schema/src/tokens.ts` and nowhere else; a ratio of two character
//! counts is therefore the same ratio of two token counts, up to the rounding
//! of a single token per measurement. Writing a second divisor here to say the
//! same thing in a different unit is exactly the duplication that estimator
//! exists to end.
//!
//! # The search knows shapes, not words
//!
//! The kernel never sees a tool's name, only its digest, so
//! [`CatalogSnapshot::capability_search`] ranks by distance between the query's
//! affinity and each tool's name digest. A caller that knew the exact digest
//! would not need to search; the interesting case, and the one measured, is a
//! caller that knows roughly what it wants.

use std::collections::BTreeMap;

use abdo_contracts::{
    CatalogHandle, Digest, EffectClass, Enforcement, ToolId, ToolSpec, WireEncode, Writer,
};
use sha2::{Digest as _, Sha256};

const SNAPSHOT_DOMAIN: &[u8] = b"ABDO/RUNTIME/CATALOG-SNAPSHOT/1\0";

/// What every tool contributes to a step, whether or not it is used.
///
/// Deliberately three fields. A brief that grew a description would be a full
/// schema arriving one field at a time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Brief {
    pub tool_id: ToolId,
    pub name_digest: Digest,
    /// Which arm of [`EffectClass`] this is, as a tag.
    ///
    /// The tag rather than the class, because the class carries the recovery
    /// plan and the endpoint digests, and none of that belongs in a summary.
    pub class_tag: u8,
    pub enforcement: Enforcement,
}

impl Brief {
    /// Characters this costs a prompt.
    ///
    /// Two per encoded byte, the width of a hex rendering. The factor is the
    /// same for briefs and schemas, so it cancels in the ratio that matters and
    /// the ratio is the only claim made from it.
    pub fn disclosure_chars(&self) -> usize {
        // tool_id (16) + name digest (32) + class tag (1) + enforcement (1).
        (16 + 32 + 1 + 1) * 2
    }
}

/// A tool as its full schema, disclosed only when it was asked for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disclosed {
    pub spec: ToolSpec,
}

impl Disclosed {
    pub fn disclosure_chars(&self) -> usize {
        encoded_len(&self.spec) * 2
    }
}

/// What a caller is looking for, and how much it will accept.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchQuery {
    /// Roughly what is wanted. Compared against each tool's name digest.
    pub affinity: Digest,
    /// Restrict to one class, or `None` for any.
    pub class_tag: Option<u8>,
    /// The disclosure budget, in tools.
    pub limit: usize,
}

/// What a search disclosed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchResult {
    /// The full schemas, best match first.
    pub disclosed: Vec<Disclosed>,
    /// How many tools the query could have matched, before the budget.
    ///
    /// Reported so a caller can tell "there were three" from "there were three
    /// thousand and you are seeing eight of them".
    pub considered: usize,
}

impl SearchResult {
    pub fn contains(&self, tool_id: ToolId) -> bool {
        self.disclosed
            .iter()
            .any(|entry| entry.spec.tool_id == tool_id)
    }

    pub fn disclosure_chars(&self) -> usize {
        self.disclosed.iter().map(Disclosed::disclosure_chars).sum()
    }
}

/// An immutable catalog, as one step saw it.
#[derive(Clone, Debug)]
pub struct CatalogSnapshot {
    handle: CatalogHandle,
    digest: Digest,
    entries: BTreeMap<u128, Entry>,
}

#[derive(Clone, Debug)]
struct Entry {
    spec: ToolSpec,
    enforcement: Enforcement,
}

impl CatalogSnapshot {
    /// Build one. Called by [`crate::ToolCatalog::snapshot`], not directly.
    pub(crate) fn build(
        handle: CatalogHandle,
        entries: BTreeMap<u128, (ToolSpec, Enforcement)>,
    ) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(SNAPSHOT_DOMAIN);
        hasher.update(handle.as_bytes());
        hasher.update((entries.len() as u64).to_be_bytes());
        let entries: BTreeMap<u128, Entry> = entries
            .into_iter()
            .map(|(id, (spec, enforcement))| {
                // Ordered, and every part length-prefixed, so the digest is a
                // statement about which tools were present rather than about
                // the order a map happened to yield them in.
                hasher.update(id.to_be_bytes());
                let encoded = encoded_bytes(&spec);
                hasher.update((encoded.len() as u32).to_be_bytes());
                hasher.update(&encoded);
                hasher.update([enforcement_tag(enforcement)]);
                (id, Entry { spec, enforcement })
            })
            .collect();
        Self {
            handle,
            digest: Digest::from_bytes(hasher.finalize().into()),
            entries,
        }
    }

    pub const fn handle(&self) -> CatalogHandle {
        self.handle
    }

    /// What this snapshot contains, as one value.
    ///
    /// Two snapshots with the same digest saw the same tools. A step that
    /// records this can be replayed against the catalog it actually ran on.
    pub const fn digest(&self) -> Digest {
        self.digest
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The summary every tool contributes, whether or not it is used.
    pub fn briefs(&self) -> Vec<Brief> {
        self.entries
            .values()
            .map(|entry| Brief {
                tool_id: entry.spec.tool_id,
                name_digest: entry.spec.name_digest,
                class_tag: class_tag(&entry.spec.effect),
                enforcement: entry.enforcement,
            })
            .collect()
    }

    /// What the briefs cost, all of them.
    pub fn brief_chars(&self) -> usize {
        self.briefs().iter().map(Brief::disclosure_chars).sum()
    }

    /// What disclosing every schema would cost.
    ///
    /// The number progressive disclosure exists to avoid, reported so the
    /// saving is a measurement rather than an assertion.
    pub fn full_chars(&self) -> usize {
        self.entries
            .values()
            .map(|entry| encoded_len(&entry.spec) * 2)
            .sum()
    }

    /// Disclose the schemas closest to what was asked for.
    ///
    /// Deterministic: same snapshot, same query, same answer, on any machine
    /// and in any process. There is no clock and no hash container here, for
    /// the same reason there is none in the reducer.
    pub fn capability_search(&self, query: &SearchQuery) -> SearchResult {
        let mut ranked: Vec<(u128, u128)> = Vec::new();
        let mut considered = 0;
        for entry in self.entries.values() {
            if let Some(wanted) = query.class_tag {
                if class_tag(&entry.spec.effect) != wanted {
                    continue;
                }
            }
            considered += 1;
            ranked.push((
                distance(&query.affinity, &entry.spec.name_digest),
                entry.spec.tool_id.get(),
            ));
        }
        // Nearest first, and ties broken by identifier rather than by whatever
        // order the sort happened to leave them in. A tie broken arbitrarily is
        // a search that answers differently on two machines.
        ranked.sort_unstable();
        let disclosed = ranked
            .into_iter()
            .take(query.limit)
            .filter_map(|(_, id)| {
                self.entries.get(&id).map(|entry| Disclosed {
                    spec: entry.spec.clone(),
                })
            })
            .collect();
        SearchResult {
            disclosed,
            considered,
        }
    }

    /// The full schema for one tool, by identifier.
    pub fn disclose(&self, tool_id: ToolId) -> Option<Disclosed> {
        self.entries.get(&tool_id.get()).map(|entry| Disclosed {
            spec: entry.spec.clone(),
        })
    }
}

/// Which arm of the class this is, without the payload.
pub fn class_tag(class: &EffectClass) -> u8 {
    match class {
        EffectClass::Read(_) => 1,
        EffectClass::Mutate(_) => 2,
        EffectClass::Reach(_) => 3,
        EffectClass::Spend(_) => 4,
        EffectClass::Irreversible(_) => 5,
    }
}

const fn enforcement_tag(enforcement: Enforcement) -> u8 {
    match enforcement {
        Enforcement::Full => 1,
        Enforcement::Partial => 2,
        Enforcement::Unavailable => 3,
    }
}

/// How far apart two digests are, over their leading bytes.
///
/// Bitwise rather than numeric: a caller that is close in one field should not
/// be dragged far away by a carry out of another.
fn distance(left: &Digest, right: &Digest) -> u128 {
    let mut lead = [0_u8; 16];
    for (index, slot) in lead.iter_mut().enumerate() {
        *slot = left.as_bytes()[index] ^ right.as_bytes()[index];
    }
    u128::from_be_bytes(lead)
}

fn encoded_bytes<T: WireEncode>(value: &T) -> Vec<u8> {
    let mut writer = Writer::new();
    value
        .encode_to(&mut writer)
        .expect("a registered spec was validated when it was admitted");
    writer.into_inner()
}

fn encoded_len<T: WireEncode>(value: &T) -> usize {
    encoded_bytes(value).len()
}
