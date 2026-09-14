// عبدو كود — واجهة سطح المكتب. رست تملك العملية والنافذة والأطفال؛
// العرض في WebView2 يستهلك عقود S137/S138 المحزومة كما هي — مالك السلوك
// يبقى المحرك مالك السلوك، والواجهة منظرٌ فوقه لا نسخةٌ منه.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

mod profile;
mod attachments;
mod attachment_documents;
mod automation;
mod automation_store;
mod automation_worker;
mod browser_surface;
mod desktop_preferences;
mod extensions;
mod extension_download;
mod release_check;
mod notify;
mod marketplace;
mod local_settings;
mod provider_setup;
mod settings;
mod terminal_pty;
mod workspace;
mod workspace_controls;

const MAX_ENGINE_FRAME_BYTES: usize = 1024 * 1024;

// A separately installed preview must also have separate engine state and
// credentials. Explicit launch overrides still win, including isolated QA homes.
/// ملفُّ سطح المكتب (workspace-v1.json وسياسةُ المواقع وعقدُ المتصفّح المملوك) يسكن `app_config_dir`،
/// بينما المحرّكُ يبحث عنه بجوار إعداداته ما لم يُخبَر بـ`ABDO_DESKTOP_PROFILE`. مقيسٌ 2026-09-13 على
/// الإنتاج: المتغيّرُ كان يُضبط للمعاينة وحدها، فرفض المحرّكُ المتصفّحَ المملوك («لم يتصل متصفح الوكيل»)
/// رغم أنّ سطحَ المكتب أطلقه وكتب عقدَه، وسقطت سياسةُ المواقع المحفوظة إلى افتراض سطر الأوامر.
/// قيمةٌ مورَّدةٌ صراحةً تبقى؛ الغيابُ وحده يُملأ من الملفّ المحلول.
fn desktop_profile_env(current: Option<std::ffi::OsString>, resolved: &Path) -> Option<PathBuf> {
    match current {
        Some(value) if !value.to_string_lossy().trim().is_empty() => None,
        _ => Some(resolved.to_path_buf()),
    }
}

fn preview_env_defaults(
    identifier: &str,
    profile: &Path,
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, PathBuf)> {
    if !identifier.ends_with(".preview") {
        return Vec::new();
    }
    let supplied =
        |name: &str| lookup(name).filter(|value| !value.to_string_lossy().trim().is_empty());
    let vault_home = supplied("ABDO_VAULT_HOME")
        .map(|value| PathBuf::from(value.to_string_lossy().trim()))
        .unwrap_or_else(|| profile.join("vault-home"));
    [
        ("ABDO_CODE_STATE_DIR", profile.join("engine-state")),
        ("ABDO_CODE_SETTINGS", profile.join("engine-settings.json")),
        ("ABDO_VAULT_HOME", vault_home.clone()),
        ("ABDO_VAULT_DIR", vault_home.join("vault")),
    ]
    .into_iter()
    .filter(|(name, _)| supplied(name).is_none())
    .collect()
}

#[cfg(test)]
mod preview_profile_tests {
    use super::{desktop_profile_env, is_owned_panel_window, preview_env_defaults, shipped_vault_script_path};
    use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

    #[test]
    fn every_identity_hands_the_engine_the_desktop_profile_unless_one_was_supplied() {
        let resolved = PathBuf::from(r"C:\Users\x\AppData\Roaming\io.abdocode.desktop");
        assert_eq!(desktop_profile_env(None, &resolved), Some(resolved.clone()));
        assert_eq!(desktop_profile_env(Some("  ".into()), &resolved), Some(resolved.clone()));
        assert_eq!(desktop_profile_env(Some(r"D:\explicit".into()), &resolved), None);
    }

    #[test]
    fn preview_gets_a_separate_profile_and_canonical_launch_is_unchanged() {
        let profile = PathBuf::from("preview-profile");
        assert!(preview_env_defaults("io.abdocode.desktop", &profile, |_| None).is_empty());
        assert!(
            preview_env_defaults("io.abdocode.desktop.previewer", &profile, |_| None).is_empty()
        );
        let values: BTreeMap<_, _> =
            preview_env_defaults("io.abdocode.desktop.preview", &profile, |_| None)
                .into_iter()
                .collect();
        assert_eq!(values.len(), 4);
        assert_eq!(values["ABDO_CODE_STATE_DIR"], profile.join("engine-state"));
        assert_eq!(
            values["ABDO_CODE_SETTINGS"],
            profile.join("engine-settings.json")
        );
        assert_eq!(values["ABDO_VAULT_HOME"], profile.join("vault-home"));
        assert_eq!(
            values["ABDO_VAULT_DIR"],
            profile.join("vault-home").join("vault")
        );
    }

    #[test]
    fn explicit_launch_paths_survive_and_vault_directory_follows_its_home() {
        let profile = PathBuf::from("preview-profile");
        let existing = BTreeMap::from([
            ("ABDO_CODE_STATE_DIR", OsString::from("qa-state")),
            ("ABDO_CODE_SETTINGS", OsString::from("qa-settings.json")),
            ("ABDO_VAULT_HOME", OsString::from("qa-vault-home")),
        ]);
        let values = preview_env_defaults("io.abdocode.desktop.preview", &profile, |key| {
            existing.get(key).cloned()
        });
        assert_eq!(
            values,
            vec![(
                "ABDO_VAULT_DIR",
                PathBuf::from("qa-vault-home").join("vault")
            )]
        );
        assert!(
            preview_env_defaults("io.abdocode.desktop.preview", &profile, |_| Some(
                OsString::from("explicit")
            ))
            .is_empty()
        );
    }

    #[test]
    fn native_vault_lookup_matches_the_engines_explicit_home() {
        assert_eq!(
            shipped_vault_script_path(Some("qa-vault".into()), Some("main-appdata".into())),
            Some(PathBuf::from("qa-vault").join("vault.ps1"))
        );
        assert_eq!(
            shipped_vault_script_path(None, Some("main-appdata".into())),
            Some(
                PathBuf::from("main-appdata")
                    .join("abdocode")
                    .join("vault.ps1")
            )
        );
        assert_eq!(shipped_vault_script_path(Some("".into()), None), None);
        assert_eq!(
            shipped_vault_script_path(Some("  qa-vault  ".into()), None),
            Some(PathBuf::from("qa-vault").join("vault.ps1"))
        );
    }

