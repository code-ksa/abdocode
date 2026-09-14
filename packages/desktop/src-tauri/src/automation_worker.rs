//! One background worker, one engine per Dispatch run. It never sends approve
//! or trust-grant; absent operator input is a durable needs-input result.
use super::automation_store::{self as store, Job};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub version: u8,
    pub engine_root: PathBuf,
    pub settings_path: PathBuf,
    pub workspace_path: PathBuf,
    pub trust_dir: PathBuf,
    pub environment: BTreeMap<String, String>,
}
pub(crate) const ENV_PATHS: [&str; 4] = [
    "ABDO_VAULT_HOME",
    "ABDO_VAULT_DIR",
    "ABDO_VAULT_SCRIPT",
    "ABDO_VAULT_LOCAL",
];
pub(crate) fn load_json(path: &Path) -> Result<Value, String> {
    if fs::metadata(path)
        .map_err(|_| "Required settings file is unavailable")?
        .len()
        > 1024 * 1024
    {
        return Err("Required settings file is too large".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Could not read required settings")?)
        .map_err(|_| "Required settings file is invalid".into())
}
pub(crate) fn config(dir: &Path) -> Result<Config, String> {
    let value = load_json(&dir.join("worker-config.json"))?;
    let c: Config = serde_json::from_value(value).map_err(|_| "Invalid worker configuration")?;
    if c.version != 1
        || !c.engine_root.is_absolute()
        || !c.settings_path.is_absolute()
        || !c.workspace_path.is_absolute()
        || !c.trust_dir.is_absolute()
        || c.environment
            .keys()
            .any(|key| !ENV_PATHS.contains(&key.as_str()))
    {
        return Err("Unsupported worker configuration".into());
    }
    Ok(c)
}
pub(crate) fn project(c: &Config, id: &str) -> Result<(String, String), String> {
    let value = load_json(&c.workspace_path)?;
    let project = value
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
        })
        .ok_or("Project was removed; choose a saved project before retrying")?;
    let path = project
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Saved project path is missing")?;
    if !Path::new(path).is_absolute() || !Path::new(path).is_dir() {
        return Err("Saved project folder is unavailable".into());
    }
    Ok((
        path.into(),
        project
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
    ))
}
pub(crate) fn owner_settings(c: &Config) -> Result<Value, String> {
    if !c.settings_path.exists() {
        return Ok(json!({"mode":"read-only"}));
    }
    load_json(&c.settings_path)
}
pub(crate) fn selected_model(settings: &Value) -> String {
    settings
        .get("agentModel")
        .or_else(|| settings.get("model"))
        .or_else(|| settings.get("chatModel"))
        .and_then(Value::as_str)
        .unwrap_or(crate::provider_setup::DEFAULT_MODEL)
        .into()
}
pub(crate) fn capped_mode(requested: &str, current: &Value) -> Result<String, String> {
    let current = current
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("read-only");
    let requested_rank = store::mode_rank(requested).ok_or("Unknown permission mode")?;
    let current_rank = store::mode_rank(current).ok_or("Current permission mode is unavailable")?;
    Ok(if requested_rank > current_rank {
        current
    } else {
        requested
    }
    .into())
}

pub(crate) fn validate_prompt(c: &Config, prompt: &str) -> Result<(), String> {
    let prefix = super::engine_argv_prefix(&c.engine_root);
    let mut command = std::process::Command::new(&prefix[0]);
    command
        .args(&prefix[1..])
        .arg("automation-validate")
        .current_dir(&c.engine_root)
        .env("ABDO_CODE_SETTINGS", &c.settings_path)
        .env(
            "ABDO_CODE_STATE_DIR",
            c.settings_path
                .parent()
                .ok_or("Validation directory unavailable")?
                .join("automation/validation-state"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = EngineRun::own(
        command
            .spawn()
            .map_err(|_| "Could not validate task text with the engine")?,
    )?;
    if let Some(mut input) = child.child.stdin.take() {
        input
            .write_all(json!({"prompt":prompt}).to_string().as_bytes())
            .map_err(|_| "Could not validate task text")?;
    }
    let output = child
        .child
        .stdout
        .take()
        .ok_or("Validation output unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output.take(4097).read_to_end(&mut bytes).map(|_| bytes);
        let _ = tx.send(result);
    });
    let result = rx.recv_timeout(Duration::from_secs(15));
    drop(child);
    let bytes = result
        .map_err(|_| "Task validation timed out")?
        .map_err(|_| "Task validation failed")?;
    if bytes.len() > 4096 {
        return Err("Task validation returned an invalid response".into());
    }
    let result: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Task validation returned an invalid response")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("The task contains a possible credential or invalid text. Store credentials in the vault and reference them by name.".into());
    }
    Ok(())
}

