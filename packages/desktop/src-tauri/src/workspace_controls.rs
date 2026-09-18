//! Project profiles and measured workspace/browser status. These controls read
//! the existing engine trust store; they never manufacture approval receipts.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{State, Webview};

static PROFILE_LOCK: Mutex<()> = Mutex::new(());
const MAX_FILE: u64 = 128 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectProfile {
    project_id: String,
    chat_model: String,
    agent_model: String,
    mode: String,
    computer_use_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderStatus {
    project_id: String,
    path: String,
    available: bool,
    trust: String,
    trusted_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceControls {
    folders: Vec<FolderStatus>,
    profiles: Vec<ProjectProfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatus {
    owned_process_running: bool,
    pid: Option<u32>,
    port: u16,
    endpoint_ready: bool,
    computer_use_enabled: bool,
}

fn local_ui(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("Workspace settings are restricted to the main window".into())
    }
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    if fs::metadata(path)
        .map_err(|_| "Settings file is unavailable")?
        .len()
        > MAX_FILE
    {
        return Err("Settings file is too large".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Could not read settings")?)
        .map_err(|_| "Settings file is invalid".into())
}

pub(crate) fn engine_settings_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ABDO_CODE_SETTINGS").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        return Ok(if path.is_absolute() {
            path
        } else {
            super::system_root().join(path)
        });
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".config/abdocode/settings.json"))
        .ok_or_else(|| "Engine settings directory is unavailable".into())
}

/// خلفيّةُ متصفّح الوكيل من إعدادات المحرّك (owned | extension | off) — الافتراضُ owned.
pub(crate) fn browser_backend() -> Result<String, String> {
    let path = engine_settings_path()?;
    if !path.exists() {
        return Ok("owned".into());
    }
    Ok(read_json(&path)?
        .get("browserBackend")
        .and_then(|value| value.as_str())
        .filter(|value| ["owned", "extension", "off"].contains(value))
        .unwrap_or("owned")
        .to_string())
}

pub(crate) fn computer_use_enabled() -> Result<bool, String> {
    let path = engine_settings_path()?;
    if !path.exists() {
        return Ok(true);
    }
    Ok(read_json(&path)?
        .get("computerUseEnabled")
        .and_then(|value| value.as_bool())
        != Some(false))
}

fn profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    super::profile::directory(app)
        .map(|path| path.join("workspace-profiles.json"))
        .map_err(|_| "Workspace profile directory is unavailable".into())
}

fn saved_projects(app: &tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let store = super::workspace::workspace_store_get(app.clone())?;
    let value = serde_json::to_value(store).map_err(|_| "Workspace metadata is unavailable")?;
    Ok(value
        .get("projects")
        .and_then(|projects| projects.as_array())
        .into_iter()
        .flatten()
        .filter_map(|project| {
            Some((
                project.get("id")?.as_str()?.to_owned(),
                project.get("path")?.as_str()?.to_owned(),
            ))
        })
        .collect())
}

fn validate_profile(profile: &ProjectProfile, projects: &[(String, String)]) -> Result<(), String> {
    let model_ok = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && value.contains('/')
            && !value.chars().any(char::is_control)
    };
    if !projects.iter().any(|(id, _)| *id == profile.project_id) {
        return Err("Choose a saved project before configuring its profile".into());
    }
    if !model_ok(&profile.chat_model) || !model_ok(&profile.agent_model) {
        return Err("Choose a valid provider/model reference".into());
    }
    if !["read-only", "auto", "full-access"].contains(&profile.mode.as_str()) {
        return Err("Invalid project permission mode".into());
    }
    Ok(())
}

fn load_profiles(path: &Path) -> Result<Vec<ProjectProfile>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let profiles: Vec<ProjectProfile> = serde_json::from_value(read_json(path)?)
        .map_err(|_| "Saved workspace profiles are invalid")?;
    if profiles.len() > 200 {
        return Err("Too many workspace profiles".into());
    }
    Ok(profiles)
}

// Mirrors the engine trust-file key: sha256(resolve(path).toLowerCase()).
// Resolve lexically, rather than canonicalizing junctions to a different path.
fn trust_key(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Saved project path is not absolute".into());
    }
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(resolved.to_string_lossy().to_lowercase().as_bytes())
    ))
}

