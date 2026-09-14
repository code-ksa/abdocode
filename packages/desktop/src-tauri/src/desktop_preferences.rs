//! Native desktop lifecycle preferences. These settings are deliberately kept
//! separate from model/provider settings because they change this process and,
//! for startup, the current Windows user's profile.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const MAX_PREFERENCES_BYTES: usize = 16 * 1024;
pub(crate) const TRAY_ID: &str = "abdocode-lifecycle-tray";
pub(crate) const TRAY_OPEN_ID: &str = "abdocode-lifecycle-open";
pub(crate) const TRAY_QUIT_ID: &str = "abdocode-lifecycle-quit";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuickEntryPreference {
    pub(crate) enabled: bool,
    pub(crate) shortcut: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopPreferences {
    pub(crate) version: u8,
    pub(crate) run_on_startup: bool,
    pub(crate) system_tray: bool,
    pub(crate) keep_computer_awake: bool,
    pub(crate) quick_entry: QuickEntryPreference,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            version: 1,
            run_on_startup: false,
            system_tray: false,
            keep_computer_awake: false,
            quick_entry: QuickEntryPreference {
                enabled: false,
                shortcut: "Ctrl+Alt+Space".into(),
            },
        }
    }
}

impl DesktopPreferences {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported desktop preferences version.".into());
        }
        let shortcut = self.quick_entry.shortcut.trim();
        if shortcut.is_empty() || shortcut.len() > 80 || shortcut.chars().any(char::is_control) {
            return Err("Quick Entry shortcut is invalid.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopAppliedState {
    pub(crate) run_on_startup: Option<bool>,
    pub(crate) system_tray: Option<bool>,
    pub(crate) keep_computer_awake: Option<bool>,
    pub(crate) quick_entry: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopCapabilities {
    pub(crate) run_on_startup: bool,
    pub(crate) system_tray: bool,
    pub(crate) keep_computer_awake: bool,
    pub(crate) quick_entry_shortcut: bool,
}

impl Default for DesktopCapabilities {
    fn default() -> Self {
        Self {
            run_on_startup: cfg!(windows) && !super::profile::is_explicit(),
            system_tray: true,
            keep_computer_awake: cfg!(windows),
            quick_entry_shortcut: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPreferenceError {
    pub(crate) field: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

impl DesktopPreferenceError {
    fn apply(field: &str, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            code: "applyFailed".into(),
            message: message.into(),
        }
    }

    fn mismatch(field: &str) -> Self {
        Self {
            field: field.into(),
            code: "notApplied".into(),
            message: "The operating system did not retain the requested state.".into(),
        }
    }

    fn stored(message: impl Into<String>) -> Self {
        Self {
            field: "desktopPreferences".into(),
            code: "invalidStoredPreferences".into(),
            message: message.into(),
        }
    }

    fn persist(message: impl Into<String>) -> Self {
        Self {
            field: "desktopPreferences".into(),
            code: "persistFailed".into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPreferencesStatus {
    pub(crate) preferences: DesktopPreferences,
    pub(crate) applied: DesktopAppliedState,
    pub(crate) capabilities: DesktopCapabilities,
    pub(crate) errors: Vec<DesktopPreferenceError>,
}

fn push_unique_error(errors: &mut Vec<DesktopPreferenceError>, error: DesktopPreferenceError) {
    if !errors
        .iter()
        .any(|item| item.field == error.field && item.code == error.code)
    {
        errors.push(error);
    }
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    super::profile::directory(app)
        .map(|dir| dir.join("desktop-preferences-v1.json"))
        .map_err(|error| error.to_string())
}

fn load(path: &Path) -> Result<DesktopPreferences, String> {
    if !path.exists() {
        return Ok(DesktopPreferences::default());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not inspect desktop preferences: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_PREFERENCES_BYTES as u64 {
        return Err("Desktop preferences file size is invalid.".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read desktop preferences: {error}"))?;
    let preferences: DesktopPreferences = serde_json::from_slice(&bytes)
        .map_err(|_| "Desktop preferences file is invalid.".to_string())?;
    preferences.validate()?;
    Ok(preferences)
}

/// A damaged owner settings file must remain visible and repairable from the
/// settings screen. Returning the disabled defaults here does not overwrite
/// the damaged file; a subsequent successful `set` performs that repair.
fn load_repairable(path: &Path) -> (DesktopPreferences, Vec<DesktopPreferenceError>) {
    match load(path) {
        Ok(preferences) => (preferences, Vec::new()),
        Err(error) => (
            DesktopPreferences::default(),
            vec![DesktopPreferenceError::stored(error)],
        ),
    }
}

fn normalize_for_capabilities(
    preferences: DesktopPreferences,
) -> (DesktopPreferences, Vec<DesktopPreferenceError>, bool) {
    (preferences, Vec::new(), false)
}

fn save(path: &Path, preferences: &DesktopPreferences) -> Result<(), String> {
    preferences.validate()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop preferences path has no parent.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the desktop preferences folder: {error}"))?;
    let bytes = serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_PREFERENCES_BYTES {
        return Err("Desktop preferences are too large.".into());
    }
    let staged = parent.join(format!(
        "desktop-preferences-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)
            .map_err(|error| format!("Could not stage desktop preferences: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not persist desktop preferences: {error}"))?;
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|error| format!("Could not replace desktop preferences: {error}"))?;
        }
        std::fs::rename(&staged, path)
            .map_err(|error| format!("Could not install desktop preferences: {error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StartupSpec {
    value_name: String,
    command: String,
}

fn startup_spec(identifier: &str, executable: &Path) -> Result<StartupSpec, String> {
    if identifier.is_empty()
        || identifier.len() > 180
        || identifier.chars().any(char::is_control)
        || !executable.is_absolute()
    {
        return Err("Application startup identity is invalid.".into());
    }
    let executable = executable.to_string_lossy();
    if executable.contains('"') || executable.is_empty() {
        return Err("Application executable path is invalid.".into());
    }
    Ok(StartupSpec {
        // Preview builds use io.abdocode.desktop.preview, so their Run value
        // cannot overwrite the canonical app's value.
        value_name: identifier.into(),
        command: format!("\"{executable}\""),
    })
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
fn startup_read(spec: &StartupSpec) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let name = wide(&spec.value_name);
    let mut byte_len = 0_u32;
    let first = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if first == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if first != ERROR_SUCCESS || byte_len < 2 || byte_len as usize > 32 * 1024 {
        return Err(format!(
            "Could not read the current-user startup entry (Windows error {first})."
        ));
    }
    let mut value = vec![0_u16; (byte_len as usize + 1) / 2];
    let mut actual_len = byte_len;
    let second = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            value.as_mut_ptr().cast(),
            &mut actual_len,
        )
    };
    if second != ERROR_SUCCESS {
        return Err(format!(
            "Could not verify the current-user startup entry (Windows error {second})."
        ));
    }
    while value.last() == Some(&0) {
        value.pop();
    }
    Ok(String::from_utf16_lossy(&value) == spec.command)
}

#[cfg(not(windows))]
fn startup_read(_spec: &StartupSpec) -> Result<bool, String> {
    Err("Run on startup is only supported on Windows in this build.".into())
}

#[cfg(windows)]
fn startup_set(spec: &StartupSpec, enabled: bool) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    };
    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let name = wide(&spec.value_name);
    let result = if enabled {
        let command = wide(&spec.command);
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                command.as_ptr().cast(),
                u32::try_from(command.len() * 2).map_err(|_| "Startup command is too long.")?,
            )
        }
    } else {
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr()) }
    };
    if result != ERROR_SUCCESS && !(result == ERROR_FILE_NOT_FOUND && !enabled) {
        return Err(format!(
            "Could not update the current-user startup entry (Windows error {result})."
        ));
    }
    let applied = startup_read(spec)?;
    if applied != enabled {
        return Err("Windows did not retain the requested startup state.".into());
    }
    Ok(applied)
}

#[cfg(not(windows))]
fn startup_set(_spec: &StartupSpec, _enabled: bool) -> Result<bool, String> {
    Err("Run on startup is only supported on Windows in this build.".into())
}

enum AwakeCommand {
    Set(bool, mpsc::SyncSender<Result<bool, String>>),
    Stop(mpsc::SyncSender<()>),
}

struct AwakeWorkerInner {
    tx: mpsc::Sender<AwakeCommand>,
    applied: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct AwakeWorker(Mutex<Option<AwakeWorkerInner>>);

#[cfg(windows)]
fn set_thread_awake(enabled: bool) -> Result<bool, String> {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let flags = ES_CONTINUOUS | if enabled { ES_SYSTEM_REQUIRED } else { 0 };
    if unsafe { SetThreadExecutionState(flags) } == 0 {
        return Err(format!(
            "Windows could not update the sleep request: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(enabled)
}

#[cfg(not(windows))]
fn set_thread_awake(_enabled: bool) -> Result<bool, String> {
    Err("Keep computer awake is only supported on Windows in this build.".into())
}

fn awake_loop(rx: mpsc::Receiver<AwakeCommand>, applied: Arc<AtomicBool>) {
    while let Ok(command) = rx.recv() {
        match command {
            AwakeCommand::Set(enabled, response) => {
                let result = set_thread_awake(enabled);
                if let Ok(state) = result {
                    applied.store(state, Ordering::SeqCst);
                }
                let _ = response.send(result);
            }
            AwakeCommand::Stop(response) => {
                if applied.load(Ordering::SeqCst) {
                    let _ = set_thread_awake(false);
                    applied.store(false, Ordering::SeqCst);
                }
                let _ = response.send(());
                break;
            }
        }
    }
    if applied.swap(false, Ordering::SeqCst) {
        let _ = set_thread_awake(false);
    }
}

impl AwakeWorker {
    fn ensure(inner: &mut Option<AwakeWorkerInner>) -> &AwakeWorkerInner {
        inner.get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel();
            let applied = Arc::new(AtomicBool::new(false));
            let worker_applied = applied.clone();
            let join = std::thread::Builder::new()
                .name("abdocode-awake".into())
                .spawn(move || awake_loop(rx, worker_applied))
                .expect("could not start the bounded awake worker");
            AwakeWorkerInner { tx, applied, join }
        })
    }

    fn set(&self, enabled: bool) -> Result<bool, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Keep-awake worker is unavailable.".to_string())?;
        if !enabled && guard.is_none() {
            return Ok(false);
        }
        let worker = Self::ensure(&mut guard);
        let (tx, rx) = mpsc::sync_channel(1);
        worker
            .tx
            .send(AwakeCommand::Set(enabled, tx))
            .map_err(|_| "Keep-awake worker stopped unexpectedly.".to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Keep-awake worker did not acknowledge the request.".to_string())?
    }

    fn current(&self) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .as_ref()
                    .map(|worker| worker.applied.load(Ordering::SeqCst))
            })
            .unwrap_or(false)
    }

    fn shutdown(&self) {
        // Shutdown is a last-resort cleanup path: recover a poisoned mutex so
        // a prior panic cannot leave ES_SYSTEM_REQUIRED active until process
        // termination.
        let worker = match self.0.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(worker) = worker {
            let (tx, rx) = mpsc::sync_channel(1);
            let _ = worker.tx.send(AwakeCommand::Stop(tx));
            let _ = rx.recv_timeout(Duration::from_secs(5));
            let _ = worker.join.join();
        }
    }
}

pub(crate) struct DesktopRuntime {
    update: Mutex<()>,
    awake: AwakeWorker,
    quitting: AtomicBool,
    last_errors: Mutex<Vec<DesktopPreferenceError>>,
    quick_entry: Mutex<Option<String>>,
}

impl Default for DesktopRuntime {
    fn default() -> Self {
        Self {
            update: Mutex::new(()),
            awake: AwakeWorker::default(),
            quitting: AtomicBool::new(false),
            last_errors: Mutex::new(Vec::new()),
            quick_entry: Mutex::new(None),
        }
    }
}

fn quick_entry_set(
    app: &tauri::AppHandle,
    runtime: &DesktopRuntime,
    requested: &QuickEntryPreference,
) -> Result<bool, String> {
    let shortcut = requested.shortcut.trim();
    let mut current = runtime
        .quick_entry
        .lock()
        .map_err(|_| "Quick Entry registration is unavailable.".to_string())?;
    if !requested.enabled {
        if let Some(active) = current.take() {
            if let Err(error) = app.global_shortcut().unregister(active.as_str()) {
                *current = Some(active);
                return Err(format!(
                    "Could not unregister the Quick Entry shortcut: {error}"
                ));
            }
        }
        return Ok(false);
    }
    if current.as_deref() == Some(shortcut) {
        return Ok(true);
    }
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| format!("Could not register Quick Entry shortcut {shortcut}: {error}"))?;
    if let Some(previous) = current.replace(shortcut.into()) {
        if let Err(error) = app.global_shortcut().unregister(previous.as_str()) {
            let _ = app.global_shortcut().unregister(shortcut);
            *current = Some(previous);
            return Err(format!(
                "Could not replace the previous Quick Entry shortcut: {error}"
            ));
        }
    }
    Ok(true)
}

fn quick_entry_current(runtime: &DesktopRuntime) -> Result<bool, String> {
    runtime
        .quick_entry
        .lock()
        .map(|value| value.is_some())
        .map_err(|_| "Quick Entry registration is unavailable.".to_string())
}

pub(crate) fn quick_entry_trigger(app: &tauri::AppHandle) {
    if show_main(app).is_ok() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval("window.dispatchEvent(new CustomEvent('abdocode-quick-entry'))");
        }
    }
}

fn show_main(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())
}

