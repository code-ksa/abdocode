//! Download a pinned, text-only GitHub package. Review/install remains owned by extensions_store.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read, time::Duration};

const LIMIT: usize = 4 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Bundle { pub schema_version: u8, pub files: Vec<BundleFile> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BundleFile { pub path: String, pub content: String }

pub(crate) fn validate_url(url: &str, digest: &str) -> Result<(), String> {
    let parts: Vec<_> = url.strip_prefix("https://raw.githubusercontent.com/")
        .ok_or("Use a raw.githubusercontent.com package URL pinned to a commit.")?.split('/').collect();
    if parts.len() < 4 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || !p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)))
        || parts[2].len() != 40 || !parts[2].bytes().all(|c| c.is_ascii_hexdigit())
        || !url.ends_with(".json") || digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Provide a full commit URL and the package SHA-256 from its publisher.".into());
    }
    Ok(())
}
pub(crate) fn parse(bytes: &[u8], digest: &str) -> Result<Bundle, String> {
    if bytes.len() > LIMIT || format!("{:x}", Sha256::digest(bytes)) != digest.to_ascii_lowercase() { return Err("Package size or SHA-256 verification failed.".into()); }
    let bundle: Bundle = serde_json::from_slice(bytes).map_err(|_| "Invalid package document.")?;
    let mut seen = BTreeSet::new();
    if bundle.schema_version != 1 || bundle.files.is_empty() || bundle.files.len() > 256 { return Err("Invalid package file count.".into()); }
    for f in &bundle.files {
        if f.path.len() > 240 || f.content.len() > 2*1024*1024 || !seen.insert(f.path.to_ascii_lowercase())
            || f.path.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with('.') || !p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))) {
            return Err("Unsafe or duplicate package path.".into());
        }
    }
    Ok(bundle)
}
pub(crate) fn fetch(url: &str, digest: &str) -> Result<Bundle, String> {
    validate_url(url, digest)?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Download client unavailable.")?;
    let response = client.get(url).send().map_err(|_| "Cannot reach GitHub. Check your connection.")?;
    if !response.status().is_success() { return Err(format!("GitHub returned {}. Private packages can be downloaded by an authorized user and imported locally.", response.status().as_u16())); }
    let mut bytes = Vec::new();
    response.take((LIMIT+1) as u64).read_to_end(&mut bytes).map_err(|_| "Package download interrupted.")?;
    parse(&bytes, digest)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn pinned_origin_only() {
        let sha="a".repeat(64); let commit="b".repeat(40);
        assert!(validate_url(&format!("https://raw.githubusercontent.com/owner/repo/{commit}/packages/a.json"),&sha).is_ok());
        for url in ["http://127.0.0.1/a.json","https://raw.githubusercontent.com/owner/repo/main/a.json","https://raw.githubusercontent.com.evil/x.json"] { assert!(validate_url(url,&sha).is_err()); }
    }
    #[test] fn captures_exact_bytes_and_rejects_path_escape() {
        let good=br#"{"schemaVersion":1,"files":[{"path":"SKILL.md","content":"review"}]}"#;
        assert_eq!(parse(good,&format!("{:x}",Sha256::digest(good))).unwrap().files[0].content,"review");
        assert!(parse(good,&"0".repeat(64)).is_err());
        for path in ["../SKILL.md","C:/file","a//b","a/CON."] {
            let bad=serde_json::json!({"schemaVersion":1,"files":[{"path":path,"content":"x"}]}).to_string();
            assert!(parse(bad.as_bytes(),&format!("{:x}",Sha256::digest(bad.as_bytes()))).is_err());
        }
    }
}