    #[test]
    fn whitespace_home_cannot_fall_back_to_the_main_profiles_vault() {
        let profile = PathBuf::from("preview-profile");
        let values: BTreeMap<_, _> =
            preview_env_defaults("io.abdocode.desktop.preview", &profile, |key| {
                (key == "ABDO_VAULT_HOME").then(|| OsString::from(" \t "))
            })
            .into_iter()
            .collect();
        assert_eq!(values["ABDO_VAULT_HOME"], profile.join("vault-home"));
        assert_eq!(
            values["ABDO_VAULT_DIR"],
            profile.join("vault-home").join("vault")
        );
        assert_eq!(shipped_vault_script_path(Some(" \t ".into()), None), None);
    }

    #[test]
    fn lifecycle_cleanup_targets_only_owned_detached_panels() {
        assert!(is_owned_panel_window("panel-terminal"));
        assert!(is_owned_panel_window("panel-browser-2"));
        assert!(!is_owned_panel_window("main"));
        assert!(!is_owned_panel_window("pane-browser"));
        assert!(!is_owned_panel_window("unrelated"));
    }
}

fn write_json_frame(writer: &mut impl Write, value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_vec(value).map_err(|e| format!("تعذّر ترميز إطار المحرّك: {e}"))?;
    if payload.is_empty() || payload.len() > MAX_ENGINE_FRAME_BYTES {
        return Err(format!("حجم إطار المحرّك غير مسموح: {}", payload.len()));
    }
    let length = u32::try_from(payload.len()).map_err(|_| "إطار المحرّك أكبر من u32".to_string())?;
    writer
        .write_all(&length.to_be_bytes())
        .map_err(|e| format!("تعذّر إرسال طول الإطار: {e}"))?;
    writer
        .write_all(&payload)
        .map_err(|e| format!("تعذّر إرسال جسم الإطار: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("تعذّر تفريغ إطار المحرّك: {e}"))
}

fn read_json_frame(reader: &mut impl Read) -> Result<Option<String>, String> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(format!("تعذّر قراءة طول إطار المحرّك: {error}")),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_ENGINE_FRAME_BYTES {
        return Err(format!("طول إطار المحرّك مرفوض: {length}"));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|e| format!("إطار محرّك ناقص: {e}"))?;
    let value: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|e| format!("إطار المحرّك ليس JSON UTF-8 صالحاً: {e}"))?;
    serde_json::to_string(&value)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// جذر النظام: مجلّد الـexe عند التوزيع، ومجلّد المصدر أثناء التطوير.
/// نفس درس التصريف: الكشف بهويّة الملفات الحاضرة لا بشكل المسار.
fn system_root() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = exe_dir {
        if dir.join("bin").join("abdo-kernel.exe").exists() {
            return dir;
        }
        // التوزيع (release فقط): الموارد تسكن payload/ إلى جوار الـexe المثبَّت.
        // في بناء التطوير tauri ينسخ الموارد إلى target/debug/payload — نسخةٌ
        // متجمّدة من لحظة التحزيم شغّلت محرّكاً قديماً وأكلت ساعةً من الأدلة؛
        // فبناء التطوير يذهب لجذر المصدر حصراً.
        #[cfg(not(debug_assertions))]
        {
            let payload = dir.join("payload");
            if payload.join("bin").join("abdo-kernel.exe").exists() {
                return payload;
            }
        }
    }
    // التطوير: src-tauri/target/debug → ثلاثة آباء فوق desktop → جذر الحزمة
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// المحرّك: الـexe المصرّف عند وجوده، وإلا bun على المصدر — نفس المالك
/// في الحالين، `abdocode serve`. لا سلوك ثالثاً هنا.
/// رأسُ أمرِ المحرّك بلا فعلٍ: الـexe المصرّف عند وجوده، وإلا bun على المصدر.
///
/// **مصدرٌ واحد**: `engine_command` تبني عليه بإضافة `serve`، و`identity`
/// تُعلنه للقشرة لتبني به أوامرَ خوادم MCP المشحونة. نسختان تفترقان يوماً،
/// فتبني القشرةُ أمراً لملفٍّ لا يُشغَّل.
fn engine_argv_prefix(root: &Path) -> Vec<String> {
    let exe = root.join("abdocode.exe");
    if exe.exists() {
        vec![exe.display().to_string()]
    } else {
        vec![
            "bun".to_string(),
            root.join("engine")
                .join("src")
                .join("cli.ts")
                .display()
                .to_string(),
        ]
    }
}

fn engine_command(root: &Path, shell_token: &str) -> Command {
    let prefix = engine_argv_prefix(root);
    let mut cmd = Command::new(&prefix[0]);
    for part in &prefix[1..] {
        cmd.arg(part);
    }
    cmd.arg("serve");
    cmd.current_dir(root)
        .env("ABDO_SHELL_TOKEN", shell_token)
        .env("ABDO_FRAMED_STDIO", "1")
        .env("ABDO_REQUIRE_PROJECT", "1")
        .env("ABDO_INSTALL_ROOT", root)
        .env("ABDO_DESKTOP_OWNER_PID", std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(engine_stderr_target());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — لا وميض كونسول
    }
    cmd
}

/// stderr المحرّك إلى ملفٍّ (يُستبدل عند كلّ تشغيل) لا إلى العدم — مقيس 2026-09-13: مات المحرّك عند
/// توصيل إضافة المتصفّح ولم يبقَ سطرٌ واحد يقول لماذا. الملفُّ تشخيصٌ محلّيّ؛ لا يصل نموذجاً ولا شبكة.
fn engine_stderr_target() -> Stdio {
    let home = std::env::var("ABDO_CODE_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join(".config").join("abdocode")))
        .ok();
    match home {
        Some(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            // مراجعة 09-14 (#19): تدويرٌ بسيط — سجلٌّ تجاوز ٤ ميغابايت يُزاح إلى engine-stderr.1.log قبل الفتح (نسخةٌ واحدة تُبقى).
            let log = dir.join("engine-stderr.log");
            if std::fs::metadata(&log).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false) {
                let _ = std::fs::rename(&log, dir.join("engine-stderr.1.log"));
            }
            match std::fs::File::create(&log) {
                Ok(file) => Stdio::from(file),
                Err(_) => Stdio::null(),
            }
        }
        None => Stdio::null(),
    }
}

struct Engine(Mutex<Option<Child>>);

#[derive(serde::Serialize)]
struct Identity {
    name: String,
    version: String,
    root: String,
    kernel_present: bool,
    engine_present: bool,
    /// رأسُ أمرِ المحرّك — تبني به القشرةُ أوامرَ خوادم MCP المشحونة معنا،
    /// فلا يكتب المستخدمُ مساراً بيده ولا نخمّنه له.
    engine_argv: Vec<String>,
}

#[tauri::command]
fn identity() -> Identity {
    let root = system_root();
    Identity {
        name: "عبدو كود".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        root: root.display().to_string(),
        kernel_present: root.join("bin").join("abdo-kernel.exe").exists(),
        engine_present: root.join("abdocode.exe").exists()
            || root.join("engine").join("src").join("cli.ts").exists(),
        engine_argv: engine_argv_prefix(&root),
    }
}

/// تشغيل المحرّك طفلاً وضخّ أطره المحدودة أحداثاً إلى الويب-فيو. سقوطه لا يعيد
/// تشغيله خلسةً: الحالة تُعلن (`engine-died`) والإحياء نقرة مشغّل —
/// fail-closed، فالجسر ينقل الحقيقة ولا يجمّلها.
#[tauri::command]
fn engine_start(app: tauri::AppHandle, engine: State<Engine>) -> Result<(), String> {
    let mut slot = engine.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = slot.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Err("المحرّك يعمل بالفعل — لا تشغيل ثانياً فوقه".into());
        }
    }
    let root = system_root();
    let shell_token = Uuid::new_v4().simple().to_string();
    let mut command = engine_command(&root, &shell_token);
    if let Ok(documents) = app.path().document_dir() {
        command.env("ABDO_DOCUMENTS_DIR", documents);
    }
    let mut child = command.spawn()
        .map_err(|e| format!("تعذّر تشغيل المحرّك: {e}"))?;
    // Authenticate before the UI can send any frame. The token exists only in
    // this parent and its private child environment; it is never emitted to JS.
    let hello = serde_json::json!({ "kind": "hello", "shell": "desktop", "token": shell_token });
    write_json_frame(
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "لا مدخل للمحرّك".to_string())?,
        &hello,
    )
    .map_err(|e| format!("تعذّرت مصادقة قناة المحرّك: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "لا مخرج للمحرّك".to_string())?;
    *slot = Some(child);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_json_frame(&mut reader) {
                Ok(Some(text)) => {
                    let _ = workspace::register_engine_project(&text);
                    let _ = app.emit("serve-frame", text);
                }
                Ok(None) | Err(_) => break,
            }
        }
        // نهاية المجرى = موت المحرّك. يُعلن ولا يُداوى في الظلّ.
        let _ = app.emit("engine-died", ());
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// T09 — خزنة المفاتيح. بابٌ واحدٌ إلى `secrets.ps1` (gpg+DPAPI القائم)، لا
// لمسٌ مباشرٌ لـgpg من التطبيق (درس «بابٌ واحدٌ لكلّ نظام»). المفتاح يُكتب
// من الواجهة إلى الخزنة رأساً؛ ولا يُقرأ إلى الواجهة أبداً — القراءة حكرُ
// المحرّك وقتَ النداء، فلا تمرّ القيمةُ بدفترٍ ولا إطارٍ ولا prompt.
// ---------------------------------------------------------------------------

/// أين خزنةُ المنتج حين لا يُعلن المالكُ خزنتَه — القاعدةُ نفسُها التي يطبّقها
/// `vaultHome` في المحرّك: `%APPDATA%\abdocode\vault.ps1`.
fn shipped_vault_script_path(
    vault_home: Option<std::ffi::OsString>,
    app_data: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let home = vault_home
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(|value| PathBuf::from(value.to_string_lossy().trim()))
        .or_else(|| {
            app_data
                .filter(|value| !value.to_string_lossy().trim().is_empty())
                .map(|value| PathBuf::from(value.to_string_lossy().trim()).join("abdocode"))
        })?;
    Some(home.join("vault.ps1"))
}

fn shipped_vault_script() -> Option<PathBuf> {
    let script = shipped_vault_script_path(
        std::env::var_os("ABDO_VAULT_HOME"),
        std::env::var_os("APPDATA"),
    )?;
    script.is_file().then_some(script)
}

/// ⚠ العطلُ المقيس (2026-09-04، على النسخة المشحونة): هذا الحلُّ كان **بيئةً
/// وحدَها**، ولا أحدَ يضبط `ABDO_VAULT_SCRIPT` — لا هذا المضيفُ ولا المُثبِّت.
/// فكان `vault_set` من الواجهة يفشل دائماً برسالةٍ تطلب من المشغّل ضبطَ متغيّرٍ
/// لا يعرفه، والمنتجُ يُثبّت خزنتَه في `%APPDATA%\abdocode` طوالَ الوقت.
/// والقاعدةُ تبقى: **قرارُ المالك يعلو** — المتغيّرُ إن وُجد فهو الحَكَم، ولا
/// يُرتدّ إلى المشحونة إلّا حين يغيب. وملفٌّ غيرُ موجودٍ لا يُعلَن مساراً.
fn vault_script() -> Result<PathBuf, String> {
    if let Some(owner) = std::env::var_os("ABDO_VAULT_SCRIPT") {
        if !owner.is_empty() {
            return Ok(PathBuf::from(owner));
        }
    }
    shipped_vault_script()
        .ok_or_else(|| "لم تُضبط خزنة محلية ولا وُجدت خزنة المنتج؛ افتح التطبيق مرّة ليُثبّتها، أو اضبط ABDO_VAULT_SCRIPT".to_string())
}

/// فضاءا أسماء الخزنة اللذان يملكهما عبدو كود — ولا ثالث.
///
/// العطلُ المقيس (2026-09-03): مسارُ المزوّد المخصّص كان **مكسوراً من طرفه إلى
/// طرفه**. القشرة تكتب المقبض `custom-<الاسم>-api-key` (index.html)، ومُدقّقُ
/// الإعدادات في المحرّك **يُلزم** `^custom-` (cli.ts)، وعاملُ رست يقبله —
/// وهذا الحارسُ وحدَه كان يرفضه، فيسقط `vault_set` ولا يُسجَّل المزوّد أبداً.
/// ثلاثةٌ مقابل واحد: فالحارسُ هو الذي يُوسَّع، لا الثلاثةُ تُضيَّق. وتضييقُ
/// القشرة إلى `abdocode-` كان سيُبطل قفلَ عاملِ رست الذي يمنع صفَّاً مخصّصاً
/// من انتحال مقبضِ مزوّدٍ مُجمَّع — أي إصلاحٌ يفتح ثغرة.
const VAULT_NAMESPACES: [&str; 2] = ["abdocode-", "custom-"];

fn vault_name(key: &str) -> Result<String, String> {
    // أسماء خزنة عبدو حصراً: حرفٌ لاتينيّ/رقم/شرطة، وببادئةٍ من فضاءَينا —
    // سياجٌ ضدّ عبثٍ بمدخلات خزنةٍ أخرى عبر اسمٍ محقون. البادئةُ تبقى شرطاً:
    // توسيعُها فضاءً ثانياً نملكه ليس إلغاءَها.
    if VAULT_NAMESPACES.iter().any(|p| key.starts_with(p))
        && key.len() <= 80
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(key.to_string())
    } else {
        Err("اسم مفتاحٍ غير مسموح — يجب أن يبدأ بـabdocode- أو custom- وبأحرفٍ لاتينية".into())
    }
}

