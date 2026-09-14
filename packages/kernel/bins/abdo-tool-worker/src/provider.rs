//! Bounded model-provider egress with Rust-owned credential materialization.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const REQUEST_MAGIC: &[u8; 5] = b"ABPM1";
const SEARCH_MAGIC: &[u8; 5] = b"ABGS2";
const RESPONSE_MAGIC: &[u8; 5] = b"ABPR1";
const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_RESPONSE_BYTES: usize = 2_097_152;
const MAX_TEXT_BYTES: usize = 32_768;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CredentialKind {
    Bearer,
    ApiKey,
}

#[derive(Clone, Copy, Debug)]
struct ProviderBinding {
    id: &'static str,
    url: &'static str,
    vault_key: &'static str,
    credential: CredentialKind,
    anthropic: bool,
}

const PROVIDERS: &[ProviderBinding] = &[
    ProviderBinding {
        id: "deepseek",
        url: "https://api.deepseek.com/chat/completions",
        vault_key: "abdocode-deepseek",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "anthropic",
        url: "https://api.anthropic.com/v1/messages",
        vault_key: "abdocode-anthropic",
        credential: CredentialKind::ApiKey,
        anthropic: true,
    },
    ProviderBinding {
        id: "openai",
        url: "https://api.openai.com/v1/chat/completions",
        vault_key: "abdocode-openai",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "google",
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        vault_key: "abdocode-google",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "xai",
        url: "https://api.x.ai/v1/chat/completions",
        vault_key: "abdocode-xai",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "mistral",
        url: "https://api.mistral.ai/v1/chat/completions",
        vault_key: "abdocode-mistral",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        vault_key: "abdocode-groq",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "together",
        url: "https://api.together.xyz/v1/chat/completions",
        vault_key: "abdocode-together",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "moonshot",
        url: "https://api.moonshot.cn/v1/chat/completions",
        vault_key: "abdocode-moonshot",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "dashscope",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        vault_key: "abdocode-dashscope",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "qwen-token-plan",
        url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
        vault_key: "abdocode-qwen-token-plan",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "qwen-coding-plan",
        url: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
        vault_key: "abdocode-qwen-coding-plan",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "minimax",
        url: "https://api.minimax.chat/v1/chat/completions",
        vault_key: "abdocode-minimax",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "openrouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        vault_key: "abdocode-openrouter",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "nvidia",
        url: "https://integrate.api.nvidia.com/v1/chat/completions",
        vault_key: "abdocode-nvidia",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
    ProviderBinding {
        id: "meta",
        url: "https://api.llama.com/compat/v1/chat/completions",
        vault_key: "abdocode-meta",
        credential: CredentialKind::Bearer,
        anthropic: false,
    },
];

/// Owner-declared custom provider passed through `ABDO_CUSTOM_PROVIDERS`
/// (entries `id|url|vault_key` joined by `;`). The host that owns settings
/// sets the variable; the request itself can never invent an endpoint — it
/// must match an owner entry exactly. Absence means refusal, and one
/// malformed entry refuses the whole list (fail-closed).
#[derive(Clone, Debug, Eq, PartialEq)]
struct OwnerBinding {
    id: String,
    url: String,
    vault_key: String,
}

fn parse_custom_bindings(raw: &str) -> Result<Vec<OwnerBinding>, String> {
    let mut out: Vec<OwnerBinding> = Vec::new();
    for entry in raw.split(';').filter(|entry| !entry.is_empty()) {
        let mut parts = entry.split('|');
        let (Some(id), Some(url), Some(vault_key), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("custom provider entry shape refused".into());
        };
        let id_ok = !id.is_empty()
            && id.len() <= 64
            && id.as_bytes()[0].is_ascii_lowercase()
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !id_ok {
            return Err("custom provider id refused".into());
        }
        if PROVIDERS.iter().any(|item| item.id == id) {
            return Err("custom provider id collides with a compiled provider".into());
        }
        let url_ok = url.starts_with("https://")
            && url.len() <= 640
            && url.ends_with("/chat/completions")
            && !url.contains(['@', '?', '#', '\\'])
            && url.bytes().all(|b| b.is_ascii_graphic());
        if !url_ok {
            return Err("custom provider url refused".into());
        }
        // Vault namespace lock: a custom entry may only name a `custom-*`
        // handle, never a compiled provider's handle — otherwise "custom
        // provider" becomes an exfiltration path for a compiled secret to
        // an owner-declared-but-foreign endpoint (adversarial scan 2026-09-01).
        let vault_ok = vault_key.len() >= 8
            && vault_key.len() <= 128
            && vault_key.starts_with("custom-")
            && vault_key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !vault_ok {
            return Err("custom provider vault key refused".into());
        }
        if PROVIDERS.iter().any(|item| item.vault_key == vault_key) {
            return Err("custom provider vault key collides with a compiled provider".into());
        }
        if out.iter().any(|prior| prior.id == id || prior.url == url) {
            return Err("custom provider duplicate refused".into());
        }
        out.push(OwnerBinding {
            id: id.into(),
            url: url.into(),
            vault_key: vault_key.into(),
        });
    }
    if out.len() > 64 {
        return Err("custom provider list exceeds 64 entries".into());
    }
    Ok(out)
}

fn owner_custom_bindings() -> Result<Vec<OwnerBinding>, String> {
    match std::env::var("ABDO_CUSTOM_PROVIDERS") {
        Ok(raw) if !raw.trim().is_empty() => parse_custom_bindings(&raw),
        _ => Ok(Vec::new()),
    }
}

/// Runtime view over either a compiled binding or an owner-declared one.
/// Custom providers speak the OpenAI-compatible dialect only: Bearer
/// credential, no Anthropic headers.
struct ResolvedBinding {
    vault_key: String,
    credential: CredentialKind,
    anthropic: bool,
}

#[derive(Debug)]
struct Request {
    provider: String,
    url: String,
    timeout_ms: u32,
    body: Vec<u8>,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(length)
            .ok_or_else(|| "provider frame overflow".to_string())?;
        let value = self
            .bytes
            .get(self.at..end)
            .ok_or_else(|| "provider frame truncated".to_string())?;
        self.at = end;
        Ok(value)
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(
            self.take(2)?.try_into().map_err(|_| "u16")?,
        ))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| "u32")?,
        ))
    }
    fn text(&mut self) -> Result<String, String> {
        let length = usize::from(self.u16()?);
        if length == 0 || length > MAX_TEXT_BYTES {
            return Err("provider text length refused".into());
        }
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| "provider text is not UTF-8".into())
    }
    fn optional_text(&mut self) -> Result<String, String> {
        let length = usize::from(self.u16()?);
        if length > MAX_TEXT_BYTES {
            return Err("provider text length refused".into());
        }
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| "provider text is not UTF-8".into())
    }
}

