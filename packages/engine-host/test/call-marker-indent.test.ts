import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"
import { trimCallMarkerIndent } from "../src/text-agent-loop"

/**
 * 🔴 **مسافةٌ واحدةٌ قبل «نفّذ:» كانت تُلغي الدورَ كلَّه.**
 *
 * النصُّ في الاختبار الأوّل **حرفيٌّ** من جولةِ قياسٍ كاملة (2026-09-26، مهمّة م9):
 * النموذجُ كتب سطرَ النداء بمسافةٍ واحدةٍ قبل العلامة، فلم يطابق `^نفّذ:` شيئاً، فحُكم
 * «ردٌّ بلا أداة»، فانتهى الدورُ عند الحقبة الأولى بـ**صفر أدوات** و«التوقف: complete».
 * 9/28 بدل 26/28، وإحدى عشرةَ ثانيةً بدل أربعين دقيقة — **والمهمّةُ ماتت وهي «مكتملة»**.
 *
 * وهي سابقةُ غلافِ `**` نفسُها (09-13، الاختبار الأخ `markdown-call`): ما يحيط
 * بالعلامةِ زخرفةٌ لا حدُّ تنفيذ.
 */
const drive = async (replies: readonly string[], callable = (name: string) => ["read", "write", "list"].includes(name)) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  const result = await runTextAgentLoop({
    input: "اقرأ TASK.md ونفّذ المراحل", history: [], maxRounds: 6,
    ask: async () => script.shift()!,
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: callable,
  })
  return { result, dispatched }
}

describe("horizontal space before the call marker is decoration, not an execution boundary", () => {
  test("THE MEASURED REPLY (the positive twin): one leading space now dispatches the read", async () => {
    const { dispatched } = await drive([
      "I'll start by reading TASK.md to understand the four stages. I'll also check the project structure. \n\n نفّذ: read TASK.md",
    ])
    expect(dispatched).toEqual(["read TASK.md"])
  })

  test("every horizontal space, direction mark and zero-width char before the marker is stripped", async () => {
    const leads = [" ", "  ", "\t", "\u00A0", "\u3000", "\u200E", "\u200F", "\u061C", "\uFEFF", " \u200F\t"]
    for (const lead of leads) {
      const { dispatched } = await drive([`سأقرأ الملفّ أوّلاً.\n\n${lead}نفّذ: read TASK.md`])
      expect(`${JSON.stringify(lead)} ⇦ ${dispatched.join("|")}`).toBe(`${JSON.stringify(lead)} ⇦ read TASK.md`)
    }
  })

  test("a NEW LINE is never swallowed, and an indented bullet still belongs to the markdown unwrapper", async () => {
    // النزعُ **أفقيٌّ فقط**: لو أكل السطرَ الجديد لالتصق نداءان فصارا واحداً.
    expect(trimCallMarkerIndent("أ\n نفّذ: read a\n نفّذ: read b")).toBe("أ\nنفّذ: read a\nنفّذ: read b")
    // وسطرُ القائمة المُزاح يبقى نصّاً كما هو، ويبقى `unwrapMarkdownCall` هو مَن يفكّه.
    expect(trimCallMarkerIndent("  - نفّذ: read a")).toBe("  - نفّذ: read a")
    expect((await drive(["  - نفّذ: read a"])).dispatched).toEqual(["read a"])
  })

  test("the twins hold: two calls are still refused, and a written-file claim is still refused", async () => {
    // لو صار النزعُ يبتلع الأسطر لمرّ هذا الردّ نداءً واحداً — فهذا حارسُ الفرق.
    expect((await drive([" نفّذ: read a.ts\n نفّذ: write b.ts <<<\nx"])).dispatched).toEqual([])
    expect((await drive(["تم إنشاء الملف index.html بنجاح.\n\n نفّذ: read index.html"])).dispatched).toEqual([])
  })

  test("an indented payload line does not become a second call", async () => {
    // حمولةُ كتابةٍ تحمل سطراً مُزاحاً يبدأ بالعلامة: النزعُ يجعله بادئةً في صدر السطر،
    // فيُرفض الردُّ «نداءَين» — وهو **الرفضُ نفسُه** الذي كان يقع لو كُتب بلا إزاحة.
    // فالقاعدةُ واحدةٌ للشكلين، ولا يفتح النزعُ باباً لم يكن مفتوحاً.
    const payload = await drive(["نفّذ: write note.md <<<\nسطرٌ عاديّ\n  نفّذ: ليس نداءً"])
    expect(payload.dispatched).toEqual([])
    const plain = await drive(["نفّذ: write note.md <<<\nسطرٌ عاديّ\nنفّذ: ليس نداءً"])
    expect(payload.dispatched).toEqual(plain.dispatched)
  })
})

describe("an UNKNOWN wrapper shape costs one call, not the whole task", () => {
  /**
   * الشكلُ المعروفُ يُشفى قبل المطابقة — وهذه شبكةُ ما لم نره بعد. مقيسٌ مرّتين أنّ
   * ردّاً يحمل العلامةَ بشكلٍ غيرِ متوقّعٍ يُقرأ «اكتمالاً» فيموت الدورُ بصفرِ أدوات.
   */
  const driveCapturing = async (replies: readonly string[]) => {
    const script = [...replies]
    const asked: string[] = []
    const dispatched: string[] = []
    const result = await runTextAgentLoop({
      input: "اقرأ TASK.md", history: [], maxRounds: 6,
      // `ask` يتلقّى **نصَّ الطلب** لا مصفوفةَ رسائل — التقاطُ الشكل الخطأ يجعل الفحصَ يمرّ فارغاً (قِيس هنا).
      ask: async (prompt) => { asked.push(prompt); return script.shift() ?? "تم" },
      dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
      isCallable: (name) => ["read", "write"].includes(name),
    })
    return { result, asked, dispatched }
  }

  test("a shape nothing unwraps is asked again with the rule — then its call runs", async () => {
    // غلافٌ لم نره: العلامةُ داخل علامتَي اقتباسٍ عربيّتين في وسط جملة.
    const { asked, dispatched, result } = await driveCapturing([
      `سأقرأ الملفّ الآن «نفّذ: read TASK.md» ثمّ أكمل.`,
      `نفّذ: read TASK.md`,
    ])
    expect(dispatched).toEqual(["read TASK.md"])
    expect(asked.some((a) => a.includes("ولم يُقرأ استدعاءً"))).toBe(true)
    expect(result.stopReason).toBe("complete")
  })

  test("the twin: it asks ONCE — a reply that keeps the shape is not circled forever", async () => {
    const { asked, dispatched } = await driveCapturing([
      `سأقرأ «نفّذ: read a» الآن.`,
      `وسأقرأ «نفّذ: read b» أيضاً.`,
    ])
    expect(dispatched).toEqual([])
    expect(asked.filter((a) => a.includes("ولم يُقرأ استدعاءً"))).toHaveLength(1)
  })

  test("the twin: a final answer with no marker at all is still accepted without an extra call", async () => {
    const { asked, dispatched, result } = await driveCapturing(["أنجزتُ المراحلَ الأربع، والاختبارُ أخضر."])
    expect(dispatched).toEqual([])
    expect(asked).toHaveLength(1)
    expect(result.stopReason).toBe("complete")
  })
})