#[cfg(test)]
mod vault_name_tests {
    use super::vault_name;

    #[test]
    fn accepts_both_owned_namespaces_and_refuses_everything_else() {
        // التوأمُ الإيجابي: المقبضُ الذي تكتبه القشرة فعلاً يُقبل — وهو العطلُ بعينه.
        assert!(vault_name("custom-myvendor-api-key").is_ok());
        assert!(vault_name("abdocode-openai-api-key").is_ok());
        // والسياجُ باقٍ: فضاءٌ لا نملكه، وحقنُ مسارٍ، وطولٌ فائض، وحرفٌ غير لاتينيّ.
        assert!(vault_name("otherapp-secret").is_err());
        assert!(vault_name("custom-../../etc/passwd").is_err());
        assert!(vault_name("custom-a b").is_err());
        assert!(vault_name(&format!("custom-{}", "a".repeat(90))).is_err());
        assert!(vault_name("مفتاح-عربي").is_err());
    }
}

// The engine derives HOME/vault for its own child environment. Native UI vault
// calls need the same default, without changing explicit owner scripts or dirs.
fn native_vault_directory(lookup: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let supplied =
        |name: &str| lookup(name).filter(|value| !value.to_string_lossy().trim().is_empty());
    if supplied("ABDO_VAULT_SCRIPT").is_some() || supplied("ABDO_VAULT_DIR").is_some() {
        return None;
    }
    supplied("ABDO_VAULT_HOME")
        .map(|value| PathBuf::from(value.to_string_lossy().trim()).join("vault"))
}

