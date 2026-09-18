#![forbid(unsafe_code)]

//! The exact S116 gate: a snapshot that will not move, and a step that does not
//! carry ten thousand schemas.
//!
//! # Why the queries are wrong on purpose
//!
//! A caller that knew a tool's exact digest would not be searching. So every
//! query here is *approximate*: it names the digest of the tool it wants with a
//! deterministic perturbation applied, which is the situation the mechanism has
//! to survive. Searching by the exact digest would report a hit rate of 1.0 and
//! prove only that a map lookup works.
//!
//! # Characters, not tokens
//!
//! The saving is measured in characters. Every token estimate in this product
//! divides characters by one constant, which lives in
//! `packages/schema/src/tokens.ts`; a ratio of characters is therefore the same
//! ratio of tokens. Writing a second divisor here to restate it in another unit
//! is the duplication that estimator exists to end.

use std::time::Instant;

use abdo_contracts::{
    CatalogHandle, Digest, EffectClass, Enforcement, EnforcementReport, IrreversibleEffect,
    MutatingEffect, ReachingEffect, ReadEffect, RecoveryPlan, ResourceLimits, SpendingEffect,
    ToolId, ToolSpec,
};
use abdo_runtime::{Sandbox, SearchQuery, ToolCatalog};

const PARENT_GATE_ENV: &str = "ABDO_DISCLOSURE_PARENT_GATE";
const TOOLS: u128 = 10_000;
/// Tools per family. Members of a family are near neighbours by digest, which
/// is what gives an approximate query something to get wrong.
const FAMILY: u128 = 50;
/// The largest disclosure budget the gate will consider.
///
/// The gate does not assert a budget; it *finds* the smallest one that reaches
/// the required hit rate and reports it. A gate that picked the budget in
/// advance would be tuned until it passed, which measures the tuning.
const BUDGET_CEILING: usize = 64;
/// The hit rate the mechanism has to reach, in parts per thousand.
const REQUIRED_HIT_PERMILLE: u64 = 990;

fn digest(seed: u128, tag: u8) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = tag;
    Digest::from_bytes(bytes)
}

/// A tool's name digest: its family, then its position inside that family.
///
/// Near neighbours share the leading bytes, so a query that is a little wrong
/// about the position lands among the family rather than nowhere.
fn name_of(id: u128) -> Digest {
    let mut bytes = [0x5a_u8; 32];
    let family = (id / FAMILY) as u16;
    let position = (id % FAMILY) as u8;
    bytes[0] = (family >> 8) as u8;
    bytes[1] = (family & 0xff) as u8;
    bytes[2] = position;
    Digest::from_bytes(bytes)
}

/// The same digest, with the position wrong by a deterministic amount.
fn approximate(id: u128) -> Digest {
    let mut bytes = *name_of(id).as_bytes();
    let drift = (id % 7) as u8;
    bytes[2] = bytes[2].wrapping_add(drift);
    Digest::from_bytes(bytes)
}

fn limits() -> ResourceLimits {
    ResourceLimits {
        wall_ms: 30_000,
        memory_bytes: 512 * 1024 * 1024,
        output_bytes: 4 * 1024 * 1024,
        open_handles: 64,
    }
}

fn recovery(seed: u128) -> RecoveryPlan {
    RecoveryPlan {
        compensating_operation_digest: digest(seed, 0x11),
        evidence_operation_digest: digest(seed, 0x12),
        max_attempts: 3,
    }
}

fn class_of(seed: u128) -> EffectClass {
    match seed % 5 {
        0 => EffectClass::Read(Box::new(ReadEffect)),
        1 => EffectClass::Mutate(Box::new(MutatingEffect {
            recovery: recovery(seed),
        })),
        2 => EffectClass::Reach(Box::new(ReachingEffect {
            recovery: recovery(seed),
            endpoint_class_digest: digest(seed, 0x13),
        })),
        3 => EffectClass::Spend(Box::new(SpendingEffect {
            recovery: recovery(seed),
            ledger_digest: digest(seed, 0x14),
        })),
        _ => EffectClass::Irreversible(Box::new(IrreversibleEffect {
            evidence_operation_digest: digest(seed, 0x15),
        })),
    }
}

