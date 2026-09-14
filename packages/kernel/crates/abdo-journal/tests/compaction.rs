#![forbid(unsafe_code)]

//! S130 (DeepSeek-3) — compaction is a journal transaction, not an edit.
//!
//! The claim under test is narrow and worth stating: a compaction **shadows** a
//! precise range. It does not remove it. Every assertion below exists because
//! the obvious implementation gets one of these wrong and still looks like it
//! worked:
//!
//! - it trims the range it summarised, and the only copy is gone;
//! - it renumbers what is left, and every hash reference into the stream breaks;
//! - it infers the range from the head, and races an append into the summary;
//! - it half-writes a shadow when the summary is too large, leaving a journal
//!   that verifies but describes something that is not there.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use abdo_contracts::{
    AdmissionEvent, CauseRef, CommandId, EventId, KernelSessionId, ProposalId, ReceivedEvent,
    RootCause,
};
use abdo_journal::{
    AppendRequest, CompactRequest, CompactedEntry, Head, Journal, JournalError, StreamId,
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TempJournal {
    root: PathBuf,
    database: PathBuf,
}

impl TempJournal {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        for _ in 0..1_000 {
            let nonce = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "abdo-journal-{label}-{}-{timestamp}-{nonce}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let database = root.join("journal.sqlite3");
                    return Self { root, database };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create exclusive journal test directory: {error}"),
            }
        }
        panic!("cannot allocate an exclusive journal test directory")
    }

    fn path(&self) -> &Path {
        &self.database
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn id<T>(value: u128) -> T
where
    T: TryFromU128,
{
    T::from_u128(value)
}

trait TryFromU128 {
    fn from_u128(value: u128) -> Self;
}

macro_rules! impl_id {
    ($($type:ty),+ $(,)?) => {
        $(
            impl TryFromU128 for $type {
                fn from_u128(value: u128) -> Self {
                    <$type>::try_from_u128(value).unwrap()
                }
            }
        )+
    };
}

impl_id!(CommandId, EventId, KernelSessionId, ProposalId);

fn event(seed: u128) -> AdmissionEvent {
    AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: id(seed + 1),
        proposal_id: id(seed + 2),
        command_id: id(seed + 3),
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms: 1_000 + seed as u64,
    }))
}

const STREAM: u128 = 0x5130;

/// Append `count` events and return the head after each one.
fn seed(journal: &mut Journal, stream: StreamId, count: u128) -> Vec<Head> {
    let mut heads = Vec::new();
    let mut expected: Option<Head> = None;
    for index in 0..count {
        let receipt = journal
            .append(AppendRequest {
                stream_id: stream,
                expected_head: expected,
                event: &event(index * 100 + 1),
                projection: None,
                snapshot: None,
            })
            .expect("append");
        expected = Some(receipt.head);
        heads.push(receipt.head);
    }
    heads
}

fn stream_id() -> StreamId {
    StreamId::try_from_u128(STREAM).expect("stream id")
}

fn open(temp: &TempJournal) -> Journal {
    Journal::open(temp.path()).expect("open journal")
}

#[test]
fn shadows_a_range_without_removing_a_single_event() {
    let temp = TempJournal::new("shadow");
    let mut journal = open(&temp);
    let stream = stream_id();
    let heads = seed(&mut journal, stream, 10);

    journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 6,
            summary: b"five turns, nothing decided",
            tokens_before: 5_000,
            tokens_after: 400,
        })
        .expect("compact");

    // The events are still there, at the same sequences, with the same hashes.
    // This is the whole difference between compaction and loss.
    let raw = journal.read_from(stream, 0).expect("read raw");
    assert_eq!(raw.len(), 10);
    for (index, envelope) in raw.iter().enumerate() {
        assert_eq!(envelope.stream_sequence, index as u64 + 1);
        assert_eq!(envelope.hash, heads[index].hash);
    }

    // And the head did not move: a compaction is not an append.
    assert_eq!(journal.head(stream).expect("head"), Some(heads[9]));
}

