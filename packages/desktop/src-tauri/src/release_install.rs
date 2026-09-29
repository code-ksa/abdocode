//! تثبيتُ إصدارٍ أحدث بنقرةٍ من داخل التطبيق (أمرُ المالك 2026-09-28: «يضغط العميل على زرّ تحديث فيُحدَّث
//! التطبيقُ بنقرةٍ بلا زيارة GitHub ولا تنزيلٍ يدويّ»). الفعلُ كلُّه بيد المستخدم: يبدأ بضغطته بعد تأكيد،
//! ولا شيءَ يجري من تلقاء نفسه. المصدرُ ثابتٌ مُجمَّع (مستودعُ التوزيع وحده)، والمثبِّتُ يُتحقَّق من بصمته
//! SHA-256 مقابل `SHA256SUMS.txt` من الإصدار نفسِه قبل أن يُشغَّل، ولا تراجعَ إلى إصدارٍ أقدم.
//!
//! المسار: تنزيلٌ متدفّق إلى مجلّدٍ مؤقّت (بسقفٍ) ⇦ مطابقةُ البصمة ⇦ إيقافُ المحرّك ⇦ تشغيلُ المثبِّت
//! بوضع التقدّم (`/P`) مع إعادة فتح التطبيق (`/R`) بعد ثوانٍ ⇦ خروجُ التطبيق. المحرّكُ يُوقَف **قبل** المثبِّت
//! كي لا يبقى `payload/abdocode.exe` مقفولاً بيتيمٍ فيُبقي المثبِّتُ القديمَ صامتاً (مقيس 2026-09-14).
use crate::release_check::newer_than;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

/// مستودعُ التوزيع وحده — لا عنوانَ يأتي من وثيقة الإصدار ولا من القشرة.
const RELEASE_BASE: &str = "https://github.com/code-ksa/abdocode/releases/download/";
/// مضيفاتُ إعادة التوجيه المقبولة لأصول GitHub (الأصلُ يُحوَّل إلى مخزن الكائنات).
const REDIRECT_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 64 * 1024;
pub(crate) const EVENT: &str = "release-install";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub message: String,
}

fn version_ok(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && version.matches('.').count() == 2
}

pub(crate) fn installer_name(version: &str) -> String {
    format!("AbdoCode-{version}-x64-setup.exe")
}

pub(crate) fn asset_url(version: &str, name: &str) -> String {
    format!("{RELEASE_BASE}v{version}/{name}")
}

/// بصمةُ ملفٍّ بعينه من `SHA256SUMS.txt` (صيغة `sha256sum`: البصمة، فراغان، وقد تسبق الاسمَ `*`).
pub(crate) fn expected_digest(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let digest = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| digest.to_ascii_lowercase())
    })
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt
                .url()
                .host_str()
                .map(|host| REDIRECT_HOSTS.iter().any(|ok| host == *ok))
                .unwrap_or(false);
            if attempt.previous().len() >= 5 || !allowed || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "تعذّر تجهيز عميل الشبكة.".to_string())
}

fn fetch_text(client: &reqwest::blocking::Client, url: &str, cap: u64) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|_| "تعذّر الوصول إلى GitHub — افحص الاتصال.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub ردّ {} على {url}.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "انقطع التنزيل.".to_string())?;
    if bytes.len() as u64 > cap {
        return Err("الملفُّ أكبرُ من المتوقَّع.".into());
    }
    String::from_utf8(bytes).map_err(|_| "الملفُّ ليس نصّاً.".into())
}

fn emit(app: &AppHandle, phase: &str, received: u64, total: u64, message: &str) {
    let _ = app.emit(
        EVENT,
        Progress {
            phase: phase.into(),
            received,
            total,
            message: message.into(),
        },
    );
}

fn download_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("abdocode-release");
    fs::create_dir_all(&dir).map_err(|e| format!("تعذّر تجهيز مجلّد التنزيل: {e}"))?;
    Ok(dir)
}