#[derive(Debug)]
struct SearchRequest {
    query: String,
    site: String,
    language: String,
    country: String,
    count: u8,
    safe: bool,
    /// ABGS2: بحثُ صورٍ (`searchType=image`) — الحقولُ المطلوبة من PSE تتبعه.
    image: bool,
    timeout_ms: u32,
}

fn decode_search_request(bytes: &[u8]) -> Result<SearchRequest, String> {
    if bytes.len() > 2_048 {
        return Err("search request exceeds 2 KiB".into());
    }
    let mut cursor = Cursor::new(bytes);
    if cursor.take(SEARCH_MAGIC.len())? != SEARCH_MAGIC {
        return Err("search request magic refused".into());
    }
    let query = cursor.text()?;
    let site = cursor.optional_text()?;
    let language = cursor.text()?;
    let country = cursor.text()?;
    let count = *cursor
        .take(1)?
        .first()
        .ok_or_else(|| "search count missing".to_string())?;
    let safe = match cursor.take(1)?.first() {
        Some(1) => true,
        Some(0) => false,
        _ => return Err("search safe mode refused".into()),
    };
    let image = match cursor.take(1)?.first() {
        Some(1) => true,
        Some(0) => false,
        _ => return Err("search kind refused".into()),
    };
    let timeout_ms = cursor.u32()?;
    if cursor.at != bytes.len()
        || query.len() > 300
        || site.len() > 253
        || !(1..=10).contains(&count)
        || !(1_000..=30_000).contains(&timeout_ms)
    {
        return Err("search request shape refused".into());
    }
    if !language
        .as_bytes()
        .iter()
        .all(|b| b.is_ascii_alphabetic() || *b == b'-')
        || language.len() > 5
        || !country.as_bytes().iter().all(u8::is_ascii_alphabetic)
        || country.len() != 2
        || (!site.is_empty()
            && !site
                .as_bytes()
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'.' | b'-')))
    {
        return Err("search locale or site refused".into());
    }
    Ok(SearchRequest {
        query,
        site,
        language,
        country,
        count,
        safe,
        image,
        timeout_ms,
    })
}

