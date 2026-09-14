#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use abdo_contracts::{
    AdmissionEvent, CauseRef, CommandId, EventId, ProposalId, ReceivedEvent, RootCause,
};
use abdo_journal::test_support::{
    seed_fixture, TEST_CHILD_DIR_ENV, TEST_CHILD_ROLE_ENV, TEST_CRASH_TOKEN_ENV,
    TEST_HANDSHAKE_FILENAME,
};
use abdo_journal::{
    AppendRequest, Journal, ProjectionKey, ProjectionUpdate, SnapshotInput, StreamId,
};

const USAGE_EXIT_CODE: i32 = 64;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    if std::env::var(TEST_CHILD_ROLE_ENV).as_deref() != Ok("1") {
        return Err("test child role marker is required".to_owned());
    }
    let mut arguments = std::env::args_os().skip(1);
    let Some(mode) = arguments.next().and_then(|value| value.into_string().ok()) else {
        std::process::exit(USAGE_EXIT_CODE);
    };
    match mode.as_str() {
        "append" => {
            let database = required_path(&mut arguments)?;
            let stream = required_stream(&mut arguments)?;
            let seed = required_u128(&mut arguments, "event seed")?;
            reject_extra(arguments)?;
            validate_child_database(&database)?;
            append(&database, stream, seed)
        }
        "checkpoint" => {
            let database = required_path(&mut arguments)?;
            reject_extra(arguments)?;
            validate_child_database(&database)?;
            let journal = Journal::open(&database).map_err(debug_error)?;
            let report = journal.checkpoint().map_err(debug_error)?;
            println!(
                "CHECKPOINT_ACK {} {} {}",
                report.busy, report.log_frames, report.checkpointed_frames
            );
            Ok(())
        }
        "migrate" => {
            let database = required_path(&mut arguments)?;
            reject_extra(arguments)?;
            validate_child_database(&database)?;
            let journal = Journal::open(&database).map_err(debug_error)?;
            println!("MIGRATE_ACK {}", journal.sqlite_identity().schema_version);
            Ok(())
        }
        "seed" => {
            let database = required_path(&mut arguments)?;
            let stream = required_stream(&mut arguments)?;
            let start_seed = required_u128(&mut arguments, "start seed")?;
            let count = required_u64(&mut arguments, "event count")?;
            let snapshot_sequence = required_u64(&mut arguments, "snapshot sequence")?;
            reject_extra(arguments)?;
            validate_child_database(&database)?;
            let mut journal = Journal::open(&database).map_err(debug_error)?;
            let report = seed_fixture(&mut journal, stream, start_seed, count, snapshot_sequence)
                .map_err(debug_error)?;
            println!(
                "SEED_ACK {} {} {} {}",
                report.events,
                report.snapshot_sequence,
                report.head.hash,
                hex(&report.fixture_digest)
            );
            Ok(())
        }
        _ => {
            std::process::exit(USAGE_EXIT_CODE);
        }
    }
}

fn append(database: &Path, stream: StreamId, seed: u128) -> Result<(), String> {
    let mut journal = Journal::open(database).map_err(debug_error)?;
    let head = journal.head(stream).map_err(debug_error)?;
    let key = ProjectionKey::new("recovery-state").map_err(str::to_owned)?;
    let projection_sequence = journal
        .projection(stream, &key)
        .map_err(debug_error)?
        .map_or(0, |projection| projection.through_sequence);
    let event = fixture_event(seed)?;
    let projection_bytes = format!("projection-{seed}").into_bytes();
    let snapshot_bytes = format!("snapshot-{seed}").into_bytes();
    let receipt = journal
        .append(AppendRequest {
            stream_id: stream,
            expected_head: head,
            event: &event,
            projection: Some(ProjectionUpdate {
                key: &key,
                expected_sequence: projection_sequence,
                bytes: &projection_bytes,
            }),
            snapshot: Some(SnapshotInput {
                bytes: &snapshot_bytes,
            }),
        })
        .map_err(debug_error)?;
    println!(
        "APPEND_ACK {} {} {}",
        receipt.global_sequence, receipt.stream_sequence, receipt.head.hash
    );
    Ok(())
}

fn fixture_event(seed: u128) -> Result<AdmissionEvent, String> {
    let event_id = seed.checked_add(1).ok_or("event id overflow")?;
    let proposal_id = seed.checked_add(2).ok_or("proposal id overflow")?;
    let command_id = seed.checked_add(3).ok_or("command id overflow")?;
    let at_ms = u64::try_from(seed)
        .ok()
        .and_then(|value| value.checked_add(1_000))
        .ok_or("timestamp overflow")?;
    Ok(AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: EventId::try_from_u128(event_id).map_err(str::to_owned)?,
        proposal_id: ProposalId::try_from_u128(proposal_id).map_err(str::to_owned)?,
        command_id: CommandId::try_from_u128(command_id).map_err(str::to_owned)?,
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms,
    })))
}

fn required_path(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
) -> Result<PathBuf, String> {
    arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "database path is required".to_owned())
}

fn required_stream(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
) -> Result<StreamId, String> {
    StreamId::try_from_u128(required_u128(arguments, "stream id")?).map_err(str::to_owned)
}

fn required_u128(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<u128, String> {
    required_text(arguments, name)?
        .parse()
        .map_err(|_| format!("{name} must be canonical decimal u128"))
}

fn required_u64(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<u64, String> {
    required_text(arguments, name)?
        .parse()
        .map_err(|_| format!("{name} must be canonical decimal u64"))
}

fn required_text(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<String, String> {
    arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| format!("{name} is required and must be Unicode"))
}

fn reject_extra(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<(), String> {
    if arguments.next().is_some() {
        Err("unexpected extra arguments".to_owned())
    } else {
        Ok(())
    }
}

fn validate_child_database(database: &Path) -> Result<(), String> {
    for parent_gate in [
        "ABDO_JOURNAL_CRASH_10K_PARENT_GATE",
        "ABDO_JOURNAL_MIGRATION_PARENT_GATE",
        "ABDO_JOURNAL_RESTORE_100K_PARENT_GATE",
    ] {
        if std::env::var_os(parent_gate).is_some() {
            return Err("test child cannot inherit a parent gate marker".to_owned());
        }
    }
    if !database.is_absolute() {
        return Err("database path must be absolute".to_owned());
    }
    let child_dir = std::env::var_os(TEST_CHILD_DIR_ENV)
        .ok_or_else(|| "test child directory marker is required".to_owned())?;
    let child_dir = std::fs::canonicalize(child_dir).map_err(|error| error.to_string())?;
    let parent = database
        .parent()
        .ok_or_else(|| "database path has no parent".to_owned())?;
    let parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if parent != child_dir {
        return Err("database parent differs from the trusted child directory".to_owned());
    }
    let token = std::env::var(TEST_CRASH_TOKEN_ENV)
        .map_err(|_| "test child token marker is required".to_owned())?;
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("test child token must be lowercase SHA-256 hex".to_owned());
    }
    let handshake = std::fs::read_to_string(child_dir.join(TEST_HANDSHAKE_FILENAME))
        .map_err(|error| format!("test child handshake cannot be read: {error}"))?;
    if handshake != token {
        return Err("test child handshake does not match its token".to_owned());
    }
    Ok(())
}

fn debug_error(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}