fn download_installer(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    let client = client()?;
    let name = installer_name(version);
    emit(app, "sums", 0, 0, "قراءةُ بصمات الإصدار…");
    let sums = fetch_text(
        &client,
        &asset_url(version, "SHA256SUMS.txt"),
        MAX_SUMS_BYTES,
    )?;
    let expected = expected_digest(&sums, &name)
        .ok_or_else(|| format!("لا بصمةَ لـ{name} في SHA256SUMS.txt — لن يُشغَّل مثبِّتٌ بلا بصمة."))?;
    let target = download_dir()?.join(&name);
    let part = download_dir()?.join(format!("{name}.part"));
    let response = client
        .get(asset_url(version, &name))
        .send()
        .map_err(|_| "تعذّر الوصول إلى GitHub — افحص الاتصال.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub ردّ {} على المثبِّت.",
            response.status().as_u16()
        ));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_INSTALLER_BYTES {
        return Err("المثبِّتُ أكبرُ من السقف المقبول.".into());
    }
    let mut file = File::create(&part).map_err(|e| format!("تعذّر إنشاء ملفّ التنزيل: {e}"))?;
    let mut hasher = Sha256::new();
    let mut reader = response.take(MAX_INSTALLER_BYTES + 1);
    let mut buffer = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    emit(app, "download", 0, total, "تنزيلُ المثبِّت…");
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "انقطع تنزيلُ المثبِّت.".to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("تعذّرت كتابةُ المثبِّت: {e}"))?;
        hasher.update(&buffer[..read]);
        received += read as u64;
        if received > MAX_INSTALLER_BYTES {
            return Err("المثبِّتُ أكبرُ من السقف المقبول.".into());
        }
        if received - last_emit >= 512 * 1024 || received == total {
            last_emit = received;
            emit(app, "download", received, total, "تنزيلُ المثبِّت…");
        }
    }
    file.flush()
        .map_err(|e| format!("تعذّر إغلاق ملفّ التنزيل: {e}"))?;
    drop(file);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(&part);
        return Err("بصمةُ المثبِّت لا تطابق SHA256SUMS.txt — أُلغي التحديث ولم يُشغَّل شيء.".into());
    }
    let _ = fs::remove_file(&target);
    fs::rename(&part, &target).map_err(|e| format!("تعذّر إتمام ملفّ التنزيل: {e}"))?;
    emit(app, "verified", received, total, "البصمةُ مطابقة.");
    Ok(target)
}

/// يشغّل المثبِّتَ منفصلاً عن التطبيق بوضع التقدّم وإعادةِ الفتح (`/P /R` من قالب NSIS) — **بعد مهلةٍ** تكفي لخروج التطبيق.
///
/// مقيس 2026-09-28/29 ثلاثَ مرّات على التطبيق الحقيقيّ: (١) وسيطُ PowerShell كان يموت مع خروج التطبيق فلا يُثبَّت شيء؛
/// (٢) إطلاقُ المثبِّت مباشرةً بلا مهلة ثبّت الحمولةَ لكنّ `abdocode-desktop.exe` بقي قديماً — التطبيقُ ما زال يقبضه لحظتَها؛
/// (٣) تمريرُ السطر `ping … & start "" "…" /P /R` وسيطاً لـ`cmd /c` **كسره اقتباسُ Rust**: الاقتباساتُ الداخليّة صارت `\"`
/// فبقي `cmd.exe` معلّقاً ثلاثَ دقائق ولم يُطلَق المثبِّتُ قطّ (4.0.77 ⇦ 4.0.78 على تطبيق المالك). الآن يُكتب السطرُ في
/// ملفّ `.cmd` بجانب المثبِّت ويُمرَّر مسارُه وحدَه — لا اقتباسَ يُعاد تفسيرُه. `cmd.exe` منفصلٌ (منفكٌّ عن أيّ Job، بلا نافذة)
/// ينتظر ~4 ثوانٍ (`ping -n 5`) ثمّ يطلق المثبِّت؛ وإن بقي التطبيقُ حيّاً رغمها يُغلقه مديرُ إعادة التشغيل بلا حوار.
fn launch_installer(path: &PathBuf) -> Result<(), String> {
    let installer = path.to_string_lossy().to_string();
    if installer.contains('"') || installer.contains('%') || installer.contains('!') {
        return Err("مسارُ المثبِّت يحمل محارفَ لا تمرّ عبر cmd.".into());
    }
    let script_path = path.with_extension("relaunch.cmd");
    let script =
        format!("@echo off\r\nping -n 5 127.0.0.1 >nul\r\nstart \"\" \"{installer}\" /P /R\r\n");
    fs::write(&script_path, script).map_err(|e| format!("تعذّرت كتابةُ سكربت التشغيل: {e}"))?;
    let spawn = |flags: u32| {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/d")
            .arg("/c")
            .arg(&script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(flags);
        }
        cmd.spawn()
    };
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB، ثمّ بلا الانفكاك إن رُفض.
    spawn(0x0000_0008 | 0x0000_0200 | 0x0800_0000 | 0x0100_0000)
        .or_else(|_| spawn(0x0000_0008 | 0x0000_0200 | 0x0800_0000))
        .map(|_| ())
        .map_err(|e| format!("تعذّر تشغيل المثبِّت: {e}"))
}

