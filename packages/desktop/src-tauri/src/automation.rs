//! Main-window API and optional per-user Windows background activation.
use super::{automation_store as store, automation_worker as worker};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use tauri::Webview;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub store: store::Store,
    pub worker_running: bool,
    pub task_registered: bool,
    pub service_supported: bool,
}
fn local(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("Dispatch is restricted to the main application window".into())
    }
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    super::profile::directory(app)
        .map(|p| p.join("automation"))
        .map_err(|_| "Automation directory is unavailable".into())
}
fn make_config(app: &tauri::AppHandle, dir: &Path) -> Result<worker::Config, String> {
    let settings_path = super::workspace_controls::engine_settings_path()?;
    let root = super::system_root();
    let state = std::env::var_os("ABDO_CODE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if root.join("abdocode.exe").exists() {
                root.clone()
            } else {
                root.join("engine/src")
            }
        });
    let trust_dir = std::env::var_os("ABDO_CODE_TRUST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| state.join("trusted-projects"));
    let environment = worker::ENV_PATHS
        .into_iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.is_empty())
                .map(|value| (key.into(), value))
        })
        .collect::<BTreeMap<_, _>>();
    let c = worker::Config {
        version: 1,
        engine_root: root,
        settings_path,
        workspace_path: super::profile::directory(app)
            .map_err(|_| "Workspace directory unavailable")?
            .join("workspace-v1.json"),
        trust_dir,
        environment,
    };
    store::atomic_json(&dir.join("worker-config.json"), &c)?;
    Ok(c)
}
fn task_name(dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(dir.to_string_lossy().to_lowercase().as_bytes());
    format!("AbdoCode-Automation-{:x}", digest)[..40].into()
}
fn powershell(script: &str) -> Result<String, String> {
    let exe = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut cmd = Command::new(exe);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| "Windows Task Scheduler could not be reached")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Windows Task Scheduler response unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = tx.send(stdout.take(4097).read_to_end(&mut bytes).map(|_| bytes));
    });
    let output = rx.recv_timeout(Duration::from_secs(15));
    if output.is_err() {
        let _ = child.kill();
    }
    let exit = child
        .wait()
        .map_err(|_| "Windows Task Scheduler did not finish")?;
    let output = output
        .map_err(|_| "Windows Task Scheduler timed out")?
        .map_err(|_| "Windows Task Scheduler response could not be read")?;
    if !exit.success() || output.len() > 4096 {
        return Err(
            "Windows Task Scheduler rejected the change. Background startup was not enabled."
                .into(),
        );
    }
    Ok(String::from_utf8_lossy(&output).trim().into())
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn registered(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        let name = quote(&task_name(dir));
        powershell(&format!("$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName {name} -ErrorAction SilentlyContinue; if($null -ne $task){{'yes'}}")).is_ok_and(|v|v=="yes")
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}
fn register(dir: &Path, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let name = quote(&task_name(dir));
        let exe = std::env::current_exe().map_err(|_| "Installed application path unavailable")?;
        let exe = quote(&exe.to_string_lossy());
        let arguments = quote(&format!(
            "--automation-worker --automation-dir \"{}\"",
            dir.display()
        ));
        let script = if enabled {
            format!("$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=New-ScheduledTaskAction -Execute {exe} -Argument {arguments}; $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user; $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName {name} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null")
        } else {
            format!("$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName {name} -ErrorAction SilentlyContinue; if($null -ne $task){{Unregister-ScheduledTask -TaskName {name} -Confirm:$false}}")
        };
        powershell(&script)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (dir, enabled);
        Err("Background startup currently requires Windows".into())
    }
}
fn start(dir: &Path, drain: bool) -> Result<(), String> {
    if store::worker_running(dir)? {
        return Ok(());
    }
    let mut cmd =
        Command::new(std::env::current_exe().map_err(|_| "Application path unavailable")?);
    cmd.arg("--automation-worker")
        .arg("--automation-dir")
        .arg(dir);
    if drain {
        cmd.arg("--drain");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    cmd.spawn()
        .map_err(|_| "Could not start the background worker")?;
    Ok(())
}
fn snapshot(dir: &Path) -> Result<Status, String> {
    Ok(Status {
        store: store::read(dir)?,
        worker_running: store::worker_running(dir)?,
        task_registered: registered(dir),
        service_supported: cfg!(windows),
    })
}

#[tauri::command]
pub(crate) fn automation_status(app: tauri::AppHandle, webview: Webview) -> Result<Status, String> {
    local(&webview)?;
    snapshot(&directory(&app)?)
}
#[tauri::command]
pub(crate) fn automation_enqueue(
    app: tauri::AppHandle,
    webview: Webview,
    request: store::JobInput,
) -> Result<store::Job, String> {
    local(&webview)?;
    let dir = directory(&app)?;
    let c = make_config(&app, &dir)?;
    store::validate_prompt(&request.title, &request.prompt)?;
    worker::validate_prompt(&c, &format!("{}\n{}", request.title, request.prompt))?;
    let (path, _) = worker::project(&c, &request.project_id)?;
    let settings = worker::owner_settings(&c)?;
    let mut request = request;
    request.mode = worker::capped_mode(&request.mode, &settings)?;
    let (job, enabled) = store::transaction(&dir, |s| {
        s.stop_requested = false;
        let enabled = s.enabled;
        Ok((
            store::enqueue(
                s,
                request,
                path,
                worker::selected_model(&settings),
                None,
                None,
            )?,
            enabled,
        ))
    })?;
    if let Err(error) = start(&dir, !enabled) {
        store::transaction(&dir, |s| {
            s.service_error = Some(error.clone());
            Ok(())
        })?;
        return Err(error);
    }
    Ok(job)
}
#[tauri::command]
pub(crate) fn automation_schedule_save(
    app: tauri::AppHandle,
    webview: Webview,
    schedule: store::Schedule,
) -> Result<store::Schedule, String> {
    local(&webview)?;
    let dir = directory(&app)?;
    let c = make_config(&app, &dir)?;
    store::validate_schedule(&schedule)?;
    worker::validate_prompt(&c, &format!("{}\n{}", schedule.name, schedule.prompt))?;
    worker::project(&c, &schedule.project_id)?;
    let settings = worker::owner_settings(&c)?;
    let mut schedule = schedule;
    schedule.mode = worker::capped_mode(&schedule.mode, &settings)?;
    store::transaction(&dir, |s| {
        if schedule.enabled && !s.enabled {
            return Err("Enable the background service before enabling a routine".into());
        }
        if !s.schedules.iter().any(|x| x.id == schedule.id) && s.schedules.len() >= 100 {
            return Err("The routine limit is 100".into());
        }
        s.schedules.retain(|x| x.id != schedule.id);
        s.schedules.push(schedule.clone());
        Ok(schedule)
    })
}
#[tauri::command]
pub(crate) fn automation_schedule_remove(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    local(&webview)?;
    store::transaction(&directory(&app)?, |s| {
        s.schedules.retain(|x| x.id != id);
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn automation_cancel(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    local(&webview)?;
    store::transaction(&directory(&app)?, |s| {
        let job = s
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Task not found")?;
        if matches!(job.status.as_str(), "queued" | "needs-input") {
            let pending = job.status == "queued";
            job.status = "canceled".into();
            job.finished_at = Some(store::now());
            job.detail = if pending {
                "Canceled before execution.".into()
            } else {
                format!("{}\nCanceled after waiting for operator input; existing results were retained.", job.detail)
            };
        } else if job.status == "running" {
            job.cancel_requested = true;
        }
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn automation_retry(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
    request_id: String,
) -> Result<store::Job, String> {
    local(&webview)?;
    let dir = directory(&app)?;
    let c = make_config(&app, &dir)?;
    let prior = store::read(&dir)?
        .jobs
        .into_iter()
        .find(|j| j.id == id)
        .ok_or("Task not found")?;
    if matches!(prior.status.as_str(), "queued" | "running") {
        return Err("This task is already pending".into());
    }
    worker::validate_prompt(&c, &format!("{}\n{}", prior.title, prior.prompt))?;
    let (path, _) = worker::project(&c, &prior.project_id)?;
    let settings = worker::owner_settings(&c)?;
    let mode = worker::capped_mode(&prior.mode, &settings)?;
    let input = store::JobInput {
        id: request_id,
        title: prior.title,
        prompt: prior.prompt,
        project_id: prior.project_id,
        mode,
    };
    let (job, enabled) = store::transaction(&dir, |s| {
        s.stop_requested = false;
        Ok((
            store::enqueue(
                s,
                input,
                path,
                worker::selected_model(&settings),
                None,
                Some(id),
            )?,
            s.enabled,
        ))
    })?;
    start(&dir, !enabled)?;
    Ok(job)
}
#[tauri::command]
pub(crate) fn automation_background_set(
    app: tauri::AppHandle,
    webview: Webview,
    enabled: bool,
) -> Result<Status, String> {
    local(&webview)?;
    let dir = directory(&app)?;
    make_config(&app, &dir)?;
    // The scheduler operation is the explicit user opt-in. Failed registration
    // cannot leave the durable enabled flag claiming a working startup service.
    register(&dir, enabled)?;
    store::transaction(&dir, |s| {
        s.enabled = enabled;
        s.stop_requested = !enabled;
        s.service_error = None;
        Ok(())
    })?;
    if enabled {
        if let Err(error) = start(&dir, false) {
            store::transaction(&dir, |s| {
                s.service_error = Some(error.clone());
                Ok(())
            })?;
            return Err(error);
        }
    }
    snapshot(&dir)
}
#[tauri::command]
pub(crate) fn automation_clear_history(
    app: tauri::AppHandle,
    webview: Webview,
) -> Result<(), String> {
    local(&webview)?;
    store::transaction(&directory(&app)?, |s| {
        s.jobs
            .retain(|j| matches!(j.status.as_str(), "queued" | "running" | "needs-input"));
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn automation_migrate_legacy(
    app: tauri::AppHandle,
    webview: Webview,
) -> Result<Status, String> {
    local(&webview)?;
    let dir = directory(&app)?;
    if store::read(&dir)?.migrated_legacy {
        return snapshot(&dir);
    }
    let c = make_config(&app, &dir)?;
    let metadata = worker::load_json(&c.workspace_path)?;
    // Import only user data. Every imported routine is paused pending review.
    let mut imported = vec![];
    for old in metadata
        .get("schedules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = old.get("id").and_then(Value::as_str).unwrap_or("");
        let project_id = old.get("projectId").and_then(Value::as_str).unwrap_or("");
        let name = old.get("name").and_then(Value::as_str).unwrap_or("");
        let prompt = old.get("prompt").and_then(Value::as_str).unwrap_or("");
        if !store::valid_id(id) || !store::valid_id(project_id) {
            continue;
        }
        worker::validate_prompt(&c, &format!("{name}\n{prompt}"))?;
        let s = store::Schedule {
            id: id.into(),
            name: name.into(),
            prompt: prompt.into(),
            project_id: project_id.into(),
            mode: "read-only".into(),
            enabled: false,
            next_run_at: store::now() + 60_000,
            interval_minutes: old
                .get("intervalMinutes")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
            timezone: "UTC".into(),
            missed_run_policy: "skip".into(),
            last_run_at: None,
        };
        store::validate_schedule(&s)?;
        imported.push(s);
    }
    store::transaction(&dir, |s| {
        if !s.migrated_legacy {
            for value in imported {
                if !s.schedules.iter().any(|item| item.id == value.id) {
                    s.schedules.push(value);
                }
            }
            s.migrated_legacy = true;
        }
        Ok(())
    })?;
    snapshot(&dir)
}
pub(crate) fn worker_entry() -> bool {
    let arguments: Vec<_> = std::env::args_os().collect();
    if !arguments.iter().any(|v| v == "--automation-worker") {
        return false;
    }
    let result = (|| {
        let index = arguments
            .iter()
            .position(|v| v == "--automation-dir")
            .ok_or("Automation directory argument missing")?;
        let dir = PathBuf::from(
            arguments
                .get(index + 1)
                .ok_or("Automation directory argument missing")?,
        );
        if !dir.is_absolute() {
            return Err("Automation directory must be absolute".into());
        }
        worker::run(&dir, arguments.iter().any(|v| v == "--drain"))
    })();
    if let Err(error) = result {
        eprintln!("Background service: {error}");
        std::process::exit(1);
    }
    true
}
