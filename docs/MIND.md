# The mind strategy: how an open model becomes a better agent inside AbdoCode

AbdoCode is a harness. Its claim is not that it ships a smarter model, but that the same open model (Nemotron, Qwen, DeepSeek, Llama, anything on Ollama or behind an OpenAI-compatible endpoint) does more real work, with fewer false claims, inside this engine than inside a thinner loop. This page states the strategy in the open, so it can be measured against other harnesses and improved by contributors. Everything below is either implemented and tested in this repository, or marked as a line of work.

## 1. The model proposes, the kernel decides

Every effect on the machine (file, command, network, browser, desktop) passes through one gate in a small Rust kernel and produces a **receipt**. The model's own text is never treated as evidence. A turn is judged by its receipts: what was written, what a command returned, what a window reported after the action. This is the root of everything else: guards that read receipts can catch a model that narrates success, and the operator can read the same receipts the model saw.

## 2. Rails that adapt to the model

A 7B local model and a 120B cloud model do not get the same rope. The rails (`rail-policy`) are chosen per model strength and tighten on measured behaviour within a turn:

- a write that would wipe a file is refused and the model is told why (`write --shrink`);
- a repeated failing edit escalates instead of looping;
- fabricated command output in the model's prose (an `ls` listing that no tool produced) is detected from the receipts and named to the operator;
- a duplicate tool call in the same workspace generation stops the turn honestly (`duplicate`) instead of burning tokens; volatile tools (page, screenshot, desktop) are exempt because their world changes underneath them;
- the turn has a token cap, and the model is told when it is near it.

## 3. Deterministic tools before vision, vision before guessing

The tool ladder is the same on every surface: read the structure the system exposes, act by reference, verify by reading back. In the browser that is `page` (accessibility tree with stable refs) → `find`/`tap`/`fill` → `page` again, with `dismiss` for overlays. On the desktop it is `desk ui` (UI Automation tree) → `desk set`/`desk press` by reference with read-back → `desk ui` again; screenshots (`desk shot`, pixel-true on scaled displays) feed the vision model only when the application exposes no tree. `desk open` launches programs through the shell and names any picker or dialog that appeared with them. A model that guesses coordinates from memory is doing the harness's job badly; the harness removes the need.

## 4. Honest stops and honest receipts

The engine would rather stop than pretend. Turns end with a named reason (`complete`, `duplicate`, `tool-failed`, `budget`, `stuck`) and a checkpoint that says what was done and what was not. Refusals name the cause and, wherever the cause has a remedy, the exact next call: a failed window focus lists the visible windows and their pids; `skill <tool>` says "that is a tool, run: …"; a missing browser extension returns the install link instead of a bare error. Every such receipt came from a measured failure of a real model on a real machine; each one is a rule the model no longer has to learn by trial.

## 5. Three-lens self-review

"Review my changes" runs three independent lenses (correctness, safety, tests) over the turn's diff before the operator trusts it. Each finding must survive a refutation pass. This is the product form of the working method that built the engine: execute, gate, review adversarially, refute, fix, commit with a receipt.

## 6. Memory that cannot leak

Lessons are learned from real failures (`lessons`), scoped to the project, and promoted to a shared store only through a written promotion rule: closed classes (playbook, package pattern, environment trap), secret sweep, and a record shape with no field for a project's identity. What has no field cannot leak from one customer's project to another's.

## 7. Self-teaching after every update

Each release ships `release-lessons.json`: reviewed lessons distilled from the defects that release fixed, written as rules the model can act on. On the first start of a new version the engine promotes them into the shared store through the same promotion rule as any other lesson, once, and reports what was accepted and what was refused. Contributors propose lessons the same way they propose code: idea first, in a pull request with the measurement that motivated it; execution after review. This is how user contributions reach every installed copy without a model being retrained and without anyone's project data travelling.

## 8. What is measured, and what is next

Measured on 2026-09-14 on a Windows 11 laptop with a 150% display, Nemotron 3 Super 120B through NVIDIA NIM: a desktop task (open Notepad, read its UI tree, fill the text field by reference, prove it) completes in four tool calls with zero failures after the rules above were built in; the same task failed three different ways before them (app picker, guessed window titles, focus stolen by our own window, the model treating a tool verb as a skill). The browser extension pairs itself with the engine in under ten seconds on a real Chrome.

Lines of work, in order of harm if left undone:

1. A **name gate** for desktop input: typing or clicking in a window the task never named, and that did not appear as a result of the agent's own action, asks first even in full-access mode.
2. **UI Automation over COM** (UIA3) for WinForms patterns the managed UIA2 client does not expose.
3. A **DesktopBackend** contract with Linux (X11 via xdotool + AT-SPI, then Wayland) and macOS channels; the contract exists, the Windows channel is the only implementation today.
4. **Distil a successful turn into a skill**, then schedule it as a routine: only successes are distilled.
5. A **benchmark harness** that runs the same desktop, browser and coding tasks against other agent loops with the same open model, publishes the receipts, and keeps this page honest.

If you are building a harness, steal what works here and send back what does not.
