I have everything needed. Measured facts that override the designs/judges:

- **HEAD is `f87f572`** (c480265 is its parent; the extra commit touches only managed-server). All line numbers below were re-read at f87f572; cli.ts = 3099 lines. Tree clean in touched packages.
- **Line endings (bytes, not grep):** CRLF = cli.ts, closure-gate.ts, contracts/*.ts, builtin-tools shell.ts/run-command.ts, desktop index.html, PRODUCT-CLOSURE doc. LF = engine-host src+tests, failure-tiering/playbook-miner/turn-memory/project-*-acceptance + all engine tests, shell-protocol.ts, IDEAS doc, all package.json/tsconfig. Mixed = tools/runner.ts (837/28), tools/index.ts, builtin-tools/index.ts. Judge 2 / D3 were right; judges 1 & 3 measured with `grep -c $'\r$'` in the Bash tool, which is wrong here.
- **Static `test(` counts:** engine-host 44, failure-tiering 14, closure-gate 19, playbook-miner 4, turn-memory 6, project-test-acceptance 2, project-build-acceptance 3, serve-wiring 5; engine total 246. engine `tsconfig.include = ["src/**/*.ts"]` → engine tests are never type-checked; engine-host tsconfig has no `include` → its tests are. Every `test` script is bare `bun test`; root has `typecheck` only.
- engine has no `@abdo/contracts` dep; engine-host does. `ShellFailureClass` is not exported from the builtin-tools barrel (subpath `./*` exists). desktop `tool-result` handler (index.html:1003-1005) reads only turnId/cmd/output. e2e prints the whole `tool-result` frame (spread). shell-protocol frame rows have only `kind/dir/required/summary` — no optional list to extend.

---

# Spec — «إيصال حكم صريح من الأداة» (queue item 1) · `plugins.toolVerdict`

Base: repository root, branch `rust-main` @ `f87f572` (brief said c480265 — its parent; nothing below differs). Winning skeleton: **Design 1** (engine-host home, one normalization point, thin optional params). Grafted: D3's discriminated union + enumerated host refusals + runtime vocabulary pin + control run; D2's single `ZERO_EXIT_ANYWHERE` + `exitZero` with `.source` pin + adapter machine-code reasons. Every judge-listed defect is resolved in §11.

## 0. Non-negotiables (all packages)

- Fail-closed: a missing verdict is `undefined`, never coerced; consumers use `verdict !== undefined ? verdict.ok : <legacy regex>`. No producer ever fabricates `ok:true` from text.
- Model-facing text byte-identical: every `output` string is built exactly as today; the verdict rides beside it.
- `dispatchTool`, `runAdapter`, `runWriteTool`, `readThroughKernel` keep their `Promise<string>` APIs as thin wrappers over new `…V` variants.
- Rust untouched: no cargo, no schema, no ledger CLI change, no `operationDigest` change.
- Live round: nothing edited, no `bun test`, no cargo until `tmp/abdocode-e2e` shows its `done` frame and no bun/abdo-tool-worker process reads this tree (WP0).

## 1. The type — `packages/engine-host/src/tool-verdict.ts` (NEW, **LF**)

