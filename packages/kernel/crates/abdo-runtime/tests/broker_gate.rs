#![forbid(unsafe_code)]

//! The exact S115 gate: ten thousand tools, and not one boolean about isolation.
//!
//! Three things are measured, and each is written so that a green run means
//! something a lazy implementation could not fake.
//!
//! p99 lookup is measured over every registered tool rather than a sample, so
//! the tail is the real tail rather than whichever ids the fixture happened to
//! pick. A catalog that was fast for the first hundred and slow for the rest
//! would show it here.
//!
//! "No schema without a handler" is counted as refusals, and the refusals only
//! mean something if handler-less specs were actually offered — so the sweep
//! offers them deliberately and the validator requires the count to be non-zero.
//!
//! "Every mutating tool has a recovery" is not counted at all, because it is
//! not checkable at runtime: the recovery lives inside the class, so a mutating
//! spec without one does not compile. What the gate reports instead is how many
//! world-changing tools were registered, which is the population the property
//! holds over.

use std::time::Instant;

use abdo_contracts::{
    Digest, EffectClass, Enforcement, EnforcementReport, IrreversibleEffect, MutatingEffect,
    ReachingEffect, ReadEffect, RecoveryPlan, ResourceLimits, SpendingEffect, ToolId, ToolSpec,
};
use abdo_runtime::{NoSandbox, RegistrationError, Sandbox, ToolCatalog};

const PARENT_GATE_ENV: &str = "ABDO_BROKER_PARENT_GATE";
const TOOLS: u128 = 10_000;
/// Specs offered with a handler the host does not have.
const ORPHANS: u128 = 250;

fn digest(seed: u128, tag: u8) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = tag;
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

/// One class per five tools, so every arm of the union is exercised.
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

fn spec(seed: u128, handler: Digest) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(seed).expect("tool id"),
        name_digest: digest(seed, 0x21),
        input_schema_digest: digest(seed, 0x22),
        output_schema_digest: digest(seed, 0x23),
        effect: class_of(seed),
        resources: limits(),
        postcondition_digest: digest(seed, 0x24),
        handler_digest: handler,
    }
}

/// A host that confines some classes and cannot confine others.
///
/// Deliberately not uniform. A sandbox that always answered `Full` would make
/// the three-way verdict indistinguishable from the boolean it replaces.
struct PartialHost;

impl Sandbox for PartialHost {
    fn confine(&self, requested_digest: Digest, class: &EffectClass) -> EnforcementReport {
        let enforcement = match class {
            // Nothing to confine.
            EffectClass::Read(_) => Enforcement::Full,
            // Confinable, but the host cannot police what it writes.
            EffectClass::Mutate(_) => Enforcement::Partial,
            // A network namespace this host does have.
            EffectClass::Reach(_) => Enforcement::Full,
            // Spending happens somewhere else entirely.
            EffectClass::Spend(_) => Enforcement::Unavailable,
            EffectClass::Irreversible(_) => Enforcement::Full,
        };
        EnforcementReport {
            requested_digest,
            granted_digest: digest(1, 0x31),
            enforcement,
            backend_digest: digest(2, 0x32),
            limitations_digest: digest(3, 0x33),
        }
    }
}

