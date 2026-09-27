# AbdoCode for VS Code

Run AbdoCode agent tasks on the open project without leaving the editor.

- **AbdoCode: Run task…** — type a task; it runs in the workspace folder.
- **AbdoCode: Ask about selection…** — the selected code travels with its file and line range.

Every task runs through `abdocode exec` — the same gates, kernel and ledger as the desktop app. Progress streams to
the **AbdoCode** output channel; the answer, the tools used and anything refused follow at the end.

## Requirements

The AbdoCode desktop app (the extension finds `%LOCALAPPDATA%\AbdoCode\payload\abdocode.exe`), or set
`abdocode.enginePath`. The extension reads the desktop app's models and vault from `%APPDATA%\io.abdocode.desktop`
(`abdocode.profileDir` to change it) and keeps its **own** engine state (`engine-state-vscode`): two engines on one
ledger break its sequencing.

## Permissions

Nobody approves inside the editor. `abdocode.mode` (default `auto`) decides what runs; a request that needs approval
is refused and listed in the report — widen the mode deliberately if you want it allowed.

## Install (unpublished)

Copy this folder to `%USERPROFILE%\.vscode\extensions\code-ksa.abdocode-vscode-0.1.0` and reload VS Code, or package it
with `npx @vscode/vsce package` and install the `.vsix`. It is not on the Marketplace.