#[cfg(test)]
mod native_vault_directory_tests {
    use super::native_vault_directory;
    use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

    #[test]
    fn home_only_uses_the_same_store_as_the_engine() {
        assert_eq!(
            native_vault_directory(
                |key| (key == "ABDO_VAULT_HOME").then(|| OsString::from("  qa-home  "))
            ),
            Some(PathBuf::from("qa-home").join("vault"))
        );
        assert_eq!(native_vault_directory(|_| None), None);
        assert_eq!(native_vault_directory(|_| Some(" \t ".into())), None);
    }

    #[test]
    fn explicit_owner_script_or_directory_is_never_replaced() {
        for explicit in ["ABDO_VAULT_SCRIPT", "ABDO_VAULT_DIR"] {
            let env = BTreeMap::from([
                ("ABDO_VAULT_HOME", OsString::from("qa-home")),
                (explicit, OsString::from("owner-value")),
            ]);
            assert_eq!(native_vault_directory(|key| env.get(key).cloned()), None);
        }
    }
}

fn vault_command(script: &Path, args: &[&str], has_input: bool) -> Command {
    let mut cmd = Command::new("powershell");
    if let Some(directory) = native_vault_directory(|name| std::env::var_os(name)) {
        cmd.env("ABDO_VAULT_DIR", directory);
    }
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    cmd.arg(script);
    cmd.args(args);
    cmd.stdin(if has_input {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    // An owner-provided script may echo its input in an error. Never relay it
    // to the interface, logs, or a inherited console.
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn run_vault_at(
    script: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    if !script.is_file() {
        return Err("Vault script is missing. Check ABDO_VAULT_SCRIPT; an explicit owner path is never replaced with another vault.".into());
    }
    let mut child = vault_command(script, args, input.is_some())
        .spawn()
        .map_err(|_| "Could not start the vault script.".to_string())?;
    if let Some(bytes) = input {
        // Taking and dropping the pipe delivers EOF before wait_with_output.
        // Only UTF-8 bytes enter the private pipe, with no KEY= wrapper or file.
        let write = match child.stdin.take() {
            Some(mut pipe) => pipe.write_all(bytes),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "missing private stdin",
            )),
        };
        if write.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The vault rejected its private input pipe. A custom vault must support set <handle> with the value on stdin.".into());
        }
    }
    child
        .wait_with_output()
        .map_err(|_| "Could not finish the vault request.".to_string())
}

fn run_vault(args: &[&str]) -> Result<std::process::Output, String> {
    run_vault_at(&vault_script()?, args, None)
}