fn decode_request(bytes: &[u8]) -> Result<Request, String> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("provider request exceeds 1 MiB".into());
    }
    let mut cursor = Cursor::new(bytes);
    if cursor.take(REQUEST_MAGIC.len())? != REQUEST_MAGIC {
        return Err("provider request magic refused".into());
    }
    let provider = cursor.text()?;
    let url = cursor.text()?;
    let timeout_ms = cursor.u32()?;
    if !(1_000..=300_000).contains(&timeout_ms) {
        return Err("provider timeout refused".into());
    }
    let body_len = usize::try_from(cursor.u32()?).map_err(|_| "provider body length")?;
    if body_len == 0 || body_len > MAX_REQUEST_BYTES {
        return Err("provider body length refused".into());
    }
    let body = cursor.take(body_len)?.to_vec();
    if cursor.at != bytes.len() {
        return Err("provider request has trailing bytes".into());
    }
    Ok(Request {
        provider,
        url,
        timeout_ms,
        body,
    })
}

fn binding(request: &Request) -> Result<ResolvedBinding, String> {
    if let Some(fixed) = PROVIDERS
        .iter()
        .find(|item| item.id == request.provider && item.url == request.url)
    {
        return Ok(ResolvedBinding {
            vault_key: fixed.vault_key.into(),
            credential: fixed.credential,
            anthropic: fixed.anthropic,
        });
    }
    let customs = owner_custom_bindings()?;
    if let Some(custom) = customs
        .iter()
        .find(|item| item.id == request.provider && item.url == request.url)
    {
        return Ok(ResolvedBinding {
            vault_key: custom.vault_key.clone(),
            credential: CredentialKind::Bearer,
            anthropic: false,
        });
    }
    Err("provider identity or endpoint is neither compiled into this worker nor declared by the owner".into())
}

struct SecretBytes(Vec<u8>);
impl SecretBytes {
    fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

fn read_secret(vault_key: &str) -> Result<SecretBytes, String> {
    let script = std::env::var_os("ABDO_VAULT_SCRIPT")
        .ok_or_else(|| "provider vault is not configured".to_string())?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("get")
        .arg(vault_key)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "provider vault process unavailable".to_string())?;
    if !output.status.success() || output.stdout.is_empty() || output.stdout.len() > 16_384 {
        return Err("provider credential unavailable".into());
    }
    let mut value = output.stdout;
    while matches!(value.last(), Some(b'\r' | b'\n' | b' ' | b'\t')) {
        value.pop();
    }
    if let Some(position) = value.iter().position(|byte| *byte == b'=') {
        value.drain(..=position);
    }
    if value.is_empty() || value.iter().any(|byte| matches!(*byte, b'\r' | b'\n' | 0)) {
        value.fill(0);
        return Err("provider credential shape refused".into());
    }
    Ok(SecretBytes(value))
}

