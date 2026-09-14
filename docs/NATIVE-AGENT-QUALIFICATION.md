# Native local-agent qualification

Date: 2026-08-30. Local development only. No upstream code, prompt, dependency,
service discovery, or hosted product was imported. This document records ideas,
not a ranking or a claim that every open-source solution has been evaluated.

## Observed failure

The execution lane supplied tool descriptions as prose but did not send native
schemas. The response reader rejected structured calls. Text commands mixed
source, narration, and receipts. Output exhaustion recurred at both 4096 and
8192 tokens. A generated module contained trailing prose and failed its build.
The failed-acceptance path also demanded an effect before allowing diagnosis.

## Research and decisions

| Primary reference | Relevant mechanism | Decision in our implementation |
| --- | --- | --- |
| [Qwen-Agent Qwen3.5 example](https://github.com/QwenLM/Qwen-Agent/blob/main/examples/assistant_qwen3.5.py) | Native API tool calling and local service option | Send typed tools to the already selected local provider; no vendor service |
| [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) | Assistant calls followed by tool-role results | Preserve action/observation pairing; reject incomplete, ambiguous or unknown calls |
| [DeepSeek Harness compaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction) | Separate compaction ownership; balanced tool pairs; bounded recovery | Keep our existing owners; prune complete exchanges, never orphan a tool result |
| [OpenCode compaction](https://opencode.ai/v2/docs/compaction/) | Objective, checkpoint, retained recent context and output reserve | Count schemas and calls in context estimates; retain typed recent history. Full semantic summary qualification remains open |
| [OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) | Detect repeated action/observation, errors and alternating cycles | Keep bounded execution; improve observed-state replay keys. Full alternating-cycle detection remains open |
| [Aider edit formats](https://aider.chat/docs/more/edit-formats.html) | Search/replace avoids full-file regeneration | Typed exact-match edit; reject ambiguous matches; preserve whitespace and arrow syntax |
| [mini-SWE-agent control flow](https://mini-swe-agent.com/latest/advanced/control_flow/) | Small step loop with separated model/environment roles | Extend our one injected-port host loop, not a parallel executor |
| [Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B) | Thinking and non-thinking modes, adequate output budget, no historical thinking | Qualify bounded non-thinking tool execution after repeated thinking-budget exhaustion; not a claim that this beats thinking on all tasks |

## Current wiring

`providers -> harness -> model-gateway -> Ollama -> engine-host -> engine
dispatcher -> existing policy and Rust tool worker`.

The native local lane exposes seven existing registered project tools: read,
list, glob, grep, write, edit and run. This is an explicit model surface, not
removal of other product packages. Other tools/providers keep the existing text
path until separately qualified. Unsupported native transports fail closed.

Ordinary local Qwen aliases select this path; `ABDO_AGENT_PROTOCOL=text` is an
explicit diagnostic fallback. `ABDO_AGENT_PROTOCOL=native` opts another local
model into qualification, not a declaration of support. Chat is unchanged.

Native source payloads remain data, with no text delimiter round trip. Exact
edits use one matching occurrence and literal replacement. Project-boundary,
approval, source validation and Rust atomic writes are still shared. Calls are
serial; batches and partial responses are rejected without dispatch.

## Qualification record

- Initial regressions: 146 tests passed, no failures, 347 assertions.
- Type checks: 51 tasks passed, 52 packages in scope.
- Structure: 52/52 package closure, 327/327 blueprint elements, zero parallel
  implementations and zero outside-product packages. Structural proof is not
  proof that every feature works in every runtime scenario.
- The live continuation uses ordinary Qwen3.5 9B, not Empero, with 65536 context.
- Live product verdict and final regression totals are recorded after the run.

## Open qualification work

Full autonomous sprint transitions and truthful model-authored handoff; complete
public routes and protected administration; persistent content/contact flows;
password migration and secure sessions; non-empty test-suite proof; HTTP and
browser journeys; semantic compaction across a restarted process. No release,
push, installer rebuild or deployment is certified here.