struct EngineRun {
    child: Child,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}
impl EngineRun {
    fn own(child: Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err("Could not contain the background engine process".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            let assigned = if configured != 0 {
                unsafe { AssignProcessToJobObject(job, child.as_raw_handle().cast()) }
            } else {
                0
            };
            if assigned == 0 {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Could not assign the background engine to its owned process group".into(),
                );
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            Ok(Self { child })
        }
    }
}
impl Drop for EngineRun {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        };
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn update(dir: &Path, id: &str, change: impl FnOnce(&mut Job)) -> Result<(), String> {
    store::transaction(dir, |state| {
        let job = state
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Dispatch task disappeared")?;
        change(job);
        state.heartbeat_at = Some(store::now());
        Ok(())
    })
}
fn finish(dir: &Path, id: &str, status: &str, detail: &str) -> Result<(), String> {
    update(dir, id, |job| {
        job.status = status.into();
        job.detail = detail.chars().take(1200).collect();
        job.finished_at = Some(store::now());
    })
}
fn append(job: &mut Job, text: &str) {
    job.output.push_str(text);
    job.output.push('\n');
    if job.output.len() > 32_000 {
        let mut cut = job.output.len() - 32_000;
        while !job.output.is_char_boundary(cut) {
            cut += 1;
        }
        job.output.drain(..cut);
    }
}

