#![forbid(unsafe_code)]

//! What a snapshot keeps, and what a search shows.

use abdo_contracts::Enforcement;
use abdo_contracts::{
    CatalogHandle, Digest, EffectClass, EnforcementReport, IrreversibleEffect, MutatingEffect,
    ReadEffect, RecoveryPlan, ResourceLimits, ToolId, ToolSpec,
};
use abdo_runtime::{class_tag, Sandbox, SearchQuery, ToolCatalog};

fn digest(fill: u8) -> Digest {
    assert!(fill != 0, "a fixture digest must not be all zeroes");
    Digest::from_bytes([fill; 32])
}

fn named(lead: u8, tail: u8) -> Digest {
    let mut bytes = [tail; 32];
    bytes[0] = lead;
    Digest::from_bytes(bytes)
}

fn handle(fill: u8) -> CatalogHandle {
    CatalogHandle::from_bytes([fill; 32])
}

fn limits() -> ResourceLimits {
    ResourceLimits {
        wall_ms: 1_000,
        memory_bytes: 1 << 20,
        output_bytes: 1 << 16,
        open_handles: 8,
    }
}

fn spec(id: u128, name: Digest, effect: EffectClass) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(id).expect("tool id"),
        name_digest: name,
        input_schema_digest: digest(0x42),
        output_schema_digest: digest(0x43),
        effect,
        resources: limits(),
        postcondition_digest: digest(0x44),
        handler_digest: digest(0x11),
    }
}

fn reading() -> EffectClass {
    EffectClass::Read(Box::new(ReadEffect))
}

fn mutating() -> EffectClass {
    EffectClass::Mutate(Box::new(MutatingEffect {
        recovery: RecoveryPlan {
            compensating_operation_digest: digest(0x31),
            evidence_operation_digest: digest(0x32),
            max_attempts: 2,
        },
    }))
}

fn irreversible() -> EffectClass {
    EffectClass::Irreversible(Box::new(IrreversibleEffect {
        evidence_operation_digest: digest(0x51),
    }))
}

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

fn catalog_with(count: u128) -> ToolCatalog {
    let mut catalog = ToolCatalog::new();
    catalog.install_handler(digest(0x11));
    for id in 1..=count {
        let class = match id % 3 {
            0 => reading(),
            1 => mutating(),
            _ => irreversible(),
        };
        catalog
            .register(spec(id, named(id as u8, 0x77), class), &FullHost)
            .expect("register");
    }
    catalog
}

#[test]
fn a_snapshot_does_not_move_when_the_catalog_does() {
    let mut catalog = catalog_with(4);
    let before = catalog.snapshot(handle(0x01));
    assert_eq!(before.len(), 4);

    // Register two more, and remove nothing — the live catalog has moved on.
    for id in 5..=6_u128 {
        catalog
            .register(spec(id, named(id as u8, 0x77), reading()), &FullHost)
            .expect("register");
    }
    assert_eq!(catalog.len(), 6);

    // The snapshot did not. Not because it declines to look, but because it
    // holds a copy and there is nothing to look at.
    assert_eq!(before.len(), 4);
    assert!(before
        .disclose(ToolId::try_from_u128(5).expect("tool id"))
        .is_none());
    assert_ne!(
        before.digest(),
        catalog.snapshot(handle(0x01)).digest(),
        "two catalogs with different contents hashed the same"
    );
}

#[test]
fn an_update_leaves_an_old_run_resolving_exactly_what_it_saw() {
    let mut catalog = catalog_with(3);
    let old = catalog.snapshot(handle(0x01));
    let old_digest = old.digest();

    catalog
        .register(spec(99, named(0x99, 0x77), reading()), &FullHost)
        .expect("register");
    let fresh = catalog.snapshot(handle(0x01));

    // The digest is what a step records, and it is what tells the two apart.
    assert_ne!(
        old_digest,
        fresh.digest(),
        "a new tool left the digest alone"
    );
    assert_eq!(
        old.digest(),
        old_digest,
        "the old digest changed under a run"
    );
    for id in 1..=3_u128 {
        let tool_id = ToolId::try_from_u128(id).expect("tool id");
        assert_eq!(
            old.disclose(tool_id).expect("old").spec,
            fresh.disclose(tool_id).expect("fresh").spec,
            "an existing tool changed meaning across an update"
        );
    }
}

#[test]
fn the_digest_covers_which_tools_were_present_not_the_handle_alone() {
    let three = catalog_with(3);
    let four = catalog_with(4);
    // Same handle, different contents.
    assert_ne!(
        three.snapshot(handle(0x01)).digest(),
        four.snapshot(handle(0x01)).digest()
    );
    // Same contents, different handle: the handle is bound in too, so a
    // snapshot cannot be presented as one taken for another catalog.
    assert_ne!(
        three.snapshot(handle(0x01)).digest(),
        three.snapshot(handle(0x02)).digest()
    );
    // And it is stable: the same catalog snapshotted twice hashes the same.
    assert_eq!(
        three.snapshot(handle(0x01)).digest(),
        three.snapshot(handle(0x01)).digest()
    );
}

