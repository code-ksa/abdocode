import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyIgnoredData } from "../src/exec-mode"
import { WORKER_SCOPE_NOTE, workerPortOffset, workerTask } from "../src/parallel-workers"

// 09-30 (مقيس بلا شاشة، «اكمل» على خطّة سبرنتين مستقلّين بعاملين، نموذج المالك ultra): كلُّ عاملٍ نفّذ السبرنتين وأغلق سبرنتَ غيره،
// وتعارض الدمجُ الثاني؛ عاملُ /api/stats أعاد أصفاراً (لا data/ في شجرته)؛ العاملان تسابقا على 3000؛ والأبُ فحص بلا خادمٍ له فأجاب خادمُ عامل.
const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")

test("a worker's task carries its lane: this task only, no plan or handoff edits, its own port", () => {
  const t = workerTask("إنشاء صفحة /about (سبرنت 4)")
  expect(t.startsWith("إنشاء صفحة /about (سبرنت 4)")).toBe(true)
  expect(t).toContain(WORKER_SCOPE_NOTE)
  expect(WORKER_SCOPE_NOTE).toContain("لا تعدّل ABDO-SPRINTS.md ولا ABDO-HANDOFF.md")
  expect([0, 1, 2].map(workerPortOffset)).toEqual([10, 20, 30])
  expect(cli).toContain('ABDO_PARALLEL_WORKER: "1", ABDO_WORKER_PORT_OFFSET: String(workerPortOffset(i))')
  expect(cli).toContain("{ task: workerTask(task), project: PROJECT_DIR")
})

test("in a worker the engine shows no sprint plan, never advances, refuses sprint done and plan/handoff writes", () => {
  expect(cli).toContain("let sprintOpenAtStart = parallelWorker ? undefined : openSprintCount(PROJECT_DIR)")
  expect(cli).toContain('sprintFocusText = parallelWorker ? "" : openSprintSection(PROJECT_DIR)')
  expect(cli).toContain('(process.env.ABDO_PARALLEL_WORKER === "1" ? "" : sprintBrief(PROJECT_DIR))')
  expect(cli).toContain("رُفض: إغلاقُ السبرنتات للأب بعد دمج الفروع")
  expect(cli).toContain('if (process.env.ABDO_PARALLEL_WORKER === "1" && /(?:^|\\/)ABDO-(?:SPRINTS|HANDOFF)\\.md$/iu.test(normalizedTarget)) {')
})

test("probe without a server of this engine names the foreign listener and is not evidence", () => {
  expect(cli).toContain("const ownServer = turnServers.snapshot().some((s) => s.alive) || devServers.snapshot().some((s) => s.alive)")
  expect(cli).toContain("هذا ليس دليلاً على شيفرتك")
  expect(cli).toContain('detail: "probe answered by a server this engine does not manage"')
})

test("ignored data dirs are copied (not linked) into the worktree, real rows readable, the base untouched", () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-wt-data-base-")), dir = mkdtempSync(join(tmpdir(), "abdo-wt-data-dir-"))
  mkdirSync(join(base, "data")); writeFileSync(join(base, "data", "openrouter.db"), "rows")
  const lines: string[] = []
  expect(copyIgnoredData(base, dir, (l) => lines.push(l))).toEqual([join(dir, "data")])
  expect(readFileSync(join(dir, "data", "openrouter.db"), "utf8")).toBe("rows")
  writeFileSync(join(dir, "data", "openrouter.db"), "worker wrote")
  expect(readFileSync(join(base, "data", "openrouter.db"), "utf8")).toBe("rows") // نسخةٌ لا وصلة
  expect(lines.some((l) => l.startsWith("📦 نسخةٌ من data"))).toBe(true)
  expect(copyIgnoredData(base, dir, () => {})).toEqual([]) // موجودٌ من قبل لا يُكتب فوقه
  const empty = mkdtempSync(join(tmpdir(), "abdo-wt-data-empty-"))
  expect(copyIgnoredData(empty, mkdtempSync(join(tmpdir(), "abdo-wt-data-x-")), () => {})).toEqual([])
  expect(existsSync(join(base, "data"))).toBe(true)
  rmSync(base, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
})

test("the managed server shifts a worker's port by its offset before anything else", () => {
  const ms = readFileSync(join(import.meta.dir, "../src/managed-server.ts"), "utf8")
  const start = ms.indexOf("async start(command: ServerCommand, cwd: string): Promise<string> {")
  const shift = ms.indexOf("if (workerOffset > 0) command = { ...command, port: command.port + workerOffset }", start)
  const ours = ms.indexOf("const ours = this.#running.find((p) => p.port === command.port)", start)
  expect(shift).toBeGreaterThan(start)
  expect(shift).toBeLessThan(ours)
})
