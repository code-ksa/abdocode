//! The durable owner of Dispatch and routine occurrences. An OS file lock covers
//! every read/modify/write transaction, including changes by a closed-UI worker.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const MAX_STORE: u64 = 16 * 1024 * 1024;
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobInput {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub project_id: String,
    pub mode: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Job {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub project_id: String,
    pub project_path: String,
    pub mode: String,
    pub model: String,
    pub status: String,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub turn_id: Option<String>,
    pub output: String,
    pub detail: String,
    pub cancel_requested: bool,
    pub occurrence: Option<String>,
    pub retry_of: Option<String>,
    pub receipt_count: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Schedule {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub project_id: String,
    pub mode: String,
    pub enabled: bool,
    pub next_run_at: u64,
    pub interval_minutes: Option<u32>,
    pub timezone: String,
    pub missed_run_policy: String,
    #[serde(default)]
    pub last_run_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Store {
    pub version: u8,
    pub enabled: bool,
    pub stop_requested: bool,
    pub migrated_legacy: bool,
    pub schedules: Vec<Schedule>,
    pub jobs: Vec<Job>,
    pub worker_pid: Option<u32>,
    pub heartbeat_at: Option<u64>,
    pub service_error: Option<String>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            stop_requested: false,
            migrated_legacy: false,
            schedules: vec![],
            jobs: vec![],
            worker_pid: None,
            heartbeat_at: None,
            service_error: None,
        }
    }
}

pub(crate) fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
pub(crate) fn mode_rank(mode: &str) -> Option<u8> {
    match mode {
        "read-only" => Some(0),
        "auto" => Some(1),
        "full-access" => Some(2),
        _ => None,
    }
}
pub(crate) fn validate_prompt(title: &str, prompt: &str) -> Result<(), String> {
    if title.trim().is_empty()
        || title.len() > 160
        || prompt.trim().is_empty()
        || prompt.len() > 16_000
        || prompt.contains('\0')
    {
        return Err("Use a task name and a prompt up to 16,000 bytes.".into());
    }
    Ok(())
}
pub(crate) fn validate_schedule(s: &Schedule) -> Result<(), String> {
    validate_prompt(&s.name, &s.prompt)?;
    if !valid_id(&s.id)
        || !valid_id(&s.project_id)
        || mode_rank(&s.mode).is_none()
        || s.next_run_at == 0
        || s.next_run_at > 32_503_680_000_000
    {
        return Err("Invalid routine identity, permission mode, or UTC time.".into());
    }
    if s.interval_minutes
        .is_some_and(|n| !(5..=525_600).contains(&n))
    {
        return Err("Repeat intervals must be 5 to 525600 minutes.".into());
    }
    if !matches!(s.missed_run_policy.as_str(), "skip" | "once")
        || s.timezone.is_empty()
        || s.timezone.len() > 100
        || s.timezone.chars().any(char::is_control)
    {
        return Err("Invalid timezone label or missed-run policy.".into());
    }
    Ok(())
}

pub(crate) fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Could not encode automation data")?;
    if bytes.len() as u64 > MAX_STORE {
        return Err("Automation history is full. Clear completed history first.".into());
    }
    let parent = path.parent().ok_or("Automation path is unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create automation storage")?;
    let staging = parent.join(format!(".automation-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|_| "Could not stage automation data")?;
        file.write_all(&bytes)
            .map_err(|_| "Could not write automation data")?;
        file.sync_all()
            .map_err(|_| "Could not flush automation data")?;
        fs::rename(&staging, path).map_err(|_| "Could not publish automation data")
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result.map_err(String::from)
}
pub(crate) fn open_lock(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Could not create automation directory")?;
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open automation lock".into())
}
pub(crate) fn transaction<T>(
    dir: &Path,
    run: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let lock = open_lock(&dir.join("store.lock"))?;
    lock.lock()
        .map_err(|_| "Could not lock automation storage")?;
    let path = dir.join("queue-v1.json");
    let mut state = if path.exists() {
        if fs::metadata(&path)
            .map_err(|_| "Could not inspect automation storage")?
            .len()
            > MAX_STORE
        {
            return Err("Automation storage is too large".into());
        }
        serde_json::from_slice::<Store>(
            &fs::read(&path).map_err(|_| "Could not read automation storage")?,
        )
        .map_err(|_| "Automation storage is invalid; it has not been replaced")?
    } else {
        Store::default()
    };
    if state.version != 1 {
        return Err("Unsupported automation storage version".into());
    }
    let result = run(&mut state)?;
    atomic_json(&path, &state)?;
    Ok(result)
}
pub(crate) fn read(dir: &Path) -> Result<Store, String> {
    transaction(dir, |s| Ok(s.clone()))
}
pub(crate) fn worker_lock_path(dir: &Path) -> PathBuf {
    dir.join("worker.lock")
}
pub(crate) fn worker_running(dir: &Path) -> Result<bool, String> {
    let file = open_lock(&worker_lock_path(dir))?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(_) => Err("Could not inspect worker ownership".into()),
    }
}
pub(crate) fn enqueue(
    s: &mut Store,
    input: JobInput,
    path: String,
    model: String,
    occurrence: Option<String>,
    retry_of: Option<String>,
) -> Result<Job, String> {
    validate_prompt(&input.title, &input.prompt)?;
    if !valid_id(&input.id) || !valid_id(&input.project_id) || mode_rank(&input.mode).is_none() {
        return Err("Invalid task identity or permission mode".into());
    }
    if let Some(existing) = s.jobs.iter().find(|j| j.id == input.id) {
        if existing.prompt == input.prompt
            && existing.project_id == input.project_id
            && existing.mode == input.mode
        {
            return Ok(existing.clone());
        }
        return Err("Task identity is already used by another request".into());
    }
    if let Some(key) = &occurrence {
        if let Some(existing) = s.jobs.iter().find(|j| j.occurrence.as_ref() == Some(key)) {
            return Ok(existing.clone());
        }
    }
    if s.jobs.len() >= 200 {
        return Err("Dispatch history is full. Clear completed tasks first.".into());
    }
    let job = Job {
        id: input.id,
        title: input.title,
        prompt: input.prompt,
        project_id: input.project_id,
        project_path: path,
        mode: input.mode,
        model,
        status: "queued".into(),
        created_at: now(),
        started_at: None,
        finished_at: None,
        turn_id: None,
        output: String::new(),
        detail: String::new(),
        cancel_requested: false,
        occurrence,
        retry_of,
        receipt_count: 0,
    };
    s.jobs.push(job.clone());
    Ok(job)
}

/// Advance the original UTC cadence inside the same transaction as enqueue.
/// A long outage creates at most one latest occurrence; it never replays a burst.
pub(crate) fn due(s: &mut Schedule, time: u64) -> Option<String> {
    if !s.enabled || s.next_run_at > time {
        return None;
    }
    let scheduled = s.next_run_at;
    let latest = if let Some(minutes) = s.interval_minutes {
        let step = u64::from(minutes) * 60_000;
        let latest = scheduled + (time - scheduled) / step * step;
        s.next_run_at = latest + step;
        latest
    } else {
        s.enabled = false;
        scheduled
    };
    if s.missed_run_policy == "skip" && time.saturating_sub(scheduled) > 60_000 {
        return None;
    }
    s.last_run_at = Some(latest);
    Some(format!("{}:{latest}", s.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn schedule() -> Schedule {
        Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Check".into(),
            prompt: "read README.md".into(),
            project_id: uuid::Uuid::new_v4().to_string(),
            mode: "read-only".into(),
            enabled: true,
            next_run_at: 1_000_000,
            interval_minutes: Some(5),
            timezone: "Asia/Riyadh".into(),
            missed_run_policy: "once".into(),
            last_run_at: None,
        }
    }
    #[test]
    fn missed_intervals_advance_once_without_drift_or_replay() {
        let mut s = schedule();
        assert!(due(&mut s, 1_920_000).unwrap().ends_with(":1900000"));
        assert_eq!(s.next_run_at, 2_200_000);
        assert!(due(&mut s, 1_920_000).is_none());
        s.missed_run_policy = "skip".into();
        assert!(due(&mut s, 5_000_000).is_none());
        assert!(s.next_run_at > 5_000_000);
    }
    #[test]
    fn single_run_disabled_even_when_missed() {
        let mut s = schedule();
        s.interval_minutes = None;
        s.missed_run_policy = "skip".into();
        assert!(due(&mut s, 2_000_000).is_none());
        assert!(!s.enabled);
    }
    #[test]
    fn duplicate_request_and_occurrence_cannot_add_second_job() {
        let mut s = Store::default();
        let x = schedule();
        let input = JobInput {
            id: uuid::Uuid::new_v4().to_string(),
            title: x.name,
            prompt: x.prompt,
            project_id: x.project_id,
            mode: x.mode,
        };
        enqueue(
            &mut s,
            input.clone(),
            "C:/fixture".into(),
            "fixture".into(),
            Some("occurrence".into()),
            None,
        )
        .unwrap();
        enqueue(
            &mut s,
            input.clone(),
            "C:/fixture".into(),
            "fixture".into(),
            None,
            None,
        )
        .unwrap();
        let mut another = input;
        another.id = uuid::Uuid::new_v4().to_string();
        enqueue(
            &mut s,
            another,
            "C:/fixture".into(),
            "fixture".into(),
            Some("occurrence".into()),
            None,
        )
        .unwrap();
        assert_eq!(s.jobs.len(), 1);
    }
    #[test]
    fn file_lock_and_disk_transaction_share_one_owner() {
        let dir =
            std::env::temp_dir().join(format!("abdo-automation-store-{}", uuid::Uuid::new_v4()));
        let lock = open_lock(&worker_lock_path(&dir)).unwrap();
        lock.lock().unwrap();
        assert!(worker_running(&dir).unwrap());
        transaction(&dir, |s| {
            s.enabled = true;
            Ok(())
        })
        .unwrap();
        assert!(read(&dir).unwrap().enabled);
        drop(lock);
        assert!(!worker_running(&dir).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
