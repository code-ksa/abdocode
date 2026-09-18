//! Local instruction skills and declarative MCP bundles. Import captures bytes;
//! installation never runs code. One atomic registry controls activation.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_FILES: usize = 256;
const MAX_FILE: usize = 2 * 1024 * 1024;
const MAX_TOTAL: usize = 16 * 1024 * 1024;
const MAX_SKILL: usize = 64 * 1024;
const MAX_REGISTRY: usize = 256 * 1024;
const MANIFEST: &str = "abdocode-extension.json";
const PREFIX: &str = "ext-";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretGrant {
    env: String,
    handle: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpServer {
    id: String,
    command: Vec<String>,
    #[serde(default)]
    secrets: Vec<SecretGrant>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    mcp_servers: Vec<McpServer>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Skill {
    id: String,
    name: String,
    description: String,
    file: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Package {
    id: String,
    name: String,
    version: String,
    description: String,
    enabled: bool,
    directory: String,
    skills: Vec<Skill>,
    mcp_servers: Vec<McpServer>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Catalog {
    schema_version: u8,
    revision: u64,
    packages: Vec<Package>,
}
impl Default for Catalog {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            packages: vec![],
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    token: String,
    package: Package,
    file_count: usize,
    total_bytes: usize,
    skill_previews: Vec<SkillPreview>,
}
#[derive(Clone, Serialize)]
pub(crate) struct SkillPreview {
    id: String,
    text: String,
}
struct Captured {
    preview: Preview,
    files: BTreeMap<String, Vec<u8>>,
    root: PathBuf,
}
static OPERATIONS: Mutex<()> = Mutex::new(());
static PREVIEWS: OnceLock<Mutex<BTreeMap<String, Captured>>> = OnceLock::new();
fn previews() -> &'static Mutex<BTreeMap<String, Captured>> {
    PREVIEWS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn err(code: &str) -> String {
    format!("extensions: {code}")
}
fn id_ok(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
}
/// ما يشبه اعتماداً — مرآةُ `secretish` في المحرّك (local-extensions.ts) حدّاً بحدّ: مفتاحُ `sk-` بحدّ كلمة، رأسُ Bearer
/// برمزٍ فعليّ (لا `Bearer ${TOKEN}` الوثائقيّ)، سلسلةٌ طويلةٌ مختلطةٌ حروفاً وأرقاماً، أو رأسُ مفتاحٍ خاصّ كامل.
/// قيس 2026-09-06: الصيغةُ القديمة رفضت فواصلَ الجداول `-----` وأسماءً مثل risk-assessment — حارسٌ يحجب كلَّ شيءٍ ليس حارساً.
fn secretish(value: &str) -> bool {
    for (i, _) in value.match_indices("-----BEGIN ") {
        let rest = &value[i + 11..];
        let head: String = rest.chars().take_while(|c| c.is_ascii_uppercase() || *c == ' ').collect();
        if rest[head.len()..].starts_with("PRIVATE KEY-----") {
            return true;
        }
    }
    let lower = value.to_ascii_lowercase();
    for (i, _) in lower.match_indices("bearer ") {
        let token: String = lower[i + 7..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .collect();
        if token.len() >= 8 {
            return true;
        }
    }
    value
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .any(|p| {
            (p.starts_with("sk-") && p.len() >= 12)
                || (p.len() >= 40
                    && p.chars().any(|c| c.is_ascii_digit())
                    && p.chars().any(|c| c.is_ascii_alphabetic()))
        })
}
fn label(value: &str, max: usize) -> Result<(), String> {
    if value.len() > max || value.chars().any(char::is_control) || secretish(value) {
        Err(err("unsafe_metadata"))
    } else {
        Ok(())
    }
}
fn relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 240 || value.contains('\\') || value.contains(':') {
        return Err(err("unsafe_relative_path"));
    }
    let p = Path::new(value);
    if p.components().any(|c| !matches!(c, Component::Normal(_)))
        || value
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.ends_with('.') || s.ends_with(' '))
    {
        return Err(err("unsafe_relative_path"));
    }
    Ok(p.into())
}
fn no_links(path: &Path) -> Result<(), String> {
    // Inspect every existing ancestor, including Windows junctions/reparse points.
    for p in path.ancestors() {
        let m = fs::symlink_metadata(p).map_err(|_| err("path_unavailable"))?;
        if m.file_type().is_symlink() {
            return Err(err("links_not_supported"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err(err("links_not_supported"));
            }
        }
    }
    Ok(())
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    no_links(path)?;
    let mut f = fs::File::open(path).map_err(|_| err("file_unreadable"))?;
    if !f.metadata().map_err(|_| err("file_unreadable"))?.is_file() {
        return Err(err("regular_files_only"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| err("file_unreadable"))?;
    if bytes.len() > max {
        return Err(err("file_too_large"));
    }
    Ok(bytes)
}
fn sensitive_file(path: &str) -> bool {
    path.split('/').any(|part| {
        let s = part.to_ascii_lowercase();
        s == ".git"
            || s == "node_modules"
            || s == "vault"
            || s == "secrets"
            || s == ".env"
            || s.starts_with(".env.")
            || s.ends_with(".pem")
            || s.ends_with(".key")
            || s == "credentials.json"
    })
}
fn capture_tree(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 12 {
        return Err(err("tree_too_deep"));
    }
    no_links(path)?;
    for entry in fs::read_dir(path).map_err(|_| err("folder_unreadable"))? {
        let p = entry.map_err(|_| err("folder_unreadable"))?.path();
        no_links(&p)?;
        let rel = p
            .strip_prefix(root)
            .map_err(|_| err("outside_package"))?
            .to_str()
            .ok_or_else(|| err("invalid_filename"))?
            .replace('\\', "/");
        relative(&rel)?;
        label(&rel, 240)?;
        if sensitive_file(&rel) {
            return Err(err("private_or_dependency_files_not_supported"));
        }
        let kind = fs::symlink_metadata(&p).map_err(|_| err("path_unavailable"))?;
        if kind.is_dir() {
            capture_tree(root, &p, files, total, depth + 1)?;
        } else {
            if !kind.is_file() || files.len() >= MAX_FILES {
                return Err(err("package_file_limit"));
            }
            let bytes = read_bounded(&p, MAX_FILE)?;
            *total += bytes.len();
            if *total > MAX_TOTAL {
                return Err(err("package_size_limit"));
            }
            if files.keys().any(|key| key.eq_ignore_ascii_case(&rel)) {
                return Err(err("duplicate_filename"));
            }
            files.insert(rel, bytes);
        }
    }
    Ok(())
}
fn validate_server(s: &McpServer) -> Result<(), String> {
    if !id_ok(&s.id, 10) || s.command.is_empty() || s.command.len() > 32 || s.secrets.len() > 8 {
        return Err(err("invalid_mcp_definition"));
    }
    for part in &s.command {
        label(part, 8192)?;
        if part.is_empty() {
            return Err(err("empty_mcp_argument"));
        }
        if part.contains("${") && !part.starts_with("${extension}/") {
            return Err(err("unsupported_command_placeholder"));
        }
        if let Some(rel) = part.strip_prefix("${extension}/") {
            relative(rel)?;
        }
    }
    for g in &s.secrets {
        let valid_env = g.env.starts_with("ABDO_EXT_")
            && g.env.len() <= 64
            && g.env
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        if !valid_env || !g.handle.starts_with("custom-") || !id_ok(&g.handle, 64) {
            return Err(err("invalid_vault_grant"));
        }
    }
    Ok(())
}
fn skill_metadata(file: &str, bytes: &[u8], fallback: &str) -> Result<Skill, String> {
    if bytes.len() > MAX_SKILL {
        return Err(err("skill_too_large"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| err("skill_must_be_utf8"))?;
    if text.trim().is_empty() || secretish(text) {
        return Err(err("empty_or_sensitive_skill"));
    }
    let mut name = fallback.to_string();
    let mut description = String::new();
    if text.starts_with("---\n") || text.starts_with("---\r\n") {
        for line in text.lines().skip(1).take_while(|line| line.trim() != "---") {
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().trim_matches(['\'', '"']).into();
            }
            if let Some(v) = line.strip_prefix("description:") {
                description = v.trim().trim_matches(['\'', '"']).into();
            }
        }
    }
    if !id_ok(&name, 48) {
        return Err(err("skill_name_must_be_lowercase_slug"));
    }
    label(&description, 1000)?;
    Ok(Skill {
        id: name.clone(),
        name,
        description,
        file: file.into(),
    })
}
fn preview_at(source: &Path, root: &Path) -> Result<Captured, String> {
    if !source.is_absolute() {
        return Err(err("absolute_source_required"));
    }
    no_links(source)?;
    let folder = if source.is_dir() {
        source.to_path_buf()
    } else if source.file_name().and_then(|n| n.to_str()) == Some(MANIFEST)
        || source.file_name().and_then(|n| n.to_str()) == Some("SKILL.md")
    {
        source
            .parent()
            .ok_or_else(|| err("invalid_source"))?
            .to_path_buf()
    } else {
        return Err(err("select_skill_folder_or_manifest"));
    };
    let mut files = BTreeMap::new();
    let mut total = 0;
    capture_tree(&folder, &folder, &mut files, &mut total, 0)?;
    let manifest = if let Some(bytes) = files.get(MANIFEST) {
        if bytes.len() > 64 * 1024 {
            return Err(err("manifest_too_large"));
        }
        serde_json::from_slice::<Manifest>(bytes).map_err(|_| err("unsupported_manifest_format"))?
    } else {
        let bytes = files
            .get("SKILL.md")
            .ok_or_else(|| err("missing_manifest_or_skill"))?;
        let fallback = folder
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| err("invalid_folder_name"))?;
        let skill = skill_metadata("SKILL.md", bytes, fallback)?;
        Manifest {
            schema_version: 1,
            id: skill.id.chars().take(16).collect(),
            name: skill.name,
            version: "1.0.0".into(),
            description: skill.description,
            skills: vec![".".into()],
            mcp_servers: vec![],
        }
    };
    if manifest.schema_version != 1
        || !id_ok(&manifest.id, 16)
        || manifest.skills.len() > 24
        || manifest.mcp_servers.len() > 12
        || manifest.skills.is_empty() && manifest.mcp_servers.is_empty()
    {
        return Err(err("invalid_manifest"));
    }
    label(&manifest.name, 120)?;
    label(&manifest.description, 1000)?;
    label(&manifest.version, 32)?;
    if manifest.name.is_empty() || manifest.version.is_empty() {
        return Err(err("missing_package_name_or_version"));
    }
    let mut skills = vec![];
    let mut seen = BTreeSet::new();
    let mut skill_previews = vec![];
    for dir in manifest.skills {
        let file = if dir == "." {
            "SKILL.md".to_string()
        } else {
            relative(&dir)?;
            format!("{dir}/SKILL.md")
        };
        let bytes = files.get(&file).ok_or_else(|| err("skill_file_missing"))?;
        let fallback = if dir == "." {
            manifest.id.as_str()
        } else {
            dir.rsplit('/').next().unwrap_or(&dir)
        };
        let s = skill_metadata(&file, bytes, fallback)?;
        if !seen.insert(s.id.clone()) {
            return Err(err("duplicate_skill"));
        }
        skill_previews.push(SkillPreview {
            id: format!("{}/{}", manifest.id, s.id),
            text: String::from_utf8(bytes.clone()).map_err(|_| err("skill_must_be_utf8"))?,
        });
        skills.push(s);
    }
    let mut seen = BTreeSet::new();
    for server in &manifest.mcp_servers {
        validate_server(server)?;
        if !seen.insert(&server.id) {
            return Err(err("duplicate_mcp_id"));
        }
        for part in &server.command {
            if let Some(rel) = part.strip_prefix("${extension}/") {
                if !files.contains_key(rel) {
                    return Err(err("mcp_entry_file_missing"));
                }
            }
        }
    }
    let package = Package {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: false,
        directory: uuid::Uuid::new_v4().simple().to_string(),
        skills,
        mcp_servers: manifest.mcp_servers,
    };
    Ok(Captured {
        preview: Preview {
            token: uuid::Uuid::new_v4().to_string(),
            package,
            file_count: files.len(),
            total_bytes: total,
            skill_previews,
        },
        files,
        root: root.into(),
    })
}
fn settings_file() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("ABDO_CODE_SETTINGS").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(value));
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| err("profile_unavailable"))?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("abdocode")
        .join("settings.json"))
}
fn store_root() -> Result<PathBuf, String> {
    Ok(settings_file()?
        .parent()
        .ok_or_else(|| err("profile_unavailable"))?
        .join("extensions"))
}
fn validate_package(p: &Package) -> Result<(), String> {
    if !id_ok(&p.id, 16)
        || p.directory.len() != 32
        || !p.directory.bytes().all(|b| b.is_ascii_hexdigit())
        || p.skills.len() > 24
        || p.mcp_servers.len() > 12
    {
        return Err(err("invalid_registry"));
    }
    label(&p.name, 120)?;
    label(&p.description, 1000)?;
    label(&p.version, 32)?;
    for s in &p.skills {
        if !id_ok(&s.id, 48) {
            return Err(err("invalid_registry"));
        }
        relative(&s.file)?;
        label(&s.name, 120)?;
        label(&s.description, 1000)?;
    }
    for s in &p.mcp_servers {
        validate_server(s)?;
    }
    Ok(())
}
fn list_at(root: &Path) -> Result<Catalog, String> {
    let path = root.join("registry.json");
    if !path.exists() {
        return Ok(Catalog::default());
    }
    let c: Catalog = serde_json::from_slice(&read_bounded(&path, 1024 * 1024)?)
        .map_err(|_| err("invalid_registry"))?;
    if c.schema_version != 1 || c.revision >= 9_007_199_254_740_991 || c.packages.len() > 64 {
        return Err(err("invalid_registry"));
    }
    let mut seen = BTreeSet::new();
    for p in &c.packages {
        validate_package(p)?;
        if !seen.insert(&p.id) {
            return Err(err("invalid_registry"));
        }
    }
    Ok(c)
}
fn root_ready(root: &Path) -> Result<(), String> {
    // Check existing ancestors before creating anything through them.
    let ancestor = root
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| err("profile_unavailable"))?;
    no_links(ancestor)?;
    fs::create_dir_all(root.join("packages")).map_err(|_| err("store_unwritable"))?;
    no_links(root)
}
struct StoreLock {
    _file: fs::File,
}
impl StoreLock {
    fn acquire(root: &Path) -> Result<Self, String> {
        root_ready(root)?;
        let path = root.join(".registry.lock");
        if path.exists() {
            no_links(&path)?;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options.open(path).map_err(|_| err("store_busy"))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            extern "C" {
                fn flock(fd: i32, operation: i32) -> i32;
            }
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
                return Err(err("store_busy"));
            }
        }
        Ok(Self { _file: file })
    }
}
#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let a: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(err("registry_commit_failed"))
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|_| err("registry_commit_failed"))
}
fn commit(root: &Path, c: &Catalog) -> Result<(), String> {
    root_ready(root)?;
    let stage = root.join(format!("registry-{}.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(c).map_err(|_| err("invalid_registry"))?;
    if bytes.len() > MAX_REGISTRY {
        return Err(err("registry_size_limit"));
    }
    let outcome = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .map_err(|_| err("store_unwritable"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| err("store_unwritable"))?;
        replace_file(&stage, &root.join("registry.json"))
    })();
    if stage.exists() {
        let _ = fs::remove_file(stage);
    }
    outcome
}
fn conflicts(root: &Path, p: &Package) -> Result<(), String> {
    let configured = settings_file()?;
    let settings = if configured.parent() == root.parent() {
        configured
    } else {
        root.parent()
            .ok_or_else(|| err("profile_unavailable"))?
            .join("settings.json")
    };
    if !settings.exists() {
        return Ok(());
    }
    let value: serde_json::Value = serde_json::from_slice(&read_bounded(&settings, 1024 * 1024)?)
        .map_err(|_| err("settings_unreadable"))?;
    for server in &p.mcp_servers {
        let id = format!("{PREFIX}{}-{}", p.id, server.id);
        if value
            .get("mcpServers")
            .and_then(|v| v.as_array())
            .is_some_and(|rows| {
                rows.iter()
                    .any(|row| row.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            })
        {
            return Err(err("mcp_id_conflicts_with_existing_settings"));
        }
    }
    Ok(())
}
fn install_at(root: &Path, captured: &Captured, expected: u64) -> Result<Catalog, String> {
    install_with_commit(root, captured, expected, commit)
}
fn install_with_commit(
    root: &Path,
    captured: &Captured,
    expected: u64,
    save: impl FnOnce(&Path, &Catalog) -> Result<(), String>,
) -> Result<Catalog, String> {
    let mut c = list_at(root)?;
    if c.revision != expected {
        return Err(err("registry_changed_refresh"));
    }
    if c.packages
        .iter()
        .any(|p| p.id == captured.preview.package.id)
    {
        return Err(err("package_already_installed_remove_first"));
    }
    if c.packages.len() >= 64 {
        return Err(err("package_limit"));
    }
    conflicts(root, &captured.preview.package)?;
    root_ready(root)?;
    let target = root
        .join("packages")
        .join(&captured.preview.package.directory);
    if target.exists() {
        return Err(err("package_directory_exists"));
    }
    fs::create_dir(&target).map_err(|_| err("store_unwritable"))?;
    let outcome = (|| {
        for (rel, bytes) in &captured.files {
            let path = target.join(relative(rel)?);
            fs::create_dir_all(path.parent().ok_or_else(|| err("invalid_path"))?)
                .map_err(|_| err("store_unwritable"))?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)
                .map_err(|_| err("store_unwritable"))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| err("store_unwritable"))?;
        }
        c.packages.push(captured.preview.package.clone());
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| err("revision_limit"))?;
        save(root, &c)
    })();
    if let Err(e) = outcome {
        no_links(&target)?;
        let _ = fs::remove_dir_all(&target);
        return Err(e);
    }
    Ok(c)
}
fn change_at(
    root: &Path,
    id: &str,
    enabled: Option<bool>,
    expected: u64,
) -> Result<Catalog, String> {
    change_with_commit(root, id, enabled, expected, commit)
}
fn change_with_commit(
    root: &Path,
    id: &str,
    enabled: Option<bool>,
    expected: u64,
    save: impl FnOnce(&Path, &Catalog) -> Result<(), String>,
) -> Result<Catalog, String> {
    if !id_ok(id, 16) {
        return Err(err("invalid_package_id"));
    }
    let mut c = list_at(root)?;
    if c.revision != expected {
        return Err(err("registry_changed_refresh"));
    }
    let i = c
        .packages
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| err("package_not_installed"))?;
    if let Some(on) = enabled {
        if on {
            conflicts(root, &c.packages[i])?;
            for skill in &c.packages[i].skills {
                let p = root
                    .join("packages")
                    .join(&c.packages[i].directory)
                    .join(relative(&skill.file)?);
                skill_metadata(&skill.file, &read_bounded(&p, MAX_SKILL)?, &skill.id)?;
            }
        }
        c.packages[i].enabled = on;
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| err("revision_limit"))?;
        save(root, &c)?;
        return Ok(c);
    }
    let target = root.join("packages").join(&c.packages[i].directory);
    no_links(&target)?;
    // Stage removal by rename. A rejected registry commit restores the package.
    let removed = root.join(format!("removed-{}", uuid::Uuid::new_v4().simple()));
    fs::rename(&target, &removed).map_err(|_| err("package_in_use"))?;
    c.packages.remove(i);
    c.revision = c
        .revision
        .checked_add(1)
        .ok_or_else(|| err("revision_limit"))?;
    if let Err(e) = save(root, &c) {
        fs::rename(&removed, &target).map_err(|_| err("removal_rollback_failed"))?;
        return Err(e);
    }
    // Only delete the verified private staged folder, never source files.
    no_links(&removed)?;
    fs::remove_dir_all(&removed).map_err(|_| err("removed_but_cleanup_pending"))?;
    Ok(c)
}