fn tray_set(app: &tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let active = app.tray_by_id(TRAY_ID).is_some();
    if enabled && !active {
        let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open AbdoCode", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit AbdoCode", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let menu = Menu::with_items(app, &[&open, &quit]).map_err(|error| error.to_string())?;
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .tooltip("AbdoCode");
        if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon);
        }
        builder
            .build(app)
            .map_err(|error| format!("Could not create the system tray icon: {error}"))?;
    } else if !enabled && active {
        drop(app.remove_tray_by_id(TRAY_ID));
    }
    Ok(app.tray_by_id(TRAY_ID).is_some())
}

trait DesktopActions {
    fn startup_current(&self) -> Result<bool, String>;
    fn tray_current(&self) -> Result<bool, String>;
    fn awake_current(&self) -> Result<bool, String>;
    fn quick_entry_current(&self) -> Result<bool, String>;
    fn startup(&mut self, enabled: bool) -> Result<bool, String>;
    fn tray(&mut self, enabled: bool) -> Result<bool, String>;
    fn awake(&mut self, enabled: bool) -> Result<bool, String>;
    fn quick_entry(&mut self, value: &QuickEntryPreference) -> Result<bool, String>;
}

struct NativeActions<'a> {
    app: &'a tauri::AppHandle,
    runtime: &'a DesktopRuntime,
    startup: StartupSpec,
}

