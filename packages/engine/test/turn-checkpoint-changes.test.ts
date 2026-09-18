/**
 * م9ح — `CheckpointStore.changes()`: الأصلُ من نقطة الرجوع والحاليُّ من القرص؛ الملفُّ المُنشأ بلا `before`، المحذوفُ بلا `after`،
 * الذي عاد كما كان لا يُذكر، والثنائيُّ يُسمّى بلا محتوى؛ ومشروعٌ آخر يعيد فراغاً.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointStore } from "../src/turn-checkpoint"

describe("checkpoint changes for the review lane", () => {
  test("edited, created, deleted, unchanged and binary files are reported by what the disk says now", () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-ckpt-changes-"))
    const project = join(base, "proj"); mkdirSync(project)
    const store = new CheckpointStore(join(base, "state"))
    try {
      const edited = join(project, "edited.txt"); writeFileSync(edited, "v1")
      const created = join(project, "created.txt")
      const deleted = join(project, "deleted.txt"); writeFileSync(deleted, "gone")
      const same = join(project, "same.txt"); writeFileSync(same, "same")
      const binary = join(project, "img.bin"); writeFileSync(binary, Buffer.from([0x89, 0x50, 0x00, 0x47]))
      for (const p of [edited, created, deleted, same, binary]) store.record("s1", "t1", project, p)
      writeFileSync(edited, "v2"); writeFileSync(created, "new"); unlinkSync(deleted); writeFileSync(same, "same"); writeFileSync(binary, Buffer.from([0x00, 0x01]))
      const rows = store.changes("s1", "t1", project)
      const byPath = new Map(rows.map((r) => [r.path, r]))
      expect(byPath.get(edited)).toEqual({ path: edited, before: "v1", after: "v2" })
      expect(byPath.get(created)).toEqual({ path: created, after: "new" })
      expect(byPath.get(deleted)).toEqual({ path: deleted, before: "gone" })
      expect(byPath.has(same)).toBe(false)
      expect(byPath.get(binary)).toEqual({ path: binary })
      expect(store.changes("s1", "t1", join(base, "other"))).toEqual([])
      expect(store.changes("s1", "t9", project)).toEqual([])
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})
