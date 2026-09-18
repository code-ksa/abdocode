import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// د7ب — أسلاكُ نطاق الدور في cli.ts: القراءةُ المؤطَّرة تُسجَّل، المجموعتان تُصفَّران عند بدء كلّ دور مع لحظته، الحكمُ يسبق قراءةَ «قبل»
// وكلَّ حرّاس المحتوى وبوّابةَ الموافقة، والكتابةُ الناجحة تُسجِّل الملفَّ مقروءاً (ومُنشأً إن لم يكن موجوداً).
const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

test("state and reset: per-turn sets and the turn start time live beside the desktop trust set and reset where the task text is captured", () => {
  expect(cli).toContain('import { fileEditAllowedByTurn, scopeKey } from "./turn-scope-gate"')
  expect(cli).toContain("const turnReadPaths = new Set<string>()")
  expect(cli).toContain("const turnCreatedPaths = new Set<string>()")
  // المفتاحُ يُحلّ على مجلّد المشروع: المسارُ المطلق (كما كتبه nemotron حيّاً) والنسبيّ مفتاحٌ واحد.
  expect(cli).toContain("const turnScopeKey = (path: string): string => scopeKey(relative(PROJECT_DIR, resolve(PROJECT_DIR, path)))")
  expect(cli).toContain("turnReadPaths.clear(); turnCreatedPaths.clear(); turnScopeStartedAt = Date.now()")
  const taskText = cli.indexOf("desktopTaskText = `${turn.body}\\n${priorGoal?.goal ?? \"\"}`")
  const reset = cli.indexOf("turnReadPaths.clear(); turnCreatedPaths.clear(); turnScopeStartedAt = Date.now()")
  expect(taskText).toBeGreaterThan(0)
  expect(reset - taskText).toBeLessThan(120)
})

test("reads are recorded on the framed read route (text and native alike), from planRead's file", () => {
  expect(cli).toContain('if (!("error" in readPlan)) turnReadPaths.add(turnScopeKey(readPlan.file))')
  const record = cli.indexOf("turnReadPaths.add(turnScopeKey(readPlan.file))")
  const dispatch = cli.indexOf("return readCommandV(readArgs)")
  expect(record).toBeGreaterThan(0)
  expect(record).toBeLessThan(dispatch)
})

test("the verdict sits after the path broker and before the content guards and the approval gate; success records read/created", () => {
  const verdict = cli.indexOf("const scope = fileEditAllowedByTurn({ target: turnScopeKey(normalizedTarget), exists: targetExists, modifiedAtMs: targetExists ? lstatSync(checked.abs).mtimeMs : undefined, turnStartedAtMs: turnScopeStartedAt, taskText: desktopTaskText, readThisTurn: turnReadPaths, createdThisTurn: turnCreatedPaths })")
  const refusal = cli.indexOf("if (!scope.ok) return refused(scope.why)")
  const broker = cli.indexOf("const checked = brokerPath(target)\r\n    if (!checked.ok) return refused(checked.why)\r\n    // مجلّدٌ يحمل اسمَ الهدف")
  const identity = cli.indexOf("const identityWrite = { projectDir: PROJECT_DIR, normalizedTarget")
  const gate = cli.indexOf('const ok = await gate(turnId, "edit", `كتابة ${target}')
  expect(broker).toBeGreaterThan(0)
  expect(verdict).toBeGreaterThan(broker)
  expect(refusal).toBeGreaterThan(verdict)
  expect(refusal).toBeLessThan(identity)
  expect(identity).toBeLessThan(gate)
  expect(cli).toContain("if (r.verdict?.ok === true) { turnReadPaths.add(turnScopeKey(normalizedTarget)); if (!targetExists) turnCreatedPaths.add(turnScopeKey(normalizedTarget)) }")
})