// Explicit profiles must never change the installed application's login entry.
// They are launched with process-local profile settings that Windows Run cannot retain.
fn profile_startup(
    explicit: bool,
    requested: Option<bool>,
    action: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    if !explicit { return action(); }
    if requested == Some(true) {
        return Err("Run on startup is unavailable for an explicit desktop profile.".into());
    }
    Ok(false)
}

impl DesktopActions for NativeActions<'_> {
    fn startup_current(&self) -> Result<bool, String> {
        profile_startup(super::profile::is_explicit(), None, || startup_read(&self.startup))
    }

    fn tray_current(&self) -> Result<bool, String> {
        Ok(self.app.tray_by_id(TRAY_ID).is_some())
    }

    fn awake_current(&self) -> Result<bool, String> {
        Ok(self.runtime.awake.current())
    }

    fn quick_entry_current(&self) -> Result<bool, String> {
        quick_entry_current(self.runtime)
    }

    fn startup(&mut self, enabled: bool) -> Result<bool, String> {
        profile_startup(super::profile::is_explicit(), Some(enabled), || startup_set(&self.startup, enabled))
    }

    fn tray(&mut self, enabled: bool) -> Result<bool, String> {
        tray_set(self.app, enabled)
    }

    fn awake(&mut self, enabled: bool) -> Result<bool, String> {
        self.runtime.awake.set(enabled)
    }

    fn quick_entry(&mut self, value: &QuickEntryPreference) -> Result<bool, String> {
        quick_entry_set(self.app, self.runtime, value)
    }
}