pub fn has(provider_id: &str) -> Result<bool, String> {
    let vault_key: String =
        if let Some(fixed) = PROVIDERS.iter().find(|item| item.id == provider_id) {
            fixed.vault_key.into()
        } else if let Some(custom) = owner_custom_bindings()?
            .into_iter()
            .find(|item| item.id == provider_id)
        {
            custom.vault_key
        } else {
            return Err(
                "provider identity is neither compiled into this worker nor declared by the owner"
                    .into(),
            );
        };
    let Some(script) = std::env::var_os("ABDO_VAULT_SCRIPT") else {
        return Ok(false);
    };
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("has")
        .arg(&vault_key)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "provider vault process unavailable".to_string())?;
    Ok(status.success())
}

struct TemporaryBody(PathBuf);
impl TemporaryBody {
    fn create(bytes: &[u8]) -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock")?
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("abdo-provider-{}-{nonce}.json", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "provider body staging refused".to_string())?;
        file.write_all(bytes)
            .map_err(|_| "provider body staging failed".to_string())?;
        file.flush()
            .map_err(|_| "provider body flush failed".to_string())?;
        Ok(Self(path))
    }
}
impl Drop for TemporaryBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn curl_path() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\Windows\System32\curl.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("curl")
    }
}

fn config_value(
    config: &mut Vec<u8>,
    option: &[u8],
    name: &[u8],
    value: &[u8],
) -> Result<(), String> {
    if value.is_empty() || value.iter().any(|byte| byte.is_ascii_control()) {
        return Err("provider configuration value refused".into());
    }
    config.extend_from_slice(option);
    config.extend_from_slice(b" = \"");
    config.extend_from_slice(name);
    for byte in value {
        if matches!(*byte, b'\\' | b'\"') {
            config.push(b'\\');
        }
        config.push(*byte);
    }
    config.extend_from_slice(b"\"\n");
    Ok(())
}

fn run_request(request: &Request, provider: &ResolvedBinding) -> Result<(u16, Vec<u8>), String> {
    let secret = read_secret(&provider.vault_key)?;
    let body = TemporaryBody::create(&request.body)?;
    let seconds = request.timeout_ms.div_ceil(1_000).to_string();
    let body_arg = format!("@{}", body.0.display());
    let mut child = Command::new(curl_path())
        .args([
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--no-progress-meter",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-redirs",
            "0",
            "--request",
            "POST",
            "--header",
            "content-type: application/json",
            // curl يرسل `Expect: 100-continue` لكلّ جسدٍ فوق ١ كيلوبايت — جولةٌ زائدة تسيء بعضُ الحوافّ معالجتَها؛ تُكبت كما تفعل عملاءُ OpenAI. (09-14: تعليقُ NIM المتقطّع ~40٪ لم يكن بسببها — قيس ٣×٦.)
            "--header",
            "Expect:",
            "--max-time",
        ])
        .arg(seconds)
        .args(["--connect-timeout", "15", "--data-binary"])
        .arg(body_arg)
        .args([
            "--write-out",
            "\nABDO_HTTP_STATUS:%{http_code}",
            request.url.as_str(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "provider HTTPS client unavailable".to_string())?;
    let header_name = match provider.credential {
        CredentialKind::Bearer => b"authorization: Bearer ".as_slice(),
        CredentialKind::ApiKey => b"x-api-key: ".as_slice(),
    };
    let mut header = Vec::with_capacity(header_name.len() + secret.as_bytes().len());
    header.extend_from_slice(header_name);
    header.extend_from_slice(secret.as_bytes());
    let mut config = Vec::with_capacity(header.len() + 64);
    config_value(&mut config, b"header", b"", &header)?;
    header.fill(0);
    if provider.anthropic {
        config.extend_from_slice(b"header = \"anthropic-version: 2023-06-01\"\n");
    }
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "provider HTTPS stdin unavailable".to_string())?
        .write_all(&config);
    config.fill(0);
    if write_result.is_err() {
        let _ = child.kill();
        return Err("provider HTTPS configuration failed".into());
    }
    let mut output = Vec::new();
    let read_result = child
        .stdout
        .take()
        .ok_or_else(|| "provider HTTPS stdout unavailable".to_string())?
        .take((MAX_RESPONSE_BYTES + 64) as u64)
        .read_to_end(&mut output);
    if read_result.is_err() {
        let _ = child.kill();
        return Err("provider HTTPS response failed".into());
    }
    if output.len() >= MAX_RESPONSE_BYTES + 64 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("provider response exceeds 2 MiB".into());
    }
    let status = child
        .wait()
        .map_err(|_| "provider HTTPS wait failed".to_string())?;
    if !status.success() {
        return Err("provider HTTPS request failed".into());
    }
    let marker = b"\nABDO_HTTP_STATUS:";
    let split = output
        .windows(marker.len())
        .rposition(|window| window == marker)
        .ok_or_else(|| "provider status marker missing".to_string())?;
    let status_text = std::str::from_utf8(&output[split + marker.len()..])
        .map_err(|_| "provider status invalid")?;
    let http_status = status_text
        .parse::<u16>()
        .map_err(|_| "provider status invalid".to_string())?;
    output.truncate(split);
    redact_bytes(&mut output, secret.as_bytes());
    if output.len() > MAX_RESPONSE_BYTES {
        return Err("provider response exceeds 2 MiB".into());
    }
    Ok((http_status, output))
}