fn trust_path(root: &Path, project: &Path) -> Result<PathBuf, String> {
    Ok(root
        .join("trusted-projects")
        .join(format!("{}.json", trust_key(project)?)))
}

fn engine_state_root() -> PathBuf {
    std::env::var_os("ABDO_CODE_STATE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                super::system_root().join(path)
            }
        })
        .unwrap_or_else(super::system_root)
}

fn folder_status(root: &Path, id: &str, path: &str) -> FolderStatus {
    let marker = trust_path(root, Path::new(path));
    let mut trust = "untrusted".to_string();
    let mut trusted_at = None;
    match marker {
        Ok(marker) if marker.exists() => {
            // Engine checks marker existence. Report that effective fact even
            // for an old marker without display metadata; never infer trust
            // merely from a folder being present in the workspace list.
            trust = "trusted".into();
            if let Ok(value) = read_json(&marker) {
                trusted_at = value
                    .get("trustedAt")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned);
            }
        }
        Err(_) => trust = "unknown".into(),
        _ => {}
    }
    FolderStatus {
        project_id: id.into(),
        path: path.into(),
        available: Path::new(path).is_dir(),
        trust,
        trusted_at,
    }
}

#[tauri::command]
pub(crate) fn workspace_controls_get(
    app: tauri::AppHandle,
    webview: Webview,
) -> Result<WorkspaceControls, String> {
    local_ui(&webview)?;
    let projects = saved_projects(&app)?;
    let root = engine_state_root();
    let folders = projects
        .iter()
        .map(|(id, path)| folder_status(&root, id, path))
        .collect();
    let profiles = load_profiles(&profile_path(&app)?)?
        .into_iter()
        .filter(|profile| validate_profile(profile, &projects).is_ok())
        .collect();
    Ok(WorkspaceControls { folders, profiles })
}

#[tauri::command]
pub(crate) fn workspace_profile_set(
    app: tauri::AppHandle,
    webview: Webview,
    profile: ProjectProfile,
) -> Result<ProjectProfile, String> {
    local_ui(&webview)?;
    let projects = saved_projects(&app)?;
    validate_profile(&profile, &projects)?;
    let _lock = PROFILE_LOCK
        .lock()
        .map_err(|_| "Workspace profiles are busy")?;
    let path = profile_path(&app)?;
    let mut profiles = load_profiles(&path)?;
    profiles.retain(|row| row.project_id != profile.project_id);
    profiles.push(profile.clone());
    let bytes =
        serde_json::to_vec_pretty(&profiles).map_err(|_| "Could not encode workspace profiles")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("Workspace profiles are too large".into());
    }
    let parent = path.parent().ok_or("Workspace profile path is invalid")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create workspace profile directory")?;
    let staging = parent.join(format!("workspace-profiles-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&staging, bytes).map_err(|_| "Could not save workspace profile")?;
    if let Err(error) = fs::rename(&staging, &path) {
        let _ = fs::remove_file(&staging);
        return Err(format!("Could not replace workspace profiles: {error}"));
    }
    let persisted = load_profiles(&path)?
        .into_iter()
        .find(|row| row.project_id == profile.project_id)
        .ok_or("Saved profile was not found")?;
    Ok(persisted)
}

#[tauri::command]
pub(crate) fn workspace_folder_revoke(
    app: tauri::AppHandle,
    webview: Webview,
    project_id: String,
) -> Result<FolderStatus, String> {
    local_ui(&webview)?;
    let projects = saved_projects(&app)?;
    let (_, path) = projects
        .iter()
        .find(|(id, _)| *id == project_id)
        .ok_or("Project is not saved in this workspace")?;
    let root = engine_state_root();
    let marker = trust_path(&root, Path::new(path))?;
    if marker.exists() {
        fs::remove_file(&marker).map_err(|_| "Could not revoke this folder's trust")?;
    }
    Ok(folder_status(&root, &project_id, path))
}

fn browser_snapshot(pane: &super::BrowserPane) -> Result<BrowserStatus, String> {
    let enabled = computer_use_enabled()?;
    let (running, pid, endpoint_ready) = {
        let mut slot = pane
            .0
            .lock()
            .map_err(|_| "Browser process state is unavailable")?;
        match slot.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => {
                    let endpoint = super::browser_surface::publish_owned_endpoint(
                        child.id(),
                        super::PANE_PORT,
                    )?;
                    (true, Some(child.id()), endpoint.is_some())
                }
                Ok(Some(_)) => {
                    *slot = None;
                    super::browser_surface::clear_lease();
                    (false, None, false)
                }
                Err(_) => {
                    super::browser_surface::clear_lease();
                    (false, None, false)
                }
            },
            None => {
                super::browser_surface::clear_lease();
                (false, None, false)
            }
        }
    };
    Ok(BrowserStatus {
        owned_process_running: running,
        pid,
        port: super::PANE_PORT,
        endpoint_ready,
        computer_use_enabled: enabled,
    })
}

