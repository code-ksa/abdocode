//! Product-owned desktop settings. Secrets are intentionally excluded: they
//! remain in the separate vault and are never serialized beside preferences.

use std::fs::OpenOptions;
use std::io::Write;

const MAX_SETTINGS_BYTES: usize = 64 * 1024;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductSettings {
    pub(crate) version: u8,
    pub(crate) language: String,
    pub(crate) color_scheme: String,
    pub(crate) ui_scale: u8,
    pub(crate) followup: String,
    pub(crate) show_navigation: bool,
    pub(crate) show_browser_pane: bool,
    pub(crate) reasoning_summaries: bool,
    pub(crate) expanded_tools: bool,
    pub(crate) notifications: NoticeSettings,
    pub(crate) sounds: NoticeSettings,
    pub(crate) keybindings: Keybindings,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoticeSettings {
    pub(crate) agent: bool,
    pub(crate) permission: bool,
    pub(crate) error: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Keybindings {
    pub(crate) command_palette: String,
    pub(crate) settings: String,
    pub(crate) new_session: String,
}

impl Default for ProductSettings {
    fn default() -> Self {
        Self {
            version: 1,
            language: "en".into(),
            color_scheme: "system".into(),
            ui_scale: 100,
            followup: "queue".into(),
            show_navigation: true,
            show_browser_pane: true,
            reasoning_summaries: true,
            expanded_tools: false,
            notifications: NoticeSettings {
                agent: true,
                permission: true,
                error: true,
            },
            sounds: NoticeSettings {
                agent: false,
                permission: true,
                error: true,
            },
            keybindings: Keybindings {
                command_palette: "Ctrl+K".into(),
                settings: "Ctrl+,".into(),
                new_session: "Ctrl+N".into(),
            },
        }
    }
}

fn one_of(value: &str, accepted: &[&str], field: &str) -> Result<(), String> {
    if accepted.contains(&value) {
        Ok(())
    } else {
        Err(format!("قيمة {field} مرفوضة"))
    }
}

fn safe_text(value: &str, max: usize, field: &str) -> Result<(), String> {
    if !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(format!("قيمة {field} مرفوضة"))
    }
}

impl ProductSettings {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || !(90..=125).contains(&self.ui_scale) {
            return Err("إصدار الإعدادات أو مقياس الواجهة مرفوض".into());
        }
        // اللغاتُ المقبولة = ما تترجمه القشرةُ فعلاً (`SUPPORTED_LANGUAGES` في `native-locale.js`)؛
        // القائمةُ السابقة (١٩١ رمز ISO) كانت نسخةً ثالثة من سؤالٍ له مالكٌ واحد، وتقبل ما لا يُعرض.
        one_of(&self.language, &["en", "ar"], "اللغة")?;
        one_of(&self.color_scheme, &["system", "light", "dark"], "السمة")?;
        one_of(&self.followup, &["queue", "steer"], "المتابعة")?;
        for value in [
            &self.keybindings.command_palette,
            &self.keybindings.settings,
            &self.keybindings.new_session,
        ] {
            safe_text(value, 40, "اختصار لوحة المفاتيح")?;
        }
        Ok(())
    }
}

fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    super::profile::directory(app)
        .map(|dir| dir.join("settings-v1.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn settings_get(app: tauri::AppHandle) -> Result<ProductSettings, String> {
    let path = path(&app)?;
    if !path.exists() {
        return Ok(ProductSettings::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("تعذّرت قراءة الإعدادات: {e}"))?;
    if bytes.is_empty() || bytes.len() > MAX_SETTINGS_BYTES {
        return Err("حجم ملف الإعدادات مرفوض".into());
    }
    let value: ProductSettings =
        serde_json::from_slice(&bytes).map_err(|_| "ملف الإعدادات غير صالح".to_string())?;
    value.validate()?;
    Ok(value)
}

#[tauri::command]
pub(crate) fn settings_set(
    app: tauri::AppHandle,
    settings: ProductSettings,
) -> Result<ProductSettings, String> {
    settings.validate()?;
    let target = path(&app)?;
    let parent = target
        .parent()
        .ok_or_else(|| "مسار الإعدادات بلا أصل".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("تعذّر إنشاء مجلد الإعدادات: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("حجم الإعدادات مرفوض".into());
    }
    let staged = parent.join(format!("settings-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staged)
        .map_err(|e| format!("تعذّر تجهيز الإعدادات: {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("تعذّر تثبيت الإعدادات: {e}"))?;
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("تعذّر استبدال الإعدادات: {e}"))?;
    }
    std::fs::rename(&staged, &target).map_err(|e| format!("تعذّر اعتماد الإعدادات: {e}"))?;
    Ok(settings)
}

#[tauri::command]
pub(crate) fn settings_reset(app: tauri::AppHandle) -> Result<ProductSettings, String> {
    settings_set(app, ProductSettings::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_local_first_and_fail_closed() {
        let settings = ProductSettings::default();
        assert_eq!(settings.followup, "queue");
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn rejects_unknown_or_unbounded_preferences() {
        let mut settings = ProductSettings::default();
        settings.ui_scale = 200;
        assert!(settings.validate().is_err());
        assert!(
            serde_json::from_str::<ProductSettings>(r#"{"version":1,"surprise":true}"#).is_err()
        );
    }
}
