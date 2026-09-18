//! Read-only workspace inspection and product-owned shell metadata.
//! Runtime permissions, credentials, approval decisions and execution state do
//! not belong in this file. Project access starts at the native folder picker.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_STORE: usize = 512 * 1024;
const MAX_TEXT: usize = 256 * 1024;
const MAX_GIT: usize = 1024 * 1024;
const MAX_GITHUB: usize = 256 * 1024;
static PICKED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Project {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Session {
    id: String,
    title: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default = "default_session_state")]
    state: String,
}
fn default_session_state() -> String {
    "ready".into()
}

impl Default for Session {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            project_id: None,
            archived: false,
            pinned: false,
            updated_at: None,
            state: default_session_state(),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Schedule {
    id: String,
    name: String,
    prompt: String,
    project_id: String,
    enabled: bool,
    interval_minutes: u32,
    #[serde(default)]
    next_run_at: Option<String>,
    #[serde(default)]
    last_run_at: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artifact {
    id: String,
    title: String,
    path: String,
    created_at: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    sidebar_width: u16,
    sidebar_side: String,
    #[serde(default = "default_true")]
    classify_session_states: bool,
    #[serde(default)]
    auto_archive_days: u16,
    #[serde(default = "default_interface_font")]
    interface_font: String,
    #[serde(default = "default_code_font")]
    code_font: String,
    #[serde(default = "default_transcript_size")]
    transcript_size: String,
    #[serde(default = "default_transcript_width")]
    transcript_width: String,
    #[serde(default = "default_ui_density")]
    ui_density: String,
    #[serde(default = "default_accent_color")]
    accent_color: String,
    #[serde(default = "default_code_theme_light")]
    code_theme_light: String,
    #[serde(default = "default_code_theme_dark")]
    code_theme_dark: String,
    #[serde(default = "default_true")]
    open_links_in_builtin: bool,
    #[serde(default = "default_browser_permission")]
    browser_default_permission: String,
    #[serde(default)]
    blocked_sites: Vec<String>,
    #[serde(default = "default_browser_persistence")]
    browser_persistence: String,
    #[serde(default = "default_true")]
    draft_pull_requests: bool,
    #[serde(default = "default_branch_prefix")]
    branch_prefix: String,
}
fn default_true() -> bool {
    true
}
fn default_interface_font() -> String {
    "system".into()
}
fn default_code_font() -> String {
    "Consolas".into()
}
fn default_transcript_size() -> String {
    "medium".into()
}
fn default_transcript_width() -> String {
    "comfortable".into()
}
fn default_ui_density() -> String {
    "comfortable".into()
}
fn default_accent_color() -> String {
    "gold".into()
}
fn default_code_theme_light() -> String {
    "abdo-light".into()
}
fn default_code_theme_dark() -> String {
    "abdo-dark".into()
}
fn default_browser_permission() -> String {
    "allow".into()
}
fn default_browser_persistence() -> String {
    // S6 (09-18): الافتراضُ «مشترك» — المتصفّحُ المملوك يبقى داخلاً بعد إعادة التشغيل؛ «لكلّ جلسة» اختيارٌ صريح.
    "shared".into()
}
fn default_branch_prefix() -> String {
    "abdo/".into()
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            sidebar_width: 356,
            sidebar_side: "left".into(),
            classify_session_states: true,
            auto_archive_days: 0,
            interface_font: default_interface_font(),
            code_font: default_code_font(),
            transcript_size: default_transcript_size(),
            transcript_width: default_transcript_width(),
            ui_density: default_ui_density(),
            accent_color: default_accent_color(),
            code_theme_light: default_code_theme_light(),
            code_theme_dark: default_code_theme_dark(),
            open_links_in_builtin: true,
            browser_default_permission: default_browser_permission(),
            blocked_sites: vec![],
            browser_persistence: default_browser_persistence(),
            draft_pull_requests: true,
            branch_prefix: default_branch_prefix(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceStore {
    version: u8,
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    sessions: Vec<Session>,
    #[serde(default)]
    schedules: Vec<Schedule>,
    #[serde(default)]
    artifacts: Vec<Artifact>,
    #[serde(default)]
    preferences: Preferences,
}
impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            version: 1,
            projects: vec![],
            sessions: vec![],
            schedules: vec![],
            artifacts: vec![],
            preferences: Preferences::default(),
        }
    }
}

fn safe_text(s: &str, max: usize, multiline: bool) -> bool {
    s.len() <= max
        && !s
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
}
fn id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
}
fn timestamp_ok(s: &Option<String>) -> bool {
    s.as_ref()
        .map(|v| {
            !v.is_empty()
                && v.len() <= 32
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || b"-:T.Z+".contains(&b))
        })
        .unwrap_or(true)
}
fn validate(store: &WorkspaceStore) -> Result<(), String> {
    if store.version != 1
        || store.projects.len() > 200
        || store.sessions.len() > 2000
        || store.schedules.len() > 200
        || store.artifacts.len() > 2000
    {
        return Err("Workspace metadata limit exceeded".into());
    }
    if !(220..=620).contains(&store.preferences.sidebar_width)
        || !["left", "right"].contains(&store.preferences.sidebar_side.as_str())
        || !["system", "cairo", "segoe"].contains(&store.preferences.interface_font.as_str())
        || !["small", "medium", "large"].contains(&store.preferences.transcript_size.as_str())
        || !["compact", "comfortable", "wide"]
            .contains(&store.preferences.transcript_width.as_str())
        || !["compact", "comfortable", "spacious"].contains(&store.preferences.ui_density.as_str())
        || !["gold", "blue", "violet", "emerald"].contains(&store.preferences.accent_color.as_str())
        || !["abdo-light", "github-light", "solarized-light"]
            .contains(&store.preferences.code_theme_light.as_str())
        || !["abdo-dark", "github-dark", "monokai"]
            .contains(&store.preferences.code_theme_dark.as_str())
        || !["allow", "block"].contains(&store.preferences.browser_default_permission.as_str())
        || !["session", "shared"].contains(&store.preferences.browser_persistence.as_str())
        || ![0, 7, 30, 90].contains(&store.preferences.auto_archive_days)
        || !safe_text(&store.preferences.code_font, 80, false)
        || store.preferences.code_font.trim().is_empty()
        || !safe_text(&store.preferences.branch_prefix, 40, false)
        || store.preferences.blocked_sites.len() > 200
        || store.preferences.blocked_sites.iter().any(|site| {
            site.is_empty()
                || site.len() > 253
                || site.starts_with('.')
                || site.ends_with('.')
                || site
                    .bytes()
                    .any(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')))
        })
    {
        return Err("Invalid workspace preferences".into());
    }
    let mut ids = HashSet::new();
    for p in &store.projects {
        if !id_ok(&p.id)
            || !ids.insert(&p.id)
            || p.name.trim().is_empty()
            || !safe_text(&p.name, 160, false)
            || !safe_text(&p.path, 4096, false)
            || !Path::new(&p.path).is_absolute()
            || !safe_text(&p.instructions, 16000, true)
        {
            return Err("Invalid project metadata".into());
        }
    }
    let project_ids = ids.clone();
    ids.clear();
    for s in &store.sessions {
        if !id_ok(&s.id)
            || !ids.insert(&s.id)
            || !safe_text(&s.title, 300, false)
            || s.project_id
                .as_ref()
                .is_some_and(|id| !project_ids.contains(id))
            || !timestamp_ok(&s.updated_at)
            || !["ready", "working", "done", "needs-input", "error"].contains(&s.state.as_str())
        {
            return Err("Invalid session metadata".into());
        }
    }
    ids.clear();
    for s in &store.schedules {
        if !id_ok(&s.id)
            || !ids.insert(&s.id)
            || s.name.trim().is_empty()
            || !safe_text(&s.name, 160, false)
            || s.prompt.trim().is_empty()
            || !safe_text(&s.prompt, 16000, true)
            || !project_ids.contains(&s.project_id)
            || !(1..=525600).contains(&s.interval_minutes)
            || !timestamp_ok(&s.next_run_at)
            || !timestamp_ok(&s.last_run_at)
        {
            return Err("Invalid schedule definition".into());
        }
    }
    ids.clear();
    for artifact in &store.artifacts {
        if !id_ok(&artifact.id)
            || !ids.insert(&artifact.id)
            || artifact.title.trim().is_empty()
            || !safe_text(&artifact.title, 300, false)
            || artifact.path.trim().is_empty()
            || !safe_text(&artifact.path, 4096, false)
            || !safe_text(&artifact.created_at, 40, false)
            || artifact
                .session_id
                .as_ref()
                .is_some_and(|value| !id_ok(value))
            || artifact
                .project_id
                .as_ref()
                .is_some_and(|value| !project_ids.contains(value))
        {
            return Err("Invalid artifact metadata".into());
        }
    }
    Ok(())
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    super::profile::directory(app)
        .map(|p| p.join("workspace-v1.json"))
        .map_err(|e| e.to_string())
}

pub(crate) fn browser_navigation_allowed(app: &tauri::AppHandle, url: &str) -> bool {
    url == "about:blank" || browser_url_allowed(app, url).is_ok()
}

pub(crate) fn browser_url_allowed(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let store = load(&store_path(app)?)?;
    browser_url_policy(&store.preferences, url)
}

fn browser_url_policy(preferences: &Preferences, url: &str) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|_| "رابط غير مفهوم".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("لا يُفتح إلا http/https".into());
    }
    if preferences.browser_default_permission == "block" {
        return Err("التصفح محظور من إعدادات المواقع".into());
    }
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if preferences.blocked_sites.iter().any(|raw| {
        let site = raw.to_ascii_lowercase();
        host == site.as_str()
            || host
                .strip_suffix(site.as_str())
                .is_some_and(|prefix| prefix.ends_with('.'))
    }) {
        return Err(format!("الموقع {host} محظور من إعدادات عبدو كود"));
    }
    Ok(())
}

