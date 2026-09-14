#![forbid(unsafe_code)]

mod support;

use abdo_contracts::encode_frame;
use abdo_journal::{
    AppendRequest, ChainHash, Journal, JournalError, ProjectionKey, ProjectionUpdate, StreamId,
};
use rusqlite::Connection;
use sha2::{Digest as ShaDigest, Sha256};

use support::{received_event, TestDirectory};

const EVENT_DOMAIN: &[u8] = b"ABDO/JOURNAL/EVENT/1\0";

#[test]
fn canonical_chain_hash_matches_an_independent_reference_and_reopens() {
    let directory = TestDirectory::new("hash-reference");
    let database = directory.join("journal.sqlite");
    let stream = StreamId::try_from_u128(41).expect("stream ID must be non-zero");
    let event = received_event(1);
    let frame = encode_frame(&event).expect("fixture event must encode");
    let mut journal = Journal::open(&database).expect("journal must open");
    let receipt = journal
        .append(AppendRequest::event(stream, None, &event))
        .expect("fixture event must append");

    let mut reference = Sha256::new();
    reference.update(EVENT_DOMAIN);
    reference.update(abdo_contracts::PROTOCOL_DESCRIPTOR.schema_fingerprint);
    reference.update(stream.to_be_bytes());
    reference.update(1_u64.to_be_bytes());
    reference.update(1_u64.to_be_bytes());
    reference.update(receipt.event_id.get().to_be_bytes());
    reference.update(ChainHash::ZERO.as_bytes());
    reference.update((frame.len() as u32).to_be_bytes());
    reference.update(&frame);
    let expected: [u8; 32] = reference.finalize().into();
    assert_eq!(receipt.head.hash.into_bytes(), expected);

    drop(journal);
    let journal = Journal::open(&database).expect("journal must reopen");
    let report = journal.verify().expect("reopened chain must verify");
    assert_eq!(report.events, 1);
    assert_eq!(
        journal.head(stream).expect("head read must succeed"),
        Some(receipt.head)
    );
    drop(journal);
    directory.remove();
}

#[test]
fn append_only_triggers_reject_event_update_and_delete() {
    let directory = TestDirectory::new("append-only");
    let database = directory.join("journal.sqlite");
    let stream = StreamId::try_from_u128(42).expect("stream ID must be non-zero");
    let event = received_event(2);
    let mut journal = Journal::open(&database).expect("journal must open");
    journal
        .append(AppendRequest::event(stream, None, &event))
        .expect("fixture event must append");
    drop(journal);

    let connection = Connection::open(&database).expect("raw fixture connection must open");
    assert!(
        connection
            .execute(
                "UPDATE journal_events SET event_frame = event_frame WHERE global_sequence = 1",
                [],
            )
            .is_err(),
        "journal event UPDATE must fail even when bytes are unchanged"
    );
    assert!(
        connection
            .execute("DELETE FROM journal_events WHERE global_sequence = 1", [])
            .is_err(),
        "journal event DELETE must fail"
    );
    let count: i64 = connection
        .query_row("SELECT count(*) FROM journal_events", [], |row| row.get(0))
        .expect("event count must remain readable");
    assert_eq!(count, 1);
    drop(connection);

    Journal::open(&database)
        .expect("append-only rejection must leave the journal reopenable")
        .verify()
        .expect("append-only rejection must leave the chain intact");
    directory.remove();
}

#[test]
fn frame_tampering_cannot_silently_reopen_as_a_valid_chain() {
    let directory = TestDirectory::new("tampered-frame");
    let database = directory.join("journal.sqlite");
    let stream = StreamId::try_from_u128(43).expect("stream ID must be non-zero");
    let first = received_event(3);
    let second = received_event(4);
    let mut journal = Journal::open(&database).expect("journal must open");
    let first_receipt = journal
        .append(AppendRequest::event(stream, None, &first))
        .expect("first fixture event must append");
    journal
        .append(AppendRequest::event(
            stream,
            Some(first_receipt.head),
            &second,
        ))
        .expect("second fixture event must append");
    drop(journal);

    let connection = Connection::open(&database).expect("raw fixture connection must open");
    connection
        .execute_batch("DROP TRIGGER journal_events_no_update;")
        .expect("fixture must explicitly remove its update guard before simulating corruption");
    let mut frame: Vec<u8> = connection
        .query_row(
            "SELECT event_frame FROM journal_events WHERE global_sequence = 2",
            [],
            |row| row.get(0),
        )
        .expect("stored event frame must be readable");
    let last = frame
        .last_mut()
        .expect("stored event frame must not be empty");
    *last ^= 0x01;
    connection
        .execute(
            "UPDATE journal_events SET event_frame = ?1 WHERE global_sequence = 2",
            [&frame],
        )
        .expect("fixture corruption must be installed");
    drop(connection);

    if let Ok(journal) = Journal::open(&database) {
        assert!(
            journal.verify().is_err(),
            "tampered event bytes must fail hash-chain verification"
        );
    }
    directory.remove();
}

#[test]
fn projection_cas_failure_rolls_back_the_event_and_head_together() {
    let directory = TestDirectory::new("projection-cas");
    let database = directory.join("journal.sqlite");
    let stream = StreamId::try_from_u128(44).expect("stream ID must be non-zero");
    let key = ProjectionKey::new("recovery-state").expect("projection key must be valid");
    let first = received_event(5);
    let second = received_event(6);
    let mut journal = Journal::open(&database).expect("journal must open");
    let first_receipt = journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: None,
            event: &first,
            projection: Some(ProjectionUpdate {
                key: &key,
                expected_sequence: 0,
                bytes: b"projection-v1",
            }),
            snapshot: None,
        })
        .expect("first projection must append");

    let failure = journal.append(AppendRequest {
        stream_id: stream,
        expected_head: Some(first_receipt.head),
        event: &second,
        projection: Some(ProjectionUpdate {
            key: &key,
            expected_sequence: 0,
            bytes: b"projection-v2",
        }),
        snapshot: None,
    });
    assert!(matches!(
        failure,
        Err(JournalError::ProjectionCasConflict { .. })
    ));
    assert_eq!(
        journal.head(stream).expect("head read must succeed"),
        Some(first_receipt.head)
    );
    assert_eq!(journal.verify().expect("chain must remain valid").events, 1);
    let projection = journal
        .projection(stream, &key)
        .expect("projection read must succeed")
        .expect("first projection must remain present");
    assert_eq!(projection.through_sequence, 1);
    assert_eq!(projection.bytes, b"projection-v1");
    drop(journal);
    directory.remove();
}
