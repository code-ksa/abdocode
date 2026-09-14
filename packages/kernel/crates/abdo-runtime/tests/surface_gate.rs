#![forbid(unsafe_code)]

//! The exact S119 gate: a surface that moved admits nothing decided before it did.
//!
//! The number that matters is `stale_admitted=0`, and zero only means something
//! if staleness was reached — so the gate moves each of the three generations
//! deliberately, in turn, and requires each refusal by its own name. A run in
//! which one comparison stood in for the other two would report the same zero
//! and prove a third of what it claims.
//!
//! There is no CDP, UIA or vision here, and none in what it tests. This is the
//! comparison, not the driver.

use std::time::Instant;

use abdo_contracts::{
    Digest, SurfaceAction, SurfaceGenerations, SurfaceHandle, SurfaceKind, SurfaceTargetRef,
    WindowHandle,
};
use abdo_runtime::{Staleness, SurfaceRegistry};

const PARENT_GATE_ENV: &str = "ABDO_SURFACE_PARENT_GATE";
const SURFACES: u128 = 250;

fn digest(seed: u128, tag: u8) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = tag;
    Digest::from_bytes(bytes)
}

fn target(seed: u128) -> SurfaceTargetRef {
    let mut surface = [0_u8; 32];
    surface[..16].copy_from_slice(&seed.to_be_bytes());
    surface[31] = 0x19;
    let mut window = [0_u8; 16];
    window[..16].copy_from_slice(&seed.to_be_bytes());
    window[15] |= 1;
    SurfaceTargetRef {
        surface: SurfaceHandle::from_bytes(surface),
        window: WindowHandle::from_bytes(window),
        generation: seed as u64 + 1,
        snapshot: digest(seed, 0x21),
    }
}

fn generations(navigation: u64, window: u64, view: u64) -> SurfaceGenerations {
    SurfaceGenerations {
        navigation,
        window,
        view,
    }
}

fn action(seed: u128, kind: SurfaceKind, seen: SurfaceGenerations) -> SurfaceAction {
    SurfaceAction {
        kind,
        target: target(seed),
        generations: seen,
        action_digest: digest(seed, 0x31),
        args_digest: digest(seed, 0x32),
        requested_at_ms: 1_000,
    }
}

fn kind_of(seed: u128) -> SurfaceKind {
    if seed.is_multiple_of(2) {
        SurfaceKind::Browser
    } else {
        SurfaceKind::Computer
    }
}

#[test]
#[ignore = "S119 exact surface staleness gate"]
fn a_surface_that_moved_admits_nothing_that_was_decided_before_it_did() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S119 surface gate requires its exact parent marker"
    );

    let started = Instant::now();
    let mut registry = SurfaceRegistry::new();

    // --- everything current --------------------------------------------------
    let opening = generations(1, 1, 1);
    for seed in 1..=SURFACES {
        registry.observe(kind_of(seed), &target(seed), opening.clone());
    }
    let mut fresh_admitted = 0_u64;
    for seed in 1..=SURFACES {
        if registry
            .admit(&action(seed, kind_of(seed), opening.clone()))
            .is_ok()
        {
            fresh_admitted += 1;
        }
    }
    assert_eq!(
        fresh_admitted as u128, SURFACES,
        "a current action was refused, so every later refusal is suspect"
    );

    // --- move one generation at a time ---------------------------------------
    //
    // Each surface gets exactly one of the three moved, so the three refusals
    // are reached separately and none can stand in for another.
    let mut navigated = 0_u64;
    let mut reframed = 0_u64;
    let mut scrolled = 0_u64;
    let mut stale_attempts = 0_u64;
    let mut stale_admitted = 0_u64;

    for seed in 1..=SURFACES {
        let moved = match seed % 3 {
            0 => generations(2, 1, 1),
            1 => generations(1, 2, 1),
            _ => generations(1, 1, 2),
        };
        registry.observe(kind_of(seed), &target(seed), moved);

        // The action still carries what the caller believed when it chose.
        stale_attempts += 1;
        match registry.admit(&action(seed, kind_of(seed), opening.clone())) {
            Ok(()) => stale_admitted += 1,
            Err(Staleness::Navigated { seen, current }) => {
                assert_eq!((seen, current), (1, 2));
                navigated += 1;
            }
            Err(Staleness::Reframed { seen, current }) => {
                assert_eq!((seen, current), (1, 2));
                reframed += 1;
            }
            Err(Staleness::Scrolled { seen, current }) => {
                assert_eq!((seen, current), (1, 2));
                scrolled += 1;
            }
            Err(other) => panic!("a moved surface was refused for the wrong reason: {other:?}"),
        }
    }

    // --- withdrawn, and mistaken for the other kind --------------------------
    let mut unknown = 0_u64;
    let mut wrong_kind = 0_u64;
    for seed in 1..=SURFACES {
        if seed.is_multiple_of(5) {
            assert!(
                registry.withdraw(&target(seed)),
                "a live surface would not withdraw"
            );
            stale_attempts += 1;
            match registry.admit(&action(seed, kind_of(seed), opening.clone())) {
                Err(Staleness::Unknown) => unknown += 1,
                Ok(()) => stale_admitted += 1,
                Err(other) => {
                    panic!("a withdrawn surface was refused for the wrong reason: {other:?}")
                }
            }
        } else if seed % 5 == 1 {
            // A browser action against a desktop, or the reverse. The two agree
            // about almost nothing except that they have coordinates.
            let other_kind = if kind_of(seed) == SurfaceKind::Browser {
                SurfaceKind::Computer
            } else {
                SurfaceKind::Browser
            };
            let current = registry.generations(&target(seed)).expect("still live");
            stale_attempts += 1;
            match registry.admit(&action(seed, other_kind, current)) {
                Err(Staleness::WrongKind) => wrong_kind += 1,
                Ok(()) => stale_admitted += 1,
                Err(other) => {
                    panic!("a mismatched kind was refused for the wrong reason: {other:?}")
                }
            }
        }
    }

    // --- and a caller that caught up -----------------------------------------
    //
    // Staleness is not a death sentence: an action decided against the moved
    // generations runs. Without this the gate would be satisfied by a registry
    // that refused everything.
    let mut recovered = 0_u64;
    for seed in 1..=SURFACES {
        if let Some(current) = registry.generations(&target(seed)) {
            if registry
                .admit(&action(seed, kind_of(seed), current))
                .is_ok()
            {
                recovered += 1;
            }
        }
    }

    assert_eq!(
        stale_admitted, 0,
        "a stale action ran against a moved surface"
    );
    assert!(navigated > 0 && reframed > 0 && scrolled > 0);
    assert!(unknown > 0 && wrong_kind > 0);
    assert!(recovered > 0, "no caller could ever catch up");

    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "S119_SURFACE surfaces={SURFACES} fresh_admitted={fresh_admitted} stale_attempts={stale_attempts} stale_admitted={stale_admitted} navigated={navigated} reframed={reframed} scrolled={scrolled} unknown={unknown} wrong_kind={wrong_kind} recovered={recovered} admitted={} refused={} elapsed_ms={elapsed_ms}",
        registry.admitted(),
        registry.refused()
    );
}