pub(crate) fn browser_profile_shared(app: &tauri::AppHandle) -> bool {
    store_path(app)
        .and_then(|path| load(&path))
        .map(|store| store.preferences.browser_persistence == "shared")
        .unwrap_or(false)
}
fn load(path: &Path) -> Result<WorkspaceStore, String> {
    if !path.exists() {
        return Ok(WorkspaceStore::default());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_STORE as u64 {
        return Err("Workspace metadata is too large".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let store =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid workspace metadata".to_string())?;
    validate(&store)?;
    Ok(store)
}

pub(crate) fn register_picked(path: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Select a project folder".into());
    }
    PICKED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "Workspace access is unavailable")?
        .insert(canonical);
    Ok(())
}

// Only the authenticated engine child pipe calls this. UI messages and model
// text cannot mint a native folder grant. The engine has already validated the
// root and completed the project-create or existing-project trust gate.
pub(crate) fn register_engine_project(text: &str) -> Result<(), String> {
    let frame: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if frame.get("kind").and_then(|v| v.as_str()) != Some("project")
        || frame.get("trusted").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(());
    }
    let value = frame.get("path").and_then(|v| v.as_str()).ok_or("Missing engine project path")?;
    let path = Path::new(value);
    if !path.is_absolute() { return Err("Engine project path must be absolute".into()); }
    register_picked(path)
}

fn allowed_root(root: &str, store: &WorkspaceStore) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(root).map_err(|_| "Project folder is unavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("Project root is not a folder".into());
    }
    let picked = PICKED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "Workspace access is unavailable")?;
    if picked.contains(&canonical)
        || store
            .projects
            .iter()
            .any(|p| fs::canonicalize(&p.path).ok().as_ref() == Some(&canonical))
    {
        Ok(canonical)
    } else {
        Err("Select this project using the folder picker first".into())
    }
}

#[tauri::command]
pub(crate) fn workspace_store_get(app: tauri::AppHandle) -> Result<WorkspaceStore, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "Workspace metadata is unavailable")?;
    load(&store_path(&app)?)
}

#[tauri::command]
pub(crate) fn workspace_store_set(
    app: tauri::AppHandle,
    store: WorkspaceStore,
) -> Result<WorkspaceStore, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "Workspace metadata is unavailable")?;
    validate(&store)?;
    let target = store_path(&app)?;
    let previous = load(&target)?;
    for project in &store.projects {
        // Existing disconnected folders may keep their labels; a new path
        // always requires a native user selection, never arbitrary JS access.
        if !previous.projects.iter().any(|p| p.path == project.path) {
            allowed_root(&project.path, &previous)?;
        }
    }
    let bytes = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STORE {
        return Err("Workspace metadata is too large".into());
    }
    let parent = target
        .parent()
        .ok_or("Workspace metadata path is invalid")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = parent.join(format!("workspace-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stage)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    replace_file(&stage, &target)?;
    Ok(store)
}

#[cfg(windows)]
pub(crate) fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let a: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // REPLACE_EXISTING | WRITE_THROUGH; old data survives a failed replace.
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
pub(crate) fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|e| e.to_string())
}

fn private_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == ".git"
        || n == ".ssh"
        || n == ".aws"
        || n == ".azure"
        || n == ".gnupg"
        || n == ".npmrc"
        || n == ".netrc"
        || n == ".pypirc"
        || n == "credentials"
        || n == "credentials.json"
        || n == "id_rsa"
        || n == "id_ed25519"
        || (n.starts_with(".env") && !n.ends_with(".example") && !n.ends_with(".sample"))
        || n.contains("secret")
        || n.contains("vault")
        || n.contains("credential")
        || n.contains("access_token")
        || n == "auth.json"
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.ends_with(".p12")
        || n.ends_with(".pfx")
        || n.ends_with(".kdbx")
        || n.ends_with(".keystore")
}
fn is_reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn relative_path(root: &Path, relative: &str, allow_missing: bool) -> Result<PathBuf, String> {
    if relative.len() > 4096 || relative.contains(':') || relative.contains('\0') {
        return Err("Invalid relative path".into());
    }
    let path = Path::new(relative);
    let mut candidate = root.to_path_buf();
    for part in path.components() {
        let Component::Normal(name) = part else {
            return Err("Path must stay inside the project".into());
        };
        if private_name(&name.to_string_lossy()) {
            return Err("Private configuration is excluded from the file viewer".into());
        }
        candidate.push(name);
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if is_reparse(&meta) => {
                return Err("Linked paths are excluded from the file viewer".into())
            }
            Ok(_) => {
                if !fs::canonicalize(&candidate)
                    .map_err(|e| e.to_string())?
                    .starts_with(root)
                {
                    return Err("Path escaped the project".into());
                }
            }
            Err(e) if allow_missing && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(candidate)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeEntry {
    name: String,
    path: String,
    kind: String,
    bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeResult {
    root: String,
    path: String,
    entries: Vec<TreeEntry>,
    truncated: bool,
}

fn tree(root: &Path, path: &str) -> Result<TreeResult, String> {
    let directory = relative_path(root, path, false)?;
    let mut entries = vec![];
    let mut scanned = 0;
    let mut truncated = false;
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        scanned += 1;
        if scanned > 3000 || entries.len() >= 500 {
            truncated = true;
            break;
        }
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        if private_name(&name) || ["node_modules", "target", ".next"].contains(&name.as_str()) {
            continue;
        }
        let meta = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        if is_reparse(&meta) || (!meta.is_dir() && !meta.is_file()) {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(root)
            .map_err(|_| "Path escaped the project")?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(TreeEntry {
            name,
            path: relative,
            kind: if meta.is_dir() { "directory" } else { "file" }.into(),
            bytes: meta.len(),
        });
    }
    entries.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(TreeResult {
        root: root.to_string_lossy().into(),
        path: path.into(),
        entries,
        truncated,
    })
}
#[tauri::command]
pub(crate) fn workspace_tree(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<TreeResult, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    tree(&root, &path)
}

#[derive(Debug, Serialize)]
pub(crate) struct TextResult {
    path: String,
    text: String,
    bytes: usize,
}
fn read_text(root: &Path, path: &str) -> Result<TextResult, String> {
    if path.is_empty() {
        return Err("Choose a text file".into());
    }
    let full = relative_path(root, path, false)?;
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_TEXT as u64 {
        return Err("The file viewer accepts text files up to 256 KiB".into());
    }
    let mut bytes = vec![];
    fs::File::open(&full)
        .map_err(|e| e.to_string())?
        .take((MAX_TEXT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_TEXT || bytes.contains(&0) {
        return Err("File is too large or contains binary data".into());
    }
    let len = bytes.len();
    let text = String::from_utf8(bytes).map_err(|_| "The file is not UTF-8 text")?;
    Ok(TextResult {
        path: path.into(),
        text,
        bytes: len,
    })
}

fn write_text(
    root: &Path,
    path: &str,
    text: &str,
    expected: Option<&str>,
) -> Result<TextResult, String> {
    if path.is_empty() || text.len() > MAX_TEXT || text.contains('\0') {
        return Err("The file editor accepts UTF-8 text up to 256 KiB".into());
    }
    let full = relative_path(root, path, true)?;
    let current = if full.exists() {
        Some(read_text(root, path)?.text)
    } else {
        None
    };
    match (current.as_deref(), expected) {
        (Some(actual), Some(expected)) if actual != expected => {
            return Err("The file changed on disk. Reload it before saving.".into())
        }
        (Some(_), None) => return Err("The file already exists. Reload it before saving.".into()),
        (None, Some(_)) => {
            return Err("The file was removed. Reload the folder before saving.".into())
        }
        _ => {}
    }
    let parent = full.parent().ok_or("The file path is invalid")?;
    let parent_meta = fs::metadata(parent).map_err(|_| "The parent folder is unavailable")?;
    if !parent_meta.is_dir() || is_reparse(&parent_meta) {
        return Err("The parent folder is unavailable".into());
    }
    let stage = parent.join(format!(
        ".abdocode-write-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&stage)
            .map_err(|error| format!("Could not stage the file: {error}"))?;
        output
            .write_all(text.as_bytes())
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("Could not write the file: {error}"))?;
        drop(output);
        if let Ok(meta) = fs::metadata(&full) {
            fs::set_permissions(&stage, meta.permissions())
                .map_err(|error| format!("Could not preserve file permissions: {error}"))?;
        }
        replace_file(&stage, &full)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&stage);
    }
    result?;
    read_text(root, path)
}
#[tauri::command]
pub(crate) fn workspace_read(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<TextResult, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    read_text(&root, &path)
}

#[tauri::command]
pub(crate) fn workspace_write(
    app: tauri::AppHandle,
    root: String,
    path: String,
    text: String,
    expected: Option<String>,
) -> Result<TextResult, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    write_text(&root, &path, &text, expected.as_deref())
}

struct GitOutput {
    ok: bool,
    bytes: Vec<u8>,
    truncated: bool,
}
fn git_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        return raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string();
    }
    #[cfg(not(windows))]
    raw.to_string()
}
fn git(root: &Path, args: &[&str]) -> Result<GitOutput, String> {
    git_inspect(root, args, false)
}

fn git_inspect(root: &Path, args: &[&str], fixed_exclusions: bool) -> Result<GitOutput, String> {
    // --no-ext-diff and --no-textconv alone are insufficient: comparing the
    // worktree can invoke a repository's clean/process filters. Enumerate
    // configuration NAMES (never values) and disable every such driver before
    // status/diff. Config inspection itself executes no filters or hooks.
    let overrides = git_filter_overrides(root)?;
    git_command(root, args, &overrides, fixed_exclusions)
}

fn git_filter_overrides(root: &Path) -> Result<Vec<String>, String> {
    let names = git_command(
        root,
        &[
            "config",
            "--includes",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|smudge|process|required)$",
        ],
        &[],
        false,
    )?;
    if names.truncated {
        return Err("Repository filter configuration is too large".into());
    }
    let mut overrides = vec![];
    for name in String::from_utf8_lossy(&names.bytes).lines() {
        if !name.starts_with("filter.") || name.chars().any(char::is_control) || name.len() > 4096 {
            return Err("Invalid repository filter configuration".into());
        }
        overrides.push(format!(
            "{}={}",
            name,
            if name.ends_with(".required") {
                "false"
            } else {
                ""
            }
        ));
    }
    Ok(overrides)
}
fn git_command(root: &Path, args: &[&str], overrides: &[String], fixed_exclusions: bool) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command.env_clear();
    for name in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(name) {
            command.env(name, v);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "diff.external=",
            "-c",
            "core.pager=cat",
        ]);
    // Only the fixed status exclusions below use glob syntax; caller-supplied paths remain literal.
    if fixed_exclusions { command.env_remove("GIT_LITERAL_PATHSPECS"); }
    for value in overrides {
        command.arg("-c").arg(value);
    }
    command
        .arg("-C")
        .arg(git_path(root))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Git is not available on this computer")?;
    let stdout = child.stdout.take().ok_or("Git output is unavailable")?;
    let stderr = child.stderr.take().ok_or("Git errors are unavailable")?;
    let output = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = stdout.take((MAX_GIT + 1) as u64).read_to_end(&mut b);
        b
    });
    let errors = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = stderr.take(8192).read_to_end(&mut b);
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output.join();
            let _ = errors.join();
            return Err("Git inspection timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut bytes = output.join().map_err(|_| "Git output could not be read")?;
    let _ = errors.join();
    let truncated = bytes.len() > MAX_GIT;
    bytes.truncate(MAX_GIT);
    Ok(GitOutput {
        ok: status.success(),
        bytes,
        truncated,
    })
}

