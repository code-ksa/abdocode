//! User-operated interactive terminals. Agent commands still use the engine's
//! guarded dispatcher; this transport is restricted to owned local UI webviews.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State, Webview};

const MAX_SESSIONS: usize = 8;
const MAX_INPUT: usize = 64 * 1024;

struct Session {
    owner: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Arc<Session>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exited {
    id: String,
    exit_code: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    id: String,
    cwd: String,
    shell: String,
    pid: Option<u32>,
}

fn owner(webview: &Webview) -> Result<String, String> {
    let label = webview.label();
    if label != "main" && label != "panel-terminal" {
        return Err("Terminal is restricted to the local workspace".into());
    }
    Ok(label.into())
}

fn dimensions(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(2..=200).contains(&rows) {
        return Err("Invalid terminal dimensions".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn get(state: &Terminals, id: &str, owner: &str) -> Result<Arc<Session>, String> {
    let sessions = state
        .0
        .lock()
        .map_err(|_| "Terminal state is unavailable")?;
    sessions
        .get(id)
        .filter(|session| session.owner == owner)
        .cloned()
        .ok_or_else(|| "Terminal session is closed".into())
}

fn shell() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into()))
    }
}

// std::fs::canonicalize returns extended Windows paths. PowerShell treats
// those as provider-qualified locations and shows an unwieldy UNC prompt.
// Simplify only that representation after validating the canonical directory;
// retain all original UTF-16 path characters and real network shares.
fn interactive_cwd(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        const EXTENDED: &[u16] = &[92, 92, 63, 92];
        const UNC: &[u16] = &[85, 78, 67, 92];
        if let Some(rest) = units.strip_prefix(EXTENDED) {
            let conventional = if let Some(share) = rest.strip_prefix(UNC) {
                [vec![92, 92], share.to_vec()].concat()
            } else if rest.len() >= 3 && rest[1] == 58 && rest[2] == 92 {
                rest.to_vec()
            } else {
                // Preserve device paths that are not drive paths or shares.
                return path.to_path_buf();
            };
            return std::ffi::OsString::from_wide(&conventional).into();
        }
    }
    path.to_path_buf()
}

#[tauri::command]
pub fn terminal_open(
    webview: Webview,
    state: State<'_, Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<Opened, String> {
    let owner = owner(&webview)?;
    let size = dimensions(cols, rows)?;
    let cwd = cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .ok_or("Working directory is unavailable")?;
    let cwd =
        std::fs::canonicalize(cwd).map_err(|_| "Terminal working directory does not exist")?;
    if !cwd.is_dir() {
        return Err("Terminal working directory must be a folder".into());
    }
    let cwd = interactive_cwd(&cwd);
    let mut sessions = state
        .0
        .lock()
        .map_err(|_| "Terminal state is unavailable")?;
    if sessions.len() >= MAX_SESSIONS {
        return Err("Close a terminal before opening another (maximum 8)".into());
    }
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|err| format!("Could not create interactive terminal: {err}"))?;
    let shell = shell();
    let mut command = CommandBuilder::new(&shell);
    #[cfg(windows)]
    command.args(["-NoLogo", "-NoProfile", "-NoExit"]);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Terminal output: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("Terminal input: {err}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("Could not start shell: {err}"))?;
    let pid = child.process_id();
    drop(pair.slave);
    let id = uuid::Uuid::new_v4().to_string();
    sessions.insert(
        id.clone(),
        Arc::new(Session {
            owner: owner.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
        }),
    );
    drop(sessions);
    let output_id = id.clone();
    let output_webview = webview.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(len) => {
                    if output_webview
                        .emit_to(
                            output_webview.label(),
                            "terminal-output",
                            Output {
                                id: output_id.clone(),
                                data: buffer[..len].to_vec(),
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    let exited_id = id.clone();
    std::thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        let _ = webview.emit_to(
            webview.label(),
            "terminal-exited",
            Exited {
                id: exited_id.clone(),
                exit_code,
            },
        );
        // The UI can disappear before the shell exits. Removing the entry here
        // also ensures a completed terminal cannot exhaust the session limit.
        if let Some(state) = webview.app_handle().try_state::<Terminals>() {
            if let Ok(mut sessions) = state.0.lock() {
                sessions.remove(&exited_id);
            }
        }
    });
    Ok(Opened {
        id,
        cwd: cwd.to_string_lossy().trim_start_matches("\\\\?\\").into(),
        shell: shell
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        pid,
    })
}

#[tauri::command]
pub fn terminal_write(
    webview: Webview,
    state: State<'_, Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_INPUT {
        return Err("Terminal input is too large".into());
    }
    let session = get(&state, &id, &owner(&webview)?)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Terminal input is unavailable")?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|err| format!("Terminal input failed: {err}"))
}

#[tauri::command]
pub fn terminal_resize(
    webview: Webview,
    state: State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let size = dimensions(cols, rows)?;
    let session = get(&state, &id, &owner(&webview)?)?;
    let master = session
        .master
        .lock()
        .map_err(|_| "Terminal size is unavailable")?;
    master
        .resize(size)
        .map_err(|err| format!("Terminal resize failed: {err}"))
}

