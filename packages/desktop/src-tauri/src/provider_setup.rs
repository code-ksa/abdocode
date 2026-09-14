//! Local provider onboarding. Credential material never enters a renderer response.
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// النموذجُ الافتراضيّ للتثبيت الطازج — نسخةُ الجانب الأصليّ من `DEFAULT_MODEL` في
/// `packages/providers/src/catalog.ts`. الحقيقةُ هناك؛ وبوّابةُ التكافؤ (`provider-parity-gate`)
/// تحمرّ إن اختلفت القيمتان، فلا يبقى في سطح المكتب افتراضيٌّ ثانٍ ينحرف بصمت.
pub(crate) const DEFAULT_MODEL: &str = "qwen-token-plan/qwen3.7-plus";

fn credential_variables(key: &str) -> Result<&'static [&'static str], String> {
    match key {
        "abdocode-qwen-token-plan" => Ok(&["ABDO_WORKER_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"]),
        "abdocode-qwen-coding-plan" => Ok(&["QWEN_CODING_PLAN_API_KEY"]),
        "abdocode-deepseek" => Ok(&["DEEPSEEK_API_KEY", "ABDO_DEEPSEEK_API_KEY"]),
        "abdocode-dashscope" => Ok(&["DASHSCOPE_API_KEY"]),
        "abdocode-openai" => Ok(&["OPENAI_API_KEY"]),
        "abdocode-anthropic" => Ok(&["ANTHROPIC_API_KEY"]),
        _ => {
            Err("This provider requires direct key entry; no import mapping is configured.".into())
        }
    }
}

fn credential_from_export(text: &str, key: &str) -> Result<String, String> {
    let names = credential_variables(key)?;
    let mut found: Option<String> = None;
    let mut worker_base: Option<String> = None;
    let mut used_worker = false;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        let Some((name, raw)) = line.split_once('=') else {
            continue;
        };
        let raw = raw.trim();
        let value = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            &raw[1..raw.len() - 1]
        } else {
            raw
        };
        if name.trim() == "ABDO_WORKER_BASE_URL" {
            worker_base = Some(value.into());
        }
        if !names.contains(&name.trim()) {
            continue;
        }
        if name.trim() == "ABDO_WORKER_API_KEY" {
            used_worker = true;
        }
        super::vault_value(value)?;
        if found.as_ref().is_some_and(|previous| previous != value) {
            return Err("The file contains conflicting provider credentials.".into());
        }
        found = Some(value.into());
    }
    if used_worker
        && worker_base.as_deref().map(|s| s.trim_end_matches('/'))
            != Some("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")
    {
        return Err(
            "The worker credential is not associated with the Qwen Token Plan endpoint.".into(),
        );
    }
    found.ok_or_else(|| "No credential for this provider was found in the selected export.".into())
}

fn import_export(path: &Path, key: &str) -> Result<(), String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| "Could not read the selected credential export.")?;
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err("Select a provider export smaller than 1 MiB.".into());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| "The export must be a UTF-8 environment file.")?;
    let value = credential_from_export(&text, key)?;
    super::vault_write(&super::vault_script()?, key, &value)
}

#[tauri::command]
pub(crate) async fn provider_import_local(key: String) -> Result<bool, String> {
    credential_variables(&key)?;
    let file = rfd::AsyncFileDialog::new()
        .set_title("Import existing provider credential (kept in the native vault)")
        .pick_file()
        .await;
    let Some(file) = file else {
        return Ok(false);
    };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || import_export(&path, &key))
        .await
        .map_err(|_| "Credential import stopped.".to_string())??;
    Ok(true)
}

#[derive(serde::Serialize)]
pub(crate) struct LocalStatus {
    running: bool,
    models: Vec<String>,
}

fn local_status() -> LocalStatus {
    let response = (|| -> Result<Vec<String>, ()> {
        let addr: SocketAddr = "127.0.0.1:11434".parse().map_err(|_| ())?;
        let mut socket =
            TcpStream::connect_timeout(&addr, Duration::from_millis(500)).map_err(|_| ())?;
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| ())?;
        socket
            .write_all(b"GET /api/tags HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .map_err(|_| ())?;
        let mut bytes = Vec::new();
        socket
            .take(1_048_576)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        let raw = std::str::from_utf8(&bytes).map_err(|_| ())?;
        let (head, body) = raw.split_once("\r\n\r\n").ok_or(())?;
        if !head.lines().next().unwrap_or("").contains(" 200 ") {
            return Err(());
        }
        let value: serde_json::Value = serde_json::from_str(body).map_err(|_| ())?;
        let models = value["models"]
            .as_array()
            .ok_or(())?
            .iter()
            .filter_map(|m| m["name"].as_str().map(String::from))
            .collect();
        Ok(models)
    })();
    match response {
        Ok(models) => LocalStatus {
            running: true,
            models,
        },
        Err(_) => LocalStatus {
            running: false,
            models: vec![],
        },
    }
}

#[tauri::command]
pub(crate) async fn provider_local_status() -> Result<LocalStatus, String> {
    tauri::async_runtime::spawn_blocking(local_status)
        .await
        .map_err(|_| "Could not inspect the local model service.".into())
}

#[tauri::command]
pub(crate) async fn provider_local_start() -> Result<LocalStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let status = local_status();
        if status.running {
            return Ok(status);
        }
        let root = std::env::var_os("LOCALAPPDATA")
            .ok_or("Windows local application directory is unavailable.")?;
        let binary = PathBuf::from(root).join("Programs/Ollama/ollama.exe");
        if !binary.is_file() {
            return Err("Ollama is not installed. Install it, then refresh local models.".into());
        }
        let mut command = Command::new(binary);
        command.arg("serve").env("OLLAMA_HOST", "127.0.0.1:11434");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| "Could not start Ollama.")?;
        for _ in 0..32 {
            std::thread::sleep(Duration::from_millis(250));
            let status = local_status();
            if status.running {
                return Ok(status);
            }
            if child
                .try_wait()
                .map_err(|_| "Could not inspect Ollama startup.")?
                .is_some()
            {
                break;
            }
        }
        Err("Ollama has not become ready. Check its local service and retry refresh.".into())
    })
    .await
    .map_err(|_| "Local service startup stopped.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_the_selected_provider_and_keeps_equals() {
        assert_eq!(
            credential_from_export(
                "OTHER_KEY=other\nDEEPSEEK_API_KEY=\"test==\"",
                "abdocode-deepseek"
            )
            .unwrap(),
            "test=="
        );
        assert!(credential_from_export("DEEPSEEK_API_KEY=x", "abdocode-dashscope").is_err());
        assert!(credential_from_export(
            "DEEPSEEK_API_KEY=x\nDEEPSEEK_API_KEY=y",
            "abdocode-deepseek"
        )
        .is_err());
    }
    #[test]
    fn token_plan_never_reuses_a_generic_or_coding_plan_key() {
        let valid="ABDO_WORKER_API_KEY=test\nABDO_WORKER_BASE_URL=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
        assert_eq!(
            credential_from_export(valid, "abdocode-qwen-token-plan").unwrap(),
            "test"
        );
        assert!(
            credential_from_export("ABDO_WORKER_API_KEY=test", "abdocode-qwen-token-plan").is_err()
        );
        assert!(credential_from_export(valid, "abdocode-qwen-coding-plan").is_err());
        assert!(
            credential_from_export("DASHSCOPE_API_KEY=test", "abdocode-qwen-token-plan").is_err()
        );
    }
}