fn apply_with(
    preferences: DesktopPreferences,
    actions: &mut impl DesktopActions,
) -> DesktopPreferencesStatus {
    // Capture the actual state before applying. If an OS setter fails, keep the
    // known prior state (or a successfully re-read post-failure state) instead
    // of manufacturing `false` in the response.
    let startup_before = actions.startup_current();
    let tray_before = actions.tray_current();
    let awake_before = actions.awake_current();
    let quick_entry_before = actions.quick_entry_current();
    let mut applied = DesktopAppliedState {
        run_on_startup: startup_before.ok(),
        system_tray: tray_before.ok(),
        keep_computer_awake: awake_before.ok(),
        quick_entry: quick_entry_before.ok(),
    };
    let mut errors = Vec::new();
    match actions.startup(preferences.run_on_startup) {
        Ok(value) => {
            applied.run_on_startup = Some(value);
            if value != preferences.run_on_startup {
                errors.push(DesktopPreferenceError::mismatch("runOnStartup"));
            }
        }
        Err(error) => {
            let message = match actions.startup_current() {
                Ok(value) => {
                    applied.run_on_startup = Some(value);
                    error
                }
                Err(read_error) => {
                    applied.run_on_startup = None;
                    format!("{error} The current state could not be read: {read_error}")
                }
            };
            errors.push(DesktopPreferenceError::apply("runOnStartup", message));
        }
    }
    match actions.tray(preferences.system_tray) {
        Ok(value) => {
            applied.system_tray = Some(value);
            if value != preferences.system_tray {
                errors.push(DesktopPreferenceError::mismatch("systemTray"));
            }
        }
        Err(error) => {
            let message = match actions.tray_current() {
                Ok(value) => {
                    applied.system_tray = Some(value);
                    error
                }
                Err(read_error) => {
                    applied.system_tray = None;
                    format!("{error} The current state could not be read: {read_error}")
                }
            };
            errors.push(DesktopPreferenceError::apply("systemTray", message));
        }
    }
    match actions.awake(preferences.keep_computer_awake) {
        Ok(value) => {
            applied.keep_computer_awake = Some(value);
            if value != preferences.keep_computer_awake {
                errors.push(DesktopPreferenceError::mismatch("keepComputerAwake"));
            }
        }
        Err(error) => {
            let message = match actions.awake_current() {
                Ok(value) => {
                    applied.keep_computer_awake = Some(value);
                    error
                }
                Err(read_error) => {
                    applied.keep_computer_awake = None;
                    format!("{error} The current state could not be read: {read_error}")
                }
            };
            errors.push(DesktopPreferenceError::apply("keepComputerAwake", message));
        }
    }
    match actions.quick_entry(&preferences.quick_entry) {
        Ok(value) => {
            applied.quick_entry = Some(value);
            if value != preferences.quick_entry.enabled {
                errors.push(DesktopPreferenceError::mismatch("quickEntry"));
            }
        }
        Err(error) => {
            let message = match actions.quick_entry_current() {
                Ok(value) => {
                    applied.quick_entry = Some(value);
                    error
                }
                Err(read_error) => {
                    applied.quick_entry = None;
                    format!("{error} The current state could not be read: {read_error}")
                }
            };
            errors.push(DesktopPreferenceError::apply("quickEntry", message));
        }
    }
    DesktopPreferencesStatus {
        preferences,
        applied,
        capabilities: DesktopCapabilities::default(),
        errors,
    }
}

