//! Windows PowerShell 5.1 بمعرّف تطبيقه المسجَّل (الحيلةُ المقيسة لإظهار toast بلا تسجيل AppUserModelId خاصّ).
//! النصُّ يُهرَّب XML؛ لا يصل شبكةً ولا نموذجاً. الفشلُ صامتٌ للمستخدم ويعود خطأً للقشرة التي تتجاهله.
use std::process::{Command, Stdio};

/// تهريبٌ مزدوج: XML (للـtoast) ثمّ الاقتباسُ المفرد لسلسلة PowerShell — `'` تصبح `&apos;` فلا تبقى علامةُ اقتباسٍ خامّة أبداً؛
/// وأيُّ حرفٍ خارج الأحرف/الأرقام/الفراغ/الترقيم الشائع يُسقَط (النصُّ بيانٌ لا كود).
fn xml_escape(text: &str) -> String {
    text.chars().take(240).filter(|c| c.is_alphanumeric() || " .,:!?()-—–_/\\%#@+…«»".contains(*c) || matches!(c, '&' | '<' | '>' | '"' | '\'')).map(|c| match c {
        '&' => "&amp;".to_string(), '<' => "&lt;".to_string(), '>' => "&gt;".to_string(),
        '"' => "&quot;".to_string(), '\'' => "&apos;".to_string(), _ => c.to_string(),
    }).collect()
}

#[tauri::command]
pub(crate) fn desktop_notify(title: String, body: String) -> Result<(), String> {
    let title = xml_escape(&title);
    let body = xml_escape(&body);
    let script = format!(
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \
         [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; \
         $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
         $xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>{title}</text><text>{body}</text></binding></visual></toast>'); \
         $toast = New-Object Windows.UI.Notifications.ToastNotification $xml; \
         [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)"
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let mut cmd = Command::new(format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::xml_escape;
    #[test]
    fn escapes_markup_and_caps_length() {
        assert_eq!(xml_escape("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
        assert_eq!(xml_escape(&"x".repeat(500)).len(), 240);
        // لا علامةَ اقتباسٍ مفردةً خامّة ولا `$`/`;`/backtick تصل سلسلةَ PowerShell — النصُّ بيانٌ لا كود.
        let hostile = xml_escape("x'; Remove-Item C:\\ -Recurse; $env:X `n");
        let stripped = hostile.replace("&apos;", "").replace("&quot;", "").replace("&amp;", "").replace("&lt;", "").replace("&gt;", "");
        assert!(!stripped.contains('\'') && !stripped.contains('$') && !stripped.contains(';') && !stripped.contains('`'), "{hostile}");
        assert_eq!(xml_escape("انتهى الدور — افتح عبدو كود."), "انتهى الدور — افتح عبدو كود.");
    }
}
