# Driving AbdoCode from your own agent

AbdoCode's engine is a single executable, `abdocode.exe` (installed under `%LOCALAPPDATA%\AbdoCode\payload\`). The desktop shell talks to it over stdio with framed JSON. Any other program, including another AI agent, can do the same.

## Starting the engine

```powershell
$env:ABDO_FRAMED_STDIO = "1"          # framed JSON on stdout instead of a text console
$env:ABDO_SHELL_TOKEN  = "<random>"   # shared secret; the first frame must carry it
$env:ABDO_CODE_STATE_DIR = "C:\path\to\state"   # optional: isolated state (ledger, memory, locks)
$env:ABDO_CODE_SETTINGS  = "C:\path\to\settings.json"   # optional: isolated settings
& "$env:LOCALAPPDATA\AbdoCode\payload\abdocode.exe" serve
```

Optional environment:

- `ABDO_DESKTOP_OWNER_PID`: the engine exits on its own when this process dies (no orphaned engines holding the state lock).
- `ABDO_SERVE_IDLE_EXIT_MS`: exit after this much idle time with no running turn.
- `ABDO_REQUIRE_PROJECT=1`: refuse turns until a project folder is set and trusted.

Only one engine may own a state directory at a time; a second one is refused with a named reason.

## Wire format

Each frame is a 4-byte big-endian length followed by UTF-8 JSON. The reference encoder and decoder are `encodeLocalJsonFrame` and `LocalJsonFrameDecoder` in `packages/transport-contracts`. Diagnostics go to stderr; stdout carries frames only.

## Handshake and a turn

```jsonc
→ { "kind": "hello", "shell": "desktop", "token": "<random>" }
← { "kind": "ready", "name": "عبدو كود", "version": "…", "sessionId": "…", "settings": { … } }

→ { "kind": "project-set", "path": "C:\\Projects\\my-app" }
← { "kind": "trust-request", "path": "…" }          // first time only
→ { "kind": "trust-grant", "path": "C:\\Projects\\my-app" }
← { "kind": "project", "path": "…", "trusted": true }

→ { "kind": "mode-set", "mode": "full-access" }     // read-only | ask | full-access
← { "kind": "mode", "mode": "full-access" }

→ { "kind": "submit", "turn": { "id": "t1", "body": "add a README for this project" } }
← { "kind": "event", "turnId": "t1", "seq": 12, "payload": "⚙ read package.json" }   // many
← { "kind": "done", "turnId": "t1", "answer": "…" }  // or "refused" / "unresolved" with a reason
```

Other inbound kinds the engine understands include `interrupt`, `approve` / `deny` (for gated actions when the mode asks), `history`, `resume`, `session-new`, `model-set`, `models`, `memory-note` / `memory-list` / `memory-forget`, `recall`, `connector-list` / `connector-auth` / `connector-forget`, `external-connect` / `external-disconnect` (MCP servers), `servers` / `server-stop`, `remote-control-get`, and `meter-get`. The authoritative list is the `frame.kind === "…"` switch in `packages/engine/src/cli.ts`.

## Events you will see

Events are Arabic product text with a leading glyph so they can be filtered without parsing prose:

| Prefix | Meaning |
|---|---|
| `⚙` | a tool call started (`⚙ read guide.md`) |
| `✍` | a write or edit receipt with byte counts |
| `↻` | epoch progress line |
| `✓ نقطة حفظ الحقبة` | epoch checkpoint: tool count, stop reason, compaction counters, trail size |
| `⏱` | turn budget line (effective tokens / cap, calls, largest call) |
| `⚠` | a guard fired (fabricated output, wiping write, refusal escalation) |
| `🔍` | review verdict from the review lane |
| `💳` | cloud spend meter |

## The text tool protocol

The model answers with a line beginning with `نفّذ:` followed by a tool. This is what makes small local models usable: no JSON function calling is required. The full catalogue, with usage lines and effects, is `packages/tools/src/catalogue.ts`. Tool families that are not relevant to the request (browser, desktop control, delegation) are hidden from the model until its intent names them, which saves tokens.

## Operator words

Some inputs are handled by the engine without a model call, for example `review` / `راجع تغييراتي` (three-lens review of the turn's diff), `checkpoints`, `rollback`, `status`, `browser owned|extension|off`, and `surface <port>`.
