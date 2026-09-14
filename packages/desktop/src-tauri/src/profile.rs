//! Explicit desktop profiles isolate preferences, workspace metadata and engine defaults.
//! The ordinary installation keeps its existing OS-selected directory.
use std::path::PathBuf;
use tauri::Manager;

pub(crate) fn is_explicit() -> bool {
    std::env::var_os("ABDO_DESKTOP_PROFILE").is_some()
}

fn override_directory(value: Option<std::ffi::OsString>) -> Result<Option<PathBuf>, String> {
    match value {
        None => Ok(None),
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err("ABDO_DESKTOP_PROFILE must be an absolute directory without parent traversal".into());
            }
            if path.exists() && !path.is_dir() { return Err("Desktop profile must be a directory".into()); }
            Ok(Some(path))
        }
    }
}

pub(crate) fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    match override_directory(std::env::var_os("ABDO_DESKTOP_PROFILE"))? {
        Some(path) => Ok(path),
        None => app.path().app_config_dir().map_err(|error| error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_profiles_do_not_silently_fall_back_to_the_user_profile() {
        assert_eq!(override_directory(None).unwrap(), None);
        for value in ["", "relative", "../profile"] { assert!(override_directory(Some(value.into())).is_err()); }
        let root = std::env::temp_dir().join("abdocode-profile-qualification");
        assert_eq!(override_directory(Some(root.clone().into_os_string())).unwrap(), Some(root.clone()));
        assert!(override_directory(Some(root.join("..").join("other").into_os_string())).is_err());
    }
}