pub(crate) fn execute(dir: &Path, c: &Config, job: &Job) -> Result<(), String> {
    let (path, instructions) = project(c, &job.project_id)?;
    if path.replace('\\', "/").to_lowercase() != job.project_path.replace('\\', "/").to_lowercase()
    {
        return finish(
            dir,
            &job.id,
            "needs-input",
            "The saved project folder changed. Review and enqueue a new task.",
        );
    }
    validate_prompt(c, &format!("{}\n{}", job.title, job.prompt))?;
    let mut settings = owner_settings(c)?;
    let mode = capped_mode(&job.mode, &settings)?;
    let object = settings
        .as_object_mut()
        .ok_or("Engine settings are not an object")?;
    object.remove("project");
    object.insert("mode".into(), json!(mode));
    object.insert("model".into(), json!(job.model));
    object.insert("agentModel".into(), json!(job.model));
    object.insert("chatModel".into(), json!(job.model));
    object.insert(
        "projectInstructions".into(),
        json!({"path":path,"text":instructions}),
    );
    let run_dir = dir.join("runs").join(&job.id);
    fs::create_dir_all(&run_dir).map_err(|_| "Could not create run storage")?;
    store::atomic_json(&run_dir.join("settings.json"), &settings)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut command = super::engine_command(&c.engine_root, &token);
    command
        .env("ABDO_CODE_SETTINGS", run_dir.join("settings.json"))
        .env("ABDO_CODE_STATE_DIR", run_dir.join("state"))
        .env("ABDO_CODE_TRUST_DIR", &c.trust_dir)
        .env("ABDO_PROJECT", &c.engine_root)
        .env("ABDO_AUTOMATION_WORKER", "1");
    for (key, value) in &c.environment {
        command.env(key, value);
    }
    #[cfg(test)]
    command
        .stderr(Stdio::inherit())
        .env("USERPROFILE", c.settings_path.parent().unwrap())
        .env("HOME", c.settings_path.parent().unwrap());
    let mut engine = EngineRun::own(
        command
            .spawn()
            .map_err(|_| "Could not start the background engine")?,
    )?;
    let stdout = engine
        .child
        .stdout
        .take()
        .ok_or("Engine output is unavailable")?;
    let (tx, rx) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let frame = super::read_json_frame(&mut reader);
            let ended = !matches!(frame, Ok(Some(_)));
            if tx.send(frame).is_err() || ended {
                break;
            }
        }
    });
    let input = engine
        .child
        .stdin
        .as_mut()
        .ok_or("Engine input is unavailable")?;
    super::write_json_frame(
        input,
        &json!({"kind":"hello","shell":"desktop","token":token}),
    )?;
    let turn_id = format!("dispatch-{}", job.id);
    let mut project_requested = false;
    let mut submitted = false;
    let started = Instant::now();
    let mut last_heartbeat = Instant::now();
    update(dir, &job.id, |job| {
        job.turn_id = Some(turn_id.clone());
        job.mode = mode.clone();
    })?;
    loop {
        if !submitted && started.elapsed() > Duration::from_secs(30) {
            return finish(
                dir,
                &job.id,
                "failed",
                "The engine did not become ready within 30 seconds.",
            );
        }
        if last_heartbeat.elapsed() >= Duration::from_secs(1) {
            let state = store::read(dir)?;
            let canceled = state.stop_requested
                || state
                    .jobs
                    .iter()
                    .find(|j| j.id == job.id)
                    .is_none_or(|j| j.cancel_requested);
            if canceled {
                return finish(dir,&job.id,"canceled","Canceled by the operator. Partial effects may exist; inspect the recorded output before retrying.");
            }
            store::transaction(dir, |s| {
                s.heartbeat_at = Some(store::now());
                Ok(())
            })?;
            last_heartbeat = Instant::now();
        }
        if started.elapsed() > Duration::from_secs(3600) {
            return finish(dir,&job.id,"needs-input","The one-hour background run limit was reached. Review partial results before retrying.");
        }
        let text = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(Some(text))) => text,
            Ok(Ok(None)) => {
                return Err("The background engine exited before a completion receipt".into())
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => return Err("Background engine output disconnected".into()),
        };
        let frame: Value = serde_json::from_str(&text).map_err(|_| "Invalid engine frame")?;
        let kind = frame.get("kind").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "trust-request" | "approval") {
            let detail = if kind == "trust-request" {
                "Project trust approval is required. Open and trust this folder in AbdoCode, then retry."
            } else {
                "The engine requires operator approval. This background run was paused without granting permission. Review its request and continue in an interactive conversation."
            };
            update(dir, &job.id, |job| {
                if let Some(what) = frame.get("what").and_then(Value::as_str) {
                    append(job, what);
                }
            })?;
            return finish(dir, &job.id, "needs-input", detail);
        }
        if kind == "ready" && !project_requested {
            super::write_json_frame(input, &json!({"kind":"project-set","path":path}))?;
            project_requested = true;
            continue;
        }
        if kind == "project"
            && frame.get("trusted").and_then(Value::as_bool) == Some(true)
            && project_requested
            && !submitted
        {
            super::write_json_frame(
                input,
                &json!({"kind":"submit","turn":{"id":turn_id,"body":job.prompt},"mode":mode,"conversationMode":"code"}),
            )?;
            submitted = true;
            continue;
        }
        let matching = frame.get("turnId").and_then(Value::as_str) == Some(turn_id.as_str());
        if matching && matches!(kind, "event" | "tool-result") {
            let output = frame
                .get(if kind == "event" { "payload" } else { "output" })
                .and_then(Value::as_str)
                .unwrap_or("");
            update(dir, &job.id, |job| {
                append(job, output);
                if kind == "tool-result" {
                    job.receipt_count = job.receipt_count.saturating_add(1);
                }
            })?;
        }
        if kind == "refused" && (matching || frame.get("turnId").is_none()) {
            return finish(
                dir,
                &job.id,
                "needs-input",
                frame
                    .get("why")
                    .and_then(Value::as_str)
                    .unwrap_or("The engine refused this task"),
            );
        }
        if matching && matches!(kind, "interrupted" | "unresolved") {
            return finish(dir,&job.id,"needs-input","The engine did not establish completion. Review the partial result before retrying.");
        }
        if matching && kind == "done" {
            let completed = frame.get("outcome").and_then(Value::as_str) == Some("completed");
            return finish(
                dir,
                &job.id,
                if completed {
                    "completed"
                } else {
                    "needs-input"
                },
                if completed {
                    "The engine recorded completion."
                } else {
                    "The engine recorded a checkpoint, not completion. Review before continuing."
                },
            );
        }
    }
}