fn redact_bytes(output: &mut [u8], secret: &[u8]) {
    if secret.is_empty() {
        return;
    }
    let mut at = 0;
    while at + secret.len() <= output.len() {
        if &output[at..at + secret.len()] == secret {
            output[at..at + secret.len()].fill(b'*');
            at += secret.len();
        } else {
            at += 1;
        }
    }
}

fn run_search_request(request: &SearchRequest) -> Result<(u16, Vec<u8>), String> {
    let api_key = read_secret("abdocode-google-pse-api-key")?;
    let engine_id = read_secret("abdocode-google-pse-engine-id")?;
    let seconds = request.timeout_ms.div_ceil(1_000).to_string();
    let mut config = Vec::with_capacity(1_024);
    config_value(&mut config, b"data-urlencode", b"key=", api_key.as_bytes())?;
    config_value(&mut config, b"data-urlencode", b"cx=", engine_id.as_bytes())?;
    config_value(
        &mut config,
        b"data-urlencode",
        b"q=",
        request.query.as_bytes(),
    )?;
    config_value(
        &mut config,
        b"data-urlencode",
        b"num=",
        request.count.to_string().as_bytes(),
    )?;
    config_value(
        &mut config,
        b"data-urlencode",
        b"safe=",
        if request.safe { b"active" } else { b"off" },
    )?;
    if request.image {
        config_value(&mut config, b"data-urlencode", b"searchType=", b"image")?;
    }
    config_value(
        &mut config,
        b"data-urlencode",
        b"hl=",
        request.language.as_bytes(),
    )?;
    config_value(
        &mut config,
        b"data-urlencode",
        b"gl=",
        request.country.as_bytes(),
    )?;
    let fields: &[u8] = if request.image {
        b"items(title,link,displayLink,snippet,mime,image(contextLink,thumbnailLink,width,height)),searchInformation(totalResults,searchTime),spelling(correctedQuery)"
    } else {
        b"items(title,link,displayLink,snippet),searchInformation(totalResults,searchTime),spelling(correctedQuery)"
    };
    config_value(&mut config, b"data-urlencode", b"fields=", fields)?;
    if !request.site.is_empty() {
        config_value(
            &mut config,
            b"data-urlencode",
            b"siteSearch=",
            request.site.as_bytes(),
        )?;
    }
    let mut child = Command::new(curl_path())
        .args([
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--no-progress-meter",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-redirs",
            "0",
            "--get",
            "--header",
            "accept: application/json",
            "--max-time",
        ])
        .arg(seconds)
        .args([
            "--connect-timeout",
            "15",
            "--write-out",
            "\nABDO_HTTP_STATUS:%{http_code}",
            "https://www.googleapis.com/customsearch/v1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "search HTTPS client unavailable".to_string())?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "search HTTPS stdin unavailable".to_string())?
        .write_all(&config);
    config.fill(0);
    if write_result.is_err() {
        let _ = child.kill();
        return Err("search HTTPS configuration failed".into());
    }
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "search HTTPS stdout unavailable".to_string())?
        .take((MAX_RESPONSE_BYTES + 64) as u64)
        .read_to_end(&mut output)
        .map_err(|_| "search HTTPS response failed".to_string())?;
    if output.len() >= MAX_RESPONSE_BYTES + 64 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("search response exceeds 2 MiB".into());
    }
    let status = child
        .wait()
        .map_err(|_| "search HTTPS wait failed".to_string())?;
    if !status.success() {
        return Err("search HTTPS request failed".into());
    }
    let marker = b"\nABDO_HTTP_STATUS:";
    let split = output
        .windows(marker.len())
        .rposition(|window| window == marker)
        .ok_or_else(|| "search status marker missing".to_string())?;
    let http_status = std::str::from_utf8(&output[split + marker.len()..])
        .map_err(|_| "search status invalid")?
        .parse::<u16>()
        .map_err(|_| "search status invalid".to_string())?;
    output.truncate(split);
    redact_bytes(&mut output, api_key.as_bytes());
    redact_bytes(&mut output, engine_id.as_bytes());
    if !(200..300).contains(&http_status) {
        output.clear();
        output.extend_from_slice(b"{\"error\":\"google-pse-refused\"}");
    }
    Ok((http_status, output))
}

