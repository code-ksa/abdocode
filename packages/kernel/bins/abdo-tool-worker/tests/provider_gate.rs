use std::io::Write;
use std::process::{Command, Stdio};

fn provider_frame(provider: &str, url: &str, body: &str) -> Vec<u8> {
    let mut frame = b"ABPM1".to_vec();
    for value in [provider, url] {
        frame.extend_from_slice(&(value.len() as u16).to_be_bytes());
        frame.extend_from_slice(value.as_bytes());
    }
    frame.extend_from_slice(&1_000_u32.to_be_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body.as_bytes());
    frame
}

fn search_frame(query: &str) -> Vec<u8> {
    let mut frame = b"ABGS2".to_vec();
    for value in [query, "", "ar", "sa"] {
        frame.extend_from_slice(&(value.len() as u16).to_be_bytes());
        frame.extend_from_slice(value.as_bytes());
    }
    frame.push(5);
    frame.push(1);
    frame.push(0);
    frame.extend_from_slice(&1_000_u32.to_be_bytes());
    frame
}

#[test]
fn provider_mode_refuses_unknown_endpoints_and_missing_vault_before_network() {
    for (provider, url, expected) in [
        (
            "openai",
            "https://api.openai.com/v1/chat/completions",
            "vault is not configured",
        ),
        (
            "openai",
            "https://evil.invalid/v1/chat/completions",
            "neither compiled into this worker nor declared by the owner",
        ),
        (
            "deepseek",
            "https://api.deepseek.com/chat/completions",
            "vault is not configured",
        ),
        (
            "deepseek",
            "https://evil.invalid/chat/completions",
            "neither compiled into this worker nor declared by the owner",
        ),
        (
            "qwen-token-plan",
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
            "vault is not configured",
        ),
        (
            "qwen-coding-plan",
            "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
            "vault is not configured",
        ),
        (
            "qwen-token-plan",
            "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
            "neither compiled into this worker nor declared by the owner",
        ),
        (
            "qwen-coding-plan",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            "neither compiled into this worker nor declared by the owner",
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_abdo-tool-worker"))
            .arg("provider")
            .env_remove("ABDO_VAULT_SCRIPT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("worker binary");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(&provider_frame(provider, url, "{}"))
            .expect("request");
        let output = child.wait_with_output().expect("worker exit");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
    }
}

#[test]
fn provider_mode_admits_owner_declared_custom_endpoint_up_to_vault_and_no_further() {
    // A request matching the owner declaration passes identity and stops at
    // the vault (no network without a credential); any mismatch is refused.
    for (provider, url, expected) in [
        (
            "my-provider",
            "https://api.example.com/v1/chat/completions",
            "vault is not configured",
        ),
        (
            "my-provider",
            "https://api.other.com/v1/chat/completions",
            "neither compiled into this worker nor declared by the owner",
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_abdo-tool-worker"))
            .arg("provider")
            .env_remove("ABDO_VAULT_SCRIPT")
            .env(
                "ABDO_CUSTOM_PROVIDERS",
                "my-provider|https://api.example.com/v1/chat/completions|custom-my-provider-api-key",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("worker binary");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(&provider_frame(provider, url, "{}"))
            .expect("request");
        let output = child.wait_with_output().expect("worker exit");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
    }
}

#[test]
fn search_mode_is_bounded_and_refuses_missing_vault_before_network() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_abdo-tool-worker"))
        .arg("provider-search")
        .env_remove("ABDO_VAULT_SCRIPT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worker binary");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&search_frame("اختبار محلي"))
        .expect("request");
    let output = child.wait_with_output().expect("worker exit");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("vault is not configured"));
}