#[test]
fn the_compacted_view_substitutes_the_summary_exactly_once() {
    let temp = TempJournal::new("view");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 10);

    journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 6,
            summary: b"summary A",
            tokens_before: 5_000,
            tokens_after: 400,
        })
        .expect("compact");

    let view = journal.read_compacted(stream).expect("compacted view");
    let kinds: Vec<&'static str> = view
        .iter()
        .map(|entry| match entry {
            CompactedEntry::Event(_) => "event",
            CompactedEntry::Summary(_) => "summary",
        })
        .collect();
    // 1, [summary for 2..=6], 7, 8, 9, 10
    assert_eq!(
        kinds,
        vec!["event", "summary", "event", "event", "event", "event"]
    );

    let CompactedEntry::Summary(record) = &view[1] else {
        panic!("expected the shadowed range to be a summary");
    };
    assert_eq!(record.from_sequence, 2);
    assert_eq!(record.through_sequence, 6);
    assert_eq!(record.shadowed_events(), 5);
    assert_eq!(record.bytes, b"summary A");
    assert_eq!(record.tokens_before, 5_000);
    assert_eq!(record.tokens_after, 400);
}

#[test]
fn two_disjoint_compactions_both_apply_in_order() {
    let temp = TempJournal::new("disjoint");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 12);

    for (from, through, summary) in [(2u64, 4u64, &b"first"[..]), (6, 9, &b"second"[..])] {
        journal
            .compact(CompactRequest {
                stream_id: stream,
                from_sequence: from,
                through_sequence: through,
                summary,
                tokens_before: 1_000,
                tokens_after: 100,
            })
            .expect("compact");
    }

    let view = journal.read_compacted(stream).expect("view");
    let summaries: Vec<Vec<u8>> = view
        .iter()
        .filter_map(|entry| match entry {
            CompactedEntry::Summary(record) => Some(record.bytes.clone()),
            CompactedEntry::Event(_) => None,
        })
        .collect();
    assert_eq!(summaries, vec![b"first".to_vec(), b"second".to_vec()]);
    // 1, [2..4], 5, [6..9], 10, 11, 12
    assert_eq!(view.len(), 7);
}

#[test]
fn an_overlapping_compaction_is_refused() {
    let temp = TempJournal::new("overlap");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 10);

    journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 3,
            through_sequence: 6,
            summary: b"first",
            tokens_before: 100,
            tokens_after: 10,
        })
        .expect("compact");

    let error = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 5,
            through_sequence: 8,
            summary: b"second",
            tokens_before: 100,
            tokens_after: 10,
        })
        .expect_err("overlapping compaction must be refused");
    assert!(matches!(error, JournalError::InvalidInput(message) if message.contains("overlaps")));

    // The refusal left exactly one compaction behind.
    assert_eq!(journal.compactions(stream).expect("compactions").len(), 1);
}

#[test]
fn a_range_past_the_head_is_refused_and_changes_nothing() {
    let temp = TempJournal::new("past-head");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 4);

    let error = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 9,
            summary: b"too far",
            tokens_before: 100,
            tokens_after: 10,
        })
        .expect_err("a range past the head must be refused");
    assert!(
        matches!(error, JournalError::InvalidInput(message) if message.contains("past the stream head"))
    );
    assert!(journal.compactions(stream).expect("compactions").is_empty());
    assert_eq!(journal.read_from(stream, 0).expect("raw").len(), 4);
}

#[test]
fn an_inverted_range_and_a_growing_compaction_are_refused() {
    let temp = TempJournal::new("nonsense");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 4);

    let inverted = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 3,
            through_sequence: 2,
            summary: b"backwards",
            tokens_before: 100,
            tokens_after: 10,
        })
        .expect_err("an inverted range must be refused");
    assert!(
        matches!(inverted, JournalError::InvalidInput(message) if message.contains("inverted"))
    );

    // A "compaction" that grew the stream would otherwise be recorded as a
    // success and nobody would look again.
    let grew = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 1,
            through_sequence: 2,
            summary: b"longer than what it replaced",
            tokens_before: 10,
            tokens_after: 900,
        })
        .expect_err("a compaction that grows the stream must be refused");
    assert!(
        matches!(grew, JournalError::InvalidInput(message) if message.contains("more tokens after"))
    );

    assert!(journal.compactions(stream).expect("compactions").is_empty());
}