fn encode_response(status: u16, body: &[u8]) -> Result<Vec<u8>, String> {
    let length = u32::try_from(body.len()).map_err(|_| "provider response length")?;
    let mut frame = Vec::with_capacity(11 + body.len());
    frame.extend_from_slice(RESPONSE_MAGIC);
    frame.extend_from_slice(&status.to_be_bytes());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

pub fn run() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|_| "provider frame unreadable".to_string())?;
    let request = decode_request(&input)?;
    let provider = binding(&request)?;
    let (status, body) = run_request(&request, &provider)?;
    encode_response(status, &body)
}

pub fn run_search() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(2_049)
        .read_to_end(&mut input)
        .map_err(|_| "search frame unreadable".to_string())?;
    let request = decode_search_request(&input)?;
    let (status, body) = run_search_request(&request)?;
    encode_response(status, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_table_has_no_duplicate_or_unowned_endpoint() {
        // 09-14: الجدولُ ١٦ مزوّداً (مسمارٌ قديم عند ١٤ لم يُرفع مع إضافة مزوّدين) — يُرفع بصدقٍ مع فحص التفرّد أدناه.
        assert_eq!(PROVIDERS.len(), 16);
        for (index, item) in PROVIDERS.iter().enumerate() {
            assert!(item.url.starts_with("https://"));
            assert!(PROVIDERS[..index]
                .iter()
                .all(|prior| prior.id != item.id && prior.url != item.url));
        }
    }

    #[test]
    fn custom_bindings_accept_a_valid_owner_entry() {
        let parsed = parse_custom_bindings(
            "my-provider|https://api.example.com/v1/chat/completions|custom-my-provider-api-key",
        )
        .expect("valid entry");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "my-provider");
        assert_eq!(parsed[0].vault_key, "custom-my-provider-api-key");
    }

    #[test]
    fn deepseek_binding_materializes_only_its_own_vault_handle() {
        let request = Request {
            provider: "deepseek".into(),
            url: "https://api.deepseek.com/chat/completions".into(),
            timeout_ms: 30_000,
            body: br#"{"model":"deepseek-v4-flash","messages":[]}"#.to_vec(),
        };
        let resolved = binding(&request).expect("compiled DeepSeek binding");
        assert_eq!(resolved.vault_key, "abdocode-deepseek");
        assert_eq!(resolved.credential, CredentialKind::Bearer);
        assert!(!resolved.anthropic);
        let spoofed = Request { url: "https://evil.example/chat/completions".into(), ..request };
        assert!(binding(&spoofed).is_err());
    }

    #[test]
    fn qwen_plan_bindings_keep_billing_endpoints_and_vault_handles_separate() {
        let token = Request {
            provider: "qwen-token-plan".into(),
            url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions".into(),
            timeout_ms: 30_000, body: br#"{"model":"qwen3.7-plus","messages":[]}"#.to_vec(),
        };
        let coding = Request {
            provider: "qwen-coding-plan".into(),
            url: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions".into(),
            timeout_ms: 30_000, body: token.body.clone(),
        };
        assert_eq!(binding(&token).unwrap().vault_key, "abdocode-qwen-token-plan");
        assert_eq!(binding(&coding).unwrap().vault_key, "abdocode-qwen-coding-plan");
        let cross_plan = Request { url: coding.url.clone(), ..token };
        assert!(binding(&cross_plan).is_err());
        let payg = Request { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions".into(), ..coding };
        assert!(binding(&payg).is_err());
    }

    #[test]
    fn expanded_owner_directory_is_bounded_and_rejects_embedded_credentials() {
        let entries: Vec<String> = (0..64).map(|index| format!(
            "provider-{index}|https://provider-{index}.example/v1/chat/completions|custom-provider-{index}"
        )).collect();
        assert_eq!(parse_custom_bindings(&entries.join(";")).expect("64 owner bindings").len(), 64);
        assert!(parse_custom_bindings(&format!("{};overflow|https://overflow.example/v1/chat/completions|custom-overflow", entries.join(";"))).is_err());
        assert!(parse_custom_bindings("provider|https://user:password@api.example/v1/chat/completions|custom-provider").is_err());
        assert!(parse_custom_bindings("provider|https://api.example/v1?secret=x/chat/completions|custom-provider").is_err());
    }

    #[test]
    fn custom_bindings_fail_closed_on_any_malformed_entry() {
        // http scheme refused by name.
        assert!(parse_custom_bindings(
            "p|http://api.example.com/v1/chat/completions|custom-p-api-key"
        )
        .is_err());
        // endpoint must be the OpenAI-compatible chat path.
        assert!(parse_custom_bindings("p|https://api.example.com/v1|custom-p-api-key").is_err());
        // colliding with a compiled provider id is refused.
        assert!(parse_custom_bindings(
            "openai|https://evil.example.com/v1/chat/completions|custom-openai-api-key"
        )
        .is_err());
        // a missing field refuses the whole list, valid siblings included.
        assert!(parse_custom_bindings(
            "good|https://api.example.com/v1/chat/completions|custom-good-api-key;bad|nope"
        )
        .is_err());
        // naming a compiled provider's vault handle is refused — the
        // custom channel must never exfiltrate a compiled secret.
        assert!(parse_custom_bindings(
            "p|https://api.example.com/v1/chat/completions|abdocode-openai"
        )
        .is_err());
        // and the custom- prefix is mandatory even for novel handles.
        assert!(
            parse_custom_bindings("p|https://api.example.com/v1/chat/completions|my-key-name")
                .is_err()
        );
        // duplicate id or endpoint is refused.
        assert!(parse_custom_bindings(
            "p|https://api.example.com/v1/chat/completions|k-one;p|https://api.other.com/v1/chat/completions|k-two"
        )
        .is_err());
    }

    #[test]
    fn custom_bindings_absent_env_means_no_customs_not_an_error() {
        assert_eq!(parse_custom_bindings("").expect("empty list"), Vec::new());
    }
}
