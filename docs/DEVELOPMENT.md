# Development

## Requirements

- Bun 1.3 or newer
- Rust stable
- On Windows: Visual Studio Build Tools (C++), WebView2 runtime (ships with Windows 11), and for the installer NSIS through the Tauri CLI

## Everyday commands

```powershell
bun install --frozen-lockfile
bun run structure      # composition manifest and structure gates
bun run typecheck      # TypeScript (turbo) + cargo check
```

Engine tests (about 2,300 tests, a few minutes; live tests spawn the real engine over framed stdio against fake providers and a fake CDP browser):

```powershell
$env:ABDO_TEST_NATIVE_BINARY_DIR = "<repo>\packages\desktop\src-tauri\payload\bin"
bun test packages/engine/test packages/engine-host/test packages/memory/test packages/providers/test packages/tools/test packages/transport-contracts/test packages/browser/test
```

Rust:

```powershell
cargo test --manifest-path packages/kernel/Cargo.toml
cargo test --manifest-path packages/kernel/bins/abdo-tool-worker/Cargo.toml
```

## Building the installer

`prepare.ts` compiles the engine into `packages/desktop/src-tauri/payload/abdocode.exe` and bundles the UI; the Tauri CLI then produces the NSIS installer under `packages/desktop/src-tauri/target/release/bundle/nsis/`.

```powershell
cd packages/desktop
bun run prepare
bunx @tauri-apps/cli build
```

The version lives in three files that must agree: `packages/desktop/package.json`, `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json`.

## Testing philosophy

- Every guard has a positive twin: a test that proves the guarded path is actually exercised, so a green negative test cannot mean "nothing happened".
- Live tests judge from disk and from the ledger, not from a function's return value.
- Source pins: some tests assert exact source lines in `cli.ts` to keep wiring order honest (for example, a guard that must run before a diff preview). When a pin fails after a deliberate change, update the pin with the reason.
- Line endings are mixed on purpose (`core.autocrlf=true`). Measure a file's endings before editing it; a wrong ending on one line produces a whole-file diff.

## Layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the package map and the engine loop, and [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md) for the stdio protocol.

## Provenance

Everything in this repository was written here. Some ideas were read in open projects and rewritten in our own way, in our own words, and credited in `legal/THIRD-PARTY-LICENSES.md`. No upstream code, prompts or dependencies were copied in.