pub(crate) fn extensions_preview(source_path: String) -> Result<Preview, String> {
    let root = store_root()?;
    let captured = preview_at(Path::new(&source_path), &root)?;
    let result = captured.preview.clone();
    let mut pending = previews().lock().map_err(|_| err("store_busy"))?;
    if pending.len() >= 3 {
        pending.clear();
    }
    pending.insert(result.token.clone(), captured);
    Ok(result)
}
pub(crate) fn extensions_list() -> Result<Catalog, String> {
    let _lock = OPERATIONS.lock().map_err(|_| err("store_busy"))?;
    list_at(&store_root()?)
}
pub(crate) fn extensions_install(token: String, expected_revision: u64) -> Result<Catalog, String> {
    let _lock = OPERATIONS.lock().map_err(|_| err("store_busy"))?;
    let root = store_root()?;
    let _store = StoreLock::acquire(&root)?;
    let mut pending = previews().lock().map_err(|_| err("store_busy"))?;
    let captured = pending
        .get(&token)
        .ok_or_else(|| err("preview_expired_import_again"))?;
    if captured.root != root {
        return Err(err("profile_changed_import_again"));
    }
    let result = install_at(&root, captured, expected_revision)?;
    pending.remove(&token);
    Ok(result)
}
pub(crate) fn extensions_set_enabled(
    id: String,
    enabled: bool,
    expected_revision: u64,
) -> Result<Catalog, String> {
    let _lock = OPERATIONS.lock().map_err(|_| err("store_busy"))?;
    let root = store_root()?;
    let _store = StoreLock::acquire(&root)?;
    change_at(&root, &id, Some(enabled), expected_revision)
}
pub(crate) fn extensions_remove(id: String, expected_revision: u64) -> Result<Catalog, String> {
    let _lock = OPERATIONS.lock().map_err(|_| err("store_busy"))?;
    let root = store_root()?;
    let _store = StoreLock::acquire(&root)?;
    change_at(&root, &id, None, expected_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("abdo-extension-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn bundle(t: &Temp) -> PathBuf {
        let p = t.0.join("source");
        fs::create_dir_all(p.join("skills/check")).unwrap();
        fs::write(
            p.join("skills/check/SKILL.md"),
            "---\nname: check\ndescription: Verify the result.\n---\nRead the evidence first.",
        )
        .unwrap();
        fs::write(
            p.join("server.py"),
            "raise RuntimeError('MUST NOT RUN AT INSTALL')",
        )
        .unwrap();
        fs::write(p.join(MANIFEST),r#"{"schemaVersion":1,"id":"proof","name":"Proof","version":"1.0.0","skills":["skills/check"],"mcpServers":[{"id":"local","command":["python","${extension}/server.py"],"secrets":[{"env":"ABDO_EXT_TOKEN","handle":"custom-proof"}]}]}"#).unwrap();
        p
    }
    #[test]
    fn lifecycle_persists_and_preserves_settings_and_source() {
        let t = Temp::new();
        let source = bundle(&t);
        let root = t.0.join("extensions");
        fs::write(
            t.0.join("settings.json"),
            r#"{"theme":"dark","mcpServers":[{"id":"existing","command":["node","server.js"]}]}"#,
        )
        .unwrap();
        let before = fs::read(t.0.join("settings.json")).unwrap();
        let capture = preview_at(&source, &root).unwrap();
        assert_eq!(capture.preview.skill_previews.len(), 1);
        assert_eq!(capture.preview.package.enabled, false);
        let c = install_at(&root, &capture, 0).unwrap();
        assert_eq!(list_at(&root).unwrap().revision, 1);
        assert!(!c.packages[0].enabled);
        let c = change_at(&root, "proof", Some(true), 1).unwrap();
        assert!(c.packages[0].enabled);
        assert!(change_at(&root, "proof", Some(false), 1).is_err());
        let c = change_at(&root, "proof", Some(false), 2).unwrap();
        assert!(!c.packages[0].enabled);
        let c = change_at(&root, "proof", None, 3).unwrap();
        assert!(c.packages.is_empty());
        assert!(source.join("server.py").exists());
        assert_eq!(fs::read(t.0.join("settings.json")).unwrap(), before);
        assert_eq!(fs::read_dir(root.join("packages")).unwrap().count(), 0);
    }
    #[test]
    fn installs_captured_bytes_not_changed_source() {
        let t = Temp::new();
        let source = bundle(&t);
        let root = t.0.join("extensions");
        let capture = preview_at(&source, &root).unwrap();
        fs::write(
            source.join("skills/check/SKILL.md"),
            "changed after preview",
        )
        .unwrap();
        let c = install_at(&root, &capture, 0).unwrap();
        let stored = root
            .join("packages")
            .join(&c.packages[0].directory)
            .join("skills/check/SKILL.md");
        assert!(fs::read_to_string(stored)
            .unwrap()
            .contains("Read the evidence"));
    }
    #[test]
    fn rejects_traversal_secrets_scripts_manifest_and_conflicts() {
        let t = Temp::new();
        let source = bundle(&t);
        let root = t.0.join("extensions");
        let original = fs::read_to_string(source.join(MANIFEST)).unwrap();
        for bad in [
            original.replace("skills/check", "../escape"),
            original.replace(
                "\"version\":",
                "\"scripts\":{\"install\":\"bad\"},\"version\":",
            ),
            original.replace("custom-proof", "sk-0123456789abcdef"),
        ] {
            fs::write(source.join(MANIFEST), bad).unwrap();
            assert!(preview_at(&source, &root).is_err());
        }
        fs::write(source.join(MANIFEST), original).unwrap();
        fs::write(
            t.0.join("settings.json"),
            r#"{"mcpServers":[{"id":"ext-proof-local","command":["existing"]}]}"#,
        )
        .unwrap();
        let c = preview_at(&source, &root).unwrap();
        assert!(install_at(&root, &c, 0).unwrap_err().contains("conflicts"));
        assert!(!root.exists());
    }
    #[test]
    fn rejects_oversized_skill_and_link_and_supports_standalone() {
        let t = Temp::new();
        let source = t.0.join("check");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: check\n---\nCheck the output.",
        )
        .unwrap();
        assert_eq!(
            preview_at(&source, &t.0.join("extensions"))
                .unwrap()
                .preview
                .package
                .skills[0]
                .id,
            "check"
        );
        fs::write(source.join("SKILL.md"), "a ".repeat(MAX_SKILL)).unwrap();
        assert!(preview_at(&source, &t.0.join("extensions")).is_err());
        #[cfg(unix)]
        {
            fs::remove_file(source.join("SKILL.md")).unwrap();
            std::os::unix::fs::symlink(t.0.join("missing"), source.join("SKILL.md")).unwrap();
            assert!(preview_at(&source, &t.0.join("extensions")).is_err());
        }
    }
    #[test]
    fn failed_registry_commit_rolls_back_actual_staged_files() {
        let t = Temp::new();
        let source = bundle(&t);
        let root = t.0.join("extensions");
        let capture = preview_at(&source, &root).unwrap();
        let target = root
            .join("packages")
            .join(&capture.preview.package.directory);
        let result = install_with_commit(&root, &capture, 0, |_, _| {
            assert!(target.join("server.py").is_file());
            Err(err("injected_commit_failure"))
        });
        assert!(result.is_err());
        assert!(!target.exists());
        assert!(!root.join("registry.json").exists());
        let c = install_at(&root, &capture, 0).unwrap();
        let before = fs::read(root.join("registry.json")).unwrap();
        let result = change_with_commit(&root, "proof", None, c.revision, |_, _| {
            assert!(!target.exists());
            Err(err("injected_commit_failure"))
        });
        assert!(result.is_err());
        assert!(target.join("server.py").is_file());
        assert_eq!(fs::read(root.join("registry.json")).unwrap(), before);
    }
    #[test]
    fn concurrent_store_lock_refuses_and_releases() {
        let t = Temp::new();
        let root = t.0.join("extensions");
        let lock = StoreLock::acquire(&root).unwrap();
        assert!(StoreLock::acquire(&root).is_err());
        drop(lock);
        assert!(StoreLock::acquire(&root).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn windows_junction_import_is_refused() {
        use std::os::windows::process::CommandExt;
        let t = Temp::new();
        let source = bundle(&t);
        let outside = t.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = source.join("redirect");
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(preview_at(&source, &t.0.join("extensions"))
            .err()
            .unwrap()
            .contains("links_not_supported"));
    }
}

pub(crate) fn preview_download(bundle: crate::extension_download::Bundle) -> Result<Preview, String> {
    let root = store_root()?;
    let captured = capture_download_at(bundle, &root)?;
    let result = captured.preview.clone();
    let mut pending = previews().lock().map_err(|_| err("store_busy"))?;
    if pending.len() >= 3 { pending.clear(); }
    pending.insert(result.token.clone(), captured);
    Ok(result)
}
fn capture_download_at(bundle: crate::extension_download::Bundle, root: &Path) -> Result<Captured, String> {
    root_ready(root)?;
    let stage = root.join(format!("download-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&stage).map_err(|_| err("download_stage_unavailable"))?;
    let result = (|| {
        for file in bundle.files {
            let path = stage.join(relative(&file.path)?);
            let parent = path.parent().ok_or_else(|| err("unsafe_relative_path"))?;
            fs::create_dir_all(parent).map_err(|_| err("download_stage_unavailable"))?;
            no_links(parent)?;
            fs::OpenOptions::new().write(true).create_new(true).open(&path)
                .and_then(|mut f| f.write_all(file.content.as_bytes())).map_err(|_| err("download_write_failed"))?;
        }
        preview_at(&stage, root)
    })();
    // Only this operation's generated direct child is removed; captured preview owns its bytes.
    if stage.parent() == Some(root) && no_links(&stage).is_ok() { let _ = fs::remove_dir_all(&stage); }
    result
}

#[cfg(test)]
mod download_lifecycle_tests {
    use super::*;
    #[test]
    fn downloaded_bytes_survive_stage_cleanup_and_install_disabled() {
        let root = std::env::temp_dir().join(format!("abdo-download-test-{}",uuid::Uuid::new_v4()));
        let bundle=crate::extension_download::Bundle {schema_version:1,files:vec![crate::extension_download::BundleFile {path:"SKILL.md".into(),content:"---\nname: review\ndescription: Review results.\n---\nRead the selected project.".into()}]};
        // A standalone skill uses its source folder name; use an explicit stable manifest for downloaded packages.
        let mut bundle=bundle;
        bundle.files.push(crate::extension_download::BundleFile {path:MANIFEST.into(),content:r#"{"schemaVersion":1,"id":"download-proof","name":"Download proof","version":"1.0.0","skills":["."]}"#.into()});
        let capture=capture_download_at(bundle,&root).unwrap();
        assert_eq!(capture.preview.skill_previews.len(),1);
        assert!(!fs::read_dir(&root).unwrap().any(|x|x.unwrap().file_name().to_string_lossy().starts_with("download-")));
        let catalog=install_at(&root,&capture,0).unwrap();
        assert!(!catalog.packages[0].enabled);
        assert!(root.join("packages").join(&catalog.packages[0].directory).join("SKILL.md").is_file());
        fs::remove_dir_all(&root).unwrap();
    }
}
