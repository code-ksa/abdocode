//! سوقُ عبدو كود — فهرسٌ بعيدٌ مجّانيّ (أمر المالك 2026-09-14). يُقرأ من نشرةِ code-ksa على main ويُرشَّح قبل أن
//! يبلغ الواجهة: كلُّ مدخلٍ رابطُ حزمةٍ مثبَّتٌ إلى كوميت داخل code-ksa وبصمةُ SHA-256؛ التنزيلُ نفسُه يبقى عبر
//! `extensions_download` الذي يتحقّق من البايتات. الفهرسُ لا يشغّل كوداً ولا يثبّت شيئاً — قائمةٌ للمراجعة فقط.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, io::Read, time::Duration};

pub(crate) const INDEX_URL: &str = "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/marketplace.json";
const LIMIT: usize = 512 * 1024;
const MAX_ENTRIES: usize = 200;
const ORIGIN: &str = "https://raw.githubusercontent.com/code-ksa/";

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub id: String,
    pub name: String,
    #[serde(default)] pub name_ar: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub description_ar: String,
    pub kind: String,
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub skills: Vec<String>,
    #[serde(default)] pub requires: String,
    #[serde(default)] pub publisher: String,
    #[serde(default)] pub commit: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)] pub bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index { schema_version: u8, entries: Vec<Entry> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketIndex { pub entries: Vec<Entry>, pub dropped: usize, pub source: String }

fn slug_ok(id: &str) -> bool {
    (2..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') && !id.starts_with('-')
}
fn text_ok(s: &str, max: usize) -> bool { s.len() <= max && !s.chars().any(|c| c.is_control()) }
fn entry_ok(e: &Entry) -> bool {
    slug_ok(&e.id) && !e.name.is_empty() && text_ok(&e.name, 80) && text_ok(&e.name_ar, 80)
        && text_ok(&e.description, 600) && text_ok(&e.description_ar, 600) && text_ok(&e.requires, 120)
        && matches!(e.kind.as_str(), "skills" | "mcp" | "mixed")
        && e.url.starts_with(ORIGIN) && crate::extension_download::validate_url(&e.url, &e.sha256).is_ok()
        && e.tags.len() <= 12 && e.tags.iter().all(|t| slug_ok(t) || t.len() <= 24 && text_ok(t, 24))
        && e.skills.len() <= 24 && e.skills.iter().all(|s| slug_ok(s))
}
/// يُرشِّح الفهرسَ: الصالحُ يمرّ بترتيبه، والفاسدُ يُعدّ في `dropped` ولا يُرفع؛ المعرِّفُ المكرَّر يُبقي أوّلَه.
pub(crate) fn interpret(bytes: &[u8], source: &str) -> Result<MarketIndex, String> {
    if bytes.len() > LIMIT { return Err("فهرسُ السوق أكبر من الحدّ.".into()); }
    let index: Index = serde_json::from_slice(bytes).map_err(|_| "فهرسُ السوق ليس وثيقةً صالحة.")?;
    if index.schema_version != 1 { return Err("إصدارُ فهرس السوق غير مدعوم.".into()); }
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    let mut dropped = 0usize;
    for e in index.entries.into_iter().take(MAX_ENTRIES) {
        if entry_ok(&e) && seen.insert(e.id.clone()) { entries.push(e); } else { dropped += 1; }
    }
    Ok(MarketIndex { entries, dropped, source: source.to_string() })
}
fn fetch() -> Result<MarketIndex, String> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "تعذّر تجهيز عميل الشبكة.")?;
    let response = client.get(INDEX_URL).header("Cache-Control", "no-cache").send().map_err(|_| "تعذّر الوصول إلى GitHub — افحص الاتصال.")?;
    if !response.status().is_success() { return Err(format!("GitHub ردّ {} — لا فهرسَ سوقٍ منشوراً بعد؛ البذرةُ المشحونة هي المتاح.", response.status().as_u16())); }
    let mut bytes = Vec::new();
    response.take((LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|_| "انقطع تنزيلُ فهرس السوق.")?;
    interpret(&bytes, INDEX_URL)
}
/// الإعدادات ▸ الامتدادات ▸ السوق ▸ «تحديث السوق»: يعيد المدخلاتِ الصالحةَ من الفهرس البعيد (قراءةٌ بلا أثر).
#[tauri::command]
pub(crate) async fn marketplace_index() -> Result<MarketIndex, String> {
    tauri::async_runtime::spawn_blocking(fetch).await.map_err(|_| "انقطع طلبُ فهرس السوق.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const COMMIT: &str = "70a181f31a8ecd9c2ee3a3629adb3f22033d3587";
    const SHA: &str = "95a5f1d87a554d1b4afef6a2546eeb1e14df0a599ec169219bc2076a3c8ce349";
    fn entry(id: &str, url: &str) -> String {
        format!(r#"{{"id":"{id}","name":"X","kind":"skills","url":"{url}","sha256":"{SHA}","skills":["a-b"],"tags":["t"]}}"#)
    }
    #[test] fn pinned_code_ksa_entries_pass_and_foreign_or_unpinned_drop() {
        let good = entry("abdo-workflow", &format!("https://raw.githubusercontent.com/code-ksa/abdocode-addons/{COMMIT}/release/workflow.json"));
        let unpinned = entry("unpinned", "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/workflow.json");
        let foreign = entry("foreign", &format!("https://raw.githubusercontent.com/evil/abdocode-addons/{COMMIT}/release/workflow.json"));
        let dup = entry("abdo-workflow", &format!("https://raw.githubusercontent.com/code-ksa/abdocode-addons/{COMMIT}/release/other.json"));
        let bad_id = entry("Bad_ID", &format!("https://raw.githubusercontent.com/code-ksa/abdocode-addons/{COMMIT}/release/workflow.json"));
        let doc = format!(r#"{{"schemaVersion":1,"entries":[{good},{unpinned},{foreign},{dup},{bad_id}]}}"#);
        let index = interpret(doc.as_bytes(), "test").unwrap();
        assert_eq!(index.entries.len(), 1, "only the pinned code-ksa entry survives");
        assert_eq!(index.entries[0].id, "abdo-workflow");
        assert_eq!(index.dropped, 4);
        assert!(interpret(br#"{"schemaVersion":2,"entries":[]}"#, "t").is_err());
        assert!(interpret(b"not json", "t").is_err());
    }
    #[test] fn bad_kind_or_sha_drops() {
        let bad_sha = format!(r#"{{"id":"a-b","name":"X","kind":"skills","url":"https://raw.githubusercontent.com/code-ksa/r/{COMMIT}/p.json","sha256":"abc"}}"#);
        let bad_kind = format!(r#"{{"id":"a-c","name":"X","kind":"binary","url":"https://raw.githubusercontent.com/code-ksa/r/{COMMIT}/p.json","sha256":"{SHA}"}}"#);
        let doc = format!(r#"{{"schemaVersion":1,"entries":[{bad_sha},{bad_kind}]}}"#);
        let index = interpret(doc.as_bytes(), "t").unwrap();
        assert!(index.entries.is_empty()); assert_eq!(index.dropped, 2);
    }
}
