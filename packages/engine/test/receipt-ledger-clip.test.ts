import { describe, expect, test } from "bun:test"
import { epochReceiptLine, RECEIPT_LEDGER_CLIP } from "../src/receipt-ledger-line"

/**
 * S11 (2026-09-18) — قصُّ حمولة إيصال الأداة في دفتر الأحداث.
 *
 * مقيس على دفاتر المثبّتات: 700 حرف (≈825 مع الرأس) تبتر شجرةَ الصفحة ونتيجةَ `look` فلا
 * يُتحقّق من الإيصال بعد الدور. السقفُ 4,000 لدفتر الأحداث وحده — بثُّ القشرة عند 16k لا يُمسّ.
 */
const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("S11 — سقفُ حمولة إيصال الأداة في الدفتر", () => {
  test("السقفُ 4,000 حرف: حمولةُ 5,000 تبقى بأربعة آلاف لا بسبعمئة، والأقصرُ تمرّ كاملةً", () => {
    expect(RECEIPT_LEDGER_CLIP).toBe(4_000)
    const page = "[r1] textbox: البريد\n".repeat(400) // ≈ 8,400 حرف
    const line = epochReceiptLine(3, "chrome.page", page)
    const [head, ...body] = line.split("\n")
    expect(head).toBe("↻ حقبة 3 · chrome.page")
    expect(body.join("\n").length).toBe(4_000)
    // التوأمُ الإيجابيّ: ما يتجاوز 700 يصل — لم يكن يصل قبل S11.
    expect(body.join("\n").length).toBeGreaterThan(825)
    const short = epochReceiptLine(1, "run npm test\nignored second line", "انتهى الأمر برمز 0")
    expect(short).toBe("↻ حقبة 1 · run npm test\nانتهى الأمر برمز 0")
  })

  test("cli.ts يكتب سطرَ الإيصال بهذه الدالّة، ولم يبقَ قصٌّ عند 700 لإيصال الأداة؛ وبثُّ القشرة عند 16k كما كان", () => {
    expect(cliSource).toContain("await emitEvent(turn.id, redactForStore(epochReceiptLine(epoch, receipt.command, receipt.output)))")
    expect(cliSource).not.toContain("${receipt.output.slice(0, 700)}")
    expect(cliSource).toContain('emit({ kind: "tool-result", turnId: turn.id, cmd, output: output.slice(0, 16000), outputTruncated: output.length > 16000')
  })
})