fn spec(id: u128, handler: Digest) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(id).expect("tool id"),
        name_digest: name_of(id),
        input_schema_digest: digest(id, 0x22),
        output_schema_digest: digest(id, 0x23),
        effect: class_of(id),
        resources: limits(),
        postcondition_digest: digest(id, 0x24),
        handler_digest: handler,
    }
}

struct FullHost;

impl Sandbox for FullHost {
    fn confine(&self, requested_digest: Digest, _class: &EffectClass) -> EnforcementReport {
        EnforcementReport {
            requested_digest,
            granted_digest: requested_digest,
            enforcement: Enforcement::Full,
            backend_digest: digest(2, 0x32),
            limitations_digest: digest(3, 0x33),
        }
    }
}

#[test]
#[ignore = "S116 exact catalog snapshot and disclosure gate"]
fn a_snapshot_holds_still_while_a_step_sees_a_fraction_of_the_catalog() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S116 disclosure gate requires its exact parent marker"
    );

    let started = Instant::now();
    let handler = digest(0xabc, 0x41);
    let mut catalog = ToolCatalog::new();
    catalog.install_handler(handler);
    for id in 1..=TOOLS {
        catalog
            .register(spec(id, handler), &FullHost)
            .expect("register");
    }

    let handle = CatalogHandle::from_bytes([0x16; 32]);
    let snapshot = catalog.snapshot(handle);
    let opening_digest = snapshot.digest();
    assert_eq!(snapshot.len() as u128, TOOLS);

    // --- the catalog moves under the step ------------------------------------
    //
    // Registrations land while the step is running, which is the situation the
    // snapshot exists for. Without them, "the snapshot held still" would be a
    // statement about a catalog nobody touched.
    let mut arrivals = 0_u64;
    for id in (TOOLS + 1)..=(TOOLS + 500) {
        catalog
            .register(spec(id, handler), &FullHost)
            .expect("late");
        arrivals += 1;
    }
    assert_eq!(catalog.len() as u128, TOOLS + 500);

    // --- what a step costs ---------------------------------------------------
    let full_chars = snapshot.full_chars();
    let brief_chars = snapshot.brief_chars();

    // --- ten thousand approximate searches -----------------------------------
    //
    // Searched once at the ceiling, and the rank of the wanted tool recorded.
    // Recall at any smaller budget follows from the ranks, so the sweep costs
    // one pass rather than one pass per candidate budget.
    let mut ranks: Vec<usize> = Vec::with_capacity(TOOLS as usize);
    let mut beyond_ceiling = 0_u64;
    let mut disclosed_chars_at_ceiling = 0_usize;
    let mut considered_total = 0_u64;
    for id in 1..=TOOLS {
        let wanted = ToolId::try_from_u128(id).expect("tool id");
        let result = snapshot.capability_search(&SearchQuery {
            affinity: approximate(id),
            class_tag: None,
            limit: BUDGET_CEILING,
        });
        disclosed_chars_at_ceiling += result.disclosure_chars();
        considered_total += result.considered as u64;
        match result
            .disclosed
            .iter()
            .position(|entry| entry.spec.tool_id == wanted)
        {
            Some(rank) => {
                // Present is not enough: the schema disclosed must be the one
                // that was registered, or the step would call the right name
                // with the wrong shape.
                assert_eq!(
                    result.disclosed[rank].spec,
                    spec(id, handler),
                    "a schema arrived altered"
                );
                ranks.push(rank);
            }
            None => {
                beyond_ceiling += 1;
                ranks.push(usize::MAX);
            }
        }
    }
    assert_eq!(ranks.len(), TOOLS as usize);
    assert!(
        ranks.iter().any(|rank| *rank > 0),
        "every query ranked its tool first, so the searches were not approximate"
    );

    // The smallest budget that reaches the required hit rate. Found, not chosen.
    let hits_at =
        |budget: usize| -> u64 { ranks.iter().filter(|rank| **rank < budget).count() as u64 };
    let budget = (1..=BUDGET_CEILING)
        .find(|candidate| (hits_at(*candidate) * 1_000) / TOOLS as u64 >= REQUIRED_HIT_PERMILLE)
        .unwrap_or_else(|| {
            panic!(
                "even a budget of {BUDGET_CEILING} schemas reached only {} per thousand",
                (hits_at(BUDGET_CEILING) * 1_000) / TOOLS as u64
            )
        });
    let hits = hits_at(budget);
    let misses = TOOLS as u64 - hits;

    // Where the wanted tool actually landed. Reported because "a budget of N"
    // on its own does not say whether the ranking earned it: if the search were
    // no better than the order the catalog happens to be in, the median rank
    // would sit near the middle of everything it considered, and the budget
    // would be covering for it rather than resting on it.
    let mut sorted_ranks: Vec<usize> = ranks
        .iter()
        .copied()
        .filter(|rank| *rank != usize::MAX)
        .collect();
    sorted_ranks.sort_unstable();
    let median_rank = sorted_ranks[sorted_ranks.len() / 2];
    let p99_rank = sorted_ranks[(sorted_ranks.len() * 99) / 100];
    // A budget of eight, reported alongside, so the shape of the curve is
    // visible rather than a single point on it.
    let hit_permille_at_eight = (hits_at(8) * 1_000) / TOOLS as u64;
    assert!(
        budget > 1,
        "a budget of one sufficed, so the queries cost the search nothing"
    );

    // What a step costs at that budget: every brief, plus the schemas one search
    // discloses. Priced by searching again at the budget rather than by scaling
    // the ceiling measurement — the schemas are not all one width, because a
    // read carries no recovery plan and a reach carries an endpoint digest, so
    // any per-schema average would be a number about the fixture's class mix.
    //
    // The second pass doubles as a cross-check: the hit count it observes must
    // equal the one derived from the ranks. A rank-derivation bug would show up
    // here rather than as a comfortable number nobody re-measured.
    let mut priced_chars = 0_usize;
    let mut priced_hits = 0_u64;
    for id in 1..=TOOLS {
        let wanted = ToolId::try_from_u128(id).expect("tool id");
        let result = snapshot.capability_search(&SearchQuery {
            affinity: approximate(id),
            class_tag: None,
            limit: budget,
        });
        priced_chars += result.disclosure_chars();
        if result.contains(wanted) {
            priced_hits += 1;
        }
    }
    assert_eq!(
        priced_hits, hits,
        "the ranks and a real search at the same budget disagree"
    );
    assert!(
        disclosed_chars_at_ceiling > priced_chars,
        "a smaller budget disclosed as much as the ceiling"
    );
    let step_chars = brief_chars + priced_chars / TOOLS as usize;
    let saved_permille = ((full_chars - step_chars) * 1_000) / full_chars;

    // --- the snapshot after all of that --------------------------------------
    assert_eq!(
        snapshot.digest(),
        opening_digest,
        "the snapshot moved while the step was running"
    );
    assert_eq!(snapshot.len() as u128, TOOLS);
    let mut late_visible = 0_u64;
    for id in (TOOLS + 1)..=(TOOLS + 500) {
        if snapshot
            .disclose(ToolId::try_from_u128(id).expect("tool id"))
            .is_some()
        {
            late_visible += 1;
        }
    }

    // --- and an old run against a moved catalog ------------------------------
    let fresh = catalog.snapshot(handle);
    assert_ne!(
        fresh.digest(),
        opening_digest,
        "five hundred new tools left the digest alone"
    );
    let mut unchanged = 0_u64;
    for id in 1..=TOOLS {
        let tool_id = ToolId::try_from_u128(id).expect("tool id");
        if snapshot.disclose(tool_id) == fresh.disclose(tool_id) {
            unchanged += 1;
        }
    }

    let elapsed_ms = started.elapsed().as_millis();
    let hit_permille = (hits * 1_000) / TOOLS as u64;
    println!(
        "S116_DISCLOSURE tools={TOOLS} snapshot={} arrivals={arrivals} late_visible={late_visible} unchanged={unchanged} full_chars={full_chars} brief_chars={brief_chars} step_chars={step_chars} saved_permille={saved_permille} budget={budget} ceiling={BUDGET_CEILING} beyond_ceiling={beyond_ceiling} median_rank={median_rank} p99_rank={p99_rank} hit_permille_at_eight={hit_permille_at_eight} hits={hits} misses={misses} hit_permille={hit_permille} considered={considered_total} elapsed_ms={elapsed_ms}",
        snapshot.len()
    );
}
