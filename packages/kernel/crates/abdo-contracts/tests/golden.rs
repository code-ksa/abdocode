#![forbid(unsafe_code)]

use abdo_contracts::{
    decode_frame, encode_frame, AdmissionEvent, BootId, CancelCommand, CancellationId, CauseRef,
    Command, CommandCause, CommandId, ContractVersion, Digest, EventId, Nonce, ProposalId,
    ReceiptId, ReceivedEvent, RootCause, RunId, Scope, TrustDecision, TrustReceipt,
    UnverifiedTrustReceipt, WorkspaceScope, PROTOCOL_DESCRIPTOR,
};

fn id<T>(value: u128, constructor: fn(u128) -> Result<T, &'static str>) -> T {
    constructor(value).unwrap()
}

fn cancel_command() -> Command {
    Command::Cancel(Box::new(CancelCommand {
        command_id: id(1, CommandId::try_from_u128),
        cancellation_id: id(2, CancellationId::try_from_u128),
        proposal_id: id(3, ProposalId::try_from_u128),
        scope: Scope::Workspace(Box::new(WorkspaceScope)),
        cause: CauseRef::Root(Box::new(RootCause)),
        requested_at_ms: 4,
    }))
}

#[test]
fn cancel_command_matches_the_fixed_golden_bytes() {
    const GOLDEN: &[u8] = include_bytes!("../test/fixtures/cancel-command-v1.bin");
    const MANIFEST: &str = include_str!("../test/fixtures/cancel-command-v1.json");

    let encoded = encode_frame(&cancel_command()).unwrap();
    assert_eq!(encoded, GOLDEN);
    assert_eq!(decode_frame::<Command>(GOLDEN).unwrap(), cancel_command());
    assert_eq!(
        MANIFEST,
        abdo_contracts::codegen::golden_cancel_command_manifest()
    );
}

fn trust_receipt() -> UnverifiedTrustReceipt {
    UnverifiedTrustReceipt {
        receipt: TrustReceipt {
            contract_version: ContractVersion::V1,
            decision: TrustDecision::Trusted,
            receipt_id: id(11, ReceiptId::try_from_u128),
            os_identity_digest: Digest::from_bytes([1; 32]),
            nonce: Nonce::from_bytes([2; 32]),
            boot_id: id(12, BootId::try_from_u128),
            run_id: id(13, RunId::try_from_u128),
            generation: 14,
            source_digest: Digest::from_bytes([3; 32]),
            entrypoint_digest: Digest::from_bytes([4; 32]),
            issuer_digest: Digest::from_bytes([5; 32]),
            artifact_digest: Digest::from_bytes([6; 32]),
            trust_policy_digest: Digest::from_bytes([7; 32]),
            reason_digest: Digest::from_bytes([8; 32]),
            issued_at_ms: 1_000,
            expires_at_ms: 61_000,
            integrity_digest: Digest::from_bytes([9; 32]),
        },
    }
}

#[test]
fn trust_receipt_integrity_is_explicitly_unverified_and_excludes_the_digest() {
    let unverified = trust_receipt();
    let framed = encode_frame(&unverified).unwrap();
    assert_eq!(framed.len(), 390);
    assert_eq!(
        decode_frame::<UnverifiedTrustReceipt>(&framed).unwrap(),
        unverified
    );
    let canonical = unverified.canonical_integrity_bytes().unwrap();
    assert_eq!(canonical.len(), 351);
    assert_eq!(
        &canonical[..abdo_contracts::TRUST_INTEGRITY_DOMAIN.len()],
        abdo_contracts::TRUST_INTEGRITY_DOMAIN
    );

    // The digest is not part of what it signs. If it were, sealing would have to
    // guess its own output, and altering it would go unnoticed by the very check
    // that exists to notice.
    let mut altered = unverified.clone();
    altered.receipt.integrity_digest = Digest::from_bytes([0xa5; 32]);
    assert_eq!(altered.canonical_integrity_bytes().unwrap(), canonical);

    // Every other field is. Changing one must change what an authority seals.
    let mut moved = unverified.clone();
    moved.receipt.generation += 1;
    assert_ne!(moved.canonical_integrity_bytes().unwrap(), canonical);

    // And this crate offers no way to call a receipt verified. Verification
    // needs the key, the key lives in `abdo-authority`, and a contract that
    // handed out a verdict on a caller-supplied closure would be handing out
    // authority it does not have.
    assert_eq!(unverified.unverified(), &unverified.receipt);
}

#[test]
fn admission_event_shape_round_trips_through_its_own_message_tag() {
    let event = AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: id(21, EventId::try_from_u128),
        proposal_id: id(22, ProposalId::try_from_u128),
        command_id: id(23, CommandId::try_from_u128),
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms: 24,
    }));
    let encoded = encode_frame(&event).unwrap();
    assert_eq!(encoded.len(), 86);
    assert_eq!(decode_frame::<AdmissionEvent>(&encoded).unwrap(), event);
}

#[test]
fn the_descriptor_carries_exactly_its_declared_messages() {
    assert_eq!(PROTOCOL_DESCRIPTOR.magic, *b"ABDC");
    assert_eq!(PROTOCOL_DESCRIPTOR.version, 1);
    // The framing version is unchanged: nothing about how a frame is laid out
    // moved. What changed is the schema, and the fingerprint is what discriminates
    // that, so a peer built against the old declaration rejects these frames
    // rather than misreading them.
    assert_eq!(
        PROTOCOL_DESCRIPTOR.schema_fingerprint,
        [224, 9, 104, 43, 194, 87, 79, 24, 234, 5, 106, 241, 171, 231, 17, 201]
    );
    assert_eq!(abdo_contracts::TRUST_INTEGRITY_DOMAIN.last(), Some(&0));
    assert_eq!(PROTOCOL_DESCRIPTOR.messages.len(), 11);
    assert_eq!(
        PROTOCOL_DESCRIPTOR
            .messages
            .iter()
            .map(|message| (message.type_name, message.tag))
            .collect::<Vec<_>>(),
        [
            ("Command", 1),
            ("AdmissionEvent", 2),
            ("UnverifiedTrustReceipt", 3),
            ("InputEnvelope", 4),
            ("ToolSpec", 5),
            ("EnforcementReport", 6),
            ("SurfaceObservation", 7),
            ("SurfaceAction", 8),
            ("SurfaceReceipt", 9),
            ("EffectRequest", 10),
            ("EffectOutcome", 11),
        ]
    );

    // Causation is typed; it cannot be confused with an event identifier.
    let cause = CauseRef::Command(Box::new(CommandCause {
        command_id: id(99, CommandId::try_from_u128),
    }));
    assert_ne!(
        format!("{cause:?}"),
        format!("{:?}", EventId::try_from_u128(99).unwrap())
    );
}
