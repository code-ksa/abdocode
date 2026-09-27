import { expect, test } from "bun:test"
import { ToolVerdictLedger } from "@abdo/engine-host"
import { describeFrame, semanticFrame } from "@abdo/semantic"
import { gateEventLine } from "../src/front-gate"
import { epochReceiptLine } from "../src/receipt-ledger-line"
import { renderLedgerLine } from "../src/token-budget"
import { exposureLine } from "../src/tool-exposure"
import { renderTurnBudgetLine, TurnSpendMeter } from "../src/turn-budget"
import { describeWorkProfile, workProfile } from "../src/work-mode"
import { engineLineForDisplay, engineOutputForDisplay, providerLabelsForDisplay, readWhenForDisplay } from "../../desktop/ui/engine-lines.js"
import { providerDisplayLabel } from "../../desktop/ui/provider-display.js"
import { Providers } from "../../providers/src/catalog"

// أسطرُ المحرّك التشخيصيّة عربيّةٌ على السلك، والواجهةُ الإنجليزيّة تعرضها بالإنجليزيّة (مقيس 2026-09-27 على
// أدوارٍ حقيقيّة). المولِّداتُ الحقيقيّة هنا لا نسخٌ منها: تغييرُ صيغةٍ في المحرّك يُحمِّر هذا الاختبار بدل أن
// يعود السطرُ عربيّاً بصمت.

const ARABIC = /[\u0600-\u06FF]/u
const outsideQuotes = (text: string) => text.replace(/«[^»]*»/gu, "")
const fullyEnglish = (line: string) => {
  const shown = engineLineForDisplay(line, "en").split("\n")[0]!
  expect(ARABIC.test(line)).toBe(true)
  expect(ARABIC.test(outsideQuotes(shown))).toBe(false)
  return shown
}

test("the engine's own generators render fully in English, and unchanged in Arabic", () => {
  const verdicts = new ToolVerdictLedger()
  verdicts.observe("list .", undefined)
  const meter = new TurnSpendMeter(400_000)
  const lines = [
    `🧭 ${describeFrame(semanticFrame("List the files in this project and summarise README.md"))}`,
    `🧭 ${describeFrame(semanticFrame("احذف ملف من نحن"))}`,
    exposureLine(38, 68, new Set()),
    exposureLine(40, 68, new Set(["web", "git"])),
    renderLedgerLine({ calls: 3, inputTokens: 900, cachedInputTokens: 300, outputTokens: 50, effectiveTokens: 700, cacheHitRate: 1 / 3 }, 100_000),
    renderTurnBudgetLine(meter.snapshot(), 1),
    verdicts.line(1),
    new ToolVerdictLedger().line(2),
    epochReceiptLine(1, "read README.md", "ok"),
    `🧭 ${describeWorkProfile(workProfile("basic"))}`,
    `🧭 ${describeWorkProfile(workProfile("max"))}`,
    gateEventLine({ decision: "answered", ref: "qwen-token-plan/qwen3.7-plus", inputTokens: 10, outputTokens: 5 }),
    gateEventLine({ decision: "escalated", reason: "tools", ref: "qwen-token-plan/qwen3.7-plus" }),
    "🧾 نظام: identity 386b · environment 161b · tool-contract 1.6k · كتالوج 7.8k = 12k",
    "✓ نقطة حفظ الحقبة 1: أدوات=2 · السبب=complete · ضغط القراءة=0 · ضغط التنفيذ=0 · أثر الحقبة=1624 · ضغط الكتابة=0 · إعادة المكرَّر=0",
    "— المقيس: دخل 3364 توكيناً (قدّرنا 4212)، خرج 143، في 2.1 ثانية، والسياق فهارس L0 كلّها.",
    "— حقب التنفيذ: 1 · الأدوات: 2 · التوقف: complete",
    "⚠ رد النموذج بلا أداة (ليس إيصال إنجاز):",
    "النواة: حاضرة (نسخة الـ72 ساعة) · دفتر النواة: 21 صفّاً · قدرات المنتج: 11/11",
    "بيئة الأبناء: يُنزع 2 متغيّراً (ABDO_VAULT_DIR، ABDO_VAULT_SCRIPT)",
  ]
  for (const line of lines) {
    fullyEnglish(line)
    expect(engineLineForDisplay(line, "ar")).toBe(line)
  }
  // «نفي» كلمةٌ قائمة، ولا تُطابَق داخل «التنفيذ».
  expect(fullyEnglish(lines[14]!)).toContain("exec compactions=0")
  // هدفُ المستخدم المقتبَس يبقى كما كتبه.
  expect(fullyEnglish(lines[1]!)).toContain("«")
})

test("model and user text is never rewritten, and a partly known line stays whole", () => {
  for (const text of [
    "أنا عبدو كود، مساعدٌ للبرمجة.",
    "✓ تمّ: أضفتُ الدالّة وشغّلتُ الاختبارات",
    "🧭 سطرٌ جديدٌ لم يُعرف بعد: لغة: ar",
    "The project contains the following files:",
  ]) expect(engineLineForDisplay(text, "en")).toBe(text)
})

test("tool output: the kernel receipt and clip note translate, file contents never do", () => {
  const output = "قرأت النواةُ الملفَّ وتحقّقت منه — بصمة المحتوى 5682af69b033e0e1… والأطوار السبعة في دفتر النواة (صفوفه الآن: 7).\n--- README.md ---\n# عرض\n✓ نقطة حفظ الحقبة في ملفّ المستخدم\n\n…[قُصّ: عُرض 100 من 900 حرفاً]"
  const shown = engineOutputForDisplay(output, "en").split("\n")
  expect(shown[0]).toBe("The kernel read and verified the file — content digest 5682af69b033e0e1…, all seven phases in the kernel ledger (rows now: 7).")
  expect(shown[2]).toBe("# عرض")
  expect(shown[3]).toBe("✓ نقطة حفظ الحقبة في ملفّ المستخدم")
  expect(shown[5]).toBe("…[clipped: showing 100 of 900 characters]")
  expect(engineOutputForDisplay(output, "ar")).toBe(output)
  // حدثُ إيصال الحقبة: سطرُه الأوّل للمحرّك، وما بعده خرجُ أداة.
  const receipt = engineLineForDisplay(epochReceiptLine(1, "read a.md", "✓ نقطة حفظ الحقبة في المحتوى"), "en").split("\n")
  expect(receipt[0]).toBe("↻ epoch 1 · read a.md")
  expect(receipt[1]).toBe("✓ نقطة حفظ الحقبة في المحتوى")
})

test("every conditional plugin reader in the engine registry has an English condition", async () => {
  const registry = await Bun.file(new URL("../src/plugin-registry.ts", import.meta.url)).text()
  const conditions = [...new Set([...registry.matchAll(/readWhen: "([^"]+)"/gu)].map((m) => m[1]!))]
  expect(conditions.length).toBeGreaterThan(10)
  for (const condition of conditions) {
    const english = readWhenForDisplay(condition, "en")
    expect(english).not.toBe(condition)
    expect(ARABIC.test(english)).toBe(false)
    expect(readWhenForDisplay(condition, "ar")).toBe(condition)
  }
})

test("notices name bundled providers in the interface language", () => {
  const why = "كوين — خطة التوكنز: The provider credential is unavailable or rejected. Open Settings → Providers to connect your vault and check the connection."
  expect(providerLabelsForDisplay(why, Providers, providerDisplayLabel, "en")).toStartWith("Qwen Token Plan: The provider credential")
  expect(providerLabelsForDisplay(why, Providers, providerDisplayLabel, "ar")).toBe(why)
})