fn tick(dir: &Path, c: &Config, scheduled: bool) -> Result<Option<Job>, String> {
    store::transaction(dir, |s| {
        s.heartbeat_at = Some(store::now());
        if scheduled && s.enabled && !s.stop_requested {
            let mut occurrences = Vec::new();
            for routine in &mut s.schedules {
                if let Some(key) = store::due(routine, store::now()) {
                    occurrences.push((routine.clone(), key));
                }
            }
            for (routine, key) in occurrences {
                match project(c, &routine.project_id)
                    .and_then(|(path, _)| owner_settings(c).map(|settings| (path, settings)))
                {
                    Ok((path, settings)) => {
                        let mode = capped_mode(&routine.mode, &settings)?;
                        let input = store::JobInput {
                            id: uuid::Uuid::new_v4().to_string(),
                            title: routine.name,
                            prompt: routine.prompt,
                            project_id: routine.project_id,
                            mode,
                        };
                        if let Err(error) = store::enqueue(
                            s,
                            input,
                            path,
                            selected_model(&settings),
                            Some(key),
                            None,
                        ) {
                            s.service_error = Some(error);
                        }
                    }
                    Err(error) => s.service_error = Some(error),
                }
            }
        }
        if s.stop_requested {
            return Ok(None);
        }
        if let Some(job) = s.jobs.iter_mut().find(|j| j.status == "queued") {
            job.status = "running".into();
            job.started_at = Some(store::now());
            return Ok(Some(job.clone()));
        }
        Ok(None)
    })
}
pub(crate) fn run(dir: &Path, _drain: bool) -> Result<(), String> {
    let lock = store::open_lock(&store::worker_lock_path(dir))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(()),
        Err(_) => return Err("Could not acquire background worker ownership".into()),
    }
    let c = config(dir)?;
    store::transaction(dir, |s| {
        s.worker_pid = Some(std::process::id());
        s.heartbeat_at = Some(store::now());
        for j in &mut s.jobs {
            if j.status == "running" {
                j.status = "needs-input".into();
                j.detail="Worker stopped during execution. Partial effects may exist; this run will not replay automatically.".into();
                j.finished_at = Some(store::now());
            }
        }
        Ok(())
    })?;
    let mut released = false;
    let result: Result<(), String> = (|| {
        loop {
            let before = store::read(dir)?;
            if !before.stop_requested {
                if let Some(job) = tick(dir, &c, before.enabled)? {
                    if let Err(error) = execute(dir, &c, &job) {
                        finish(dir, &job.id, "failed", &error)?;
                    }
                    continue;
                }
            }
            // Enqueue and shutdown use the same store lock. Release ownership
            // before allowing a new enqueue transaction to decide whether it
            // must start a worker, eliminating the last-job shutdown race.
            released = store::transaction(dir, |s| {
                if !s.stop_requested && (s.enabled || s.jobs.iter().any(|j| j.status == "queued")) {
                    return Ok(false);
                }
                s.worker_pid = None;
                s.heartbeat_at = Some(store::now());
                lock.unlock()
                    .map_err(|_| "Could not release background worker ownership")?;
                Ok(true)
            })?;
            if released {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        Ok(())
    })();
    if !released {
        let _ = store::transaction(dir, |s| {
            s.worker_pid = None;
            s.heartbeat_at = Some(store::now());
            if let Err(error) = &result {
                s.service_error = Some(error.clone());
            }
            Ok(())
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    struct Fixture {
        root: PathBuf,
        dir: PathBuf,
        c: Config,
        project_id: String,
        project_path: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ad-{}", uuid::Uuid::new_v4()));
            let dir = root.join("automation");
            let project_path = root.join("project");
            fs::create_dir_all(&project_path).unwrap();
            fs::write(project_path.join("input.txt"), "DISPATCH_REAL_FILE_PROOF").unwrap();
            let project_id = uuid::Uuid::new_v4().to_string();
            let packaged = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("payload");
            // After desktop preparation, qualify the same standalone engine
            // shipped by the installer; a shell's bun.cmd shim is not an exe.
            let engine_root = if packaged.join("abdocode.exe").exists() {
                packaged
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .to_path_buf()
            };
            let c = Config {
                version: 1,
                engine_root,
                settings_path: root.join("owner-settings.json"),
                workspace_path: root.join("workspace-v1.json"),
                trust_dir: root.join("existing-trust"),
                environment: BTreeMap::new(),
            };
            store::atomic_json(&c.settings_path,&json!({"mode":"full-access","language":"en","plugins":{"serversPanel":false},"computerUseEnabled":false})).unwrap();
            store::atomic_json(
                &c.workspace_path,
                &json!({"projects":[{"id":project_id,"path":project_path,"instructions":""}]}),
            )
            .unwrap();
            store::atomic_json(&dir.join("worker-config.json"), &c).unwrap();
            Self {
                root,
                dir,
                c,
                project_id,
                project_path,
            }
        }
        fn trust(&self) {
            let key = format!(
                "{:x}",
                Sha256::digest(
                    self.project_path
                        .to_string_lossy()
                        .to_lowercase()
                        .as_bytes()
                )
            );
            store::atomic_json(&self.c.trust_dir.join(format!("{key}.json")),&json!({"project":self.project_path,"by":"operator","trustedAt":"2026-09-05T00:00:00Z"})).unwrap();
        }
        fn enqueue(&self, prompt: &str, mode: &str) -> Job {
            store::transaction(&self.dir, |s| {
                store::enqueue(
                    s,
                    store::JobInput {
                        id: uuid::Uuid::new_v4().to_string(),
                        title: "Worker qualification".into(),
                        prompt: prompt.into(),
                        project_id: self.project_id.clone(),
                        mode: mode.into(),
                    },
                    self.project_path.to_string_lossy().into(),
                    crate::provider_setup::DEFAULT_MODEL.into(),
                    None,
                    None,
                )
            })
            .unwrap()
        }
    }
    #[test]
    fn permission_mode_cannot_grow_past_current_owner_setting() {
        assert_eq!(
            capped_mode("full-access", &json!({"mode":"read-only"})).unwrap(),
            "read-only"
        );
        assert_eq!(
            capped_mode("read-only", &json!({"mode":"full-access"})).unwrap(),
            "read-only"
        );
        assert!(capped_mode("bypass", &json!({"mode":"full-access"})).is_err());
    }
    #[test]
    #[ignore = "Runs the real framed engine with isolated local project fixtures and no model requests"]
    fn real_worker_reads_writes_and_pauses_at_trust_and_approval() {
        let f = Fixture::new();
        let untrusted = f.enqueue("read input.txt", "read-only");
        run(&f.dir, true).unwrap();
        let state = store::read(&f.dir).unwrap();
        let untrusted = state.jobs.iter().find(|j| j.id == untrusted.id).unwrap();
        assert_eq!(
            untrusted.status, "needs-input",
            "{} {}",
            untrusted.detail, untrusted.output
        );
        assert!(
            !f.c.trust_dir.exists(),
            "worker must not manufacture folder trust"
        );
        f.trust();
        let read = f.enqueue("read input.txt", "read-only");
        run(&f.dir, true).unwrap();
        let state = store::read(&f.dir).unwrap();
        let read = state.jobs.iter().find(|j| j.id == read.id).unwrap();
        assert_eq!(read.status, "completed", "{} {}", read.detail, read.output);
        assert!(read.output.contains("DISPATCH_REAL_FILE_PROOF"));
        let write = f.enqueue(
            "write actual-result.txt <<< DISPATCH_WRITTEN_BY_REAL_ENGINE",
            "full-access",
        );
        run(&f.dir, true).unwrap();
        let state = store::read(&f.dir).unwrap();
        let write = state.jobs.iter().find(|j| j.id == write.id).unwrap();
        assert_eq!(
            write.status, "completed",
            "{} {}",
            write.detail, write.output
        );
        assert_eq!(
            fs::read_to_string(f.project_path.join("actual-result.txt")).unwrap(),
            "DISPATCH_WRITTEN_BY_REAL_ENGINE"
        );
        let waiting = f.enqueue(
            "write approval-required.txt <<< MUST_NOT_EXIST",
            "read-only",
        );
        run(&f.dir, true).unwrap();
        let state = store::read(&f.dir).unwrap();
        assert_eq!(
            state
                .jobs
                .iter()
                .find(|j| j.id == waiting.id)
                .unwrap()
                .status,
            "needs-input"
        );
        assert!(!f.project_path.join("approval-required.txt").exists());
        assert!(!store::worker_running(&f.dir).unwrap());
        let prior = state.jobs.len();
        run(&f.dir, true).unwrap();
        assert_eq!(store::read(&f.dir).unwrap().jobs.len(), prior);
        assert_eq!(
            fs::read_to_string(f.project_path.join("actual-result.txt")).unwrap(),
            "DISPATCH_WRITTEN_BY_REAL_ENGINE"
        );
        eprintln!("Real worker proof: untrusted paused, actual file read, actual file written, approval paused without write, no replay on restart");
    }

    #[test]
    #[ignore = "Runs an isolated real engine sleep to qualify cancellation and crash recovery"]
    fn real_worker_cancel_and_crash_recovery_never_replay() {
        let f = Fixture::new();
        f.trust();
        let job = f.enqueue("run Start-Sleep -Seconds 30", "full-access");
        let dir = f.dir.clone();
        let running = std::thread::spawn(move || run(&dir, true));
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let state = store::read(&f.dir).unwrap();
            let record = state.jobs.iter().find(|j| j.id == job.id).unwrap();
            assert!(
                !matches!(
                    record.status.as_str(),
                    "failed" | "needs-input" | "completed"
                ),
                "{} {}",
                record.detail,
                record.output
            );
            if record.turn_id.is_some()
                && record.started_at.is_some_and(|at| store::now() > at + 2200)
            {
                break;
            }
            assert!(Instant::now() < deadline, "real engine did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let canceled = Instant::now();
        store::transaction(&f.dir, |s| {
            s.jobs
                .iter_mut()
                .find(|j| j.id == job.id)
                .unwrap()
                .cancel_requested = true;
            Ok(())
        })
        .unwrap();
        running.join().unwrap().unwrap();
        assert!(canceled.elapsed() < Duration::from_secs(5));
        assert_eq!(store::read(&f.dir).unwrap().jobs[0].status, "canceled");
        let abandoned = f.enqueue("write crash-replay.txt <<< MUST_NOT_RUN", "full-access");
        store::transaction(&f.dir, |s| {
            s.jobs
                .iter_mut()
                .find(|j| j.id == abandoned.id)
                .unwrap()
                .status = "running".into();
            Ok(())
        })
        .unwrap();
        run(&f.dir, true).unwrap();
        let state = store::read(&f.dir).unwrap();
        assert_eq!(
            state
                .jobs
                .iter()
                .find(|j| j.id == abandoned.id)
                .unwrap()
                .status,
            "needs-input"
        );
        assert!(!f.project_path.join("crash-replay.txt").exists());
        eprintln!("Real worker cancellation completed within 5s; abandoned running task retained as needs-input without replay");
    }
}
