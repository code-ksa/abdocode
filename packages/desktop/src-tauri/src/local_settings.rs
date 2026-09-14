//! Local profile, bounded diagnostics and user-selected exports. Never reads vault values.
use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::Manager;
static PROFILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProfile {
    display_name: String,
}
impl LocalProfile {
    fn validate(&self) -> Result<(), String> {
        if self.display_name.chars().count() > 80 || self.display_name.chars().any(char::is_control)
        {
            return Err(
                "Use a display name of up to 80 characters without control characters".into(),
            );
        }
        Ok(())
    }
}
fn profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(super::profile::directory(app)
        .map_err(|e| e.to_string())?
        .join("local-profile-v1.json"))
}
fn owner(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open settings in the main window".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn local_profile_get(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<LocalProfile, String> {
    owner(&window)?;
    let _lock = PROFILE_LOCK.lock().map_err(|_| "Profile unavailable")?;
    let path = profile_path(&app)?;
    if !path.exists() {
        return Ok(LocalProfile::default());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4096 {
        return Err("Profile is too large".into());
    }
    let profile: LocalProfile = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid local profile")?;
    profile.validate()?;
    Ok(profile)
}
#[tauri::command]
pub(crate) fn local_profile_set(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    profile: LocalProfile,
) -> Result<LocalProfile, String> {
    owner(&window)?;
    profile.validate()?;
    let _lock = PROFILE_LOCK.lock().map_err(|_| "Profile unavailable")?;
    let target = profile_path(&app)?;
    fs::create_dir_all(target.parent().ok_or("Invalid profile directory")?)
        .map_err(|e| e.to_string())?;
    let stage = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        crate::workspace::replace_file(&stage, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&stage);
    }
    result?;
    Ok(profile)
}

#[tauri::command]
pub(crate) fn local_diagnostics(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    owner(&window)?;
    let config = super::profile::directory(&app).map_err(|e| e.to_string())?;
    let mut files = vec![];
    // Fixed allowlist: filenames and sizes only. No arbitrary paths or file content.
    for name in [
        "settings-v1.json",
        "local-profile-v1.json",
        "workspace-v1.json",
        "engine-settings.json",
        "desktop-preferences-v1.json",
    ] {
        let path = config.join(name);
        let meta = fs::symlink_metadata(&path).ok();
        files.push(serde_json::json!({"name":name,"exists":meta.as_ref().is_some_and(|m|m.is_file()&&!m.file_type().is_symlink()),"bytes":meta.filter(|m|m.is_file()&&!m.file_type().is_symlink()).map(|m|m.len())}));
    }
    let engine = app.state::<crate::Engine>();
    let engine_running = engine
        .0
        .lock()
        .map_err(|_| "Engine status unavailable")?
        .as_mut()
        .is_some_and(|child| child.try_wait().ok() == Some(None));
    Ok(
        serde_json::json!({"version":app.package_info().version.to_string(),"applicationId":app.config().identifier,"processId":std::process::id(),"engineRunning":engine_running,"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"profileDirectory":config.display().to_string(),"files":files}),
    )
}

#[tauri::command]
pub(crate) async fn local_export_text(
    window: tauri::WebviewWindow,
    kind: String,
    text: String,
) -> Result<Option<String>, String> {
    owner(&window)?;
    let filename = match kind.as_str() {
        "conversation" => "abdocode-visible-conversation.txt",
        _ => return Err("Unknown export type".into()),
    };
    if text.len() > 2 * 1024 * 1024 {
        return Err("Export exceeds 2 MiB".into());
    }
    write_export(filename, text).await
}
async fn write_export(filename: &str, text: String) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Save AbdoCode export")
        .set_file_name(filename)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    file.write(text.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(file.path().display().to_string()))
}
#[tauri::command]
pub(crate) async fn local_export_diagnostics(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let data = local_diagnostics(app, window)?;
    write_export(
        "abdocode-diagnostics.json",
        serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?,
    )
    .await
}

fn signal_policy(
    s: &crate::settings::ProductSettings,
    event: &str,
) -> Result<(bool, bool), String> {
    Ok(match event {
        "agent" => (s.notifications.agent, s.sounds.agent),
        "permission" => (s.notifications.permission, s.sounds.permission),
        "error" => (s.notifications.error, s.sounds.error),
        _ => return Err("Invalid notification event".into()),
    })
}
#[tauri::command]
pub(crate) fn desktop_signal(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    event: String,
) -> Result<serde_json::Value, String> {
    owner(&window)?;
    let (notify, sound) = signal_policy(&crate::settings::settings_get(app)?, &event)?;
    let attention = notify && !window.is_focused().unwrap_or(true);
    if attention {
        window
            .request_user_attention(Some(tauri::UserAttentionType::Informational))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    if sound {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBeep(kind: u32) -> i32;
        }
        if unsafe { MessageBeep(if event == "error" { 0x10 } else { 0x40 }) } == 0 {
            return Err("Windows could not play the notification sound".into());
        }
    }
    Ok(serde_json::json!({"attention":attention,"sound":sound&&cfg!(windows)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_rejects_controls_and_overlong_names() {
        assert!(LocalProfile {
            display_name: "Abdo\nCode".into()
        }
        .validate()
        .is_err());
        assert!(LocalProfile {
            display_name: "ع".repeat(81)
        }
        .validate()
        .is_err());
        assert!(LocalProfile {
            display_name: "عبد الرحمن".into()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn native_signals_obey_each_saved_preference() {
        let mut s = crate::settings::ProductSettings::default();
        assert_eq!(signal_policy(&s, "permission").unwrap(), (true, true));
        s.sounds.permission = false;
        s.notifications.permission = false;
        assert_eq!(signal_policy(&s, "permission").unwrap(), (false, false));
        assert_eq!(signal_policy(&s, "agent").unwrap(), (true, false));
        assert!(signal_policy(&s, "arbitrary").is_err());
    }
    #[test]
    fn whitespace_cannot_create_an_unreadable_profile() {
        assert!(LocalProfile {
            display_name: " ".repeat(5000)
        }
        .validate()
        .is_err());
    }
}
