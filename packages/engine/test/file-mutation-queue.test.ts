/**
 * م9هـ — طابورُ كتابة الملفّ الواحد. التوأمان: بلا طابورٍ يضيع تحديثٌ (الأخُ الثاني يقرأ الأساسَ القديم فيمحو ما كتبه
 * الأوّل)، وبالطابور يبقى الاثنان — يُقاس بالقرص لا بالعائد. والطفرةُ التي تُحمّر هذا الاختبار: تشغيلُ العملين بلا run().
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileMutationQueue, queueWaitLine } from "../src/file-mutation-queue"

/** قطاعُ كتابةٍ يشبه المحرّك: يقرأ الأساس، ينتظر «موافقة»، يفحص القرص، ثمّ يكتب — وفحصُ القرص هو الحارسُ القائم. */
const writeSection = (path: string, append: string, approvalMs: number) => async (): Promise<"written" | "refused"> => {
  const baseline = readFileSync(path, "utf8")
  await Bun.sleep(approvalMs)
  if (readFileSync(path, "utf8") !== baseline) return "refused"
  writeFileSync(path, baseline + append)
  return "written"
}

describe("file mutation queue", () => {
  test("negative twin: without the queue, siblings on one file race — one is refused by the disk guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-fmq-")); const file = join(dir, "a.txt"); writeFileSync(file, "base\n")
    try {
      const [a, b] = await Promise.all([writeSection(file, "A\n", 40)(), writeSection(file, "B\n", 60)()])
      expect([a, b].sort()).toEqual(["refused", "written"])
      expect(readFileSync(file, "utf8")).toBe("base\nA\n")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("positive twin: with the queue, the second sibling reads what the first wrote and both land on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-fmq-")); const file = join(dir, "a.txt"); writeFileSync(file, "base\n")
    const queue = new FileMutationQueue()
    try {
      const first = queue.run(file, writeSection(file, "A\n", 40))
      // الثاني يُسجَّل والأوّل ما يزال جارياً: pending يقول ١ أمامه — السطرُ يُقال قبل الانتظار.
      expect(queue.pending(file)).toBe(1)
      const second = queue.run(file, writeSection(file, "B\n", 10))
      expect(queue.pending(file)).toBe(2)
      expect(await Promise.all([first, second])).toEqual(["written", "written"])
      expect(readFileSync(file, "utf8")).toBe("base\nA\nB\n")
      expect(queue.pending(file)).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("different paths do not wait for each other; a thrown work does not block the next on the same path", async () => {
    const queue = new FileMutationQueue(false)
    const order: string[] = []
    const slow = queue.run("/p/one.txt", async () => { await Bun.sleep(60); order.push("one"); return 1 })
    const fast = queue.run("/p/two.txt", async () => { order.push("two"); return 2 })
    await Promise.all([slow, fast])
    expect(order).toEqual(["two", "one"])
    const boom = queue.run("/p/x.txt", async () => { throw new Error("boom") })
    const after = queue.run("/p/x.txt", async () => "ok")
    await expect(boom).rejects.toThrow("boom")
    expect(await after).toBe("ok")
    expect(queue.pending("/p/x.txt")).toBe(0)
  })

  test("the key ignores letter case on Windows and slash direction, and the wait line names the count", () => {
    const win = new FileMutationQueue(true)
    expect(win.keyFor("C:\\proj\\A.TXT")).toBe(win.keyFor("c:/proj/a.txt"))
    const posix = new FileMutationQueue(false)
    expect(posix.keyFor("/proj/A.TXT")).not.toBe(posix.keyFor("/proj/a.txt"))
    expect(queueWaitLine("src/app.ts", 2)).toContain("src/app.ts")
    expect(queueWaitLine("src/app.ts", 2)).toContain("تنتظر 2 قبلها")
  })
})
