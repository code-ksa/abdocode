import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { AdapterEffectLedger } from "@abdo/tool-worker"

// مقيس 2026-09-27: وكيلان متوازيان يكتبان في الدور نفسه، والثاني رُفض بـ
// «journal writer is busy after 0ms; nothing was executed» — فضاعت كتابتُه وقال التقريرُ «نُفّذت».
// كلُّ begin/settle عمليّةُ `abdo-kernel adapter-ledger` قصيرة، والدفترُ كاتبٌ وحيد بانتظارٍ صفريّ افتراضاً.
// الإصلاح في النواة: انتظارٌ محدود (LEDGER_WRITER_WAIT) فيتتابع الأثران، وبعده يبقى الرفضُ مغلقاً.

const HOST = resolve(import.meta.dir, "../../kernel/target/release/abdo-kernel.exe")
const hex = (value: string) => createHash("sha256").update(value).digest("hex")

test.skipIf(process.platform !== "win32" || !existsSync(HOST))("parallel effects on one journal all record instead of one being refused as busy", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-ledger-parallel-"))
  const journal = join(home, "abdocode.sqlite")
  try {
    const ledger = new AdapterEffectLedger(HOST, journal)
    const one = async (n: number) => {
      const id = randomUUID().replaceAll("-", "")
      const op = hex(`op-${n}`)
      await ledger.begin(id, op)
      await ledger.settle(id, op, hex(`outcome-${n}`))
    }
    // ثمانيةٌ معاً — أكثرُ من فريقٍ حقيقيّ في وضع «أقوى+» (حتى 4)، وأقلُّ من «أقصى» (حتى 12).
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => one(n)))
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected").map((o) => String(o.reason).slice(0, 200))
    expect(refused).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)