Home justified: engine-host already owns `toolReceiptFailed` (text-agent-loop.ts:65), depends on `@abdo/contracts` and `@abdo/tools` (package.json:16,19), is a dependency of engine (engine/package.json:31); cli.ts already imports from it (cli.ts:54). Not contracts (foundational, hot path in session-runtime, barrel pinned by contracts.test.ts:4-11, host-only codes don't belong there). Name `ToolOutcome` is taken (runner.ts:59, ports.ts:309) — neither copy is touched. This file must **not** import `./text-agent-loop` (no cycle).

```ts
/** One vocabulary. Every literal is copied from its owner and pinned by a runtime test. */
export type ToolVerdictReason =
  // ShellFailureClass verbatim — packages/builtin-tools/src/shell.ts:44-51
  | "command_not_found" | "process_spawn_failed" | "nonzero_exit" | "empty_failure_output"
  | "timeout" | "aborted" | "isolation_refused"
  // contracts classifyFailure codes — packages/contracts/src/failure.ts:176, :187
  | "policy_denied" | "tool_not_permitted"
  // runner.ts:388 / cli.ts:1412,1456,1477
  | "unknown_tool"
  // usage refusals (`الصيغة:`, «يحتاج …», «غير موجود») — USER_INPUT class
  | "invalid_input"
  // host rails in cli.ts that refused BEFORE any executor ran (policy class, not breakage)
  | "guard_refused"
  // kernel-tools/src/index.ts:156-159 (Rust EffectOutcome reused, no wire change)
  | "kernel_declined" | "kernel_unresolved"
  // cli.ts:250 / cli.ts:262
  | "ledger_unsettled" | "admission_refused"
  // executor reported !ok with no finer machine code (adapter/external)
  | "tool_failed"

export type ToolVerdict =
  | { readonly ok: true }
  | { readonly ok: false
      readonly reason: ToolVerdictReason
      /** POLICY refusal (gate/guard/runner denied:true/kernel declined): loop-failure yes; wall/miner NO. */
      readonly denied: boolean
      /** Human detail (≤160 chars). Never matched on. */
      readonly detail?: string }

/** What a verdict-aware dispatcher returns. `output` is byte-identical to today's string. */
export interface DispatchResult {
  readonly output: string
  /** Absent = no explicit verdict offered → consumers fall back to their legacy regex AND count it. */
  readonly verdict?: ToolVerdict
  /** idempotencyKeyFor(...) when the operation is effectful (§7). */
  readonly idempotencyKey?: string
}

export interface ToolReceipt { readonly command: string; readonly output: string; readonly verdict?: ToolVerdict }

export const VERDICT_OK: ToolVerdict = Object.freeze({ ok: true })
export const verdictFailed   = (v: ToolVerdict): boolean => !v.ok                 // loop predicate (denial IS non-completion — legacy, pinned)
export const verdictIsBreakage = (v: ToolVerdict): boolean => !v.ok && !v.denied  // wall/miner predicate
/** THE normalization point. A string or a result without `verdict` yields verdict undefined — never ok. */
export const resolveDispatch = (r: string | DispatchResult): { output: string; verdict: ToolVerdict | undefined; idempotencyKey: string | undefined } =>
  typeof r === "string" ? { output: r, verdict: undefined, idempotencyKey: undefined }
                        : { output: r.output, verdict: r.verdict, idempotencyKey: r.idempotencyKey }

/** Per-epoch coverage (anton reason_coverage lesson): denominator = ALL results; zero → "—" never 1.0. */
export class ToolVerdictLedger {
  observe(command: string, verdict: ToolVerdict | undefined, unmapped?: boolean): void
  snapshot(): { total: number; explicit: number; inferred: number; inferredTools: readonly string[]; denied: number; failed: number; byReason: Readonly<Record<string, number>>; unmapped: number }
  reset(): void   // per epoch
  line(epoch: number): string
  // `📐 أحكام الأدوات ح${epoch}: صريح=${explicit}/${total} · مستنتَج=${inferred}${inferredTools.length ? ` (أدوات: ${inferredTools.join(",")})` : ""} · رفض سياسة=${denied} · فشل=${failed} · أسباب=${k×n,…} · غير ممطوط=${unmapped}`
  // when total === 0: `📐 أحكام الأدوات ح${epoch}: —`
}
```
`unmapped` counts adapter errors whose machine prefix was not recognised and fell to `tool_failed` (§3.2) — so an unmigrated producer code is visible, not summed away. There is no `source` field: a `ToolVerdict` object is explicit by construction; absence is `undefined` (kills D1's dead `"inferred"` literal and D2/D3's inferred-ok fail-open in one move).

Exports added to `packages/engine-host/src/index.ts` (LF) inside the block at :148-156 or beside it: `resolveDispatch, verdictFailed, verdictIsBreakage, VERDICT_OK, ToolVerdictLedger, type ToolVerdict, type ToolVerdictReason, type DispatchResult, type ToolReceipt` from `./tool-verdict`, plus `export { idempotencyKeyFor, type OperationKind } from "@abdo/contracts/idempotency"` (engine cannot import contracts directly).

## 2. Work packages (disjoint files; order)

| WP | Owner files (worktree EOL) | Depends on |
|---|---|---|
| **WP0** gate — no code | wait for the live round's `done` frame; confirm no `bun … cli.ts serve`, `agent-project-e2e`, or `abdo-tool-worker.exe` from this tree; only then branch off `f87f572` | — |
| **WP1** engine-host | `packages/engine-host/src/tool-verdict.ts` (NEW LF), `src/text-agent-loop.ts` (LF), `src/index.ts` (LF), `test/text-agent-loop.test.ts` (LF, append), `test/tool-verdict.test.ts` (NEW LF) | WP0 |
| **WP2** engine helpers (no cli.ts) | `packages/engine/src/failure-tiering.ts` (LF), `playbook-miner.ts` (LF), `closure-gate.ts` (**CRLF**), `project-test-acceptance.ts` (LF), `project-build-acceptance.ts` (LF), `turn-memory.ts` (LF) + their six tests (LF, append) | WP1 landed (imports `type ToolVerdict` from `@abdo/engine-host`); may be authored in parallel from this spec |
| **WP3** cli.ts producers/host/toggle/metric/idempotency | `packages/engine/src/cli.ts` (**CRLF**), `packages/engine/test/serve-wiring.test.ts` (LF, append), `packages/desktop/ui/index.html` (**CRLF**) | WP1 + WP2 landed |
| **WP4** closure | `docs/PRODUCT-CLOSURE-10-SPRINT-PROGRAM.md` (**CRLF**), `docs/IDEAS-INVENTORY-MINDSHUB-DSH-20260901.md` (LF), `ملفّ وعي جلسة المشرف: session-<date>-abdocode-tool-verdict.md`, optional `packages/engine/test/fixtures/receipts-*.jsonl` + `tool-verdict-fixtures.test.ts` | WP1-3 green + one ON round + one OFF control round |

## 3. Producers (WP3, cli.ts) — file:line today → change

Local helpers at the top of the serve scope (near :1038): `const refused = (output: string, detail = output.slice(0,160)): DispatchResult => ({ output, verdict: { ok:false, reason:"guard_refused", denied:true, detail } })`, `denied(output, reason: "policy_denied"|"tool_not_permitted")`, `invalid(output)` (reason `invalid_input`, denied:false), `unknownTool(output)`, `okText(output)` (`VERDICT_OK`), `plain(output): DispatchResult => ({ output })` (no verdict). Import `resolveDispatch, VERDICT_OK, ToolVerdictLedger, idempotencyKeyFor, type ToolVerdict, type DispatchResult, type ToolReceipt` at :54.

### 3.1 runExec (:1694-1804) → `runExecV(cmd, turnId, hooks): Promise<DispatchResult>`; `runExec = async (...a) => (await runExecV(...a)).output` (kept for any string caller).
- :1706 plan re-materialised, command NOT executed → `refused(...)`.
- :1709, :1713, :1716, :1719, :1722, :1725, :1728, :1733, :1735, :1739, :1743, :1747, :1750, :1754, :1757, :1760 → `refused(text)` (the guard modules — shell-command-guard.ts:10/24/50/67, secret-command-guard.ts:24, project-dependency-guard.ts:67, managed-server.ts:38 — return strings without a `رُفض` prefix in several cases; today they are fail-open successes).
- :1736 `return turnServers.start(...)` → `plain(await turnServers.start(...))` — **inferred on purpose** (first-party text; the legacy predicate is correct here: `فشل تشغيل الخادم`/`تعذّر التشغيل` contain `فشل`/no marker → see §9 residuals). Not `refused` (J1/J3 defect on D3).
- :1762-1803: receipt string at :1803 unchanged. Verdict from the SAME `result`: `result.ok === true ? VERDICT_OK : { ok:false, reason: (output.failureClass as ToolVerdictReason | undefined) ?? "tool_failed", denied: output.failureClass === "isolation_refused", detail: result.error?.slice(0,160) }`. run-command.ts:198-206 makes `ok:true` ⇔ `exitCode===0 && !timedOut && !aborted`; `failureClass` is set at :150 (`isolation_refused`), :174 (`res.reasonCode`, spawn), :201 (`timeout|aborted|nonzero_exit`). Widen the cast at :1773-1780 with `failureClass?: string`. `exitCode===null` («غير معروف» :1791) and «قوطع» :1788 therefore become `ok:false` — closes two measured fail-opens.

### 3.2 runAdapter (:195-264) → `runAdapterV(adapter, toolName, input, executionId?, signal?): Promise<DispatchResult>`; `runAdapter = async (...a) => (await runAdapterV(...a)).output` for :269 `git()` and :2842-2846 slash commands.
- Compute `idempotencyKey` (§7) before :218 and pass `{ name: toolName, input, idempotencyKey }` at :219. **Do not** add it to `operationDigest` (:225-234) — that is the Rust ledger cause hash.
- Verdict from `outcome` (ToolOutcome, structural):
  - `outcome.ok` → `VERDICT_OK`
  - `outcome.denied === true` → `{ ok:false, reason:"policy_denied", denied:true, detail }` (runner.ts:414-421 mode gate, :574 PDP — live in this loop under `mode:"BUILD"`)
  - else map the adapter's OWN machine prefix of `outcome.error` (one hop on first-party codes, adapters.ts:61/78, runner.ts:388): `^unknown_tool` → `unknown_tool`; `^exit_\d+` → `nonzero_exit`; `^timeout` → `timeout`; `^aborted` → `aborted`; `^(command_not_found|process_spawn_failed|isolation_refused|empty_failure_output)` → that class (`isolation_refused` → denied:true); anything else → `tool_failed` **and mark `unmapped`** (the return carries `unmapped: true` via a module-level `lastUnmapped` flag or a 4th field on DispatchResult `unmapped?: true` — pick the field; it is dropped at the string wrapper).
- :250 settle failure → `{ output: <same sentence>, verdict: { ok:false, reason:"ledger_unsettled", denied:false } }` (today judged success by every sniffer).
- :255 success/failure text unchanged (Rust line still appended for both).
- :262 catch → `{ output: <same>, verdict: { ok:false, reason:"admission_refused", denied: /^tool_worker_refused/.test(message), detail } }`.

### 3.3 runWriteTool (:1224-1391) → `runWriteToolV(...): Promise<DispatchResult>`; `runWriteTool = textOf wrapper` for runPatchTool (:1180,:1184 region).
Every early `return "<string>"` is wrapped by category — no text change:
- `refused()`: :1241, :1258, :1261, :1277, :1281, :1283, :1286, :1289, :1294, :1299, :1308, :1311 (`secretSource`), :1314 (`duplicate`), :1316, :1319, :1322, :1335 (plan materialised — nothing written by the model), :1338, :1342, :1346, :1350, :1354, :1358, :1362, :1366, :1370, :1374, and the three `checked.why` returns :1233, :1270, :1303 (texts at :1125-1134 carry no `رُفض` prefix → fail-open today).
- `invalid()`: :1249, :1265, :1268 (`الصيغة:`), :1234, :1271 (`الملفّ غير موجود`), :1273 (old text not found).
- :1380 skip → `okText(...)` (advancesWorkspace keeps excluding it by its `تُخطّى` text test — unchanged).
- :1387 mode gate → `denied(text, "policy_denied")`.
- :1389-1390: `const r = await runAdapterV(..., \`write_${turnId}_${nextToolSeq()}\`, ...)`; `return { output: r.output.startsWith("رُفض") ? r.output : \`✍ …\n${r.output}\`, verdict: r.verdict, idempotencyKey: r.idempotencyKey }` (the `startsWith` decides only the prefix cosmetics as today; the verdict comes from the adapter).

### 3.4 readThroughKernel (:315-370) → `readThroughKernelV(file): Promise<DispatchResult>`; `readThroughKernel = textOf wrapper` for :930, :2836, :2910, :3049.
- :330-331 «الملفّ غير موجود» → `invalid()`.
- :350 → `{ output, verdict: result.denied === true ? {ok:false, reason:"policy_denied", denied:true} : result.error.startsWith("kernel_declined:") ? {…reason:"kernel_declined", denied:true} : {…reason:"kernel_unresolved", denied:false} }` (kernel-tools/src/index.ts:156-159 — Rust EffectOutcome reused).
- :353 invalid digest → `kernel_unresolved`, denied:false.
- :362-366 success → `VERDICT_OK`.

### 3.5 external tools (:1403-1410): :1406 → `denied(…, "policy_denied")`; :1409 → `{ output: <same>, verdict: r.ok ? VERDICT_OK : { ok:false, reason:"tool_failed", denied:false, detail: r.text.slice(0,160) } }` (mind/external.ts:111 already returns `{ok,text}`).

### 3.6 dispatchTool (:1398-1492) → `dispatchToolV(word, body, turnId, hooks, nativeCall?): Promise<DispatchResult>`; `dispatchTool = async (...a) => (await dispatchToolV(...a)).output` keeps :1217 (codemode) and :1532 (runPlan) untouched.
| line | today | verdict |
|---|---|---|
| :1400 planning-phase refusal | string | `denied(…, "policy_denied")` |
| :1412 `أداةٌ مجهولة` | fail-open | `unknownTool()` |
| :1418, :1432, :1438, :1442, :1448, :1453, :1462 | usage strings | `invalid()` |
| :1420, :1436, :1465 gate refusals | :1420 fail-open | `denied(…, "policy_denied")` |
| :1421 exec | `runExec` | `runExecV` |
| :1424 write | `runWriteTool` | `runWriteToolV` |
| :1426 project-read | string | `plain()` — inferred, counted |
| :1428 framed | `executeBody` | if `spec.name === "read"`: derive `tail` exactly as executeBody does (:2830-2836) and return `readThroughKernelV(tail[0])` / `invalid("read يحتاج ملفاً")`; otherwise `plain(await executeBody(...))` |
| :1433, :1439, :1443, :1450, :1454 adapters | `runAdapter` | `runAdapterV` with executionId `\`git_${turnId}_${nextToolSeq()}\`` etc. (§7) |
| :1456, :1477 | strings | `unknownTool()` |
| :1472 search ok | string | `okText()` |
| :1474 search fallback | fail-open (`تعذّرت` has no `فشل`) | `{ output, verdict:{ok:false, reason:"tool_failed", denied:false} }` |
| :1483 cloud-only ⛔ | string | `denied(…, "tool_not_permitted")` |
| :1486-1487 patch/codemode, :1490 surface | strings | `plain()` — inferred, counted |

Rule of derivation: the verdict comes from a structured field (`result.ok/failureClass`, `outcome.ok/denied`, `r.ok`, kernel error code) or from **which `return` fired**. No producer parses its own receipt prose; the only string hop is the adapter machine-code prefix table in §3.2 (pinned by test).

## 4. Transport (WP1 text-agent-loop.ts + WP3 cli.ts)

text-agent-loop.ts (LF):
- :29 `dispatch: (command, nativeCall?) => Promise<string | DispatchResult>`.
- :31 `onToolResult?: (command: string, output: string, verdict?: ToolVerdict, idempotencyKey?: string) => void`.
- :41 `priorReceipts?: readonly ToolReceipt[]`.
- :200-202 `advancesWorkspace = (command, output, verdict?: ToolVerdict) => /^(?:write|edit|patch|run)\b/u.test(command) && (verdict !== undefined ? !verdictFailed(verdict) : !toolReceiptFailed(command, output)) && !/(?:تُخطّى|نفس المحتوى)/u.test(output)`.
- :203-208 replay passes `receipt.verdict`.
- :312 `const { output, verdict, idempotencyKey } = resolveDispatch(await options.dispatch(command, nativeReply?.call))` — the single normalization point; :313 `options.onToolResult?.(command, output, verdict, idempotencyKey)`; :314-318 and :326-329 unchanged (`output`) → model prompt byte-identical.
- :320 `if (verdict !== undefined ? verdictFailed(verdict) : toolReceiptFailed(command, output)) hadToolFailure = true else stopReason = "complete"`; :323 `advancesWorkspace(command, output, verdict)`.
- `toolReceiptFailed` signature/export untouched (pinned :48-51; used cli.ts:2223). Sticky `hadToolFailure` untouched (pinned :268-291).

cli.ts (CRLF):
- :2251 `allReceipts: ToolReceipt[]`, :2337 `receipts: ToolReceipt[]`.
- Loop dispatch :2399-2402: `dispatch: async (command, nativeCall) => { const r = await dispatchToolV(...); return verdictOn ? r : r.output }` — OFF hands the loop a bare string.
- :2413 `onToolResult: (cmd, output, verdict, idempotencyKey) => { …push({ command: cmd, output, verdict }) … observeAcceptanceReceipt(cmd, output, verdict) … wallTracker.observe(output, verdict) … playbookMiner.observe(output, verdict) … distillFact(cmd, output, verdict) … emit({ kind:"tool-result", turnId, cmd, output: output.slice(0,500), epoch, ...(verdictOn && verdict !== undefined ? { verdict: { ok: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason, denied: verdict.denied }) } } : {}), ...(verdictOn && idempotencyKey ? { idempotencyKey } : {}) })`; `ledger?.observe(cmd, verdict)`.
- Forced probe :2348-2359: `const r = await dispatchToolV("run", command, …); const output = r.output; const verdict = verdictOn ? r.verdict : undefined;` push `{command, output, verdict}`; `observeAcceptanceReceipt(command, output, verdict)`; `wallTracker.observe(output, verdict)`; `playbookMiner.observe(output, verdict)`; `forcedFailed = acceptanceProblem !== undefined || !exitZero(output, verdict)`; frame as above; `ledger?.observe(command, verdict)`.
- Direct path :2222-2223: `const r = await dispatchToolV(word, turn.body, turn.id, hooks); return { answer: r.output, completed: verdictOn && r.verdict !== undefined ? r.verdict.ok : !toolReceiptFailed(turn.body, r.output) }`.
- Frames outbound are unvalidated (shell-protocol.ts:77 inbound-only; row :59 has no optional list — **do not edit shell-protocol.ts**); desktop :1003-1005 ignores extra fields; e2e :104-111 spreads the frame so `verdict` shows in round logs.
- project_fact :2491-2503: receipts map adds `...(receipt.verdict ? { ok: receipt.verdict.ok, ...(receipt.verdict.ok ? {} : { reason: receipt.verdict.reason, denied: receipt.verdict.denied }) } : {})`; value gains `...(verdictOn ? { verdictCoverage: ledger.snapshot() } : {})`. `recallExecutionFact` (project-test-acceptance.ts:9-19) projects only command/output → recalled prompt text unchanged.
- `done` frame :2686 and `completed` :2638 — shape and formula untouched.

## 5. Consumers

| site | change |
|---|---|
| text-agent-loop.ts:320 (sticky tool-failed) | verdict when present, else `toolReceiptFailed` |
| text-agent-loop.ts:200-208 | as §4 |
| failure-tiering.ts (WP2, LF) | add `export const ZERO_EXIT_ANYWHERE = /(?:انتهى الأمر برمز\|exit(?:ed)?(?: with)?(?: code)?)\s*0\b/iu` (byte-identical to the 7 removed literals); `export const exitZero = (output: string, verdict?: ToolVerdict) => verdict !== undefined ? verdict.ok : ZERO_EXIT_ANYWHERE.test(output)`; `receiptFailed(output, verdict?)` → `verdict !== undefined ? verdictIsBreakage(verdict) : <existing body>`; `receiptSucceeded(output, verdict?)` → `verdict !== undefined ? verdict.ok : lastExitCode(output)===0`; `WallTracker.observe(output, verdict?)` → first line `if (!receiptFailed(output, verdict)) return undefined` (denial and ok never feed the counter; tier/signature stay text-based). `lastExitCode` untouched (test :40 "LAST marker governs"). |
| playbook-miner.ts:27-28 | `observe(output, verdict?)` → `if (!receiptFailed(output, verdict)) return undefined` |
| closure-gate.ts:143-152 (CRLF) | param type `readonly { command; output; verdict?: ToolVerdict }[]`; :152 `.filter((r) => receiptSucceeded(r.output, r.verdict))` |
| project-test-acceptance.ts:2-3 | `projectTestPassed(output, verdict?)`; :3 → `if (!exitZero(output, verdict)) return false`; content regexes :4-5 kept |
| project-build-acceptance.ts:22-23 | `projectBuildViolation(projectDir, output, verdict?)`; :23 → `if (!exitZero(output, verdict) \|\| !isNextProject(projectDir)) return undefined` |
| turn-memory.ts:29-31 | `distillFact(command, output, verdict?)`; :31 `const passed = exitZero(output, verdict)` |
| cli.ts:2295-2302 `observeAcceptanceReceipt(command, output, verdict?)` | :2296 `projectTestPassed(output, verdict)`; :2297/:2299/:2300 regex → `exitZero(output, verdict)`; :2298 `projectBuildViolation(PROJECT_DIR, output, verdict)` |
| cli.ts:2358 forcedFailed | `!exitZero(output, verdict)` |
| cli.ts:2222-2223 direct path | §4 |
| cli.ts:2580, :2638 outputEvidenceVerdict | unchanged calls; `allReceipts` now carries verdicts |
| semantic-verifier.ts:40 | no change (structurally accepts the wider object) |
| cli.ts:1217-1219 codemode, :1532-1538 runPlan | **unchanged** string sniff via wrapper — listed as residual (§9) |

After WP2+WP3 the literal `انتهى الأمر برمز|exit(?:ed)?` regex exists exactly twice in engine src: `EXIT_MARKER` (failure-tiering.ts:68) and `ZERO_EXIT_ANYWHERE`; the engine-host nonzero variant (text-agent-loop.ts:67) stays as the legacy fallback. The three fallback heuristics (first-nonzero / last-marker / any-zero) are **not** unified — OFF must equal legacy.

## 6. Toggle — `plugins.toolVerdict`

- Storage: `Settings.plugins: Record<string, boolean>` (cli.ts:500); `SETTINGS_KEYS` already whitelists `plugins` (:507); `validateSettingsPatch` passes plugin keys through; persisted by `saveSettings` merge (:517-526); flows over the existing `settings-set` frame — zero protocol change.
- Read once per turn beside :2309/:2313/:2319: `const verdictOn = loadSettings().plugins?.toolVerdict !== false`. A flip applies at the next turn, never mid-turn (rule 6 «تبديله لا يمسّ تقدّم…»).
- **Default ON** (`!== false`, like `walls`/`miner`). Justification: (a) it removes an inference, it adds no heuristic — the verdict is the producer's already-computed fact (run-command.ts:198-206, runner.ts:416/574); (b) only fail-closed corrections; zero model cost; (c) coverage is unobservable while OFF and queue item 2 (intent/violation distillation) needs `reason`; (d) the verifier's default-OFF precedent is for a *model-judged* plugin. Rule 4 is satisfied by the WP4 receipt plan (ON round + OFF control round). Resolved against D3/J2: OFF-by-default would leave five measured fail-opens live by default.
- **Exact OFF semantics (provably legacy):** the loop `dispatch` returns `r.output` (string) → `resolveDispatch` yields `verdict: undefined` → `onToolResult` third arg undefined → receipts carry no `verdict` → `priorReceipts` replay sniffs text as today → `WallTracker/PlaybookMiner/closure-gate/exitZero/projectTestPassed/projectBuildViolation/distillFact` take their `verdict === undefined` branches, which are the unchanged legacy statements; forced probe and direct path pass `undefined`; **no** `ToolVerdictLedger` is constructed, **no** 📐 event, **no** `verdict`/`idempotencyKey` frame fields, **no** `verdictCoverage`/`ok`/`reason` in facts. The `DispatchResult` objects are still built inside `dispatchToolV` (pure, in-process) and dropped at the boundary — «المعطَّل لا يُحمَّل» is met for everything observable. **Not** behind the toggle (stated explicitly): `ToolCall.idempotencyKey` (inert in the runner) and unique `executionId`s (§7) — they change control-record `requestId/toolExecutionId`, not receipts, frames, or text.
- Trap inherited from siblings: `loadSettings()` returns `{}` on a corrupt file (:512-514) → silently ON. Tell: the 📐 line is present. Follow-up (not this sprint): one journal event on settings parse failure.
- Desktop (WP3, CRLF): after index.html:317 add `<div class="setting-row"><label>حكم صريح من الأداة<small>الحكم من حقول المنفّذ لا من نص الإيصال؛ التعبير النمطي احتياطٌ يُعدّ. يسري من الدور القادم.</small></label><input type="checkbox" data-plugin="toolVerdict" checked></div>` (mirror the exact markup of the walls row :315); in the reset object :1336 add `toolVerdict: true`. Save path :1307 and restore :1188-1191 are generic.

## 7. Idempotency sub-scope

Wired now:
1. `const nextToolSeq = (() => { let n = 0; return () => (++n).toString(36) })()` in the serve scope near :1038. executionIds at cli.ts:1389 `write_${turnId}`, :1433/:1439/:1443 `git_${turnId}`, :1450 `packages_${turnId}`, :1454 `fetch_${turnId}` → `${prefix}_${turnId}_${nextToolSeq()}` — unique per dispatch even for a byte-identical repeat (runner.ts:282-283 stamps it as requestId/toolExecutionId). Identity ≠ idempotency (contracts idempotency.ts:5-13). Resolves J1/J2 defect on D1's `sha256(key)` suffix.
2. In `runAdapterV`: `const idempotencyKey = adapterIdempotencyKey(toolName, input)` where the map is: `write_file|edit_file → { kind:"file_edit", target: input.path }`; `git_change → { kind:"command", target: \`git:${input.action}${input.path ? ":"+input.path : ""}\` }`; `package_install → { kind:"command", target: \`${manager}:${network}\` }`; `network_fetch → { kind:"other", target: input.url }` (a fetch is a read; `network_send` is for outbound effects — J2); `git_read → undefined`. Always `payloadDigest: digestValue(input)` (a digest, never content) and `scope: digestValue(PROJECT_DIR)`. Passed on `ToolCall.idempotencyKey` (runner.ts:48 — grep confirms zero runtime readers: only :18 comment and :48) → inert, so no behaviour change; the promise the type makes is now kept by the producer.
3. The key rides on `DispatchResult.idempotencyKey` → receipts (`ToolReceipt` may carry it; optional), the `tool-result` frame and the project_fact — its first observable consumers.

Deferred, with reasons (owner decision, not inference): deriving `effectId` (cli.ts:202) from the key — `adapter_ledger.rs` `begin` writes `Write::Fresh` on the effect_id stream and `settle` requires last phase `Dispatching`; a repeated legitimate op would re-enter an existing stream, behaviour unverified (read-only, no cargo). Making `ok:false` visible in Rust (`outcome_digest` scheme vs `EffectOutcome::Declined`) — `settle` is called for failures today (:240-251); changing it is ledger semantics. Folding the key into `operationDigest` — rejected (changes the Rust cause hash for every effect, adds no uniqueness once executionId is unique). Pre-dispatch replay (`checkIdempotency`) — needs an event-store read the cli loop does not have.

## 8. Measurement

- `const ledger = verdictOn ? new ToolVerdictLedger() : undefined` per turn beside :2308; `ledger.reset()` at the top of each epoch (:2337 region); `ledger.observe(cmd, verdict)` at the forced probe and in `onToolResult` (denominator = every tool result; the `unmapped` flag from §3.2 increments `unmapped`).
- Emission A: `if (ledger) await emitEvent(turn.id, ledger.line(epoch))` immediately after the checkpoint line at :2464 — a separate event; the existing `✓ نقطة حفظ الحقبة …` text is unchanged (no test pins it; measured).
- Emission B: `verdictCoverage: ledger.snapshot()` in the epoch project_fact (:2496-2501) when ON.
- Emission C: `verdict`/`idempotencyKey` on each `tool-result` frame when ON (§4) — the round log names each inferred receipt.
- Denominator rules: coverage = explicit/total over ALL results; zero results → `—`; `inferredTools` lists distinct first words so an unmigrated producer is named; `unmapped` separates "explicit but generic reason" from "no verdict".
- Expected after WP3 under ON: `inferredTools ⊆ {list, glob, grep, search?, surface, patch, codemode, run(server start)}`; anything else under مستنتَج is a producer the sprint missed.

## 9. NON-goals / residuals (explicit)

- No Rust change; no `cargo build` while the round runs (worker exe swapped under live processes).
- No change to receipt text, `done`/`rerun`, sticky `hadToolFailure`, or "denial = loop non-completion" (pinned text-agent-loop.test.ts:268-291; owner decision).
- Not unified: the three fallback exit heuristics; `EXIT_MARKER` and text-agent-loop.ts:67 stay.
- Still inferred (listed in 📐): project-read (list/glob/grep/read-non-kernel), surface, patch/codemode, non-read framed, `turnServers.start` result (first-party text; structured return from `ManagedServers` is the next slice), codemode :1219 and runPlan :1533 string sniffs.
- `ToolOutcome` duplicate (runner.ts:59 / ports.ts:309) untouched; dead `ToolWorkerResult` untouched; `distillFact` content regexes (`compiled successfully`, `pass`) untouched.
- No `operationDigest`/`effectId` change; no shell-protocol.ts edit; no contracts/tools/builtin-tools edits (zero lockfile change).

## 10. Test plan (each consumer has a test that FAILS if the verdict is ignored)

**WP1 — `packages/engine-host/test/text-agent-loop.test.ts` (append 7; existing 44 untouched — their string dispatches ARE the legacy proof):**
1. KILLER: `dispatch: async () => ({ output: "$ npm test\nانتهى الأمر برمز 0", verdict: { ok:false, reason:"aborted", denied:false } })` for `نفّذ: run npm test` then prose → `stopReason === "tool-failed"` (regex says success).
2. Inverse: `{ output: "قرأت النواةُ الملفَّ …\nفشل التحميل is a UI string", verdict: { ok:true } }` for a `read` → `"complete"` (regex says failure).
3. Object without verdict: `{ output: "رُفض/فشل المحوّل: x" }` → `"tool-failed"` and the `onToolResult` spy receives `undefined` as third arg (absence never fabricated).
4. `onToolResult` receives the verdict object and the idempotencyKey as args 3–4.
5. `priorReceipts: [{ command:"write a.ts <<<x", output:"✍ a.ts …", verdict:{ ok:false, reason:"ledger_unsettled", denied:false } }]` then the same command → `"duplicate"` (a failed prior write did not bump workspaceGeneration).
6. `policy_denied` verdict → `"tool-failed"` not `"complete"`.
7. LEGACY PAIR: same scripted ask run with string dispatch vs `{ output }` (no verdict) → identical `stopReason`, `commands`, `answer`.

**WP1 — `packages/engine-host/test/tool-verdict.test.ts` (NEW):** (a) VOCABULARY PIN (runtime, executes under `bun test`): read `../../builtin-tools/src/shell.ts` via `Bun.file`, extract every `| "…"` literal between `export type ShellFailureClass =` and the next blank line, assert each is accepted by a `const REASONS: readonly ToolVerdictReason[]` exported for the test; assert `packages/contracts/src/failure.ts` contains `"policy_denied"` and `"tool_not_permitted"`; (b) `resolveDispatch("x")`, `resolveDispatch({output:"x"})` → verdict undefined; with verdict → passthrough by reference; (c) `verdictIsBreakage({ok:false, reason:"policy_denied", denied:true}) === false`, `verdictFailed(same) === true`; (d) ledger: 3 explicit (1 denied, 1 failed) + 2 inferred (`list`, `grep`) → `line(2)` contains `صريح=3/5`, `مستنتَج=2 (أدوات: list,grep)`, `رفض سياسة=1`; zero → `— `; `unmapped` increments only when flagged.

**WP2 — engine tests (append; existing 14/4/19/6/2/3 untouched):**
- failure-tiering: `WallTracker.observe("EACCES: permission denied", {ok:false, reason:"nonzero_exit", denied:false})` ×2 → WallVerdict (text has no exit marker and no keyword from :89 → legacy returns undefined); same text with `policy_denied/denied:true` ×5 → undefined; wall text with `{ok:true}` → undefined; `exitZero("انتهى الأمر برمز 0", {ok:false, reason:"aborted", denied:false}) === false`; `exitZero("انتهى الأمر برمز غير معروف", {ok:true}) === true`; `ZERO_EXIT_ANYWHERE.source === "(?:انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\\s*0\\b"` and `.flags === "iu"`; `receiptSucceeded("no marker", {ok:true}) === true`.
- playbook-miner: markerless keywordless text + `{ok:false, reason:"tool_failed", denied:false}` ×3 → candidate hits 3; `denied:true` ×5 → never.
- closure-gate: goal naming output `Hello Riyadh`; receipt `run node app.js` with output `Hello Riyadh` (no marker) + `{ok:true}` → undefined (today violation); same with `{ok:false,…}` and text `…\nانتهى الأمر برمز 0` → violation string.
- project-test-acceptance: `projectTestPassed("3 passed\nانتهى الأمر برمز 0", {ok:false, reason:"aborted", denied:false}) === false`.
- project-build-acceptance: same shape with a Next project fixture → verdict ok:false yields `undefined` (no violation claimed because the build is not zero) — and `{ok:true}` with marker-less output on a project lacking app/page → violation string.
- turn-memory: `distillFact("run npm test", "3 passed\nانتهى الأمر برمز 0", {ok:false,…})` → undefined.

**WP3 — `packages/engine/test/serve-wiring.test.ts` (append one `test`, `Bun.file` style already at :3):** cli.ts contains `plugins?.toolVerdict !== false`; `resolveDispatch` is not needed in cli (it lives in the loop) but cli.ts contains `dispatchToolV(`, `runExecV(`, `runAdapterV(`, `runWriteToolV(`, `readThroughKernelV(`; `onToolResult: (cmd, output, verdict, idempotencyKey)`; `receipts.push({ command: cmd, output, verdict })`; `wallTracker.observe(output, verdict)`; `playbookMiner.observe(output, verdict)`; `distillFact(cmd, output, verdict)`; `exitZero(output, verdict)`; `{ name: toolName, input, idempotencyKey }`; `new ToolVerdictLedger()`; `verdictCoverage`; **zero** occurrences of the literal `انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\s*0\b` in cli.ts, project-test-acceptance.ts, project-build-acceptance.ts, turn-memory.ts; **zero** occurrences of `` write_${turnId}` ``, `` git_${turnId}` ``, `` packages_${turnId}` ``, `` fetch_${turnId}` `` (backtick-terminated); the `دليل عامل Rust:` template still present; `managed-server.ts` still contains `فشل تشغيل الخادم` (pins the residual's legacy correctness). Also assert `desktop/ui/index.html` contains `data-plugin="toolVerdict"` and `toolVerdict: true`.

**WP4 (after the round closes) — fixtures (ACC habit):** `packages/engine/test/tool-verdict-fixtures.test.ts` enumerating legacy-vs-explicit for `انتهى الأمر برمز غير معروف`, `⚠ قوطع الأمر بيد المشغّل`, `أداةٌ مجهولة: x`, `الأثر لم يكتمل: kernel_unresolved:…`, `النتيجة معروفة محلياً لكن دفتر Rust لم يغلقها…`, `⚙ run …\nرُفض التنفيذ`, `المسار خارج المشروع — مرفوض`, the :1706 and :1335 plan-materialised messages; real receipts copied verbatim from round.log **only after** the round's `done` frame and with owner approval.

**Live receipt (rule 4):** round A with `<state>/settings.json` absent or `{"plugins":{"toolVerdict":true}}`: every `tool-result` frame carries `verdict`, one 📐 line per epoch with `صريح>0`, `inferredTools` ⊆ the §8 set, `done` semantics unchanged. Round B (control) on the same goal with `{"plugins":{"toolVerdict":false}}`: no `verdict` field, no 📐 line, checkpoint lines identical in shape. Record both in the awareness file before closing.

## 11. Judge disagreements — resolved

| question | decision | why |
|---|---|---|
| Type home: engine-host (D1/D3, J1, J2) vs contracts (D2, J3) | engine-host | smallest blast radius in a freeze; contracts is foundational (session-runtime hot path) and barrel-pinned; host-only codes don't belong there; engine cannot import contracts anyway |
| `source: explicit\|inferred` field (D1/D3) | dropped | J3: never-produced literal; J1: inferred `ok:true` objects were D2/D3's fail-open. Absence is `undefined`; an object is explicit by construction |
| Default ON (D1/D2, J3) vs OFF (D3, J2 "owner call") | ON | §6; five measured fail-opens would otherwise stay live by default; control round covers comparability |
| OFF still emits `متاح=N` (D1) | rejected (J1/J2/J3 unanimous) | nothing new emitted when OFF |
| executionId from `sha256(key)` (D1) vs unique (D2/D3) | unique per dispatch, key separate | identical retry re-collides under D1 |
| fold key into `operationDigest` (D2) | rejected (J1) | changes the Rust cause hash; no uniqueness gained |
| `isolation_refused` denied (D2/J2) vs breakage (J1) | denied:true | shell.ts:51 "launcher refused BEFORE starting anything" = policy class; loop still fails |
| `turnServers.start` as `refused()` (D3) | `plain()` (inferred) | J1/J3: success path; first-party text where legacy predicate is correct; structured return is a follow-up |
| compile-time Record pin (D1/D2) | replaced by runtime `Bun.file` pin (D3) | engine tsconfig excludes tests; `bun test` never type-checks |
| kind for `network_fetch`: `network_send` (D3) vs `other` | `other` | idempotency.ts:33 defines network_send as outbound effects |
| shell-protocol.ts optional names (D1) | not edited | row type has no optional list; outbound unvalidated |

## 12. Verification commands (only after WP0 clears)

```
cd packages/engine-host && bun test && bun run typecheck      # tests ARE type-checked here
cd packages/engine      && bun test && bun run typecheck      # spawns processes — never while the round is live
bun run typecheck                                              # root: bun turbo typecheck
git diff --stat                                                # only intended lines; no whole-file churn
```
No `cargo build`, no `cargo test`, no `bun run test` in `packages/kernel` (nothing there changes). Counts to expect: engine-host 44+7+(tool-verdict ~6); engine 246 + WP2 appends + 1 serve-wiring — cite only what `bun test` prints.

## 13. Line-ending rule

Preserve each file's **current worktree** ending, verified by bytes (`[IO.File]::ReadAllBytes` or `git ls-files --eol`; never `grep -c $'\r$'` in the Bash tool). CRLF: `cli.ts`, `closure-gate.ts`, `desktop/ui/index.html`, `PRODUCT-CLOSURE-10-SPRINT-PROGRAM.md`. LF: `text-agent-loop.ts`, engine-host `index.ts`, **new** `tool-verdict.ts` + its test, all engine helper files in WP2 except closure-gate, all test files, IDEAS doc. Edit with Edit/sed; never rewrite whole files; after each edit the CR count must equal the file's pre-edit ratio (all-or-none). `core.autocrlf=true` — a whole-file diff means an EOL flip; revert and redo.