#[test]
fn a_brief_carries_no_schema() {
    let catalog = catalog_with(3);
    let snapshot = catalog.snapshot(handle(0x01));
    let briefs = snapshot.briefs();
    assert_eq!(briefs.len(), 3);

    // A brief costs the same however large the schema behind it is, which is
    // the entire reason it exists.
    let widths: Vec<usize> = briefs
        .iter()
        .map(|brief| brief.disclosure_chars())
        .collect();
    assert!(widths.windows(2).all(|pair| pair[0] == pair[1]));
    assert!(
        snapshot.brief_chars() < snapshot.full_chars(),
        "briefs cost as much as the schemas they replace"
    );
    // The class is a tag, not the class: the recovery plan and the endpoint
    // digests do not belong in a summary.
    for brief in &briefs {
        assert!((1..=5).contains(&brief.class_tag));
    }
}

#[test]
fn a_search_is_bounded_and_says_how_much_it_left_out() {
    let catalog = catalog_with(50);
    let snapshot = catalog.snapshot(handle(0x01));
    let result = snapshot.capability_search(&SearchQuery {
        affinity: named(7, 0x77),
        class_tag: None,
        limit: 5,
    });
    assert_eq!(result.disclosed.len(), 5);
    // "There were fifty and you are seeing five" is a different situation from
    // "there were five", and a caller that cannot tell them apart cannot know
    // whether to search again.
    assert_eq!(result.considered, 50);
    assert!(result.contains(ToolId::try_from_u128(7).expect("tool id")));
    assert_eq!(
        result.disclosed[0].spec.tool_id.get(),
        7,
        "the exact match did not rank first"
    );
}

#[test]
fn a_class_filter_narrows_what_was_considered_not_only_what_was_shown() {
    let catalog = catalog_with(30);
    let snapshot = catalog.snapshot(handle(0x01));
    let reads = snapshot.capability_search(&SearchQuery {
        affinity: named(3, 0x77),
        class_tag: Some(class_tag(&reading())),
        limit: 100,
    });
    assert!(reads.considered > 0 && reads.considered < 30);
    for entry in &reads.disclosed {
        assert_eq!(class_tag(&entry.spec.effect), class_tag(&reading()));
    }
    // Filtering must not silently widen: asking for one class and being handed
    // another is worse than being handed nothing.
    let mutations = snapshot.capability_search(&SearchQuery {
        affinity: named(3, 0x77),
        class_tag: Some(class_tag(&mutating())),
        limit: 100,
    });
    assert_eq!(
        reads.considered + mutations.considered + irreversible_count(&snapshot),
        30
    );
}

fn irreversible_count(snapshot: &abdo_runtime::CatalogSnapshot) -> usize {
    snapshot
        .capability_search(&SearchQuery {
            affinity: named(1, 0x77),
            class_tag: Some(class_tag(&irreversible())),
            limit: usize::MAX,
        })
        .considered
}

#[test]
fn the_same_query_gives_the_same_answer_every_time() {
    let catalog = catalog_with(40);
    let snapshot = catalog.snapshot(handle(0x01));
    let query = SearchQuery {
        affinity: named(19, 0x77),
        class_tag: None,
        limit: 6,
    };
    let first = snapshot.capability_search(&query);
    for _ in 0..5 {
        assert_eq!(
            snapshot.capability_search(&query),
            first,
            "a search answered differently on the same snapshot"
        );
    }
    // Ties are broken by identifier rather than left to the sort, so two
    // machines agree even when two tools are equally close.
    let ids: Vec<u128> = first
        .disclosed
        .iter()
        .map(|entry| entry.spec.tool_id.get())
        .collect();
    assert_eq!(ids.len(), 6);
}

#[test]
fn an_empty_snapshot_searches_to_nothing_rather_than_to_everything() {
    let catalog = ToolCatalog::new();
    let snapshot = catalog.snapshot(handle(0x01));
    assert!(snapshot.is_empty());
    let result = snapshot.capability_search(&SearchQuery {
        affinity: digest(0x11),
        class_tag: None,
        limit: 10,
    });
    assert!(result.disclosed.is_empty());
    assert_eq!(result.considered, 0);
    assert_eq!(snapshot.full_chars(), 0);
    assert_eq!(snapshot.brief_chars(), 0);
}

#[test]
fn a_zero_budget_discloses_nothing_and_still_reports_what_exists() {
    let catalog = catalog_with(10);
    let snapshot = catalog.snapshot(handle(0x01));
    let result = snapshot.capability_search(&SearchQuery {
        affinity: named(4, 0x77),
        class_tag: None,
        limit: 0,
    });
    // A budget of nothing is a real budget. It must not be read as "no limit".
    assert!(result.disclosed.is_empty());
    assert_eq!(result.considered, 10);
    assert_eq!(result.disclosure_chars(), 0);
}
