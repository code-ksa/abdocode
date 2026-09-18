// م9ط — أسلاكُ نقاط الرجوع في cli.ts: التسجيلُ بعد البوّابة وفحص القرص وقبل الأثر، وكلمتا المشغّل قبل حارة الشات.
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("turn checkpoints wiring", () => {
  test("the store lives under the state root, record() sits between the gate/disk check and the write effect, and the words precede compact", () => {
    expect(source).toContain('import { CheckpointStore, restoreReportLine } from "./turn-checkpoint"')
    expect(source).toContain('const checkpoints = new CheckpointStore(join(STATE_ROOT, "checkpoints"))')
    const gate = source.indexOf('const ok = await gate(turnId, "edit", `كتابة ${target} (${after.length} حرفاً)`)')
    const disk = source.indexOf("if (diskNow !== baseline) {", gate)
    const record = source.indexOf("checkpoints.record(currentSession, turnId, PROJECT_DIR, checked.abs)", disk)
    const effect = source.indexOf('const r = await runAdapterV("write", "write_file", { path: checked.abs, content: after }', record)
    expect(gate).toBeGreaterThan(0); expect(disk).toBeGreaterThan(gate); expect(record).toBeGreaterThan(disk); expect(effect).toBeGreaterThan(record)
    expect(effect - record).toBeLessThan(400)
    // التسجيلُ مرّةٌ واحدة في المصدر — لا مسارَ كتابةٍ ثانٍ يتجاوزه (كلُّ الكتابات تمرّ بـrunWriteToolV)
    expect(source.match(/checkpoints\.record\(/gu)).toHaveLength(1)
    const words = source.indexOf('if (/^\\/?checkpoints$/iu.test(turn.body.trim()) || turn.body.trim() === "نقاط الرجوع") {')
    const rollback = source.indexOf('const rollback = /^\\/?rollback(?:\\s+(\\S+))?$/iu.exec(turn.body.trim()) ?? /^ارجع إلى ما قبل الدور(?:\\s+(\\S+))?$/u.exec(turn.body.trim())', words)
    const compact = source.indexOf('if (/^\\/?compact$/iu.test(turn.body.trim()) || turn.body.trim() === "اضغط السياق") {', rollback)
    expect(words).toBeGreaterThan(0); expect(rollback).toBeGreaterThan(words); expect(compact).toBeGreaterThan(rollback)
    // الدورُ الحاليّ لا يُستعاد، والتقريرُ يصل السجلَّ حدثاً ثمّ الجواب
    expect(source).toContain("checkpoints.list(currentSession, PROJECT_DIR).filter((c) => c.turnId !== turn.id)")
    expect(source).toContain("const report = checkpoints.restore(currentSession, chosen, PROJECT_DIR)")
    expect(source).toContain("await emitEvent(turn.id, line)")
    // مقيس على 4.0.11: الجوابُ لا يكرّر سطرَ الحدث (كان يظهر مرّتين في السجلّ)
    expect(source).toContain('return { answer: report.ok ? "↩ تمّ الرجوع — التفاصيل في السطر أعلاه." : line, completed: report.ok }')
  })
})