fn vault_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("The API key is empty.".into());
    }
    // The worker reads a v= prefix plus this value within the same 16 KiB cap.
    if value.len() > 16_382 {
        return Err("The API key exceeds the vault reader limit.".into());
    }
    if value.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0)) {
        return Err("The API key cannot contain a newline or NUL character.".into());
    }
    if value.starts_with('\u{feff}') || value.ends_with([' ', '\t']) {
        return Err(
            "Remove the byte-order mark or trailing whitespace before saving the API key.".into(),
        );
    }
    Ok(())
}

fn vault_write(script: &Path, name: &str, value: &str) -> Result<(), String> {
    vault_value(value)?;
    let out = run_vault_at(script, &["set", name], Some(value.as_bytes()))?;
    if out.status.success() {
        Ok(())
    } else {
        // Exit status is safe to expose; script output may contain the value.
        let reason = match out.status.code() {
            Some(3) => "The vault refused the key handle.",
            Some(5) => "The vault received an empty key.",
            Some(6) => "The vault refused an oversized key.",
            Some(7) => "The vault refused an invalid key format.",
            Some(8) => "The vault could not locate its user profile.",
            Some(10) => "The vault could not save the key. Check the existing vault configuration and access permissions.",
            _ => "The vault rejected the write. Custom vault scripts must support set <handle> and read the value from stdin; file-based -From input is not supported.",
        };
        Err(reason.into())
    }
}

/// Save through the shipped stdin contract. No plaintext temporary file or
/// command-line value is created, including for explicit owner vault scripts.
#[tauri::command]
fn vault_set(key: String, value: String) -> Result<(), String> {
    let name = vault_name(&key)?;
    vault_write(&vault_script()?, &name, &value)
}

#[cfg(test)]
mod vault_stdin_tests {
    use super::{run_vault_at, vault_command, vault_value, vault_write};
    use std::path::{Path, PathBuf};

    #[test]
    fn command_contains_the_shipped_set_contract_without_a_value_or_from_file() {
        let command = vault_command(
            Path::new("C:/fixture/vault.ps1"),
            &["set", "custom-fixture"],
            true,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "C:/fixture/vault.ps1",
                "set",
                "custom-fixture"
            ]
        );
    }

    #[test]
    fn refuses_values_that_the_shipped_reader_would_change_or_reject() {
        for value in [
            "",
            "fixture\nvalue",
            "fixture\rvalue",
            "fixture\0value",
            "fixture ",
            "fixture\t",
            "\u{feff}fixture",
        ] {
            assert!(vault_value(value).is_err());
        }
        assert!(vault_value(&"x".repeat(16_383)).is_err());
        assert!(vault_value(&"x".repeat(16_382)).is_ok());
        assert!(vault_value("fixture=العربية").is_ok());
    }

    struct ScriptFixture(PathBuf);
    impl Drop for ScriptFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn fixture(source: &str) -> ScriptFixture {
        let path = std::env::temp_dir().join(format!(
            "abdocode-vault-contract-{}.ps1",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, source).expect("write harmless script fixture");
        ScriptFixture(path)
    }

    #[test]
    #[cfg(windows)]
    fn sends_exact_utf8_on_stdin_and_closes_it_without_an_extra_argument() {
        // This fixture has no vault, filesystem writes, DPAPI, or ACL operations.
        let script = fixture(
            r#"param([Parameter(Position=0)][string]$Verb,[Parameter(Position=1)][string]$Handle,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Extra)
if ($Extra.Count -gt 0) { exit 9 }
if ($Verb -ne 'set' -or $Handle -ne 'custom-fixture') { exit 2 }
$buffer = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($buffer)
ConvertTo-Json -Compress -InputObject @($buffer.ToArray())
"#,
        );
        let value = "fixture-only=العربية";
        let out = run_vault_at(
            &script.0,
            &["set", "custom-fixture"],
            Some(value.as_bytes()),
        )
        .unwrap();
        assert!(out.status.success());
        let bytes: Vec<u8> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(bytes, value.as_bytes());
        assert!(vault_write(&script.0, "custom-fixture", value).is_ok());
    }

    #[test]
    #[cfg(windows)]
    fn unsupported_owner_contract_fails_without_exposing_script_output() {
        let script = fixture("[Console]::Error.WriteLine('fixture-only-do-not-expose'); exit 9");
        let error = vault_write(&script.0, "custom-fixture", "fixture-only-value").unwrap_err();
        assert!(error.contains("stdin"));
        assert!(error.contains("-From"));
        assert!(!error.contains("fixture-only"));
    }
}

/// هل المفتاح موجود؟ — سؤالٌ بنعم/لا للواجهة، **بلا كشف القيمة**.
#[tauri::command]
fn vault_has(key: String) -> Result<bool, String> {
    let name = vault_name(&key)?;
    let out = run_vault(&["list"])?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.contains(&name)))
}

/// T06 — منتقي مجلد المشروع الأصليّ (rfd). يفتح حوار ويندوز؛ يعيد المسار
/// أو لا شيء إن ألغى المشغّل. لا وصولٌ للقرص من الويب-فيو — رست تسأل.
#[tauri::command]
fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("اختر مجلد المشروع")
        .pick_folder()
        .and_then(|p| {
            workspace::register_picked(&p)
                .ok()
                .map(|_| p.display().to_string())
        })
}

/// A Git worktree can escape the selected project by design, so its destination
/// is never accepted from the webview. Windows supplies it through this native
/// folder picker, then the workspace layer validates and creates it.
#[tauri::command]
fn workspace_create_worktree(
    app: tauri::AppHandle,
    root: String,
    branch: String,
) -> Result<Option<workspace::WorktreeCreated>, String> {
    let Some(destination) = rfd::FileDialog::new()
        .set_title("Choose an empty folder for the new worktree")
        .pick_folder()
    else {
        return Ok(None);
    };
    workspace::create_picked_worktree(&app, &root, &destination, &branch).map(Some)
}

#[tauri::command]
fn app_window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    let runtime = app.state::<desktop_preferences::DesktopRuntime>();
    desktop_preferences::begin_quit(&runtime);
    app.exit(0);
}