#[tauri::command]
pub fn terminal_close(
    webview: Webview,
    state: State<'_, Terminals>,
    id: String,
) -> Result<(), String> {
    let owner = owner(&webview)?;
    let session = get(&state, &id, &owner)?;
    let result = session
        .killer
        .lock()
        .map_err(|_| "Terminal process is unavailable")?
        .kill()
        .map_err(|err| format!("Could not close terminal: {err}"));
    state
        .0
        .lock()
        .map_err(|_| "Terminal state is unavailable")?
        .remove(&id);
    result
}

pub fn shutdown(state: &Terminals, owner: Option<&str>) {
    if let Ok(mut sessions) = state.0.lock() {
        let ids: Vec<_> = sessions
            .iter()
            .filter(|(_, session)| owner.is_none_or(|owner| session.owner == owner))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(session) = sessions.remove(&id) {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dimensions_are_bounded_before_native_calls() {
        assert!(dimensions(80, 24).is_ok());
        assert!(dimensions(0, 24).is_err());
        assert!(dimensions(500, 201).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_cwd_retains_drive_unc_and_unicode_paths() {
        assert_eq!(
            interactive_cwd(Path::new(r"\\?\C:\Users\عبدو")),
            PathBuf::from(r"C:\Users\عبدو")
        );
        assert_eq!(
            interactive_cwd(Path::new(r"\\?\UNC\server\share\folder")),
            PathBuf::from(r"\\server\share\folder")
        );
        assert_eq!(
            interactive_cwd(Path::new(r"C:\project")),
            PathBuf::from(r"C:\project")
        );
        assert_eq!(
            interactive_cwd(Path::new(r"\\?\Volume{test}\")),
            PathBuf::from(r"\\?\Volume{test}\")
        );
    }

    /// Exercises the actual platform PTY, including stateful input, Ctrl+C and
    /// native resize. No mock provider or command-output receipt is involved.
    #[test]
    #[ignore = "spawns a real local interactive shell"]
    fn real_shell_keeps_state_interrupts_and_resizes() {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let pair = native_pty_system()
            .openpty(dimensions(80, 24).unwrap())
            .unwrap();
        let mut cmd = CommandBuilder::new(shell());
        let cwd = interactive_cwd(
            &std::fs::canonicalize(
                std::env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| std::env::current_dir().unwrap()),
            )
            .unwrap(),
        );
        cmd.cwd(&cwd);
        #[cfg(windows)]
        cmd.args(["-NoLogo", "-NoProfile", "-NoExit"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            while let Ok(len) = reader.read(&mut buf) {
                if len == 0 {
                    break;
                }
                if tx
                    .send(String::from_utf8_lossy(&buf[..len]).into_owned())
                    .is_err()
                {
                    break;
                }
            }
        });
        let wait_for = |writer: &mut Box<dyn Write + Send>, needle: &str| {
            let mut seen = String::new();
            let until = Instant::now() + Duration::from_secs(15);
            while Instant::now() < until {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                    seen.push_str(&chunk);
                    if seen.ends_with("\u{1b}[6n") {
                        writer.write_all(b"\x1b[1;1R").unwrap();
                        writer.flush().unwrap();
                    }
                    if seen.contains(needle) {
                        return seen;
                    }
                }
            }
            panic!("interactive terminal did not produce marker {needle}: {seen:?}");
        };
        #[cfg(windows)]
        {
            let prompt = wait_for(&mut writer, &format!("PS {}>", cwd.display()));
            assert!(!prompt.contains("Microsoft.PowerShell.Core\\FileSystem::"));
            assert!(!prompt.contains(r"\\?\"));
            writer.write_all(b"$abdoTerminalProbe = 42\r").unwrap();
            writer.flush().unwrap();
            // Marker is deliberately split in the submitted command, so the
            // echoed input cannot satisfy the assertion before evaluation.
            writer
                .write_all(b"Write-Output ('ABDO' + '-STATE-' + $abdoTerminalProbe)\r")
                .unwrap();
            writer.flush().unwrap();
            wait_for(&mut writer, "ABDO-STATE-42");
            pair.master.resize(dimensions(110, 32).unwrap()).unwrap();
            assert_eq!(pair.master.get_size().unwrap().cols, 110);
            writer
                .write_all(b"Write-Output ('ABDO' + '-WAIT'); Start-Sleep -Seconds 30\r")
                .unwrap();
            writer.flush().unwrap();
            wait_for(&mut writer, "ABDO-WAIT");
            writer.write_all(b"\x03").unwrap();
            writer.flush().unwrap();
            wait_for(&mut writer, "PS ");
            writer
                .write_all(b"Write-Output ('ABDO' + '-AFTER-INTERRUPT')\r")
                .unwrap();
            writer.flush().unwrap();
            wait_for(&mut writer, "ABDO-AFTER-INTERRUPT");
        }
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
