#![forbid(unsafe_code)]

//! What the catalog refuses, and what a worker is allowed to hold.

use abdo_contracts::{
    Digest, EffectClass, Enforcement, EnforcementReport, IrreversibleEffect, MutatingEffect,
    ReadEffect, RecoveryPlan, ResourceLimits, ToolId, ToolSpec,
};
use abdo_runtime::{NoSandbox, RegistrationError, Sandbox, ToolCatalog};

fn digest(fill: u8) -> Digest {
    assert!(fill != 0, "a fixture digest must not be all zeroes");
    Digest::from_bytes([fill; 32])
}

fn limits() -> ResourceLimits {
    ResourceLimits {
        wall_ms: 1_000,
        memory_bytes: 1 << 20,
        output_bytes: 1 << 16,
        open_handles: 8,
    }
}

fn recovery() -> RecoveryPlan {
    RecoveryPlan {
        compensating_operation_digest: digest(0x31),
        evidence_operation_digest: digest(0x32),
        max_attempts: 2,
    }
}

fn spec(id: u128, handler: Digest, effect: EffectClass) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(id).expect("tool id"),
        name_digest: digest(0x41),
        input_schema_digest: digest(0x42),
        output_schema_digest: digest(0x43),
        effect,
        resources: limits(),
        postcondition_digest: digest(0x44),
        handler_digest: handler,
    }
}

fn reading() -> EffectClass {
    EffectClass::Read(Box::new(ReadEffect))
}

fn mutating() -> EffectClass {
    EffectClass::Mutate(Box::new(MutatingEffect {
        recovery: recovery(),
    }))
}

fn irreversible() -> EffectClass {
    EffectClass::Irreversible(Box::new(IrreversibleEffect {
        evidence_operation_digest: digest(0x51),
    }))
}

/// A host that grants everything it is asked for.
struct FullHost;

impl Sandbox for FullHost {
    fn confine(&self, requested_digest: Digest, _class: &EffectClass) -> EnforcementReport {
        EnforcementReport {
            requested_digest,
            granted_digest: requested_digest,
            enforcement: Enforcement::Full,
            backend_digest: digest(0x61),
            limitations_digest: digest(0x62),
        }
    }
}

#[test]
fn a_schema_whose_handler_the_host_lacks_never_reaches_the_catalog() {
    let mut catalog = ToolCatalog::new();
    // No handler installed at all.
    let refused = catalog.register(spec(1, digest(0x11), reading()), &FullHost);
    assert!(matches!(refused, Err(RegistrationError::NoHandler { .. })));
    // Refused before storage, not stored and failed later: a lookup that
    // succeeded here would hand a caller a tool with nothing behind it.
    assert!(catalog.is_empty());
    assert!(catalog
        .lookup(ToolId::try_from_u128(1).expect("tool id"))
        .is_none());
}

#[test]
fn a_second_spec_for_one_id_is_refused_rather_than_swapped_in() {
    let mut catalog = ToolCatalog::new();
    let handler = digest(0x11);
    catalog.install_handler(handler);
    catalog
        .register(spec(1, handler, reading()), &FullHost)
        .expect("first registration");

    // Same id, different class. A silent replacement is how a tool's meaning
    // changes underneath everything already holding its identifier.
    let refused = catalog.register(spec(1, handler, mutating()), &FullHost);
    assert!(matches!(refused, Err(RegistrationError::Duplicate { .. })));
    assert_eq!(catalog.len(), 1);
    assert!(
        catalog
            .recovery_of(ToolId::try_from_u128(1).expect("tool id"))
            .is_none(),
        "the replacement took effect anyway"
    );
}

#[test]
fn recovery_is_carried_by_the_classes_that_can_need_it() {
    let mut catalog = ToolCatalog::new();
    let handler = digest(0x11);
    catalog.install_handler(handler);
    catalog
        .register(spec(1, handler, mutating()), &FullHost)
        .expect("mutating");
    catalog
        .register(spec(2, handler, reading()), &FullHost)
        .expect("reading");
    catalog
        .register(spec(3, handler, irreversible()), &FullHost)
        .expect("irreversible");

    let mutating_recovery = catalog
        .recovery_of(ToolId::try_from_u128(1).expect("tool id"))
        .expect("a mutating tool carries a recovery");
    assert_eq!(mutating_recovery.max_attempts, 2);

    // Two absences with different meanings. Reading has nothing to undo;
    // irreversible work cannot be undone. The catalog reports both as `None`
    // and the class is what tells them apart, which is why the class is what
    // callers are made to look at.
    for id in [2_u128, 3] {
        assert!(catalog
            .recovery_of(ToolId::try_from_u128(id).expect("tool id"))
            .is_none());
    }
    assert!(!ToolCatalog::is_world_changing(&reading()));
    assert!(ToolCatalog::is_world_changing(&irreversible()));
}

#[test]
fn a_host_that_can_confine_nothing_says_so_rather_than_claiming_success() {
    let mut catalog = ToolCatalog::new();
    let handler = digest(0x11);
    catalog.install_handler(handler);
    let bare = NoSandbox::new(digest(0x71), digest(0x72));

    let report = catalog
        .register(spec(1, handler, mutating()), &bare)
        .expect("mutating work may run with its gaps recorded");
    // The tool runs, and the record says plainly that nothing was enforced.
    // A boolean here would have had to choose between lying and refusing.
    assert_eq!(report.enforcement, Enforcement::Unavailable);
    assert_eq!(report.backend_digest, digest(0x71));
    assert_eq!(report.limitations_digest, digest(0x72));

    // Irreversible work is the exception, and the only one.
    let refused = catalog.register(spec(2, handler, irreversible()), &bare);
    assert!(matches!(
        refused,
        Err(RegistrationError::Unenforceable { .. })
    ));
    assert!(catalog
        .lookup(ToolId::try_from_u128(2).expect("tool id"))
        .is_none());
}

#[test]
fn the_lease_carries_the_enforcement_rather_than_hiding_it() {
    let mut catalog = ToolCatalog::new();
    let handler = digest(0x11);
    catalog.install_handler(handler);
    let bare = NoSandbox::new(digest(0x71), digest(0x72));
    catalog
        .register(spec(1, handler, mutating()), &bare)
        .expect("register");

    let lease = catalog
        .lookup(ToolId::try_from_u128(1).expect("tool id"))
        .expect("lookup");
    // A worker running with no isolation should be able to know it, and a log
    // should be able to say it. Both need the verdict to travel with the lease.
    assert_eq!(lease.enforcement(), Enforcement::Unavailable);
    assert_eq!(lease.operation_digest(), handler);
    assert_eq!(lease.resources().wall_ms, 1_000);
    assert_eq!(
        catalog
            .enforcement_of(ToolId::try_from_u128(1).expect("tool id"))
            .expect("report")
            .enforcement,
        lease.enforcement(),
        "the lease and the record disagree about what was enforced"
    );
}

#[test]
fn an_unknown_tool_resolves_to_nothing_rather_than_to_a_neighbour() {
    let mut catalog = ToolCatalog::new();
    let handler = digest(0x11);
    catalog.install_handler(handler);
    for id in [10_u128, 20, 30] {
        catalog
            .register(spec(id, handler, reading()), &FullHost)
            .expect("register");
    }
    // Between two registered ids, and past the end. An ordered container that
    // answered with the nearest neighbour would hand back the wrong tool.
    for absent in [1_u128, 15, 25, 100] {
        assert!(
            catalog
                .lookup(ToolId::try_from_u128(absent).expect("tool id"))
                .is_none(),
            "an unregistered id resolved to something"
        );
    }
}