#[test]
#[ignore = "S115 exact tool broker gate"]
fn ten_thousand_tools_resolve_fast_and_every_one_attests_what_was_enforced() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S115 broker gate requires its exact parent marker"
    );

    let started = Instant::now();
    let mut catalog = ToolCatalog::new();

    // --- handlers, then specs -----------------------------------------------
    let handler = digest(0xabc, 0x41);
    catalog.install_handler(handler);

    let mut registered = 0_u64;
    let mut world_changing = 0_u64;
    let mut with_recovery = 0_u64;
    let mut full = 0_u64;
    let mut partial = 0_u64;
    let mut unavailable = 0_u64;
    let mut refused_no_handler = 0_u64;
    let mut refused_duplicate = 0_u64;
    let mut refused_unenforceable = 0_u64;

    for seed in 1..=TOOLS {
        let candidate = spec(seed, handler);
        let changes_world = ToolCatalog::is_world_changing(&candidate.effect);
        match catalog.register(candidate, &PartialHost) {
            Ok(report) => {
                registered += 1;
                if changes_world {
                    world_changing += 1;
                }
                match report.enforcement {
                    Enforcement::Full => full += 1,
                    Enforcement::Partial => partial += 1,
                    Enforcement::Unavailable => unavailable += 1,
                }
            }
            Err(RegistrationError::Unenforceable { .. }) => refused_unenforceable += 1,
            Err(other) => panic!("an honest spec was refused: {other:?}"),
        }
    }
    assert_eq!(registered as u128, TOOLS, "a tool went missing");

    // --- specs whose handler the host does not have --------------------------
    for seed in 1..=ORPHANS {
        let orphan = spec(TOOLS + seed, digest(TOOLS + seed, 0x51));
        match catalog.register(orphan, &PartialHost) {
            Err(RegistrationError::NoHandler { .. }) => refused_no_handler += 1,
            other => panic!("a schema with no handler was admitted: {other:?}"),
        }
    }

    // --- a host that can confine nothing -------------------------------------
    //
    // Everything else may run with its gaps written down. Irreversible work may
    // not, because there is no undoing it afterwards, and this is the only
    // place that distinction is observable. Without this block the refusal
    // would be a branch nobody ever took while the gate still read green.
    let bare = NoSandbox::new(digest(4, 0x61), digest(5, 0x62));
    let mut unconfined_registered = 0_u64;
    for seed in 1..=ORPHANS {
        let mut lonely = ToolCatalog::new();
        lonely.install_handler(handler);
        let id = TOOLS * 2 + seed;
        match lonely.register(spec(id, handler), &bare) {
            Err(RegistrationError::Unenforceable { .. }) => {
                assert_eq!(
                    id % 5,
                    4,
                    "only irreversible work may be refused for want of a sandbox"
                );
                refused_unenforceable += 1;
            }
            Ok(report) => {
                assert_ne!(
                    id % 5,
                    4,
                    "irreversible work was admitted with no isolation at all"
                );
                // Admitted, and the report says plainly that nothing was
                // enforced. That is the whole point of a three-way verdict: a
                // boolean here would have had to choose between lying and
                // refusing.
                assert_eq!(report.enforcement, Enforcement::Unavailable);
                unconfined_registered += 1;
            }
            Err(other) => panic!("an honest spec was refused: {other:?}"),
        }
    }
    assert!(
        refused_unenforceable > 0,
        "no irreversible tool ever met a host that could not confine it"
    );
    assert!(
        unconfined_registered > 0,
        "everything was refused, so the report was never the thing that mattered"
    );

    // --- the same id twice ---------------------------------------------------
    for seed in 1..=ORPHANS {
        match catalog.register(spec(seed, handler), &PartialHost) {
            Err(RegistrationError::Duplicate { .. }) => refused_duplicate += 1,
            other => panic!("a tool id was silently replaced: {other:?}"),
        }
    }

    // --- every world-changing tool declares a recovery -----------------------
    //
    // Counted from the catalog rather than from the fixture, so a class that
    // stopped carrying its recovery would show up as a shortfall here.
    for seed in 1..=TOOLS {
        let tool_id = ToolId::try_from_u128(seed).expect("tool id");
        let lease = catalog.lookup(tool_id).expect("registered tool resolves");
        assert_eq!(lease.operation_digest(), handler);
        assert_eq!(lease.resources().wall_ms, 30_000);
        if catalog.recovery_of(tool_id).is_some() {
            with_recovery += 1;
        }
        // The lease is the whole of what a worker gets. If it ever grew a way
        // to reach the spec, the policy or a key, this is where it would show.
        let _: Enforcement = lease.enforcement();
    }

    // --- the hot path --------------------------------------------------------
    //
    // Every registered id, timed individually, so p99 is the real tail rather
    // than the tail of whichever sample the fixture chose.
    let mut timings = Vec::with_capacity(TOOLS as usize);
    for seed in 1..=TOOLS {
        let tool_id = ToolId::try_from_u128(seed).expect("tool id");
        let at = Instant::now();
        let found = catalog.lookup(tool_id);
        let elapsed = at.elapsed().as_nanos();
        assert!(found.is_some(), "a registered tool stopped resolving");
        timings.push(elapsed);
    }
    timings.sort_unstable();
    let p99_ns = timings[(timings.len() * 99) / 100];
    let max_ns = *timings.last().expect("timings are non-empty");

    // A miss must also be fast, and must be a miss rather than a stale hit.
    let absent = ToolId::try_from_u128(TOOLS * 100).expect("tool id");
    assert!(catalog.lookup(absent).is_none(), "an unknown tool resolved");

    let elapsed_ms = started.elapsed().as_millis();
    let catalog_size = catalog.len() as u64;
    println!(
        "S115_BROKER tools={TOOLS} registered={registered} catalog={catalog_size} world_changing={world_changing} with_recovery={with_recovery} full={full} partial={partial} unavailable={unavailable} unconfined_registered={unconfined_registered} refused_no_handler={refused_no_handler} refused_duplicate={refused_duplicate} refused_unenforceable={refused_unenforceable} p99_lookup_ns={p99_ns} max_lookup_ns={max_ns} elapsed_ms={elapsed_ms}"
    );
}
