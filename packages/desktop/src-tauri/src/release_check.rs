//! إصدارٌ أحدث. قراءةٌ فقط: يقرأ وثيقةَ الإصدار المنشورة في مستودع التوزيع العامّ ويقارنها بإصدار
//! هذا التنفيذيّ، ويعرض صفحةَ التنزيل بيد المستخدم. لا تنزيلَ ولا تثبيتَ ولا تشغيلَ آليّ — القرارُ
//! والفعلُ للمستخدم (بوابةُ الاستقلال ترفض أيَّ «auto-update» وهذه ليست منه).
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};

/// وثيقةُ الإصدار المنشورة — على الفرع الرئيسيّ لمستودع التوزيع، لأنّها بطبيعتها متحرّكة (آخرُ إصدار).
pub(crate) const FEED_URL: &str = "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/abdocode-desktop.json";
/// صفحاتُ التنزيل المقبولة: مستودعاتُ حساب التوزيع وحدها — وثيقةٌ تشير إلى غيرها تُرفض بصمت (تُعرض الصفحةُ الافتراضيّة).
const PAGE_PREFIX: &str = "https://github.com/code-ksa/";
const DEFAULT_PAGE: &str = "https://github.com/code-ksa/abdocode-addons/releases";
const LIMIT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    schema_version: u8,
    version: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    page: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub published_at: String,
    pub notes: String,
    pub page: String,
}

/// مقارنةُ إصدارين رقميّاً (أرقامٌ مفصولة بنقاط؛ ما بعد `-` يُتجاهل) — «4.0.10» أحدثُ من «4.0.9» لا أقدم كما في المقارنة النصّيّة.
pub(crate) fn newer_than(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim().trim_start_matches('v').split('-').next().unwrap_or("").split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0)).collect()
    };
    let (a, b) = (parse(latest), parse(current));
    let width = a.len().max(b.len());
    for i in 0..width {
        let (x, y) = (*a.get(i).unwrap_or(&0), *b.get(i).unwrap_or(&0));
        if x != y { return x > y; }
    }
    false
}

pub(crate) fn interpret(bytes: &[u8], current: &str) -> Result<ReleaseInfo, String> {
    if bytes.len() > LIMIT { return Err("وثيقةُ الإصدار أكبرُ من المتوقَّع.".into()); }
    let feed: Feed = serde_json::from_slice(bytes).map_err(|_| "وثيقةُ الإصدار غيرُ مفهومة.")?;
    if feed.schema_version != 1 || feed.version.is_empty() || feed.version.len() > 32 { return Err("وثيقةُ الإصدار بصيغةٍ غير مدعومة.".into()); }
    let page = if feed.page.starts_with(PAGE_PREFIX) && feed.page.len() < 200 { feed.page } else { DEFAULT_PAGE.to_string() };
    Ok(ReleaseInfo {
        newer: newer_than(&feed.version, current),
        current: current.to_string(),
        latest: feed.version,
        published_at: feed.published_at.chars().take(32).collect(),
        notes: feed.notes.chars().take(600).collect(),
        page,
    })
}

fn fetch(current: &str) -> Result<ReleaseInfo, String> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "تعذّر تجهيز عميل الشبكة.")?;
    let response = client.get(FEED_URL).header("Cache-Control", "no-cache").send().map_err(|_| "تعذّر الوصول إلى GitHub — افحص الاتصال.")?;
    if !response.status().is_success() { return Err(format!("GitHub ردّ {} — لا وثيقةَ إصدارٍ منشورة بعد.", response.status().as_u16())); }
    let mut bytes = Vec::new();
    response.take((LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|_| "انقطع تنزيلُ وثيقة الإصدار.")?;
    interpret(&bytes, current)
}

/// Help ▸ التحقّق من التحديثات (وفحصٌ صامت عند البدء تُدير القشرةُ إيقاعَه): يعيد الإصدارَ الحاليَّ والأحدثَ وهل هناك أجدد.
#[tauri::command]
pub(crate) fn release_check() -> Result<ReleaseInfo, String> {
    fetch(env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn numeric_not_lexical() {
        assert!(newer_than("4.0.10", "4.0.9"));
        assert!(newer_than("4.1.0", "4.0.99"));
        assert!(newer_than("v5.0.0-beta.1", "4.0.0"));
        assert!(!newer_than("4.0.0", "4.0.0"));
        assert!(!newer_than("3.9.9", "4.0.0"));
        assert!(!newer_than("garbage", "4.0.0"));
    }
    #[test] fn feed_is_read_and_foreign_pages_fall_back() {
        let good = br#"{"schemaVersion":1,"version":"4.0.1","publishedAt":"2026-09-20","notes":"fixes","page":"https://github.com/code-ksa/abdocode-addons/releases/tag/v4.0.1"}"#;
        let info = interpret(good, "4.0.0").unwrap();
        assert!(info.newer);
        assert_eq!(info.page, "https://github.com/code-ksa/abdocode-addons/releases/tag/v4.0.1");
        let foreign = br#"{"schemaVersion":1,"version":"9.9.9","page":"https://evil.example/x"}"#;
        assert_eq!(interpret(foreign, "4.0.0").unwrap().page, DEFAULT_PAGE);
        assert!(interpret(br#"{"schemaVersion":2,"version":"1"}"#, "4.0.0").is_err());
        assert!(interpret(b"not json", "4.0.0").is_err());
        assert!(!interpret(br#"{"schemaVersion":1,"version":"4.0.0"}"#, "4.0.0").unwrap().newer);
    }
}
