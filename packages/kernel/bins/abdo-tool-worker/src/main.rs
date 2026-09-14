#![forbid(unsafe_code)]

//! The real tool boundary.
//!
//! It consumes one bounded ToolSpec frame, admits it through the canonical Rust
//! ToolCatalog and writes the actual isolation report. It does not accept a
//! caller-selected executable: the only handler is compiled into this binary.
//! Unknown handlers and irreversible work on an unenforced host fail closed.

use std::io::{Read, Write};

use abdo_contracts::{
    decode_frame, encode_frame, label_digest, Digest, EnforcementReport, ToolSpec,
};
use abdo_runtime::{CompiledBoundary, ToolCatalog};
use abdo_tools::{adapter_kind, RegistrationError};

mod provider;

const MAX_FRAME_BYTES: usize = 65_536;

fn builtin_handler() -> Digest {
    label_digest(b"abdo-bounded-tool")
}

fn run() -> Result<EnforcementReport, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_FRAME_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("unreadable frame: {error}"))?;
    if input.len() > MAX_FRAME_BYTES {
        return Err("frame exceeds the worker limit".into());
    }

    let spec: ToolSpec = decode_frame(&input).map_err(|error| error.to_string())?;
    if spec.handler_digest != builtin_handler() {
        return Err("handler is not compiled into this worker".into());
    }
    if adapter_kind(&spec).is_none() {
        return Err("adapter name or effect class is not compiled into this worker".into());
    }

    let sandbox = CompiledBoundary::new(
        label_digest(b"compiled-adapter-boundary-v1"),
        label_digest(b"application-controls-only-no-os-sandbox"),
    );
    let mut catalog = ToolCatalog::new();
    catalog.install_handler(builtin_handler());
    catalog
        .register(spec, &sandbox)
        .map_err(|error| match error {
            RegistrationError::NoHandler { .. } => "handler unavailable".into(),
            RegistrationError::Duplicate { .. } => "duplicate tool".into(),
            RegistrationError::Unenforceable { .. } => {
                "irreversible tool refused without enforceable isolation".into()
            }
        })
}

fn main() -> std::process::ExitCode {
    if std::env::args().nth(1).as_deref() == Some("provider-has") {
        let provider_id = std::env::args().nth(2).unwrap_or_default();
        return match provider::has(&provider_id) {
            Ok(found) => {
                if std::io::stdout()
                    .lock()
                    .write_all(if found { b"1" } else { b"0" })
                    .is_ok()
                {
                    std::process::ExitCode::SUCCESS
                } else {
                    std::process::ExitCode::FAILURE
                }
            }
            Err(error) => {
                eprintln!("abdo-tool-worker provider-has: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    if std::env::args().nth(1).as_deref() == Some("provider") {
        return match provider::run() {
            Ok(frame) if std::io::stdout().lock().write_all(&frame).is_ok() => {
                std::process::ExitCode::SUCCESS
            }
            Ok(_) => std::process::ExitCode::FAILURE,
            Err(error) => {
                eprintln!("abdo-tool-worker provider: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    if std::env::args().nth(1).as_deref() == Some("provider-search") {
        return match provider::run_search() {
            Ok(frame) if std::io::stdout().lock().write_all(&frame).is_ok() => {
                std::process::ExitCode::SUCCESS
            }
            Ok(_) => std::process::ExitCode::FAILURE,
            Err(error) => {
                eprintln!("abdo-tool-worker provider-search: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    let report = match run() {
        Ok(report) => report,
        Err(error) => {
            eprintln!("abdo-tool-worker: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let encoded = match encode_frame(&report) {
        Ok(encoded) => encoded,
        Err(error) => {
            eprintln!("abdo-tool-worker: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    if std::io::stdout().lock().write_all(&encoded).is_err() {
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}
