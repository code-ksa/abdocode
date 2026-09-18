#![forbid(unsafe_code)]

use abdo_contracts::{
    decode_frame, encode_frame, BootId, CancelCommand, CancellationId, CauseRef, Command,
    CommandId, ContractVersion, DecodeError, Digest, EncodeError, Nonce, ProposalId, ReceiptId,
    RootCause, RunId, Scope, TrustDecision, TrustReceipt, UnverifiedTrustReceipt, WorkspaceScope,
    MAX_MESSAGE_BYTES,
};

fn command() -> Command {
    Command::Cancel(Box::new(CancelCommand {
        command_id: CommandId::try_from_u128(1).unwrap(),
        cancellation_id: CancellationId::try_from_u128(2).unwrap(),
        proposal_id: ProposalId::try_from_u128(3).unwrap(),
        scope: Scope::Workspace(Box::new(WorkspaceScope)),
        cause: CauseRef::Root(Box::new(RootCause)),
        requested_at_ms: 4,
    }))
}

fn trust_receipt(expires_at_ms: u64) -> UnverifiedTrustReceipt {
    UnverifiedTrustReceipt {
        receipt: TrustReceipt {
            contract_version: ContractVersion::V1,
            decision: TrustDecision::Trusted,
            receipt_id: ReceiptId::try_from_u128(11).unwrap(),
            os_identity_digest: Digest::from_bytes([1; 32]),
            nonce: Nonce::from_bytes([2; 32]),
            boot_id: BootId::try_from_u128(12).unwrap(),
            run_id: RunId::try_from_u128(13).unwrap(),
            generation: 14,
            source_digest: Digest::from_bytes([3; 32]),
            entrypoint_digest: Digest::from_bytes([4; 32]),
            issuer_digest: Digest::from_bytes([5; 32]),
            artifact_digest: Digest::from_bytes([6; 32]),
            trust_policy_digest: Digest::from_bytes([7; 32]),
            reason_digest: Digest::from_bytes([8; 32]),
            issued_at_ms: 1_000,
            expires_at_ms,
            integrity_digest: Digest::from_bytes([9; 32]),
        },
    }
}

#[test]
fn rejects_unknown_version_and_message_or_union_tags() {
    let canonical = encode_frame(&command()).unwrap();

    let mut unknown_version = canonical.clone();
    unknown_version[4..6].copy_from_slice(&2_u16.to_le_bytes());
    assert_eq!(
        decode_frame::<Command>(&unknown_version).unwrap_err(),
        DecodeError::UnsupportedVersion(2)
    );

    let mut unknown_message = canonical.clone();
    unknown_message[22..24].copy_from_slice(&99_u16.to_le_bytes());
    assert_eq!(
        decode_frame::<Command>(&unknown_message).unwrap_err(),
        DecodeError::UnknownMessageTag(99)
    );

    let mut unknown_command = canonical;
    unknown_command[28] = 99;
    assert_eq!(
        decode_frame::<Command>(&unknown_command).unwrap_err(),
        DecodeError::UnknownVariant {
            type_name: "Command",
            tag: 99,
        }
    );
}

#[test]
fn rejects_missing_trailing_oversize_and_noncanonical_values() {
    let canonical = encode_frame(&command()).unwrap();

    let mut missing = canonical.clone();
    missing.pop();
    assert_eq!(
        decode_frame::<Command>(&missing).unwrap_err(),
        DecodeError::Truncated
    );

    let mut trailing = canonical.clone();
    trailing.push(0);
    assert_eq!(
        decode_frame::<Command>(&trailing).unwrap_err(),
        DecodeError::TrailingBytes
    );

    let oversized = vec![0; MAX_MESSAGE_BYTES + 1];
    assert_eq!(
        decode_frame::<Command>(&oversized).unwrap_err(),
        DecodeError::Oversize {
            actual: MAX_MESSAGE_BYTES + 1,
            maximum: MAX_MESSAGE_BYTES,
        }
    );

    let mut zero_id = canonical.clone();
    zero_id[29..45].fill(0);
    assert!(matches!(
        decode_frame::<Command>(&zero_id),
        Err(DecodeError::InvalidValue("CommandId must be non-zero"))
    ));

    let invalid = Command::Cancel(Box::new(CancelCommand {
        command_id: CommandId::try_from_u128(1).unwrap(),
        cancellation_id: CancellationId::try_from_u128(2).unwrap(),
        proposal_id: ProposalId::try_from_u128(3).unwrap(),
        scope: Scope::Workspace(Box::new(WorkspaceScope)),
        cause: CauseRef::Root(Box::new(RootCause)),
        requested_at_ms: 0,
    }));
    assert_eq!(
        encode_frame(&invalid).unwrap_err(),
        EncodeError::InvalidValue("requested_at_ms must be non-zero")
    );
}

#[test]
fn rejects_a_schema_fingerprint_mutation_before_payload_decode() {
    let mut mutated = encode_frame(&command()).unwrap();
    mutated[6] ^= 0x80;
    assert_eq!(
        decode_frame::<Command>(&mutated).unwrap_err(),
        DecodeError::SchemaFingerprintMismatch
    );
}

#[test]
fn trust_receipt_rejects_non_trusted_unknown_ttl_and_zero_integrity_shapes() {
    let canonical = encode_frame(&trust_receipt(61_000)).unwrap();

    let mut unknown_decision = canonical.clone();
    unknown_decision[29] = 2;
    assert_eq!(
        decode_frame::<UnverifiedTrustReceipt>(&unknown_decision).unwrap_err(),
        DecodeError::UnknownVariant {
            type_name: "TrustDecision",
            tag: 2,
        }
    );

    let mut zero_integrity = canonical;
    let integrity_start = zero_integrity.len() - 32;
    zero_integrity[integrity_start..].fill(0);
    assert_eq!(
        decode_frame::<UnverifiedTrustReceipt>(&zero_integrity).unwrap_err(),
        DecodeError::InvalidValue("integrity_digest must not be all-zero bytes")
    );

    assert_eq!(
        encode_frame(&trust_receipt(61_001)).unwrap_err(),
        EncodeError::InvalidValue("expires_at_ms must be at most 60000ms after issued_at_ms")
    );
}