#[tauri::command]
pub(crate) fn workspace_browser_status(
    webview: Webview,
    pane: State<'_, super::BrowserPane>,
) -> Result<BrowserStatus, String> {
    local_ui(&webview)?;
    browser_snapshot(&pane)
}

#[tauri::command]
pub(crate) fn workspace_browser_open(
    app: tauri::AppHandle,
    webview: Webview,
    pane: State<'_, super::BrowserPane>,
    url: String,
) -> Result<BrowserStatus, String> {
    local_ui(&webview)?;
    if !computer_use_enabled()? {
        return Err("Enable browser computer use before opening the controlled browser".into());
    }
    if browser_backend()? == "off" {
        return Err("The agent browser is switched off in Settings; choose the lightweight browser or the extension first".into());
    }
    let before = browser_snapshot(&pane)?;
    if !before.owned_process_running
        && TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], super::PANE_PORT)),
            Duration::from_millis(200),
        )
        .is_ok()
    {
        // يتيمٌ من تشغيلٍ سابق للتطبيق (مالكُ العقد ميّت والمستمعُ هو Edge الذي أطلقناه) يُسترَدّ؛ وغيرُه يبقى غريباً لا يُمَسّ.
        if !super::browser_surface::reclaim_orphan(super::PANE_PORT)? {
            return Err("The browser control port is in use by another process; that browser was not connected or closed".into());
        }
    }
    super::browser_open(app, pane.clone(), url)?;
    browser_snapshot(&pane)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn saved_folder_is_not_automatically_trusted() {
        let root = std::env::temp_dir().join(format!("abdo-trust-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.to_string_lossy().into_owned();
        assert_eq!(folder_status(&root, "project", &path).trust, "untrusted");
        let marker = trust_path(&root, &root).unwrap();
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, b"{\"trustedAt\":\"2026-09-05\"}").unwrap();
        let measured = folder_status(&root, "project", &path);
        assert_eq!(measured.trust, "trusted");
        assert_eq!(measured.trusted_at.as_deref(), Some("2026-09-05"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn profiles_cannot_add_folders_or_unknown_permission_modes() {
        let projects = vec![("selected".into(), "C:\\project".into())];
        let mut profile = ProjectProfile {
            project_id: "selected".into(),
            chat_model: "deepseek/deepseek-v4-flash".into(),
            agent_model: "qwen/qwen3-coder-plus".into(),
            mode: "auto".into(),
            computer_use_enabled: false,
        };
        assert!(validate_profile(&profile, &projects).is_ok());
        profile.project_id = "unselected".into();
        assert!(validate_profile(&profile, &projects).is_err());
        profile.project_id = "selected".into();
        profile.mode = "bypass-everything".into();
        assert!(validate_profile(&profile, &projects).is_err());
    }
    #[test]
    fn endpoint_health_requires_real_cdp_json() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (mut client, _) = server.accept().unwrap();
            let mut buf = [0; 1024];
            let _ = client.read(&mut buf);
            let body = format!(
                "{{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:{port}/devtools/browser/{}\"}}",
                uuid::Uuid::new_v4()
            );
            client
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        assert!(super::super::browser_surface::endpoint(port).is_some());
        thread.join().unwrap();
        assert!(super::super::browser_surface::endpoint(port).is_none());
    }
}
