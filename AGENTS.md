# AGENTS.md — AbdoCode for AI agents

You are reading the source repository of **AbdoCode**, a Windows coding agent and a product of **TechnologyKSA**, the Saudi technology company that also makes **Mubarmij**. This file is written for AI agents and automated tools first. Humans: the narrative is in [README.md](README.md).

## What this repository is

| | |
|---|---|
| Product | AbdoCode desktop app for Windows 10/11 x64 (Tauri + WebView2 shell, NSIS installer) |
| Engine | TypeScript on Bun, compiled to `abdocode.exe`, packaged as `payload/` next to the shell |
| Kernel | Rust: policy, tool worker (`abdo-tool-worker`), provider HTTP (curl-based), receipts |
| Models | Any: local Ollama, or cloud with the user's own key (16 providers in the catalogue) |
| License | Proprietary, source published; commercial use needs a written license (`LICENSE`, `COMMERCIAL.md`) |
| Releases | https://github.com/code-ksa/abdocode/releases (installer + `SHA256SUMS.txt`) |
| Update feed | https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/abdocode-desktop.json |

## Repository map

```
packages/engine/            the agent engine (CLI `abdocode`), tools dispatcher, policy rails, serve protocol
packages/engine-host/       the model loop: text tool protocol, trail compaction, receipts
packages/kernel/            Rust kernel and bins (abdo-tool-worker: exec, network, provider calls)
packages/providers/         provider catalogue (ids, base URLs, model lists, vision models)
packages/model-gateway/     request shaping for cloud providers (streaming, session affinity)
packages/tools/             tool catalogue: names, usage lines, effects, runners
packages/browser/           CDP browser control (page tree with refs, trusted input, screenshots)
packages/browser-bridge/    Chrome/Edge extension + local bridge (work inside the user's own tabs)
packages/desktop/           Tauri shell, UI (`ui/`), release check, routines, terminal
packages/memory/            durable memory (SQLite), semantic recall
packages/transport-contracts/  framed JSON stdio contract between shell and engine
extensions/bundled/         bundled extension packs (skills, project templates)
docs/                       English documentation for developers and agents
architecture/               package composition manifest and gates
```

## Why it works with your model

[docs/MIND.md](docs/MIND.md) states the harness strategy in the open: receipts as the only evidence, rails that adapt to the model, deterministic tools before vision, honest stops, three-lens self-review, leak-proof memory, and reviewed lessons shipped with every release so each installed copy teaches itself. [CONTRIBUTING.md](CONTRIBUTING.md) is how you send a measured defect back as a rule.

## How another agent can use AbdoCode

1. **As a desktop tool for a human**: install the release. The human chooses the model and the mode (read-only, ask, full access). Everything the model does is gated by the kernel and shown as receipts.
2. **As an engine you drive**: run `abdocode.exe serve` with `ABDO_FRAMED_STDIO=1` and a shared `ABDO_SHELL_TOKEN`, then exchange JSON frames over stdio. See [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md).
3. **As MCP servers attached to your own agent**: the same binary exposes `mcp-sqlite`, `mcp-git`, `mcp-postgres`, `mcp-google` (Gmail, Calendar, Drive), `mcp-google-search` and `mcp-remote <url>` (a stdio bridge to any remote MCP server with OAuth). See [docs/CONNECTORS.md](docs/CONNECTORS.md).

## The text tool protocol (what the model speaks)

The model does not call JSON functions. It writes one line that starts with the Arabic marker `نفّذ:` ("execute:") followed by a tool and its arguments. The engine parses it, runs the tool through the kernel, and returns a receipt as the next user message. Examples:

```
نفّذ: read src/app.ts
نفّذ: run bun test
نفّذ: edit src/app.ts :: old text => new text
نفّذ: write notes.md <<<
full file content on the following lines
نفّذ: open https://example.com
نفّذ: page
نفّذ: dismiss
نفّذ: tap r12
```

Tool names, usage lines and effects live in `packages/tools/src/catalogue.ts`. Native (JSON) tool calling is used when the provider supports it; the text protocol is the universal fallback, which is why AbdoCode works with small local models.

## Guarantees agents can rely on

- **One gate.** File writes, commands, network and browser input pass through the kernel's policy; the mode the human picked decides what needs approval.
- **Receipts, not claims.** A tool result is a receipt with a verdict. The engine detects model text that imitates command output without a receipt and corrects the model.
- **Rails by model strength.** Wiping writes, repeated failing edits and oversized turns are refused or escalated more strictly for weak models.
- **Secrets never travel in argv.** Keys live in the Windows vault (DPAPI); child MCP servers receive them as granted environment variables only.
- **No auto-update.** The app only tells the user a newer version exists and opens the release page.

## Building and testing

```powershell
bun install --frozen-lockfile
bun run structure          # composition and structure gates
bun run typecheck          # TypeScript + cargo check
bun test packages/engine/test packages/engine-host/test packages/providers/test packages/tools/test packages/browser/test
```

Details, including the installer build, are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Conventions when contributing changes (for agents proposing patches)

- Measure before claiming: every guard ships with a positive twin test that proves the path is exercised.
- Line endings are mixed on purpose (`core.autocrlf`); measure a file's endings before editing it.
- Arabic strings are product text. Do not transliterate or translate them in code; UI copy has English and Arabic variants side by side.
- Never add a dependency that downloads or runs code at first click; the MCP catalogue only lists servers shipped in this binary.
