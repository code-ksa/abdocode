// م9ط — نقاطُ الرجوع لكلّ دور: الأصلُ يُحفظ قبل الكتابة الأولى، والاستعادةُ تعيد الموجودَ وتحذف ما لم يكن، وترفض مشروعاً آخر.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKPOINT_BYTES_CAP, CheckpointStore, restoreReportLine } from "../src/turn-checkpoint"

const scratch = () => mkdtempSync(join(tmpdir(), "abdo-ckpt-"))

describe("CheckpointStore", () => {
  test("records the original once per path, restores edited files and removes files the turn created", () => {
    const root = scratch(); const project = join(root, "proj"); mkdirSync(project)
    const store = new CheckpointStore(join(root, "state"))
    const a = join(project, "a.txt"); writeFileSync(a, "alpha-1")
    const b = join(project, "src", "new.ts")
    expect(store.record("s1", "t1", project, a)).toBe("recorded")
    expect(store.record("s1", "t1", project, a)).toBe("already")
    expect(store.record("s1", "t1", project, b)).toBe("recorded") // لم يكن موجوداً
    // «الدور» يكتب
    writeFileSync(a, "alpha-2"); mkdirSync(join(project, "src")); writeFileSync(b, "export {}")
    expect(store.list("s1", project)).toEqual([expect.objectContaining({ turnId: "t1", files: 2, skipped: 0 })])
    const report = store.restore("s1", "t1", project)
    expect(report.ok).toBe(true)
    if (report.ok) { expect(report.restored).toEqual([a]); expect(report.removed).toEqual([b]); expect(report.skipped).toEqual([]) }
    expect(readFileSync(a, "utf8")).toBe("alpha-1")
    expect(existsSync(b)).toBe(false)
    expect(restoreReportLine(report)).toContain("1 ملفّاً أُعيد")
    rmSync(root, { recursive: true, force: true })
  })
  test("refuses another project, names a missing checkpoint, skips oversized files by name, and prunes old turns", () => {
    const root = scratch(); const project = join(root, "proj"); const other = join(root, "other"); mkdirSync(project); mkdirSync(other)
    const store = new CheckpointStore(join(root, "state"))
    const big = join(project, "big.bin"); writeFileSync(big, Buffer.alloc(CHECKPOINT_BYTES_CAP + 1))
    expect(store.record("s1", "t1", project, big)).toBe("skipped-large")
    expect(store.list("s1", project)[0]).toMatchObject({ files: 0, skipped: 1 })
    const foreign = store.restore("s1", "t1", other)
    expect(foreign.ok).toBe(false); if (!foreign.ok) expect(foreign.why).toContain("لمشروعٍ آخر")
    const missing = store.restore("s1", "t9", project)
    expect(missing.ok).toBe(false); if (!missing.ok) expect(missing.why).toContain("لا نقطةَ رجوعٍ")
    const ok = store.restore("s1", "t1", project)
    expect(ok.ok).toBe(true); if (ok.ok) expect(ok.skipped[0]).toContain("big.bin")
    for (let i = 2; i <= 5; i += 1) { const f = join(project, `f${i}.txt`); writeFileSync(f, String(i)); store.record("s1", `t${i}`, project, f) }
    expect(store.prune("s1", 3)).toBe(2)
    expect(store.list("s1", project).length).toBe(3)
    // مشروعٌ آخر لا يرى نقاطَ هذا المشروع
    expect(store.list("s1", other)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
  test("a tampered blob is not written back (named in skipped) — the twin of the happy path", () => {
    const root = scratch(); const project = join(root, "proj"); mkdirSync(project)
    const store = new CheckpointStore(join(root, "state"))
    const a = join(project, "a.txt"); writeFileSync(a, "good")
    store.record("s1", "t1", project, a)
    const blob = join(root, "state", "s1", "t1", "f0"); writeFileSync(blob, "evil")
    writeFileSync(a, "changed")
    const report = store.restore("s1", "t1", project)
    expect(report.ok).toBe(true); if (report.ok) { expect(report.restored).toEqual([]); expect(report.skipped[0]).toContain("تالفة") }
    expect(readFileSync(a, "utf8")).toBe("changed")
    rmSync(root, { recursive: true, force: true })
  })
})