/// D22 — لوحة التصفّح: **متصفّحٌ منفصلٌ بملفٍّ خاصّ**، تشغّله رست.
///
/// جُرّبت أوّلاً نافذةُ Tauri ثانية (`WebviewWindowBuilder` بـ`External`)
/// فعلّقت العملية: النافذة تُنشأ `about:blank` ثمّ يحجب الاستدعاء. فالنهج
/// المعتمد هو **ما أثبتَه T16 حيّاً**: عمليةُ متصفّحٍ مستقلّة بمنفذ CDP
/// وملفِّ تعريفٍ معزول — سياقان منفصلان فعلاً (محتوى الغريب لا يجاور
/// واجهتنا)، ومقبضُ قيادةٍ واحدٌ يحكمه عقد السطح (T15).
struct BrowserPane(Mutex<Option<Child>>);

const PANE_PORT: u16 = 9366;

fn stop_browser_process(pane: &BrowserPane) {
    let mut slot = match pane.0.lock() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    };
    browser_surface::clear_lease();
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    pane: State<BrowserPane>,
    url: String,
) -> Result<String, String> {
    if !workspace_controls::computer_use_enabled()? {
        return Err("Enable browser computer use before opening the controlled browser".into());
    }
    workspace::browser_url_allowed(&app, &url)?;
    let mut slot = pane.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = slot.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            browser_surface::publish_owned_endpoint(child.id(), PANE_PORT)?;
            return Ok(format!("اللوحة تعمل — وجّهها بالأدوات: surface {PANE_PORT}"));
        }
    }
    *slot = None;
    browser_surface::clear_lease();
    if std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], PANE_PORT)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
    {
        return Err(
            "The browser control port belongs to another process. It was not connected or closed."
                .into(),
        );
    }
    let profile = std::env::temp_dir().join(if workspace::browser_profile_shared(&app) {
        "abdocode-pane-profile".into()
    } else {
        format!("abdocode-pane-session-{}", std::process::id())
    });
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    let exe = candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "لم أجد متصفّح Edge على هذا الجهاز".to_string())?;
    // Start blank; the engine protects navigation before the UI submits go.
    let child = browser_surface::launch(exe, &profile, PANE_PORT)?;
    *slot = Some(child);
    Ok(format!("فُتحت اللوحة — لقيادتها: surface {PANE_PORT}"))
}

#[tauri::command]
fn browser_close(pane: State<BrowserPane>) -> Result<(), String> {
    stop_browser_process(&pane);
    Ok(())
}

// ---------------------------------------------------------------------------
// لوحة التصفّح داخل النافذة (على نمط كوديكس) — webviews أطفالٌ تملكها رست.
//
// مقيسٌ 2026-08-28: `add_child` يعمل ولا يعلّق (المسبار: النافذة حيّة
// مستجيبة بعده) — بخلاف نافذة D22 الثانية (WebviewWindowBuilder+External)
// التي علّقت العملية؛ فالدرسان مختلفا الـAPI ولا يُخلَط بينهما.
// كلّ تبويبٍ webview باسمه (`pane-N`)؛ التبديل = حدود حقيقية للنشِط وركنٌ
// خارج الشاشة للبقية. الواجهة ترسم الشريط والقيادة هنا بعقود http/https فقط.
// ---------------------------------------------------------------------------

fn pane_url_ok(url: &str) -> Result<tauri::Url, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("لا يُفتح إلا http/https".into());
    }
    url.parse().map_err(|_| "رابط غير مفهوم".into())
}

fn pane_of(app: &tauri::AppHandle, label: &str) -> Result<tauri::Webview, String> {
    if !label.starts_with("pane-") {
        return Err("تسمية لوحةٍ غير مسموحة".into());
    }
    app.get_webview(label)
        .ok_or_else(|| format!("لا لوحة باسم {label}"))
}

// ⚠️ الأمر المتزامن يجري على الخيط الرئيسيّ داخل ردّ IPC الخاصّ بالويب-فيو،
// و`add_child` هناك يبني متحكّم WebView2 جديداً **وينتظر اكتماله** — اكتمالٌ لا
// يصل ما دام الردّ على المكدس. قفلٌ ميت قيس حيّاً 2026-08-28: اللوحة تُخلق
// وتبقى about:blank، ووعدُ invoke لا يُحسم (فلا نجاح ولا رفض ولا إشعار) وكلّ
// نداءٍ بعده يموت — فبدا العيبُ هندسةً وهو قفل. `(async)` يُخرج الأمر عن الخيط
// الرئيسيّ فيعود الردّ ويُبنى الطفل فعلاً. بقيّة أوامر pane_* تبقى متزامنة:
// الإنشاء وحده هو الذي ينتظر اكتمال WebView2.
// ---------------------------------------------------------------------------
// نافذةُ لوحٍ مستقلّة — القياسُ قبل الوعد
//
// المواصفة تطلب في ترويسة كلّ لوحٍ زرَّ «افتح في نافذةٍ مستقلّة»، وتَسِمُه
// بأنه **يحتاج قياساً**: «إن تعذّر يُقال ولا يُشحن زرٌّ لا يعمل».
//
// المقيسُ قراءةً: السياسةُ الأمنيّة تُطبَّق لكلّ **أصل** لا لكلّ نافذة،
// فنافذةٌ تحمّل أصلاً من `frontendDist` ترث `default-src 'self'` بلا إعداد.
// وأنبوبُ المحرّك حالةٌ على مستوى التطبيق تُبثّ إلى كلّ ويب-فيو، فالجسرُ قائم.
//
// والباقي غيرُ المقيس كان واحداً: هل يعلّق `WebviewWindowBuilder::build()`
// العمليةَ كما علّقتها محاولةُ D22؟ تلك كانت **متزامنةً** ومع `External`،
// والدرسُ المدفوع في `pane_open` أنّ `(async)` يُخرج الأمرَ عن الخيط الرئيسيّ.
// فبُني `(async)` ومع `App` لا `External`، **وقِيس بمسبارٍ شُغِّل ثمّ نُزع**
// (2026-09-04): `build()` عاد في **72 مللي ثانية**، ونداءٌ تالٍ على النافذة
// الرئيسية عاد أيضاً (`main_responsive`)، ونافذةُ اللوح نفسُها شغّلت شيفرتها.
// فالقفلُ خاصٌّ بالمسار المتزامن وحده — والزرُّ يُشحن الآن بعد القياس لا قبله.
// ---------------------------------------------------------------------------

