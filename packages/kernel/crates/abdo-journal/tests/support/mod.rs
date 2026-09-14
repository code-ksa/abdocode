#![allow(dead_code)]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use abdo_contracts::{
    AdmissionEvent, CauseRef, CommandId, EventId, ProposalId, ReceivedEvent, RootCause,
};

pub const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(2);
pub const CHILD_TIMEOUT: Duration = Duration::from_secs(15);
pub const CRASH_PARENT_GATE_ENV: &str = "ABDO_JOURNAL_CRASH_10K_PARENT_GATE";
pub const MIGRATION_PARENT_GATE_ENV: &str = "ABDO_JOURNAL_MIGRATION_PARENT_GATE";
pub const RESTORE_PARENT_GATE_ENV: &str = "ABDO_JOURNAL_RESTORE_100K_PARENT_GATE";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
pub struct ScopedChildren {
    children: Vec<Child>,
}

impl ScopedChildren {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            children: Vec::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, child: Child) {
        self.children.push(child);
    }

    pub fn as_mut_slice(&mut self) -> &mut [Child] {
        &mut self.children
    }

    pub fn take(&mut self) -> Vec<Child> {
        std::mem::take(&mut self.children)
    }
}

impl Drop for ScopedChildren {
    fn drop(&mut self) {
        for child in &mut self.children {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

#[derive(Debug)]
pub struct TestDirectory {
    path: PathBuf,
    canonical_parent: PathBuf,
}

impl TestDirectory {
    pub fn new(label: &str) -> Self {
        assert!(
            !label.is_empty()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
            "test directory label must be a non-empty lowercase slug"
        );
        let parent = env::temp_dir();
        let canonical_parent = fs::canonicalize(&parent).expect("temporary directory must exist");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must not precede the Unix epoch")
            .as_nanos();
        for _ in 0..100 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = canonical_parent.join(format!(
                "abdo-journal-{label}-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Self {
                        path,
                        canonical_parent,
                    };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create scoped journal test directory: {error}"),
            }
        }
        panic!("failed to allocate a unique scoped journal test directory")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, name: &str) -> PathBuf {
        assert_canonical_leaf_name(name);
        self.path.join(name)
    }

    pub fn write_handshake(&self, token: &str) -> PathBuf {
        assert!(valid_gate_token(token), "invalid parent handshake token");
        let path = self.join(".abdo-journal-test-token");
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .expect("handshake must be created exactly once");
        file.write_all(token.as_bytes())
            .expect("handshake token must be written");
        file.sync_all().expect("handshake token must be durable");
        path
    }

    pub fn remove(mut self) {
        self.remove_inner()
            .expect("scoped test directory cleanup failed");
        self.path = PathBuf::new();
    }

    fn remove_inner(&self) -> std::io::Result<()> {
        if self.path.as_os_str().is_empty() || !self.path.exists() {
            return Ok(());
        }
        let canonical = fs::canonicalize(&self.path)?;
        assert_eq!(
            canonical.parent(),
            Some(self.canonical_parent.as_path()),
            "refusing to remove a journal test directory outside the OS temp root"
        );
        let name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .expect("journal test directory name must be UTF-8");
        assert!(
            name.starts_with("abdo-journal-") && name.len() > "abdo-journal-".len(),
            "refusing to remove an unowned temporary directory"
        );
        fs::remove_dir_all(canonical)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = self.remove_inner();
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum ExactInvocationRole {
    Parent(String),
    Child,
}

pub fn exact_invocation_role(
    parent_gate: Option<String>,
    child_markers: &[Option<String>],
    sibling_parent_markers: &[Option<String>],
) -> Result<ExactInvocationRole, &'static str> {
    if sibling_parent_markers.iter().any(Option::is_some) {
        return Err("sibling S105 parent gate marker is forbidden");
    }
    let present = child_markers.iter().filter(|value| value.is_some()).count();
    match (parent_gate, present) {
        (Some(_), count) if count != 0 => Err("parent and child gate markers cannot coexist"),
        (None, 0) => Err("exact S105 test requires the forced parent gate"),
        (None, count) if count != child_markers.len() => {
            Err("partial child environment is forbidden")
        }
        (None, _) => Ok(ExactInvocationRole::Child),
        (Some(token), 0) if valid_gate_token(&token) => Ok(ExactInvocationRole::Parent(token)),
        (Some(_), 0) => Err("forced parent gate token is invalid"),
        (Some(_), _) => unreachable!(),
    }
}

pub fn valid_gate_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn validate_child_scope(
    directory: &Path,
    database: &Path,
    handshake: &Path,
    token: &str,
    expected_database_name: &str,
) {
    assert!(valid_gate_token(token), "invalid child gate token");
    assert_canonical_leaf_name(expected_database_name);
    let canonical_directory = fs::canonicalize(directory).expect("child directory must exist");
    assert_eq!(
        fs::canonicalize(database.parent().expect("database must have a parent"))
            .expect("database parent must exist"),
        canonical_directory,
        "child database escaped the parent-created directory"
    );
    assert_eq!(
        database.file_name().and_then(|value| value.to_str()),
        Some(expected_database_name),
        "child database name is not canonical"
    );
    assert_eq!(
        fs::canonicalize(handshake.parent().expect("handshake must have a parent"))
            .expect("handshake parent must exist"),
        canonical_directory,
        "child handshake escaped the parent-created directory"
    );
    assert_eq!(
        handshake.file_name().and_then(|value| value.to_str()),
        Some(".abdo-journal-test-token"),
        "child handshake name is not canonical"
    );
    assert_eq!(
        fs::read_to_string(handshake).expect("child handshake must be readable"),
        token,
        "child handshake token mismatch"
    );
}

pub fn wait_for_child(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("child status must be readable") {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().expect("timed-out child must be terminated");
            let _ = child.wait();
            panic!("journal crash child exceeded its bounded timeout");
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
    }
}

pub fn wait_for_children(children: &mut [Child], timeout: Duration) -> Vec<ExitStatus> {
    let deadline = Instant::now() + timeout;
    let mut statuses: Vec<Option<ExitStatus>> = (0..children.len()).map(|_| None).collect();
    loop {
        for (index, child) in children.iter_mut().enumerate() {
            if statuses[index].is_none() {
                statuses[index] = child.try_wait().expect("child status must be readable");
            }
        }
        if statuses.iter().all(Option::is_some) {
            return statuses
                .into_iter()
                .map(|status| status.expect("all child statuses were observed"))
                .collect();
        }
        if Instant::now() >= deadline {
            for (index, child) in children.iter_mut().enumerate() {
                if statuses[index].is_none() {
                    child.kill().expect("timed-out child must be terminated");
                    let _ = child.wait();
                }
            }
            panic!("journal crash child batch exceeded its bounded timeout");
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
    }
}

pub fn received_event(serial: u64) -> AdmissionEvent {
    let base = u128::from(serial) * 4 + 1;
    AdmissionEvent::Received(Box::new(ReceivedEvent {
        event_id: EventId::try_from_u128(base).expect("event ID must be non-zero"),
        proposal_id: ProposalId::try_from_u128(base + 1).expect("proposal ID must be non-zero"),
        command_id: CommandId::try_from_u128(base + 2).expect("command ID must be non-zero"),
        cause: CauseRef::Root(Box::new(RootCause)),
        at_ms: serial.checked_add(1).expect("event timestamp overflow"),
    }))
}

fn assert_canonical_leaf_name(name: &str) {
    assert!(
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains('/')
            && !name.contains('\\'),
        "path component must be a canonical leaf name"
    );
}