fn apply(
    app: &tauri::AppHandle,
    runtime: &DesktopRuntime,
    preferences: DesktopPreferences,
) -> Result<DesktopPreferencesStatus, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the current executable: {error}"))?;
    let startup = startup_spec(&app.config().identifier, &executable)?;
    let mut actions = NativeActions {
        app,
        runtime,
        startup,
    };
    Ok(apply_with(preferences, &mut actions))
}

pub(crate) fn initialize(app: &tauri::AppHandle, runtime: &DesktopRuntime) {
    let result = preferences_path(app).and_then(|path| {
        let (loaded, mut errors) = load_repairable(&path);
        if !errors.is_empty() {
            // Do not mutate OS state from guessed defaults when the owner's
            // stored intent cannot be read. The next `get` exposes a status
            // that can be repaired with an ordinary `set`.
            return Ok(errors);
        }
        let (preferences, normalization_errors, changed) = normalize_for_capabilities(loaded);
        errors.extend(normalization_errors);
        if changed {
            if let Err(error) = save(&path, &preferences) {
                push_unique_error(&mut errors, DesktopPreferenceError::persist(error));
            }
        }
        let status = apply(app, runtime, preferences)?;
        for error in status.errors {
            push_unique_error(&mut errors, error);
        }
        Ok(errors)
    });
    let errors = match result {
        Ok(errors) => errors,
        Err(error) => vec![DesktopPreferenceError::apply("desktopPreferences", error)],
    };
    if let Ok(mut current) = runtime.last_errors.lock() {
        *current = errors;
    }
}