fn git_write_command(root: &Path, args: &[String], timeout: Duration) -> Result<(), String> {
    let overrides = git_filter_overrides(root)?;
    let mut command = Command::new("git");
    command.env_clear();
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "SSH_AUTH_SOCK",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "diff.external=",
            "-c",
            "core.pager=cat",
        ]);
    for value in overrides {
        command.arg("-c").arg(value);
    }
    command
        .arg("-C")
        .arg(git_path(root))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Git is not available on this computer".to_string())?;
    let stderr = child.stderr.take().ok_or("Git errors are unavailable")?;
    let errors = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stderr.take(8192).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let detail = errors.join().unwrap_or_default();
            return if status.success() {
                Ok(())
            } else if cfg!(test) {
                Err(format!(
                    "Git test action failed: {}",
                    String::from_utf8_lossy(&detail)
                ))
            } else {
                Err("Git could not complete the requested action. No credential or remote details were exposed.".into())
            };
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = errors.join();
            return Err("Git action timed out".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn ensure_repository_root(root: &Path) -> Result<(), String> {
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    if !top.ok {
        return Err("This folder is not a Git repository".into());
    }
    let top = String::from_utf8_lossy(&top.bytes).trim().to_string();
    if fs::canonicalize(top).ok().as_ref() != Some(&root.to_path_buf()) {
        return Err("Open the repository root before changing Git state".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitActionRequest {
    action: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    remote: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitActionResult {
    action: String,
    message: String,
    overview: GitOverview,
}

fn git_action(root: &Path, request: GitActionRequest) -> Result<GitActionResult, String> {
    ensure_repository_root(root)?;
    let action = request.action.as_str();
    let mut timeout = Duration::from_secs(20);
    let args: Vec<String> = match action {
        "stage" | "unstage" => {
            let path = request.path.as_deref().ok_or("Choose a changed file")?;
            relative_path(root, path, true)?;
            if action == "stage" {
                vec!["add".into(), "--".into(), path.into()]
            } else if git_optional(root, &["rev-parse", "--verify", "HEAD"])?.is_some() {
                vec![
                    "restore".into(),
                    "--staged".into(),
                    "--".into(),
                    path.into(),
                ]
            } else {
                vec![
                    "rm".into(),
                    "--cached".into(),
                    "--ignore-unmatch".into(),
                    "--".into(),
                    path.into(),
                ]
            }
        }
        "commit" => {
            let message = request.message.as_deref().map(str::trim).unwrap_or("");
            if message.is_empty() || !safe_text(message, 500, false) {
                return Err("Enter a one-line commit message up to 500 characters".into());
            }
            vec![
                "commit".into(),
                "--no-verify".into(),
                "-m".into(),
                message.into(),
            ]
        }
        "createBranch" => {
            let branch = request.branch.as_deref().map(str::trim).unwrap_or("");
            if branch.is_empty() || !safe_text(branch, 240, false) {
                return Err("Enter a valid branch name".into());
            }
            let checked = git(root, &["check-ref-format", "--branch", branch])?;
            if !checked.ok {
                return Err("Enter a valid branch name".into());
            }
            vec![
                "switch".into(),
                "--no-guess".into(),
                "-c".into(),
                branch.into(),
            ]
        }
        "switchBranch" => {
            let branch = request.branch.as_deref().map(str::trim).unwrap_or("");
            let overview = git_overview(root)?;
            if !overview.branches.iter().any(|item| item.name == branch) {
                return Err("Choose a local branch from this repository".into());
            }
            vec![
                "switch".into(),
                "--no-guess".into(),
                "--".into(),
                branch.into(),
            ]
        }
        "pull" => {
            if git_optional(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])?.is_none() {
                return Err("Set an upstream branch before pulling".into());
            }
            timeout = Duration::from_secs(90);
            vec!["pull".into(), "--ff-only".into(), "--no-rebase".into()]
        }
        "push" => {
            timeout = Duration::from_secs(90);
            let overview = git_overview(root)?;
            if overview.branch.is_empty() || overview.detached {
                return Err("Switch to a local branch before pushing".into());
            }
            if overview.upstream.is_some() {
                vec!["push".into(), "--no-verify".into()]
            } else {
                let remote = request.remote.as_deref().map(str::trim).unwrap_or("");
                if !overview.remotes.iter().any(|item| item.name == remote) {
                    return Err("Choose a configured remote".into());
                }
                vec![
                    "push".into(),
                    "--no-verify".into(),
                    "--set-upstream".into(),
                    remote.into(),
                    overview.branch,
                ]
            }
        }
        _ => return Err("Unsupported Git action".into()),
    };
    git_write_command(root, &args, timeout)?;
    Ok(GitActionResult {
        action: action.into(),
        message: "Git action completed".into(),
        overview: git_overview(root)?,
    })
}
#[derive(Serialize)]
pub(crate) struct GitFile {
    path: String,
    status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitResult {
    is_repository: bool,
    branch: String,
    files: Vec<GitFile>,
    diff: String,
    truncated: bool,
}
fn git_diff(root: &Path, path: Option<&str>, staged: bool) -> Result<GitResult, String> {
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    if !top.ok {
        return Ok(GitResult {
            is_repository: false,
            branch: String::new(),
            files: vec![],
            diff: String::new(),
            truncated: false,
        });
    }
    let top = String::from_utf8_lossy(&top.bytes).trim().to_string();
    if fs::canonicalize(top).ok().as_ref() != Some(&root.to_path_buf()) {
        return Err("Open the repository root to inspect its changes".into());
    }
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let status = git_inspect(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--", ".", ":(glob,exclude)**/node_modules/**", ":(glob,exclude)**/.next/**", ":(glob,exclude)**/target/**",
        ],
        true,
    )?;
    if !status.ok || status.truncated {
        return Err("Git status could not be read within the output limit".into());
    }
    let mut files = vec![];
    let records: Vec<&[u8]> = status.bytes.split(|b| *b == 0).collect();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.len() < 4 {
            continue;
        }
        let flag = String::from_utf8_lossy(&record[..2]).into_owned();
        let renamed = record[..2].contains(&b'R') || record[..2].contains(&b'C');
        let candidate = String::from_utf8_lossy(&record[3..]).into_owned();
        let old = if renamed && i < records.len() {
            let old = String::from_utf8_lossy(records[i]).into_owned();
            i += 1;
            Some(old)
        } else {
            None
        };
        if relative_path(root, &candidate, true).is_err()
            || old
                .as_ref()
                .is_some_and(|p| relative_path(root, p, true).is_err())
        {
            continue;
        }
        if files.len() >= 500 {
            break;
        }
        files.push(GitFile {
            path: candidate,
            status: flag,
        });
    }
    let selected: Vec<&str> = if let Some(path) = path.filter(|p| !p.is_empty()) {
        relative_path(root, path, true)?;
        if !files.iter().any(|f| f.path == path) {
            return Err("Choose a visible changed file".into());
        }
        vec![path]
    } else {
        files
            .iter()
            .filter(|f| f.status != "??")
            .map(|f| f.path.as_str())
            .collect()
    };
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
        "--unified=3",
    ];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.extend(selected.iter().copied());
    let diff = if selected.is_empty() {
        GitOutput {
            ok: true,
            bytes: vec![],
            truncated: false,
        }
    } else {
        git(root, &args)?
    };
    if !diff.ok {
        return Err("Git diff could not be read".into());
    }
    Ok(GitResult {
        is_repository: true,
        branch: String::from_utf8_lossy(&branch.bytes).trim().into(),
        files,
        diff: String::from_utf8_lossy(&diff.bytes).into(),
        truncated: diff.truncated || i < records.len(),
    })
}
#[tauri::command(async)]
pub(crate) fn workspace_git_diff(
    app: tauri::AppHandle,
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<GitResult, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    git_diff(&root, path.as_deref(), staged.unwrap_or(false))
}

#[derive(Serialize)]
pub(crate) struct GitBranch {
    name: String,
    head: String,
    current: bool,
    upstream: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommit {
    id: String,
    short_id: String,
    subject: String,
    authored_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemote {
    name: String,
    web_url: Option<String>,
    compare_url: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    locked: bool,
    prunable: bool,
    current: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitOverview {
    is_repository: bool,
    branch: String,
    head: Option<String>,
    upstream: Option<String>,
    ahead: Option<u64>,
    behind: Option<u64>,
    detached: bool,
    files: Vec<GitFile>,
    branches: Vec<GitBranch>,
    commits: Vec<GitCommit>,
    remotes: Vec<GitRemote>,
    worktrees: Vec<GitWorktree>,
    truncated: bool,
}

fn git_optional(root: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let output = git(root, args)?;
    if output.truncated {
        return Err("Git metadata exceeds the output limit".into());
    }
    if !output.ok {
        return Ok(None);
    }
    let text = String::from_utf8(output.bytes).map_err(|_| "Git metadata is not UTF-8")?;
    Ok(Some(text.trim().into()).filter(|s: &String| !s.is_empty()))
}

// Normalise only known public hosting URLs. Raw transport URLs, embedded
// credentials, query strings and fragments never leave this module.
fn normalized_remote_url(raw: &str) -> Option<tauri::Url> {
    let raw = raw.trim();
    if raw.len() > 4096 || raw.chars().any(char::is_control) {
        return None;
    }
    let candidate = if !raw.contains("://") {
        match raw.split_once(':') {
            Some((host, path)) if host.contains('@') && !path.starts_with('/') => {
                format!("https://{}/{}", host.rsplit('@').next().unwrap_or(""), path)
            }
            _ => return None,
        }
    } else {
        raw.into()
    };
    let Ok(mut url) = tauri::Url::parse(&candidate) else {
        return None;
    };
    if !["https", "http", "ssh"].contains(&url.scheme()) || url.port().is_some() {
        return None;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !["github.com", "gitlab.com", "bitbucket.org"].contains(&host.as_str()) {
        return None;
    }
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2
        || (host != "gitlab.com" && segments.len() != 2)
        || segments.iter().any(|s| {
            s.is_empty()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    let path = format!("/{}", path);
    let _ = url.set_scheme("https");
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.set_path(&path);
    Some(url)
}

// These are browser links only. A comparison link is deliberately not a pull
// request receipt; only the authenticated GitHub command below can create one.
fn git_remote_links(raw: &str, branch: &str) -> (Option<String>, Option<String>) {
    let Some(mut url) = normalized_remote_url(raw) else {
        return (None, None);
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let web = url.to_string();
    let compare = if host == "github.com" && branch != "HEAD" && !branch.is_empty() {
        if let Ok(mut parts) = url.path_segments_mut() {
            parts.push("compare").push(branch);
        }
        Some(url.to_string())
    } else {
        None
    };
    (Some(web), compare)
}

fn git_overview(root: &Path) -> Result<GitOverview, String> {
    // Reuse the existing confined status/file inspection. Its file list omits
    // private names and reparse points; the UI must not infer total repo size.
    let status = git_diff(root, None, false)?;
    let mut result = GitOverview {
        is_repository: status.is_repository,
        branch: status.branch,
        files: status.files,
        head: None,
        upstream: None,
        ahead: None,
        behind: None,
        detached: false,
        branches: vec![],
        commits: vec![],
        remotes: vec![],
        worktrees: vec![],
        truncated: status.truncated,
    };
    if !result.is_repository {
        return Ok(result);
    }
    result.head = git_optional(root, &["rev-parse", "--verify", "HEAD"])?;
    result.detached = result.head.is_some() && result.branch == "HEAD";
    if result.head.is_none() {
        result.branch = git_optional(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
            .unwrap_or_default();
    }
    result.upstream = git_optional(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    if result.upstream.is_some() {
        if let Some(counts) = git_optional(
            root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )? {
            let values: Vec<&str> = counts.split_whitespace().collect();
            if values.len() == 2 {
                result.ahead = values[0].parse().ok();
                result.behind = values[1].parse().ok();
            }
        }
    }
    let branches = git_optional(
        root,
        &[
            "for-each-ref",
            "--count=201",
            "--sort=refname",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
        ],
    )?;
    for line in branches.as_deref().unwrap_or("").lines() {
        if result.branches.len() == 200 {
            result.truncated = true;
            break;
        }
        let fields: Vec<&str> = line.split('\0').collect();
        if fields.len() != 4 || fields[..3].iter().any(|s| !safe_text(s, 4096, false)) {
            return Err("Invalid Git branch metadata".into());
        }
        result.branches.push(GitBranch {
            name: fields[0].into(),
            head: fields[1].into(),
            current: fields[3].trim() == "*",
            upstream: (!fields[2].is_empty()).then(|| fields[2].into()),
        });
    }
    if result.head.is_some() {
        let log = git_optional(
            root,
            &[
                "log",
                "-n",
                "30",
                "--no-show-signature",
                "--format=%H%x00%h%x00%s%x00%aI",
                "HEAD",
            ],
        )?;
        for line in log.as_deref().unwrap_or("").lines() {
            let fields: Vec<&str> = line.split('\0').collect();
            if fields.len() != 4 || fields.iter().any(|s| !safe_text(s, 8192, false)) {
                return Err("Invalid Git commit metadata".into());
            }
            result.commits.push(GitCommit {
                id: fields[0].into(),
                short_id: fields[1].into(),
                subject: fields[2].into(),
                authored_at: fields[3].into(),
            });
        }
    }
    let names = git_optional(root, &["remote"])?;
    for name in names.as_deref().unwrap_or("").lines() {
        if result.remotes.len() == 20 {
            result.truncated = true;
            break;
        }
        if !safe_text(name, 256, false) {
            return Err("Invalid Git remote name".into());
        }
        let key = format!("remote.{name}.url");
        let raw = git_optional(root, &["config", "--get", &key])?;
        let (web_url, compare_url) = raw
            .as_deref()
            .map(|s| git_remote_links(s, &result.branch))
            .unwrap_or_default();
        result.remotes.push(GitRemote {
            name: name.into(),
            web_url,
            compare_url,
        });
    }
    if let Some(rows) = git_optional(root, &["worktree", "list", "--porcelain"])? {
        for block in rows.split("\n\n") {
            if result.worktrees.len() == 100 {
                result.truncated = true;
                break;
            }
            let mut path = None;
            let mut head = None;
            let mut branch = None;
            let mut locked = false;
            let mut prunable = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("HEAD ") {
                    head = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_string());
                } else if line == "locked" || line.starts_with("locked ") {
                    locked = true;
                } else if line == "prunable" || line.starts_with("prunable ") {
                    prunable = true;
                }
            }
            let Some(path) = path else { continue };
            if !safe_text(&path, 4096, false)
                || head.as_deref().is_some_and(|v| !safe_text(v, 128, false))
                || branch
                    .as_deref()
                    .is_some_and(|v| !safe_text(v, 4096, false))
            {
                return Err("Invalid Git worktree metadata".into());
            }
            let current = fs::canonicalize(&path).ok().as_ref() == Some(&root.to_path_buf());
            result.worktrees.push(GitWorktree {
                path,
                head,
                branch,
                locked,
                prunable,
                current,
            });
        }
    }
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitHubRepository {
    owner: String,
    name: String,
    slug: String,
    web_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConfiguredRemote {
    name: String,
    provider: String,
    web_url: Option<String>,
    github: Option<GitHubRepository>,
}

fn configured_remote(
    root: &Path,
    overview: &GitOverview,
    requested: Option<&str>,
) -> Result<Option<ConfiguredRemote>, String> {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    let selected = if let Some(requested) = requested {
        overview
            .remotes
            .iter()
            .find(|remote| remote.name == requested)
            .ok_or("Choose a configured remote")?
    } else if let Some(origin) = overview
        .remotes
        .iter()
        .find(|remote| remote.name == "origin")
    {
        origin
    } else if let Some(first) = overview.remotes.first() {
        first
    } else {
        return Ok(None);
    };
    let key = format!("remote.{}.url", selected.name);
    let raw = git_optional(root, &["config", "--get", &key])?;
    let Some(url) = raw.as_deref().and_then(normalized_remote_url) else {
        return Ok(Some(ConfiguredRemote {
            name: selected.name.clone(),
            provider: "unknown".into(),
            web_url: None,
            github: None,
        }));
    };
    let provider = match url.host_str().unwrap_or("").to_ascii_lowercase().as_str() {
        "github.com" => "github",
        "gitlab.com" => "gitlab",
        "bitbucket.org" => "bitbucket",
        _ => "unknown",
    };
    let web_url = url.to_string();
    let github = if provider == "github" {
        let segments: Vec<String> = url
            .path_segments()
            .into_iter()
            .flatten()
            .map(str::to_string)
            .collect();
        if segments.len() != 2 {
            None
        } else {
            Some(GitHubRepository {
                owner: segments[0].clone(),
                name: segments[1].clone(),
                slug: format!("{}/{}", segments[0], segments[1]),
                web_url: web_url.clone(),
            })
        }
    } else {
        None
    };
    Ok(Some(ConfiguredRemote {
        name: selected.name.clone(),
        provider: provider.into(),
        web_url: Some(web_url),
        github,
    }))
}

fn suggested_base_branch(root: &Path, overview: &GitOverview, remote: &str) -> String {
    let remote_head = format!("refs/remotes/{remote}/HEAD");
    if let Ok(Some(value)) =
        git_optional(root, &["symbolic-ref", "--quiet", "--short", &remote_head])
    {
        if let Some(branch) = value.strip_prefix(&format!("{remote}/")) {
            if !branch.is_empty() && safe_text(branch, 240, false) {
                return branch.into();
            }
        }
    }
    for candidate in ["main", "master"] {
        if overview
            .branches
            .iter()
            .any(|branch| branch.name == candidate)
        {
            return candidate.into();
        }
    }
    overview
        .branches
        .iter()
        .find(|branch| !branch.current)
        .map(|branch| branch.name.clone())
        .unwrap_or_else(|| "main".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitHubRunError {
    Unavailable,
    TimedOut,
    Failed,
}

#[derive(Clone)]
struct GitHubOutput {
    ok: bool,
    bytes: Vec<u8>,
    truncated: bool,
}

trait GitHubRunner {
    fn run(
        &self,
        args: &[OsString],
        capture_stdout: bool,
        timeout: Duration,
    ) -> Result<GitHubOutput, GitHubRunError>;
}

struct SystemGitHubRunner;

impl GitHubRunner for SystemGitHubRunner {
    fn run(
        &self,
        args: &[OsString],
        capture_stdout: bool,
        timeout: Duration,
    ) -> Result<GitHubOutput, GitHubRunError> {
        let mut command = Command::new("gh");
        command.env_clear();
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "GH_CONFIG_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_FORCE_TTY", "0")
            .env("NO_COLOR", "1")
            .env("PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .stdin(Stdio::null())
            .stdout(if capture_stdout {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitHubRunError::Unavailable
            } else {
                GitHubRunError::Failed
            }
        })?;
        let reader = child.stdout.take().map(|stdout| {
            std::thread::spawn(move || {
                let mut bytes = vec![];
                let _ = stdout.take((MAX_GITHUB + 1) as u64).read_to_end(&mut bytes);
                bytes
            })
        });
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|_| GitHubRunError::Failed)? {
                break status;
            }
            if started.elapsed() > timeout {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(reader) = reader {
                    let _ = reader.join();
                }
                return Err(GitHubRunError::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let mut bytes = match reader {
            Some(reader) => reader.join().map_err(|_| GitHubRunError::Failed)?,
            None => vec![],
        };
        let truncated = bytes.len() > MAX_GITHUB;
        bytes.truncate(MAX_GITHUB);
        Ok(GitHubOutput {
            ok: status.success(),
            bytes,
            truncated,
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitProviderStatus {
    provider: String,
    supported: bool,
    cli_available: bool,
    authenticated: bool,
    remote: String,
    repository: Option<String>,
    web_url: Option<String>,
    branch: String,
    suggested_base: String,
    can_create: bool,
    reason_code: Option<String>,
}

fn git_provider_status_with(
    root: &Path,
    requested_remote: Option<&str>,
    runner: &impl GitHubRunner,
) -> Result<GitProviderStatus, String> {
    ensure_repository_root(root)?;
    let overview = git_overview(root)?;
    let selected = configured_remote(root, &overview, requested_remote)?;
    let Some(selected) = selected else {
        return Ok(GitProviderStatus {
            provider: "none".into(),
            supported: false,
            cli_available: false,
            authenticated: false,
            remote: String::new(),
            repository: None,
            web_url: None,
            branch: overview.branch,
            suggested_base: "main".into(),
            can_create: false,
            reason_code: Some("noRemote".into()),
        });
    };
    let suggested_base = suggested_base_branch(root, &overview, &selected.name);
    let supported = selected.github.is_some();
    let mut cli_available = false;
    let mut authenticated = false;
    let auth = if supported {
        runner.run(
            &[
                "auth".into(),
                "status".into(),
                "--active".into(),
                "--hostname".into(),
                "github.com".into(),
            ],
            false,
            Duration::from_secs(15),
        )
    } else {
        Err(GitHubRunError::Unavailable)
    };
    match auth {
        Ok(output) => {
            cli_available = true;
            authenticated = output.ok;
        }
        Err(GitHubRunError::Unavailable) => {}
        Err(_) => cli_available = true,
    }
    let expected_upstream = format!("{}/{}", selected.name, overview.branch);
    let reason_code = if !supported {
        Some("unsupportedProvider")
    } else if !cli_available {
        Some("cliUnavailable")
    } else if !authenticated {
        Some("authenticationRequired")
    } else if overview.detached || overview.branch.is_empty() || overview.branch == "HEAD" {
        Some("branchRequired")
    } else if overview.upstream.as_deref() != Some(expected_upstream.as_str()) {
        Some("pushRequired")
    } else if overview.ahead != Some(0) {
        Some("pushRequired")
    } else {
        None
    };
    Ok(GitProviderStatus {
        provider: selected.provider,
        supported,
        cli_available,
        authenticated,
        remote: selected.name,
        repository: selected.github.as_ref().map(|repo| repo.slug.clone()),
        web_url: selected.web_url,
        branch: overview.branch,
        suggested_base,
        can_create: reason_code.is_none(),
        reason_code: reason_code.map(str::to_string),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitPullRequest {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    base_ref_name: String,
    created_at: String,
    updated_at: String,
}

fn pull_request_url(repo: &GitHubRepository, raw: &str, number: u64) -> Option<String> {
    let url = tauri::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https"
        || url.host_str().map(str::to_ascii_lowercase).as_deref() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let expected = format!("/{}/{}/pull/{number}", repo.owner, repo.name);
    (url.path() == expected).then(|| url.to_string())
}

fn parse_pull_requests(
    bytes: &[u8],
    repo: &GitHubRepository,
) -> Result<Vec<GitPullRequest>, String> {
    let rows: Vec<GitPullRequest> = serde_json::from_slice(bytes)
        .map_err(|_| "GitHub returned an invalid pull request response")?;
    if rows.len() > 30 {
        return Err("GitHub returned too many pull requests".into());
    }
    for row in &rows {
        if row.number == 0
            || row.title.trim().is_empty()
            || !safe_text(&row.title, 512, false)
            || !safe_text(&row.head_ref_name, 512, false)
            || !safe_text(&row.base_ref_name, 512, false)
            || !safe_text(&row.created_at, 64, false)
            || !safe_text(&row.updated_at, 64, false)
            || !["OPEN", "CLOSED", "MERGED"].contains(&row.state.as_str())
            || pull_request_url(repo, &row.url, row.number).is_none()
        {
            return Err("GitHub returned an invalid pull request response".into());
        }
    }
    Ok(rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPullRequestList {
    provider: String,
    remote: String,
    repository: String,
    branch: String,
    pull_requests: Vec<GitPullRequest>,
}

fn git_pull_requests_with(
    root: &Path,
    remote: &str,
    runner: &impl GitHubRunner,
) -> Result<GitPullRequestList, String> {
    let status = git_provider_status_with(root, Some(remote), runner)?;
    if !status.supported {
        return Err(
            "Pull request integration is currently available for GitHub remotes only".into(),
        );
    }
    if !status.cli_available {
        return Err("Install GitHub CLI to list pull requests".into());
    }
    if !status.authenticated {
        return Err("Sign in with GitHub CLI to list pull requests".into());
    }
    let overview = git_overview(root)?;
    let selected = configured_remote(root, &overview, Some(remote))?
        .and_then(|remote| remote.github.map(|repo| (remote.name, repo)))
        .ok_or("Choose a GitHub remote")?;
    let args: Vec<OsString> = vec![
        "pr".into(),
        "list".into(),
        "--repo".into(),
        selected.1.slug.clone().into(),
        "--head".into(),
        overview.branch.clone().into(),
        "--state".into(),
        "all".into(),
        "--limit".into(),
        "30".into(),
        "--json".into(),
        "number,title,url,state,isDraft,headRefName,baseRefName,createdAt,updatedAt".into(),
    ];
    let output = runner
        .run(&args, true, Duration::from_secs(30))
        .map_err(|_| "GitHub could not list pull requests")?;
    if !output.ok || output.truncated {
        return Err("GitHub could not list pull requests".into());
    }
    let pull_requests = parse_pull_requests(&output.bytes, &selected.1)?;
    Ok(GitPullRequestList {
        provider: "github".into(),
        remote: selected.0,
        repository: selected.1.slug,
        branch: overview.branch,
        pull_requests,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitPullRequestCreateRequest {
    remote: String,
    title: String,
    #[serde(default)]
    body: String,
    base: String,
    head: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    confirmed: bool,
}

struct TemporaryPullRequestBody {
    path: PathBuf,
}

impl TemporaryPullRequestBody {
    fn create(body: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            ".abdocode-pr-body-{}.md",
            uuid::Uuid::new_v4().simple()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "The pull request body could not be prepared")?;
        if file
            .write_all(body.as_bytes())
            .and_then(|_| file.sync_all())
            .is_err()
        {
            let _ = fs::remove_file(&path);
            return Err("The pull request body could not be prepared".into());
        }
        Ok(Self { path })
    }
}

impl Drop for TemporaryPullRequestBody {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPullRequestReceipt {
    created: bool,
    verified: bool,
    provider: String,
    remote: String,
    repository: String,
    number: Option<u64>,
    url: Option<String>,
    state: String,
    is_draft: bool,
    title: String,
    head_ref_name: String,
    base_ref_name: String,
    message: String,
}

fn created_pull_request_url(
    bytes: &[u8],
    repo: &GitHubRepository,
) -> (Option<u64>, Option<String>) {
    for line in String::from_utf8_lossy(bytes).lines().rev() {
        let raw = line.trim();
        let Some(number) = raw.rsplit('/').next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        if let Some(url) = pull_request_url(repo, raw, number) {
            return (Some(number), Some(url));
        }
    }
    (None, None)
}

fn create_pull_request_with(
    root: &Path,
    request: GitPullRequestCreateRequest,
    runner: &impl GitHubRunner,
) -> Result<GitPullRequestReceipt, String> {
    if !request.confirmed {
        return Err("Review and confirm the pull request before creating it".into());
    }
    let title = request.title.trim();
    let base = request.base.trim();
    let head = request.head.trim();
    let remote = request.remote.trim();
    if title.is_empty() || !safe_text(title, 256, false) {
        return Err("Enter a one-line pull request title up to 256 characters".into());
    }
    if request.body.len() > 64 * 1024 || !safe_text(&request.body, 64 * 1024, true) {
        return Err("Pull request body must be valid text up to 64 KiB".into());
    }
    for branch in [base, head] {
        if branch.is_empty()
            || !safe_text(branch, 240, false)
            || !git(root, &["check-ref-format", "--branch", branch])?.ok
        {
            return Err("Choose valid base and head branches".into());
        }
    }
    if base == head {
        return Err("Choose different base and head branches".into());
    }
    let status = git_provider_status_with(root, Some(remote), runner)?;
    if status.branch != head {
        return Err("The head branch changed. Review the pull request again".into());
    }
    if !status.can_create {
        return Err(match status.reason_code.as_deref() {
            Some("unsupportedProvider") => {
                "Pull request creation is currently available for GitHub remotes only"
            }
            Some("cliUnavailable") => "Install GitHub CLI before creating a pull request",
            Some("authenticationRequired") => {
                "Sign in with GitHub CLI before creating a pull request"
            }
            Some("branchRequired") => "Switch to a local branch before creating a pull request",
            _ => "Push the current branch and refresh Git status before creating a pull request",
        }
        .into());
    }
    let overview = git_overview(root)?;
    let selected = configured_remote(root, &overview, Some(remote))?
        .and_then(|remote| remote.github.map(|repo| (remote.name, repo)))
        .ok_or("Choose a GitHub remote")?;
    let body = TemporaryPullRequestBody::create(&request.body)?;
    let mut args: Vec<OsString> = vec![
        "pr".into(),
        "create".into(),
        "--repo".into(),
        selected.1.slug.clone().into(),
        "--title".into(),
        title.into(),
        "--body-file".into(),
        body.path.as_os_str().to_os_string(),
        "--base".into(),
        base.into(),
        "--head".into(),
        head.into(),
    ];
    if request.draft {
        args.push("--draft".into());
    }
    let output = runner
        .run(&args, true, Duration::from_secs(90))
        .map_err(|_| "GitHub could not create the pull request")?;
    if !output.ok || output.truncated {
        return Err("GitHub did not create the pull request. Review authentication, branch, and repository access".into());
    }
    let (number, url) = created_pull_request_url(&output.bytes, &selected.1);
    let verified = number.is_some() && url.is_some();
    Ok(GitPullRequestReceipt {
        created: true,
        verified,
        provider: "github".into(),
        remote: selected.0,
        repository: selected.1.slug,
        number,
        url,
        state: "OPEN".into(),
        is_draft: request.draft,
        title: title.into(),
        head_ref_name: head.into(),
        base_ref_name: base.into(),
        message: if verified {
            "GitHub created the pull request and returned its receipt".into()
        } else {
            "GitHub accepted the create request, but its receipt could not be verified. Refresh pull requests before retrying".into()
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeCreated {
    path: String,
    branch: String,
}

fn create_worktree(
    root: &Path,
    destination: &Path,
    branch: &str,
) -> Result<WorktreeCreated, String> {
    ensure_repository_root(root)?;
    let branch = branch.trim();
    if branch.is_empty()
        || !safe_text(branch, 240, false)
        || !git(root, &["check-ref-format", "--branch", branch])?.ok
    {
        return Err("Enter a valid new branch name".into());
    }
    let reference = format!("refs/heads/{branch}");
    if git(root, &["show-ref", "--verify", "--quiet", &reference])?.ok {
        return Err("This branch already exists".into());
    }
    let meta = fs::symlink_metadata(destination)
        .map_err(|_| "Choose an existing empty destination folder")?;
    if !meta.is_dir()
        || is_reparse(&meta)
        || fs::read_dir(destination)
            .map_err(|_| "The destination folder is unavailable")?
            .next()
            .is_some()
    {
        return Err("Choose an empty destination folder that is not a link".into());
    }
    let selected_destination = destination.to_path_buf();
    let destination =
        fs::canonicalize(destination).map_err(|_| "The destination folder is unavailable")?;
    if destination == root || destination.starts_with(root) || root.starts_with(&destination) {
        return Err("Choose a separate destination outside the repository".into());
    }
    // Git requires the worktree destination not to exist. The native picker can
    // only return an existing folder, so remove the already verified empty
    // directory and restore it if Git fails.
    fs::remove_dir(&destination).map_err(|_| "The empty destination could not be prepared")?;
    let args = vec![
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.into(),
        git_path(&selected_destination),
    ];
    if let Err(error) = git_write_command(root, &args, Duration::from_secs(60)) {
        let _ = fs::create_dir_all(&destination);
        return Err(error);
    }
    Ok(WorktreeCreated {
        path: git_path(&selected_destination),
        branch: branch.into(),
    })
}

pub(crate) fn create_picked_worktree(
    app: &tauri::AppHandle,
    root: &str,
    destination: &Path,
    branch: &str,
) -> Result<WorktreeCreated, String> {
    let root = allowed_root(root, &load(&store_path(app)?)?)?;
    let result = create_worktree(&root, destination, branch)?;
    register_picked(Path::new(&result.path))?;
    Ok(result)
}

#[tauri::command(async)]
pub(crate) fn workspace_git_overview(
    app: tauri::AppHandle,
    root: String,
) -> Result<GitOverview, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    git_overview(&root)
}

#[tauri::command(async)]
pub(crate) fn workspace_git_action(
    app: tauri::AppHandle,
    root: String,
    request: GitActionRequest,
) -> Result<GitActionResult, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    git_action(&root, request)
}

#[tauri::command(async)]
pub(crate) fn workspace_git_provider_status(
    app: tauri::AppHandle,
    root: String,
    remote: Option<String>,
) -> Result<GitProviderStatus, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    git_provider_status_with(&root, remote.as_deref(), &SystemGitHubRunner)
}

#[tauri::command(async)]
pub(crate) fn workspace_git_pull_requests(
    app: tauri::AppHandle,
    root: String,
    remote: String,
) -> Result<GitPullRequestList, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    git_pull_requests_with(&root, &remote, &SystemGitHubRunner)
}

#[tauri::command(async)]
pub(crate) fn workspace_git_create_pull_request(
    app: tauri::AppHandle,
    root: String,
    request: GitPullRequestCreateRequest,
) -> Result<GitPullRequestReceipt, String> {
    let root = allowed_root(&root, &load(&store_path(&app)?)?)?;
    create_pull_request_with(&root, request, &SystemGitHubRunner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn temporary() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "abdocode-workspace-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&p).unwrap();
        fs::canonicalize(p).unwrap()
    }

    #[derive(Clone, Debug)]
    struct GitHubCall {
        args: Vec<String>,
        capture_stdout: bool,
        body_path: Option<PathBuf>,
        body: Option<String>,
    }

    struct MockGitHubRunner {
        outputs: Mutex<VecDeque<Result<GitHubOutput, GitHubRunError>>>,
        calls: Mutex<Vec<GitHubCall>>,
    }

    impl MockGitHubRunner {
        fn new(outputs: Vec<Result<GitHubOutput, GitHubRunError>>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into()),
                calls: Mutex::new(vec![]),
            }
        }
        fn calls(&self) -> Vec<GitHubCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GitHubRunner for MockGitHubRunner {
        fn run(
            &self,
            args: &[OsString],
            capture_stdout: bool,
            _timeout: Duration,
        ) -> Result<GitHubOutput, GitHubRunError> {
            let args: Vec<String> = args
                .iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect();
            let body_path = args
                .iter()
                .position(|value| value == "--body-file")
                .and_then(|index| args.get(index + 1))
                .map(PathBuf::from);
            let body = body_path
                .as_ref()
                .and_then(|path| fs::read_to_string(path).ok());
            self.calls.lock().unwrap().push(GitHubCall {
                args,
                capture_stdout,
                body_path,
                body,
            });
            self.outputs
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected GitHub command")
        }
    }

    fn github_output(ok: bool, text: &str) -> Result<GitHubOutput, GitHubRunError> {
        Ok(GitHubOutput {
            ok,
            bytes: text.as_bytes().to_vec(),
            truncated: false,
        })
    }

    fn github_repository_fixture() -> PathBuf {
        let root = temporary();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.name", "AbdoCode Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("hello.txt"), "hello\n").unwrap();
        run(&["add", "--", "hello.txt"]);
        run(&["commit", "--quiet", "-m", "Initial"]);
        run(&[
            "remote",
            "add",
            "origin",
            "git@github.com:example/project.git",
        ]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);
        run(&["switch", "--quiet", "-c", "feature/native-pr"]);
        run(&[
            "update-ref",
            "refs/remotes/origin/feature/native-pr",
            "HEAD",
        ]);
        run(&["config", "branch.feature/native-pr.remote", "origin"]);
        run(&[
            "config",
            "branch.feature/native-pr.merge",
            "refs/heads/feature/native-pr",
        ]);
        root
    }
    #[test]
    fn viewer_reads_real_text_and_rejects_traversal_secrets_and_binary() {
        let root = temporary();
        fs::write(root.join("hello.txt"), "hello عربي").unwrap();
        fs::write(root.join(".env"), "PRIVATE=do-not-read").unwrap();
        fs::write(
            root.join("application_default_credentials.json"),
            "PRIVATE=do-not-read",
        )
        .unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        assert_eq!(read_text(&root, "hello.txt").unwrap().text, "hello عربي");
        for p in [
            "../hello.txt",
            "C:/Windows/test",
            ".env",
            "application_default_credentials.json",
            "binary",
        ] {
            assert!(read_text(&root, p).is_err(), "{p}");
        }
        let listing = tree(&root, "").unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(!listing.entries.iter().any(|e| e.name == ".env"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn editor_writes_atomically_and_rejects_stale_or_private_targets() {
        let root = temporary();
        fs::write(root.join("hello.txt"), "first").unwrap();
        let saved = write_text(&root, "hello.txt", "second عربي", Some("first")).unwrap();
        assert_eq!(saved.text, "second عربي");
        assert_eq!(
            fs::read_to_string(root.join("hello.txt")).unwrap(),
            "second عربي"
        );
        assert!(write_text(&root, "hello.txt", "third", Some("first"))
            .unwrap_err()
            .contains("changed on disk"));
        let created = write_text(&root, "new.txt", "new", None).unwrap();
        assert_eq!(created.text, "new");
        assert!(write_text(&root, ".env", "SECRET=1", None).is_err());
        assert!(root.read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".abdocode-write-")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metadata_cannot_invent_approvals_or_credentials_or_unknown_projects() {
        assert!(validate(&WorkspaceStore::default()).is_ok());
        assert!(
            serde_json::from_str::<WorkspaceStore>(r#"{"version":1,"grants":["all"]}"#).is_err()
        );
        assert!(
            serde_json::from_str::<WorkspaceStore>(r#"{"version":1,"credentials":"secret"}"#)
                .is_err()
        );
        let mut s = WorkspaceStore::default();
        s.sessions.push(Session {
            id: "s-1".into(),
            project_id: Some("absent".into()),
            ..Default::default()
        });
        assert!(validate(&s).is_err());
    }
    #[test]
    fn fresh_sidebar_uses_reference_width_and_saved_width_is_preserved() {
        assert_eq!(WorkspaceStore::default().preferences.sidebar_width, 356);
        let saved: WorkspaceStore = serde_json::from_str(
            r#"{"version":1,"preferences":{"sidebarWidth":280,"sidebarSide":"right"}}"#,
        )
        .unwrap();
        assert_eq!(saved.preferences.sidebar_width, 280);
        assert_eq!(saved.preferences.sidebar_side, "right");
        assert_eq!(saved.preferences.interface_font, "system");
        assert_eq!(saved.preferences.code_font, "Consolas");
        assert_eq!(saved.preferences.ui_density, "comfortable");
        assert_eq!(saved.preferences.accent_color, "gold");
        assert_eq!(saved.preferences.code_theme_light, "abdo-light");
        assert_eq!(saved.preferences.code_theme_dark, "abdo-dark");
        assert!(saved.preferences.classify_session_states);
        assert!(saved.preferences.open_links_in_builtin);
    }
    #[test]
    fn workspace_preferences_reject_invalid_domains_and_visual_values() {
        let mut store = WorkspaceStore::default();
        store.preferences.blocked_sites = vec!["example.com".into()];
        assert!(validate(&store).is_ok());
        store.preferences.blocked_sites = vec!["https://example.com/path".into()];
        assert!(validate(&store).is_err());
        store.preferences.blocked_sites.clear();
        store.preferences.transcript_size = "gigantic".into();
        assert!(validate(&store).is_err());
    }
    #[test]
    fn unselected_roots_are_denied_and_native_selection_admits_them() {
        let root = temporary();
        let store = WorkspaceStore::default();
        let p = root.to_string_lossy();
        assert!(allowed_root(&p, &store).is_err());
        register_picked(&root).unwrap();
        assert_eq!(allowed_root(&p, &store).unwrap(), root);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn trusted_engine_project_frame_registers_native_access_without_a_picker() {
        let root = temporary();
        let store = WorkspaceStore::default();
        let path = root.to_string_lossy();
        for frame in [serde_json::json!({"kind":"tool-result","trusted":true,"path":path}), serde_json::json!({"kind":"project","trusted":false,"path":path})] {
            register_engine_project(&frame.to_string()).unwrap();
            assert!(allowed_root(&path, &store).is_err());
        }
        register_engine_project(&serde_json::json!({"kind":"project","trusted":true,"created":true,"path":path}).to_string()).unwrap();
        assert_eq!(allowed_root(&path, &store).unwrap(), root);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn new_repository_changes_list_files_without_generated_dependency_trees() {
        let root = temporary();
        assert!(git(&root, &["init", "--quiet"]).unwrap().ok);
        for path in ["app/page.tsx", "node_modules/pkg/index.js", ".next/server.js"] {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path), "content").unwrap();
        }
        let result = git_diff(&root, None, false).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "app/page.tsx");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn file_replacement_preserves_valid_metadata() {
        let root = temporary();
        let target = root.join("workspace.json");
        let stage = root.join("new.tmp");
        fs::write(&target, b"old").unwrap();
        fs::write(&stage, b"new").unwrap();
        replace_file(&stage, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!stage.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_git_diff_never_runs_external_diff_and_excludes_private_files() {
        let root = temporary();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.name", "Workspace Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("hello.txt"), "before\n").unwrap();
        fs::write(root.join(".env"), "old-key\n").unwrap();
        run(&["add", "hello.txt", ".env"]);
        run(&["commit", "--quiet", "-m", "initial"]);
        run(&[
            "config",
            "diff.external",
            "nonexistent-abdocode-test-command",
        ]);
        run(&[
            "config",
            "filter.hostile.clean",
            "nonexistent-abdocode-test-filter",
        ]);
        run(&[
            "config",
            "filter.hostile.process",
            "nonexistent-abdocode-test-process",
        ]);
        run(&["config", "filter.hostile.required", "true"]);
        fs::write(root.join(".gitattributes"), "hello.txt filter=hostile\n").unwrap();
        fs::write(root.join("hello.txt"), "after\n").unwrap();
        fs::write(root.join(".env"), "private-new-key\n").unwrap();
        let result = git_diff(&root, None, false).unwrap();
        assert!(result.is_repository);
        assert_eq!(result.files.len(), 2);
        assert!(result.diff.contains("+after"));
        assert!(!result.diff.contains("private-new-key"));
        assert!(git_diff(&root, Some(".env"), false).is_err());
        run(&[
            "-c",
            "filter.hostile.clean=",
            "-c",
            "filter.hostile.process=",
            "-c",
            "filter.hostile.required=false",
            "add",
            "hello.txt",
        ]);
        assert!(git_diff(&root, Some("hello.txt"), true)
            .unwrap()
            .diff
            .contains("+after"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn git_overview_reads_real_history_tracking_and_sanitized_remotes_without_mutation() {
        let root = temporary();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.name", "Workspace Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("hello file.txt"), "first\n").unwrap();
        run(&["add", "--", "hello file.txt"]);
        run(&["commit", "--quiet", "-m", "First local commit"]);
        run(&["remote", "add", "origin", "https://test-user:private-secret@github.com/example/project.git?token=private-query#private-fragment"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["config", "branch.main.remote", "origin"]);
        run(&["config", "branch.main.merge", "refs/heads/main"]);
        run(&["branch", "feature/local"]);
        fs::write(root.join("hello file.txt"), "second\n").unwrap();
        run(&["add", "--", "hello file.txt"]);
        run(&["commit", "--quiet", "-m", "Second local commit"]);
        run(&[
            "config",
            "core.fsmonitor",
            "nonexistent-abdocode-overview-monitor",
        ]);
        run(&[
            "config",
            "diff.external",
            "nonexistent-abdocode-overview-diff",
        ]);
        run(&[
            "config",
            "filter.hostile.clean",
            "nonexistent-abdocode-overview-filter",
        ]);
        run(&["config", "filter.hostile.required", "true"]);
        fs::write(root.join(".gitattributes"), "*.txt filter=hostile\n").unwrap();
        fs::write(root.join("hello file.txt"), "third\n").unwrap();
        fs::write(root.join(".env"), "private-file-content").unwrap();
        let before_index = fs::read(root.join(".git/index")).unwrap();
        let before_ref = fs::read(root.join(".git/refs/heads/main")).unwrap();
        let overview = git_overview(&root).unwrap();
        assert!(overview.is_repository);
        assert_eq!(overview.branch, "main");
        assert!(!overview.detached);
        assert_eq!(overview.upstream.as_deref(), Some("origin/main"));
        assert_eq!(overview.ahead, Some(1));
        assert_eq!(overview.behind, Some(0));
        assert_eq!(overview.commits.len(), 2);
        assert_eq!(overview.commits[0].subject, "Second local commit");
        assert_eq!(
            overview.head.as_deref(),
            Some(overview.commits[0].id.as_str())
        );
        assert!(overview
            .branches
            .iter()
            .any(|b| b.name == "main" && b.current));
        assert!(overview
            .branches
            .iter()
            .any(|b| b.name == "feature/local" && !b.current));
        assert!(overview.files.iter().any(|f| f.path == "hello file.txt"));
        assert!(!overview.files.iter().any(|f| f.path == ".env"));
        assert_eq!(
            overview.remotes[0].web_url.as_deref(),
            Some("https://github.com/example/project")
        );
        assert_eq!(
            overview.remotes[0].compare_url.as_deref(),
            Some("https://github.com/example/project/compare/main")
        );
        let serialized = serde_json::to_string(&overview).unwrap();
        for private in [
            "private-secret",
            "private-query",
            "private-fragment",
            "private-file-content",
            "test-user",
        ] {
            assert!(!serialized.contains(private));
        }
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), before_index);
        assert_eq!(
            fs::read(root.join(".git/refs/heads/main")).unwrap(),
            before_ref
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_actions_stage_commit_and_switch_only_inside_the_selected_root() {
        let root = temporary();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.name", "AbdoCode Test"]);
        run(&["config", "user.email", "abdocode@example.invalid"]);
        fs::write(root.join("hello.txt"), "hello").unwrap();
        git_action(
            &root,
            GitActionRequest {
                action: "stage".into(),
                path: Some("hello.txt".into()),
                message: None,
                branch: None,
                remote: None,
            },
        )
        .unwrap();
        let committed = git_action(
            &root,
            GitActionRequest {
                action: "commit".into(),
                path: None,
                message: Some("initial commit".into()),
                branch: None,
                remote: None,
            },
        )
        .unwrap();
        assert!(committed.overview.head.is_some());
        let branched = git_action(
            &root,
            GitActionRequest {
                action: "createBranch".into(),
                path: None,
                message: None,
                branch: Some("feature/editor".into()),
                remote: None,
            },
        )
        .unwrap();
        assert_eq!(branched.overview.branch, "feature/editor");
        assert!(git_action(
            &root,
            GitActionRequest {
                action: "stage".into(),
                path: Some("../outside".into()),
                message: None,
                branch: None,
                remote: None,
            },
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_local_push_and_fast_forward_pull_preserve_unrelated_worktree_changes() {
        let remote = temporary();
        let primary = temporary();
        let peer = temporary();
        let run = |root: &Path, args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(
            &remote,
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        );
        run(&primary, &["init", "--quiet", "--initial-branch=main"]);
        run(&primary, &["config", "user.name", "AbdoCode Test"]);
        run(&primary, &["config", "user.email", "test@example.invalid"]);
        fs::write(primary.join("shared.txt"), "base\n").unwrap();
        fs::write(primary.join("local.txt"), "base\n").unwrap();
        run(&primary, &["add", "--", "shared.txt", "local.txt"]);
        run(&primary, &["commit", "--quiet", "-m", "Initial"]);
        run(&primary, &["remote", "add", "origin", &git_path(&remote)]);
        let pushed = git_action(
            &primary,
            GitActionRequest {
                action: "push".into(),
                path: None,
                message: None,
                branch: None,
                remote: Some("origin".into()),
            },
        )
        .unwrap();
        assert_eq!(pushed.overview.upstream.as_deref(), Some("origin/main"));

        let clone = Command::new("git")
            .args(["clone", "--quiet"])
            .arg(git_path(&remote))
            .arg(git_path(&peer))
            .output()
            .unwrap();
        assert!(
            clone.status.success(),
            "{}",
            String::from_utf8_lossy(&clone.stderr)
        );
        run(&peer, &["config", "user.name", "Peer Test"]);
        run(&peer, &["config", "user.email", "peer@example.invalid"]);
        fs::write(peer.join("shared.txt"), "from peer\n").unwrap();
        run(&peer, &["add", "--", "shared.txt"]);
        run(&peer, &["commit", "--quiet", "-m", "Peer update"]);
        run(&peer, &["push", "--quiet", "origin", "main"]);

        fs::write(primary.join("local.txt"), "local edit\n").unwrap();
        fs::write(primary.join("untracked.txt"), "keep me\n").unwrap();
        let pulled = git_action(
            &primary,
            GitActionRequest {
                action: "pull".into(),
                path: None,
                message: None,
                branch: None,
                remote: None,
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(primary.join("shared.txt")).unwrap(),
            "from peer\n"
        );
        assert_eq!(
            fs::read_to_string(primary.join("local.txt")).unwrap(),
            "local edit\n"
        );
        assert_eq!(
            fs::read_to_string(primary.join("untracked.txt")).unwrap(),
            "keep me\n"
        );
        assert!(pulled
            .overview
            .files
            .iter()
            .any(|file| file.path == "local.txt"));
        assert!(pulled
            .overview
            .files
            .iter()
            .any(|file| file.path == "untracked.txt"));
        assert_eq!(pulled.overview.ahead, Some(0));
        assert_eq!(pulled.overview.behind, Some(0));
        fs::remove_dir_all(primary).unwrap();
        fs::remove_dir_all(peer).unwrap();
        fs::remove_dir_all(remote).unwrap();
    }

    #[test]
    fn github_pull_request_list_is_structured_and_rejects_foreign_receipts() {
        let root = github_repository_fixture();
        let valid = r#"[{"number":7,"title":"Native shell","url":"https://github.com/example/project/pull/7","state":"OPEN","isDraft":true,"headRefName":"feature/native-pr","baseRefName":"main","createdAt":"2026-09-05T00:00:00Z","updatedAt":"2026-09-05T00:01:00Z"}]"#;
        let runner =
            MockGitHubRunner::new(vec![github_output(true, ""), github_output(true, valid)]);
        let listed = git_pull_requests_with(&root, "origin", &runner).unwrap();
        assert_eq!(listed.repository, "example/project");
        assert_eq!(listed.branch, "feature/native-pr");
        assert_eq!(listed.pull_requests.len(), 1);
        assert_eq!(listed.pull_requests[0].number, 7);
        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        assert!(!calls[0].capture_stdout);
        assert_eq!(
            calls[0].args,
            ["auth", "status", "--active", "--hostname", "github.com"]
        );
        assert!(calls[1].capture_stdout);
        assert!(calls[1]
            .args
            .windows(2)
            .any(|pair| pair == ["--repo", "example/project"]));
        assert!(calls[1]
            .args
            .windows(2)
            .any(|pair| pair == ["--head", "feature/native-pr"]));

        let foreign = valid.replace(
            "https://github.com/example/project/pull/7",
            "https://github.com/other/project/pull/7",
        );
        let runner =
            MockGitHubRunner::new(vec![github_output(true, ""), github_output(true, &foreign)]);
        assert!(git_pull_requests_with(&root, "origin", &runner)
            .unwrap_err()
            .contains("invalid pull request response"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn github_create_uses_confirmed_fields_private_body_file_and_actual_receipt() {
        let root = github_repository_fixture();
        let runner = MockGitHubRunner::new(vec![
            github_output(true, "ignored account output"),
            github_output(true, "https://github.com/example/project/pull/19\n"),
        ]);
        let receipt = create_pull_request_with(
            &root,
            GitPullRequestCreateRequest {
                remote: "origin".into(),
                title: "Native Git integration".into(),
                body: "## Summary\n\nActual body from the review form.\n".into(),
                base: "main".into(),
                head: "feature/native-pr".into(),
                draft: true,
                confirmed: true,
            },
            &runner,
        )
        .unwrap();
        assert!(receipt.created);
        assert!(receipt.verified);
        assert_eq!(receipt.number, Some(19));
        assert_eq!(
            receipt.url.as_deref(),
            Some("https://github.com/example/project/pull/19")
        );
        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        let create = &calls[1];
        assert_eq!(
            create.body.as_deref(),
            Some("## Summary\n\nActual body from the review form.\n")
        );
        assert!(create
            .args
            .windows(2)
            .any(|pair| pair == ["--title", "Native Git integration"]));
        assert!(create
            .args
            .windows(2)
            .any(|pair| pair == ["--base", "main"]));
        assert!(create
            .args
            .windows(2)
            .any(|pair| pair == ["--head", "feature/native-pr"]));
        assert!(create.args.iter().any(|value| value == "--draft"));
        assert!(create.body_path.as_ref().is_some_and(|path| !path.exists()));

        let unconfirmed = MockGitHubRunner::new(vec![]);
        assert!(create_pull_request_with(
            &root,
            GitPullRequestCreateRequest {
                remote: "origin".into(),
                title: "No confirmation".into(),
                body: String::new(),
                base: "main".into(),
                head: "feature/native-pr".into(),
                draft: false,
                confirmed: false,
            },
            &unconfirmed,
        )
        .is_err());
        assert!(unconfirmed.calls().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn comparison_links_and_failed_github_output_are_never_reported_as_pull_requests() {
        let root = github_repository_fixture();
        let runner = MockGitHubRunner::new(vec![
            github_output(true, "account output is discarded"),
            github_output(
                true,
                "https://github.com/example/project/compare/feature%2Fnative-pr",
            ),
        ]);
        let receipt = create_pull_request_with(
            &root,
            GitPullRequestCreateRequest {
                remote: "origin".into(),
                title: "Comparison is not a receipt".into(),
                body: String::new(),
                base: "main".into(),
                head: "feature/native-pr".into(),
                draft: false,
                confirmed: true,
            },
            &runner,
        )
        .unwrap();
        assert!(receipt.created);
        assert!(!receipt.verified);
        assert!(receipt.url.is_none());
        assert!(receipt.number.is_none());

        let runner = MockGitHubRunner::new(vec![
            github_output(true, "account output is discarded"),
            github_output(false, "token=must-never-be-returned"),
        ]);
        let error = create_pull_request_with(
            &root,
            GitPullRequestCreateRequest {
                remote: "origin".into(),
                title: "Expected failure".into(),
                body: "Body removed after failure".into(),
                base: "main".into(),
                head: "feature/native-pr".into(),
                draft: false,
                confirmed: true,
            },
            &runner,
        )
        .unwrap_err();
        assert!(!error.contains("token"));
        assert!(runner.calls()[1]
            .body_path
            .as_ref()
            .is_some_and(|path| !path.exists()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_creation_requires_an_empty_separate_folder_and_new_branch() {
        let root = temporary();
        let destination = temporary();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&[
            "-c",
            "user.name=AbdoCode Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial",
        ]);
        let created = create_worktree(&root, &destination, "feature/isolated").unwrap();
        assert_eq!(created.branch, "feature/isolated");
        assert!(destination.join(".git").is_file());
        let overview = git_overview(&root).unwrap();
        assert!(overview
            .worktrees
            .iter()
            .any(|item| item.branch.as_deref() == Some("feature/isolated") && !item.current));
        assert!(create_worktree(&root, &destination, "feature/another").is_err());
        run(&[
            "worktree",
            "remove",
            "--force",
            destination.to_str().unwrap(),
        ]);
        fs::remove_dir_all(root).unwrap();
        if destination.exists() {
            fs::remove_dir_all(destination).unwrap();
        }
    }
    #[test]
    fn git_overview_distinguishes_non_repository_unborn_and_detached_head() {
        let root = temporary();
        assert!(!git_overview(&root).unwrap().is_repository);
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        let unborn = git_overview(&root).unwrap();
        assert!(unborn.is_repository);
        assert_eq!(unborn.branch, "main");
        assert!(unborn.head.is_none());
        assert!(unborn.commits.is_empty());
        assert!(unborn.ahead.is_none());
        assert!(!unborn.detached);
        run(&[
            "-c",
            "user.name=Workspace Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial",
        ]);
        run(&["checkout", "--detach", "--quiet", "HEAD"]);
        let detached = git_overview(&root).unwrap();
        assert!(detached.detached);
        assert_eq!(detached.branch, "HEAD");
        assert_eq!(detached.commits.len(), 1);
        assert!(detached.upstream.is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn remote_links_are_known_host_web_links_and_never_raw_transport_urls() {
        let (web, compare) =
            git_remote_links("git@github.com:example/project.git", "feature/my-work");
        assert_eq!(web.as_deref(), Some("https://github.com/example/project"));
        assert_eq!(
            compare.as_deref(),
            Some("https://github.com/example/project/compare/feature%2Fmy-work")
        );
        assert_eq!(
            git_remote_links("https://gitlab.com/group/subgroup/project.git", "main")
                .0
                .as_deref(),
            Some("https://gitlab.com/group/subgroup/project")
        );
        for remote in [
            "file:///private/repo",
            "ext::do-not-run",
            "ssh://host.invalid/repo",
            "https://github.com:8443/example/repo",
            "https://github.com/example/repo/secret",
            "https://github.com/example/%2Frepo",
        ] {
            assert_eq!(git_remote_links(remote, "main"), (None, None), "{remote}");
        }
    }
    #[test]
    fn linked_paths_do_not_escape_project() {
        let root = temporary();
        let outside = temporary();
        fs::write(outside.join("outside.txt"), "outside").unwrap();
        #[cfg(windows)]
        {
            // A junction exercises the Windows reparse-point rule without
            // requiring symlink privilege. The target is a test-owned folder.
            let result = Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(root.join("linked"))
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success(), "Junction fixture creation failed");
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(read_text(&root, "linked/outside.txt").is_err());
        assert!(tree(&root, "linked").is_err());
        #[cfg(windows)]
        fs::remove_dir(root.join("linked")).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(root.join("linked")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}

/// Reuses the bounded GitHub transport. The endpoint is derived from a validated pinned raw URL.
pub(crate) fn github_package_download(url: &str, sha256: &str) -> Result<Vec<u8>, String> {
    crate::extension_download::validate_url(url, sha256)?;
    let parts: Vec<_> = url.strip_prefix("https://raw.githubusercontent.com/").ok_or("Invalid package host")?.split('/').collect();
    let endpoint = format!("repos/{}/{}/contents/{}?ref={}", parts[0],parts[1],parts[3..].join("/"),parts[2]);
    let args: Vec<OsString> = ["api","--hostname","github.com","--method","GET",&endpoint,"--header","Accept: application/vnd.github.raw+json"].iter().map(OsString::from).collect();
    let output = SystemGitHubRunner.run(&args,true,Duration::from_secs(30))
        .map_err(|_| "GitHub CLI is unavailable or timed out. Sign in with gh auth login, then retry.".to_string())?;
    if !output.ok || output.truncated { return Err("GitHub denied access or the package exceeds the download limit. Check your GitHub sign-in and repository access.".into()); }
    Ok(output.bytes)
}