/// «تحديث الآن» — بضغطة المستخدم بعد تأكيده. يعود فوراً، والتقدّمُ بأحداث `release-install`؛
/// عند النجاح يخرج التطبيقُ بنفسه ويعيده المثبِّت.
#[tauri::command]
pub(crate) fn release_install(app: AppHandle, version: String) -> Result<(), String> {
    let version = version.trim().trim_start_matches('v').to_string();
    if !version_ok(&version) {
        return Err("رقمُ الإصدار غيرُ مفهوم.".into());
    }
    if !newer_than(&version, env!("CARGO_PKG_VERSION")) {
        return Err("لا تراجعَ إلى إصدارٍ أقدم أو مساوٍ من هنا.".into());
    }
    std::thread::spawn(move || {
        let outcome = download_installer(&app, &version).and_then(|path| {
            emit(&app, "install", 0, 0, "إيقافُ المحرّك وتشغيلُ المثبِّت…");
            crate::stop_engine(&app);
            launch_installer(&path)
        });
        match outcome {
            Ok(()) => {
                emit(
                    &app,
                    "done",
                    0,
                    0,
                    "يُغلق التطبيقُ الآن ويُعاد فتحُه بعد التثبيت.",
                );
                std::thread::sleep(Duration::from_millis(800));
                let runtime = app.state::<crate::desktop_preferences::DesktopRuntime>();
                crate::desktop_preferences::begin_quit(&runtime);
                app.exit(0);
            }
            Err(message) => emit(&app, "error", 0, 0, &message),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_names_are_derived_from_the_version_alone() {
        assert_eq!(installer_name("4.0.71"), "AbdoCode-4.0.71-x64-setup.exe");
        assert_eq!(
            asset_url("4.0.71", "SHA256SUMS.txt"),
            "https://github.com/code-ksa/abdocode/releases/download/v4.0.71/SHA256SUMS.txt"
        );
        assert!(version_ok("4.0.71"));
        assert!(!version_ok("4.0"));
        assert!(!version_ok("4.0.71-rc"));
        assert!(!version_ok("../x"));
    }

    #[test]
    fn digest_is_read_for_the_named_file_only() {
        let sums = "ee99751de719427282bd96e765521b447545ac3710f94417b1798b34b51ff999 *AbdoCode-4.0.71-x64-setup.exe\n\
                    0000000000000000000000000000000000000000000000000000000000000000  other.exe\n";
        assert_eq!(
            expected_digest(sums, "AbdoCode-4.0.71-x64-setup.exe").as_deref(),
            Some("ee99751de719427282bd96e765521b447545ac3710f94417b1798b34b51ff999")
        );
        assert!(expected_digest(sums, "AbdoCode-4.0.70-x64-setup.exe").is_none());
        assert!(expected_digest(
            "zz *AbdoCode-4.0.71-x64-setup.exe",
            "AbdoCode-4.0.71-x64-setup.exe"
        )
        .is_none());
    }

    #[test]
    fn only_newer_versions_are_installable() {
        assert!(newer_than("9.9.9", env!("CARGO_PKG_VERSION")));
        assert!(!newer_than(
            env!("CARGO_PKG_VERSION"),
            env!("CARGO_PKG_VERSION")
        ));
    }
}