#[test]
fn an_oversized_summary_rolls_back_and_leaves_the_journal_verifiable() {
    let temp = TempJournal::new("overflow");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 6);
    let before = journal.verify().expect("verify before");

    // One byte past what a derived blob may be. This is the case that would
    // otherwise leave a half-written shadow behind.
    let oversized = vec![0u8; abdo_journal::MAX_DERIVED_BLOB_BYTES + 1];
    let error = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 4,
            summary: &oversized,
            tokens_before: 1_000,
            tokens_after: 10,
        })
        .expect_err("an oversized summary must be refused");
    assert!(matches!(error, JournalError::InvalidInput(_)));

    assert!(journal.compactions(stream).expect("compactions").is_empty());
    let after = journal.verify().expect("verify after");
    assert_eq!(before, after, "a refused compaction must change nothing");
}

#[test]
fn the_shadowed_range_is_rebuildable_after_reopening() {
    let temp = TempJournal::new("rebuild");
    let stream = stream_id();
    {
        let mut journal = open(&temp);
        seed(&mut journal, stream, 8);
        journal
            .compact(CompactRequest {
                stream_id: stream,
                from_sequence: 2,
                through_sequence: 5,
                summary: b"four turns",
                tokens_before: 4_000,
                tokens_after: 200,
            })
            .expect("compact");
    }

    // A fresh process. The compaction survived, and so did everything it shadowed.
    let journal = open(&temp);
    let records = journal.compactions(stream).expect("compactions");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].bytes, b"four turns");

    let rebuilt: Vec<u64> = journal
        .read_from(stream, 0)
        .expect("raw")
        .into_iter()
        .filter(|envelope| {
            envelope.stream_sequence >= records[0].from_sequence
                && envelope.stream_sequence <= records[0].through_sequence
        })
        .map(|envelope| envelope.stream_sequence)
        .collect();
    assert_eq!(rebuilt, vec![2, 3, 4, 5]);
    journal.verify().expect("integrity after reopen");
}

#[test]
fn appending_after_a_compaction_still_works_and_the_chain_holds() {
    let temp = TempJournal::new("append-after");
    let mut journal = open(&temp);
    let stream = stream_id();
    let heads = seed(&mut journal, stream, 5);

    journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 1,
            through_sequence: 3,
            summary: b"opening",
            tokens_before: 900,
            tokens_after: 90,
        })
        .expect("compact");

    let receipt = journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: Some(heads[4]),
            event: &event(9_999),
            projection: None,
            snapshot: None,
        })
        .expect("append after compaction");
    assert_eq!(receipt.stream_sequence, 6);
    journal.verify().expect("integrity after appending");

    let view = journal.read_compacted(stream).expect("view");
    // [1..3], 4, 5, 6
    assert_eq!(view.len(), 4);
    assert!(matches!(view[0], CompactedEntry::Summary(_)));
}

#[test]
fn a_compaction_cannot_be_deleted_or_rewritten() {
    let temp = TempJournal::new("append-only");
    let mut journal = open(&temp);
    let stream = stream_id();
    seed(&mut journal, stream, 5);
    journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 4,
            summary: b"kept",
            tokens_before: 500,
            tokens_after: 50,
        })
        .expect("compact");

    // Re-compacting the identical range is an overlap, which is the only door
    // in: there is no update path, and the triggers guarantee there never will
    // be one by accident.
    let again = journal
        .compact(CompactRequest {
            stream_id: stream,
            from_sequence: 2,
            through_sequence: 4,
            summary: b"rewritten",
            tokens_before: 500,
            tokens_after: 10,
        })
        .expect_err("a compaction may not be rewritten");
    assert!(matches!(again, JournalError::InvalidInput(message) if message.contains("overlaps")));
    assert_eq!(
        journal.compactions(stream).expect("compactions")[0].bytes,
        b"kept"
    );
}
