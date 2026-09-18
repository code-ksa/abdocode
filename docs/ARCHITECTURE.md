# Architecture

## One sentence

A TypeScript engine runs the model loop and the tools; a Rust kernel executes effects and judges them; a Tauri shell shows receipts to the human and never touches the model directly.

## Packages

| Package | Role |
|---|---|
| `packages/engine` | The `abdocode` CLI: `serve` (framed stdio for the shell and for other agents), tool dispatch, policy rails, checkpoints and rollback, review lane, connectors, routines, remote control, built-in MCP servers |
| `packages/engine-host` | The text agent loop: parses the `نفّذ:` tool protocol, replays cached reads, digests old read/exec/write messages in the trail (prefix-preserving compaction), records receipts |
| `packages/kernel` | Rust: policy and receipts; `bins/abdo-tool-worker` executes commands, network fetches and provider HTTP calls (curl), so no TypeScript code holds a provider key |
| `packages/providers` | Provider catalogue (16 providers), model lists, vision-capable models, session-affinity allowlist |
| `packages/model-gateway` | Request shaping: streaming, retries with bounded backoff, session affinity headers |
| `packages/tools` | Tool catalogue: names, aliases, usage lines, effect classes, runners |
| `packages/browser` | CDP control of the owned Edge: page tree with stable refs, trusted input events, screenshots, dialog policy |
| `packages/browser-bridge` | Chrome/Edge extension plus a local bridge so the agent can read and tap inside the user's own tabs (no typing there, ever) |
| `packages/desktop` | Tauri shell and UI, engine lifecycle, release check, terminal, routines scheduler |
| `packages/memory` | Durable memory (SQLite) and semantic recall |
| `packages/transport-contracts` | The framed JSON contract between shell and engine |

## The loop

1. The shell submits a turn. The engine classifies intent (language, verb, target) and decides which tool families to expose.
2. The model answers. If the answer contains a `نفّذ:` line, the engine parses it and dispatches the tool through the kernel with the current mode. The receipt (with a verdict) is appended as the next user message; the model continues.
3. Guards run around every effect: wiping-write refusal, edit refusal escalation with nearest-line hints, fabricated-output detection, budget notice at 75% of the turn cap, bounded provider retries.
4. Old tool results and old full-file write payloads are digested in place (size + fingerprint) so long turns keep a stable prompt prefix without losing receipts.
5. The turn ends with a checkpoint line, the spend meter, and a rollback point.

## Rails by model strength

`rail-policy.ts` maps the active model to a tier: strict, medium or thin. Weak models get stricter thresholds (a write that keeps less than 25% of a file is refused unless `--shrink` is stated; the first failed edit already advises a full rewrite), strong models get thinner rails. The tier is automatic; the user can pin it in settings.

## Browser

Two backends share one vocabulary (`open`, `page`, `find`, `tap`, `fill`, `key`, `scroll`, `shot`, `dismiss`):

- **Owned**: a separate Edge profile controlled over CDP. Clicks are trusted input events at the element's verified position; refs are re-checked after approval.
- **Extension**: the user's own Chrome/Edge through the bridge. Reading and tapping only; typing is refused by design.

`shot` sends a screenshot to the pane and to the vision model on the next call; `image <file>` does the same for an image saved in the project.

## Desktop control

`desk` (screenshot, windows, focus, click, type, key, scroll) is implemented with PowerShell and Win32 on the user's own desktop. It is off by default, requires a bound window for every input action, and every action is gated.
