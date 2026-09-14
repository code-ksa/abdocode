//! Desktop commands for reviewed local skill and MCP bundle installation.
#[path = "extensions_store.rs"]
mod store;

#[tauri::command]
pub(crate) async fn extensions_choose(kind: String) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new().set_title("Import AbdoCode local extension");
    let choice = match kind.as_str() {
        "folder" => dialog.pick_folder().await,
        "manifest" => {
            dialog
                .add_filter("AbdoCode extension", &["json"])
                .pick_file()
                .await
        }
        _ => return Err("extensions: unsupported_source_kind".into()),
    };
    Ok(choice.map(|p| p.path().to_string_lossy().into_owned()))
}
#[tauri::command]
pub(crate) fn extensions_preview(source_path: String) -> Result<store::Preview, String> {
    store::extensions_preview(source_path)
}
#[tauri::command]
pub(crate) fn extensions_list() -> Result<store::Catalog, String> {
    store::extensions_list()
}
#[tauri::command]
pub(crate) fn extensions_install(
    token: String,
    expected_revision: u64,
) -> Result<store::Catalog, String> {
    store::extensions_install(token, expected_revision)
}
#[tauri::command]
pub(crate) fn extensions_set_enabled(
    id: String,
    enabled: bool,
    expected_revision: u64,
) -> Result<store::Catalog, String> {
    store::extensions_set_enabled(id, enabled, expected_revision)
}
#[tauri::command]
pub(crate) fn extensions_remove(
    id: String,
    expected_revision: u64,
) -> Result<store::Catalog, String> {
    store::extensions_remove(id, expected_revision)
}

#[tauri::command]
pub(crate) async fn extensions_download(url: String, sha256: String, github_auth: Option<bool>) -> Result<store::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = if github_auth.unwrap_or(false) {
            let bytes = crate::workspace::github_package_download(&url, &sha256)?;
            crate::extension_download::parse(&bytes, &sha256)?
        } else { crate::extension_download::fetch(&url, &sha256)? };
        store::preview_download(bundle)
    }).await.map_err(|_| "Download task interrupted.".to_string())?
}