#[tauri::command]
pub(crate) fn desktop_preferences_get(
    app: tauri::AppHandle,
    runtime: tauri::State<DesktopRuntime>,
) -> Result<DesktopPreferencesStatus, String> {
    let _update = runtime
        .update
        .lock()
        .map_err(|_| "Desktop preferences are busy.".to_string())?;
    let path = preferences_path(&app)?;
    let (mut preferences, mut errors) = load_repairable(&path);
    if errors.is_empty() {
        let original = preferences.clone();
        let (normalized, normalization_errors, changed) = normalize_for_capabilities(preferences);
        for error in normalization_errors {
            push_unique_error(&mut errors, error);
        }
        if changed {
            match save(&path, &normalized) {
                Ok(()) => preferences = normalized,
                Err(error) => {
                    // Keep the original enabled value in the response when it
                    // could not be cleared on disk. That leaves the UI toggle
                    // actionable so the owner can retry the repair.
                    preferences = original;
                    push_unique_error(&mut errors, DesktopPreferenceError::persist(error));
                }
            }
        } else {
            preferences = normalized;
        }
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the current executable: {error}"))?;
    let startup = startup_spec(&app.config().identifier, &executable)?;
    let retained_errors = runtime
        .last_errors
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    // Re-measure all applied OS fields below. Old transient failures for those
    // fields must not survive beside a now-correct actual state.
    for error in retained_errors.into_iter().filter(|error| {
        !matches!(
            error.field.as_str(),
            "runOnStartup" | "systemTray" | "keepComputerAwake" | "quickEntry"
        )
    }) {
        push_unique_error(&mut errors, error);
    }
    let run_on_startup = match profile_startup(super::profile::is_explicit(), None, || startup_read(&startup)) {
        Ok(value) => Some(value),
        Err(error) => {
            push_unique_error(
                &mut errors,
                DesktopPreferenceError::apply("runOnStartup", error),
            );
            None
        }
    };
    if run_on_startup.is_some_and(|value| preferences.run_on_startup != value)
        && !errors.iter().any(|error| error.field == "runOnStartup")
    {
        push_unique_error(
            &mut errors,
            DesktopPreferenceError::mismatch("runOnStartup"),
        );
    }
    let system_tray = Some(app.tray_by_id(TRAY_ID).is_some());
    if system_tray.is_some_and(|value| preferences.system_tray != value)
        && !errors.iter().any(|error| error.field == "systemTray")
    {
        push_unique_error(&mut errors, DesktopPreferenceError::mismatch("systemTray"));
    }
    let keep_computer_awake = Some(runtime.awake.current());
    if keep_computer_awake.is_some_and(|value| preferences.keep_computer_awake != value)
        && !errors
            .iter()
            .any(|error| error.field == "keepComputerAwake")
    {
        push_unique_error(
            &mut errors,
            DesktopPreferenceError::mismatch("keepComputerAwake"),
        );
    }
    let quick_entry = match quick_entry_current(&runtime) {
        Ok(value) => Some(value),
        Err(error) => {
            push_unique_error(
                &mut errors,
                DesktopPreferenceError::apply("quickEntry", error),
            );
            None
        }
    };
    if quick_entry.is_some_and(|value| preferences.quick_entry.enabled != value)
        && !errors.iter().any(|error| error.field == "quickEntry")
    {
        push_unique_error(&mut errors, DesktopPreferenceError::mismatch("quickEntry"));
    }
    Ok(DesktopPreferencesStatus {
        preferences,
        applied: DesktopAppliedState {
            run_on_startup,
            system_tray,
            keep_computer_awake,
            quick_entry,
        },
        capabilities: DesktopCapabilities::default(),
        errors,
    })
}

#[tauri::command]
pub(crate) fn desktop_preferences_set(
    app: tauri::AppHandle,
    runtime: tauri::State<DesktopRuntime>,
    preferences: DesktopPreferences,
) -> Result<DesktopPreferencesStatus, String> {
    preferences.validate()?;
    let _update = runtime
        .update
        .lock()
        .map_err(|_| "Desktop preferences are busy.".to_string())?;
    let (preferences, normalization_errors, _) = normalize_for_capabilities(preferences);
    save(&preferences_path(&app)?, &preferences)?;
    let mut status = apply(&app, &runtime, preferences)?;
    for error in normalization_errors {
        push_unique_error(&mut status.errors, error);
    }
    if let Ok(mut errors) = runtime.last_errors.lock() {
        *errors = status.errors.clone();
    }
    Ok(status)
}

pub(crate) fn system_tray_active(app: &tauri::AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

pub(crate) fn should_hide_on_close(system_tray: bool, quitting: bool) -> bool {
    system_tray && !quitting
}

pub(crate) fn should_shutdown_on_close(system_tray: bool, quitting: bool) -> bool {
    !should_hide_on_close(system_tray, quitting)
}

pub(crate) fn is_quitting(runtime: &DesktopRuntime) -> bool {
    runtime.quitting.load(Ordering::SeqCst)
}

pub(crate) fn tray_open(app: &tauri::AppHandle) {
    let _ = show_main(app);
}

pub(crate) fn begin_quit(runtime: &DesktopRuntime) {
    runtime.quitting.store(true, Ordering::SeqCst);
}

pub(crate) fn shutdown(app: &tauri::AppHandle, runtime: &DesktopRuntime) {
    runtime.quitting.store(true, Ordering::SeqCst);
    if let Ok(mut current) = runtime.quick_entry.lock() {
        if let Some(shortcut) = current.take() {
            let _ = app.global_shortcut().unregister(shortcut.as_str());
        }
    }
    runtime.awake.shutdown();
}

#[cfg(test)]
mod tests {
    #[test]
    fn explicit_profile_never_reads_or_writes_shared_login_registration() {
        for requested in [None, Some(false), Some(true)] {
            let result = super::profile_startup(true, requested, || panic!("shared startup entry touched"));
            if requested == Some(true) { assert!(result.is_err()); }
            else { assert_eq!(result.unwrap(), false); }
        }
        assert!(super::profile_startup(false, Some(true), || Ok(true)).unwrap());
        assert!(super::profile_startup(false, None, || Err("registry unavailable".into())).is_err());
    }
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "abdocode-desktop-preferences-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn defaults_are_disabled_and_quick_entry_default_is_explicit() {
        let preferences = DesktopPreferences::default();
        assert!(!preferences.run_on_startup);
        assert!(!preferences.system_tray);
        assert!(!preferences.keep_computer_awake);
        assert!(!preferences.quick_entry.enabled);
        assert_eq!(preferences.quick_entry.shortcut, "Ctrl+Alt+Space");
        assert!(preferences.validate().is_ok());
    }

    #[test]
    fn preferences_round_trip_without_enabling_any_native_state() {
        let root = TempDir::new();
        let path = root.0.join("desktop.json");
        assert_eq!(load(&path).unwrap(), DesktopPreferences::default());
        let mut preferences = DesktopPreferences::default();
        preferences.system_tray = true;
        preferences.quick_entry.shortcut = "Ctrl+Shift+Space".into();
        save(&path, &preferences).unwrap();
        assert_eq!(load(&path).unwrap(), preferences);
        assert!(root.0.read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn parser_rejects_unknown_fields_and_unbounded_shortcuts() {
        assert!(serde_json::from_str::<DesktopPreferences>(r#"{"version":1,"runOnStartup":false,"systemTray":false,"keepComputerAwake":false,"quickEntry":{"enabled":false,"shortcut":"Ctrl+Alt+Space"},"surprise":true}"#).is_err());
        let mut preferences = DesktopPreferences::default();
        preferences.quick_entry.shortcut = "x".repeat(81);
        assert!(preferences.validate().is_err());
    }

    #[test]
    fn preview_and_canonical_startup_entries_cannot_replace_each_other() {
        let canonical = startup_spec(
            "io.abdocode.desktop",
            Path::new("C:/Program Files/AbdoCode/abdocode-desktop.exe"),
        )
        .unwrap();
        let preview = startup_spec(
            "io.abdocode.desktop.preview",
            Path::new("C:/Users/Owner/AppData/Local/AbdoCode Preview/abdocode-desktop.exe"),
        )
        .unwrap();
        assert_ne!(canonical.value_name, preview.value_name);
        assert_ne!(canonical.command, preview.command);
        assert_eq!(
            preview.command,
            r#""C:/Users/Owner/AppData/Local/AbdoCode Preview/abdocode-desktop.exe""#
        );
        assert!(startup_spec("io.abdocode.desktop", Path::new("relative.exe")).is_err());
    }

    #[derive(Default)]
    struct FakeActions {
        calls: Vec<(String, bool)>,
        results: VecDeque<Result<bool, String>>,
        current: DesktopAppliedState,
        observations: RefCell<VecDeque<Result<bool, String>>>,
    }
    impl DesktopActions for FakeActions {
        fn startup_current(&self) -> Result<bool, String> {
            if let Some(observed) = self.observations.borrow_mut().pop_front() {
                return observed;
            }
            self.current
                .run_on_startup
                .ok_or_else(|| "fixture startup state unavailable".into())
        }
        fn tray_current(&self) -> Result<bool, String> {
            if let Some(observed) = self.observations.borrow_mut().pop_front() {
                return observed;
            }
            self.current
                .system_tray
                .ok_or_else(|| "fixture tray state unavailable".into())
        }
        fn awake_current(&self) -> Result<bool, String> {
            if let Some(observed) = self.observations.borrow_mut().pop_front() {
                return observed;
            }
            self.current
                .keep_computer_awake
                .ok_or_else(|| "fixture awake state unavailable".into())
        }
        fn quick_entry_current(&self) -> Result<bool, String> {
            self.current
                .quick_entry
                .ok_or_else(|| "fixture Quick Entry state unavailable".into())
        }
        fn startup(&mut self, enabled: bool) -> Result<bool, String> {
            self.calls.push(("startup".into(), enabled));
            let result = self.results.pop_front().unwrap();
            if let Ok(value) = &result {
                self.current.run_on_startup = Some(*value);
            }
            result
        }
        fn tray(&mut self, enabled: bool) -> Result<bool, String> {
            self.calls.push(("tray".into(), enabled));
            let result = self.results.pop_front().unwrap();
            if let Ok(value) = &result {
                self.current.system_tray = Some(*value);
            }
            result
        }
        fn awake(&mut self, enabled: bool) -> Result<bool, String> {
            self.calls.push(("awake".into(), enabled));
            let result = self.results.pop_front().unwrap();
            if let Ok(value) = &result {
                self.current.keep_computer_awake = Some(*value);
            }
            result
        }
        fn quick_entry(&mut self, value: &QuickEntryPreference) -> Result<bool, String> {
            self.calls.push(("quickEntry".into(), value.enabled));
            self.current.quick_entry = Some(value.enabled);
            Ok(value.enabled)
        }
    }

    #[test]
    fn apply_reports_each_actual_state_and_does_not_hide_partial_failure() {
        let preferences = DesktopPreferences {
            run_on_startup: true,
            system_tray: true,
            keep_computer_awake: true,
            quick_entry: QuickEntryPreference {
                enabled: true,
                shortcut: "Ctrl+Alt+Space".into(),
            },
            ..DesktopPreferences::default()
        };
        let mut actions = FakeActions {
            results: VecDeque::from([Ok(true), Err("fixture tray failure".into()), Ok(false)]),
            current: DesktopAppliedState {
                run_on_startup: Some(false),
                system_tray: Some(true),
                keep_computer_awake: Some(true),
                quick_entry: Some(false),
            },
            ..FakeActions::default()
        };
        let status = apply_with(preferences.clone(), &mut actions);
        assert_eq!(status.preferences, preferences);
        assert_eq!(
            status.applied,
            DesktopAppliedState {
                run_on_startup: Some(true),
                // The failed tray setter did not erase the actual prior state.
                system_tray: Some(true),
                keep_computer_awake: Some(false),
                quick_entry: Some(true)
            }
        );
        assert_eq!(
            actions.calls,
            [
                ("startup".into(), true),
                ("tray".into(), true),
                ("awake".into(), true),
                ("quickEntry".into(), true)
            ]
        );
        assert_eq!(status.errors.len(), 2);
        assert!(status
            .errors
            .iter()
            .any(|error| error.field == "systemTray" && error.code == "applyFailed"));
        assert!(status
            .errors
            .iter()
            .any(|error| error.field == "keepComputerAwake" && error.code == "notApplied"));
        assert!(status.capabilities.quick_entry_shortcut);
    }

    #[test]
    fn an_unreadable_failed_apply_is_reported_as_unknown_instead_of_false() {
        let mut actions = FakeActions {
            results: VecDeque::from([Err("fixture setter failure".into()), Ok(false), Ok(false)]),
            ..FakeActions::default()
        };
        let status = apply_with(DesktopPreferences::default(), &mut actions);
        assert_eq!(status.applied.run_on_startup, None);
        assert!(status
            .errors
            .iter()
            .any(|error| error.field == "runOnStartup" && error.code == "applyFailed"));
        let json = serde_json::to_value(status).unwrap();
        assert!(json["applied"]["runOnStartup"].is_null());
    }

    #[test]
    fn a_pre_apply_value_is_not_claimed_after_set_and_re_read_both_fail() {
        let mut actions = FakeActions {
            results: VecDeque::from([
                Err("fixture partially-applied setter failure".into()),
                Ok(false),
                Ok(false),
            ]),
            current: DesktopAppliedState {
                run_on_startup: Some(false),
                system_tray: Some(false),
                keep_computer_awake: Some(false),
                quick_entry: Some(false),
            },
            observations: RefCell::new(VecDeque::from([
                Ok(false),
                Ok(false),
                Ok(false),
                Err("fixture post-write read failure".into()),
            ])),
            ..FakeActions::default()
        };
        let status = apply_with(DesktopPreferences::default(), &mut actions);
        assert_eq!(status.applied.run_on_startup, None);
        let error = status
            .errors
            .iter()
            .find(|error| error.field == "runOnStartup")
            .unwrap();
        assert!(error.message.contains("partially-applied setter failure"));
        assert!(error.message.contains("post-write read failure"));
    }

    #[test]
    fn close_hides_only_while_the_tray_lifecycle_is_active() {
        assert!(should_hide_on_close(true, false));
        assert!(!should_hide_on_close(false, false));
        assert!(!should_hide_on_close(true, true));
        assert!(!should_shutdown_on_close(true, false));
        assert!(should_shutdown_on_close(false, false));
        assert!(should_shutdown_on_close(true, true));
    }

    #[test]
    fn corrupt_preferences_return_a_repairable_disabled_status() {
        let root = TempDir::new();
        let path = root.0.join("desktop.json");
        std::fs::write(&path, b"{not-json").unwrap();

        let (preferences, errors) = load_repairable(&path);
        assert_eq!(preferences, DesktopPreferences::default());
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "desktopPreferences");
        assert_eq!(errors[0].code, "invalidStoredPreferences");

        save(&path, &preferences).unwrap();
        let (repaired, repaired_errors) = load_repairable(&path);
        assert_eq!(repaired, DesktopPreferences::default());
        assert!(repaired_errors.is_empty());
    }

    #[test]
    fn supported_quick_entry_is_retained_before_it_is_persisted() {
        let root = TempDir::new();
        let path = root.0.join("desktop.json");
        let mut requested = DesktopPreferences::default();
        requested.quick_entry.enabled = true;

        let (normalized, errors, changed) = normalize_for_capabilities(requested);
        assert!(!changed);
        assert!(normalized.quick_entry.enabled);
        assert!(errors.is_empty());

        save(&path, &normalized).unwrap();
        assert!(load(&path).unwrap().quick_entry.enabled);
    }
}
