---
name: rust-analyzer-setup
description: Set up rust-analyzer as the Rust language server for an Abdo Code project — install, verify, and read diagnostics, definitions and references from it while working on Rust code.
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). The origin plugin only carried an LSP configuration file; this text is ours. -->

# rust-analyzer for Abdo Code

Use this skill when the project contains `Cargo.toml` and you need language intelligence (errors, types, go-to-definition, references) while editing Rust.

## 1. Install and verify

1. Check the toolchain: run `rustup component list --installed` and confirm `rust-analyzer` is present; otherwise run `rustup component add rust-analyzer`.
2. Confirm the binary answers: run `rust-analyzer --version`.
3. Confirm the crate builds before trusting diagnostics: run `cargo check` — a broken build produces misleading LSP noise.

## 2. Use it from Abdo Code

- Prefer `cargo check` and `cargo clippy --all-targets` receipts over guessing: every fix ends with a green `cargo check`.
- When Abdo Code's `lsp` tool is available in the tool registry, ask for `lsp diagnostics <file>` after each edit and `lsp refs <symbol>` before renaming; when it is not, use `grep` for references and `cargo check` for diagnostics.
- Never edit `Cargo.lock` by hand; let `cargo` regenerate it.

## 3. Acceptance gates for Rust work

- Build: `cargo build`
- Types/lints: `cargo clippy --all-targets -- -D warnings`
- Tests: `cargo test`

Report which gate ran and its exit code — a gate that did not run is "unverified", not "passed".