#[tauri::command(async)]
fn open_panel_window(app: tauri::AppHandle, label: String, title: String) -> Result<(), String> {
    // فضاءُ أسماءٍ مغلق: لصيقةٌ خارجَه تقع خارج كلّ صلاحيةٍ مُعلَنة فتُفتح
    // نافذةٌ ميّتة لا تسمع المحرّك — وذلك أسوأ من رفضٍ مسمّى.
    if !label.starts_with("panel-") {
        return Err("لصيقةُ نافذةٍ غير مسموحة — يجب أن تبدأ بـpanel-".into());
    }
    if app.get_webview_window(&label).is_some() {
        return Err("النافذة مفتوحةٌ بالفعل".into());
    }
    // اللوحُ يُعرَّف في العنوان: النافذةُ تحمّل الصفحةَ نفسَها فتقرأ من
    // `location.search` أنّها نافذةُ لوحٍ لا النافذةَ الرئيسية — فلا تُشغّل
    // المحرّكَ ثانيةً (وهو يرفض التشغيل المكرّر برسالةٍ يراها المستخدم).
    let entry = format!("index.html?panel={}", label.trim_start_matches("panel-"));
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(entry.into()))
        .title(title)
        .inner_size(720.0, 540.0)
        .build()
        .map_err(|e| format!("تعذّر فتح النافذة: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn pane_open(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    workspace::browser_url_allowed(&app, &url)?;
    let parsed = pane_url_ok(&url)?;
    if !label.starts_with("pane-") {
        return Err("تسمية لوحةٍ غير مسموحة".into());
    }
    if app.get_webview(&label).is_some() {
        return Err("اللوحة موجودة — استعمل pane_nav".into());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "لا نافذة رئيسية".to_string())?;
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
                .on_navigation(move |url| {
                    workspace::browser_navigation_allowed(&navigation_app, url.as_str())
                })
                .on_new_window(move |url, _| {
                    // Keep popup navigation in the guarded pane. An unmanaged new
                    // window would lose the site checks on its next navigation.
                    if workspace::browser_url_allowed(&popup_app, url.as_str()).is_ok() {
                        let target_app = popup_app.clone();
                        let target_label = popup_label.clone();
                        let _ = popup_app.run_on_main_thread(move || {
                            if let Some(pane) = target_app.get_webview(&target_label) {
                                let _ = pane.navigate(url);
                            }
                        });
                    }
                    tauri::webview::NewWindowResponse::Deny
                }),
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(w, h),
        )
        .map_err(|e| format!("تعذّر فتح اللوحة: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pane_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let pane = pane_of(&app, &label)?;
    pane.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    pane.set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())
}

/// ركنُ تبويبٍ غير نشط: خارج مساحة العرض — يبقى حيّاً بحالته دون أن يُرى.
#[tauri::command]
fn pane_park(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let pane = pane_of(&app, &label)?;
    pane.set_position(tauri::LogicalPosition::new(-20000.0, 0.0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_nav(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    workspace::browser_url_allowed(&app, &url)?;
    let parsed = pane_url_ok(&url)?;
    let pane = pane_of(&app, &label)?;
    pane.navigate(parsed)
        .map_err(|e| format!("تعذّر التنقّل: {e}"))
}

#[tauri::command]
fn pane_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    pane_of(&app, &label)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    pane_of(&app, &label)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    pane_of(&app, &label)?
        .eval("location.reload()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    pane_of(&app, &label)?.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    pane_of(&app, &label)?
        .url()
        .map(|u| u.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_zoom(app: tauri::AppHandle, label: String, factor: f64) -> Result<(), String> {
    if !(0.25..=5.0).contains(&factor) {
        return Err("عامل تكبيرٍ خارج الحدود".into());
    }
    pane_of(&app, &label)?
        .set_zoom(factor)
        .map_err(|e| e.to_string())
}

/// بحثٌ في الصفحة — عمليّتان مثبّتتان فقط (بحث/طباعة)، لا eval عامّاً.
#[tauri::command]
fn pane_find(app: tauri::AppHandle, label: String, query: String) -> Result<(), String> {
    let quoted = serde_json::to_string(&query).map_err(|e| e.to_string())?;
    pane_of(&app, &label)?
        .eval(&format!("window.find({quoted})"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pane_print(app: tauri::AppHandle, label: String) -> Result<(), String> {
    pane_of(&app, &label)?
        .eval("window.print()")
        .map_err(|e| e.to_string())
}

/// فتح الرابط في متصفّح الجهاز الافتراضيّ — خارج التطبيق بيد المشغّل.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    pane_url_ok(&url)?;
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", &url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("تعذّر الفتح الخارجيّ: {e}"))
}

#[tauri::command]
fn engine_send(engine: State<Engine>, line: String) -> Result<(), String> {
    let mut slot = engine.0.lock().map_err(|e| e.to_string())?;
    let child = slot.as_mut().ok_or_else(|| "المحرّك غير مُشغَّل".to_string())?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "لا مدخل للمحرّك".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("الإطار المرسل ليس JSON صالحاً: {e}"))?;
    write_json_frame(stdin, &value).map_err(|e| format!("تعذّر الإرسال: {e}"))
}

fn stop_engine(app: &tauri::AppHandle) {
    if let Some(engine) = app.try_state::<Engine>() {
        let mut slot = match engine.0.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn is_owned_panel_window(label: &str) -> bool {
    label.starts_with("panel-")
}

fn close_owned_panel_windows(app: &tauri::AppHandle) {
    // Collect first: destroying a window emits lifecycle events and can mutate
    // the manager's window map.
    let panels: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| is_owned_panel_window(&label).then_some(window))
        .collect();
    for panel in panels {
        let _ = panel.destroy();
    }
}

fn shutdown_native_session(app: &tauri::AppHandle) {
    if let Some(terminals) = app.try_state::<terminal_pty::Terminals>() {
        terminal_pty::shutdown(&terminals, None);
    }
    if let Some(runtime) = app.try_state::<desktop_preferences::DesktopRuntime>() {
        desktop_preferences::shutdown(app, &runtime);
    }
    if let Some(browser) = app.try_state::<BrowserPane>() {
        stop_browser_process(&browser);
    }
    close_owned_panel_windows(app);
    stop_engine(app);
}

fn main() {
    if automation::worker_entry() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        desktop_preferences::quick_entry_trigger(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            identity,
            automation::automation_status,
            automation::automation_enqueue,
            automation::automation_schedule_save,
            automation::automation_schedule_remove,
            automation::automation_cancel,
            automation::automation_retry,
            automation::automation_background_set,
            automation::automation_clear_history,
            automation::automation_migrate_legacy,
            attachments::attachments_pick,
            attachments::attachments_import,
            local_settings::local_profile_get,
            local_settings::local_profile_set,
            local_settings::local_diagnostics,
            local_settings::local_export_text,
            local_settings::local_export_diagnostics,
            local_settings::desktop_signal,
            workspace_controls::workspace_controls_get,
            workspace_controls::workspace_profile_set,
            workspace_controls::workspace_folder_revoke,
            workspace_controls::workspace_browser_status,
            workspace_controls::workspace_browser_open,
            extensions::extensions_choose,
            extensions::extensions_preview,
            extensions::extensions_download,
            extensions::extensions_list,
            extensions::extensions_install,
            extensions::extensions_set_enabled,
            extensions::extensions_remove,
            release_check::release_check,
            marketplace::marketplace_index,
            notify::desktop_notify,
            terminal_pty::terminal_open,
            terminal_pty::terminal_write,
            terminal_pty::terminal_resize,
            terminal_pty::terminal_close,
            engine_start,
            engine_send,
            open_panel_window,
            vault_set,
            provider_setup::provider_import_local,
            provider_setup::provider_local_status,
            provider_setup::provider_local_start,
            vault_has,
            settings::settings_get,
            settings::settings_set,
            settings::settings_reset,
            desktop_preferences::desktop_preferences_get,
            desktop_preferences::desktop_preferences_set,
            workspace::workspace_store_get,
            workspace::workspace_store_set,
            workspace::workspace_tree,
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_git_diff,
            workspace::workspace_git_overview,
            workspace::workspace_git_action,
            workspace::workspace_git_provider_status,
            workspace::workspace_git_pull_requests,
            workspace::workspace_git_create_pull_request,
            workspace_create_worktree,
            pick_directory,
            app_window_close,
            app_quit,
            browser_open,
            browser_close,
            pane_open,
            pane_bounds,
            pane_park,
            pane_nav,
            pane_back,
            pane_forward,
            pane_reload,
            pane_close,
            pane_url,
            pane_zoom,
            pane_find,
            pane_print,
            open_external
        ])
        .manage(desktop_preferences::DesktopRuntime::default())
        .setup(|app| {
            // كلُّ الهويّات: المحرّكُ يرث ملفَّ سطح المكتب نفسَه الذي يكتب فيه العقدُ والسياسة.
            if let Ok(resolved) = profile::directory(app.handle()) {
                if let Some(dir) = desktop_profile_env(std::env::var_os("ABDO_DESKTOP_PROFILE"), &resolved) {
                    std::env::set_var("ABDO_DESKTOP_PROFILE", dir);
                }
            }
            if app.config().identifier.ends_with(".preview") {
                let profile = profile::directory(app.handle()).map_err(std::io::Error::other)?;
                for (name, value) in
                    preview_env_defaults(&app.config().identifier, &profile, |name| {
                        std::env::var_os(name)
                    })
                {
                    std::env::set_var(name, value);
                }
            }
            // File/Help actions live in the reference shell's custom top bar.
            // Keep the ordinary Windows decoration and close lifecycle intact.
            let runtime = app.state::<desktop_preferences::DesktopRuntime>();
            desktop_preferences::initialize(app.handle(), &runtime);
            Ok(())
        })
        .manage(terminal_pty::Terminals::default())
        .manage(Engine(Mutex::new(None)))
        .manage(BrowserPane(Mutex::new(None)))
        .on_menu_event(|app, event| match event.id().as_ref() {
            desktop_preferences::TRAY_OPEN_ID => desktop_preferences::tray_open(app),
            desktop_preferences::TRAY_QUIT_ID => {
                let runtime = app.state::<desktop_preferences::DesktopRuntime>();
                desktop_preferences::begin_quit(&runtime);
                shutdown_native_session(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(terminals) = window.app_handle().try_state::<terminal_pty::Terminals>()
                {
                    terminal_pty::shutdown(&terminals, Some(window.label()));
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let runtime = app.state::<desktop_preferences::DesktopRuntime>();
                    if desktop_preferences::should_hide_on_close(
                        desktop_preferences::system_tray_active(app),
                        desktop_preferences::is_quitting(&runtime),
                    ) {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    if desktop_preferences::should_shutdown_on_close(
                        desktop_preferences::system_tray_active(app),
                        desktop_preferences::is_quitting(&runtime),
                    ) {
                        // The main window owns the session. With no active tray
                        // lifecycle, detached panels and child processes must
                        // not keep the app or its awake request alive.
                        shutdown_native_session(app);
                    }
                }
            }
            // إغلاق النافذة **الرئيسية** يُغلق المحرّك — لا أيتام (درس
            // windows-dev-server-orphans). واشتراطُ اللصيقة ليس تجميلاً: بلا
            // فحصٍ للاسم يقتل **أيُّ** نافذةٍ تُغلق المحرّكَ للجميع، فلوحٌ
            // يُفتح في نافذةٍ مستقلّة (وهو ما تطلبه مواصفة القشرة) كان إغلاقُه
            // سيُسقط الجلسة كلَّها. عطلٌ كامنٌ اليوم لأن النافذة واحدة، ويصير
            // فوريّاً مع أوّل نافذةٍ ثانية — فيُغلق قبل أن يُفتح ذلك الباب.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                // Covers forced destruction paths that bypass CloseRequested.
                // All cleanup operations are deliberately idempotent.
                shutdown_native_session(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("نافذة عبدو كود لم تُفتح");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            shutdown_native_session(app);
        }
    });
}
