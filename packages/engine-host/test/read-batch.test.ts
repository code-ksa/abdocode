import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src/text-agent-loop"

// ذ9و — حزمةُ القراءة: عدّةُ نداءاتِ قراءةٍ في ردٍّ واحد تُوزَّع بالترتيب وتُطعَم كلُّها **قبل** النداء التالي.
// ما يُثبَت هنا: القبولُ الضيّق (قرّاءٌ خُلَّصٌ بسطرٍ واحد وحدهم)، والرفضُ الكامل لأيّ خلطٍ بأداةِ أثر،
// والتكرارُ يُسقَط عند القبول لا وسط التوزيع، ونداءُ نموذجٍ **واحدٌ** للحزمة كلِّها، وتعطيلُها حين تطلب البوّابةُ إصلاحاً.

interface Harness {
  readonly dispatched: string[]
  readonly asks: { prompt: string; history: readonly { role: string; content: string }[] }[]
  readonly rejections: string[]
  readonly result: Awaited<ReturnType<typeof runTextAgentLoop>>
}

/** يشغّل الحلقةَ بردودٍ مُعدّة: `replies[0]` أوّلُ ردّ، ثمّ ردٌّ لكلّ نداءٍ تالٍ. */
async function run(replies: readonly string[], options: Partial<Parameters<typeof runTextAgentLoop>[0]> = {}): Promise<Harness> {
  const dispatched: string[] = []
  const asks: { prompt: string; history: readonly { role: string; content: string }[] }[] = []
  const rejections: string[] = []
  const queue = [...replies]
  const result = await runTextAgentLoop({
    input: "اقرأ الملفّات",
    history: [],
    // الردُّ الأوّل يأتي من أوّل نداء: الحلقةُ تسأل النموذجَ قبل أن تحلّل شيئاً.
    ask: async (prompt, history) => {
      asks.push({ prompt, history: history.map((m) => ({ role: m.role, content: m.content })) })
      return queue.shift() ?? "تمّت القراءة."
    },
    dispatch: async (command) => { dispatched.push(command); return `محتوى ${command}` },
    isCallable: (name) => ["read", "list", "glob", "grep", "git", "docs", "write", "run"].includes(name),
    onProposalRejected: (why) => { rejections.push(why) },
    maxRounds: 6,
    ...options,
  } as Parameters<typeof runTextAgentLoop>[0])
  return { dispatched, asks, rejections, result }
}

describe("ذ9و — حزمةُ القراءة في حلقة النصّ", () => {
  test("ثلاثةُ قرّاءٍ في ردٍّ واحد: تُوزَّع بالترتيب، وتُطعَم كلُّها، ونداءُ نموذجٍ واحدٌ بعد آخرها", async () => {
    const h = await run(["نفّذ: read a.ts\nنفّذ: read b.ts\nنفّذ: grep foo src", "تمّت القراءة."])
    expect(h.dispatched).toEqual(["read a.ts", "read b.ts", "grep foo src"])
    // نداءان فقط: الأوّلُ يبدأ الدور، والثاني بعد الحزمة كلِّها — لا نداءَ بين قراءتين
    expect(h.asks).toHaveLength(2)
    const second = h.asks[1]!
    // النتيجتان الأوليان في تاريخ النداء الثاني، والثالثةُ في متنه
    const history = second.history.map((m) => m.content).join("\n")
    expect(history).toContain("محتوى read a.ts")
    expect(history).toContain("محتوى read b.ts")
    expect(second.prompt).toContain("محتوى grep foo src")
    expect(second.prompt).toContain("حزمة القراءة (3 نداءً)")
    // والأثرُ يعرض النداءات الثلاثة للمشغّل
    expect(h.result.answer).toContain("⚙ read a.ts")
    expect(h.result.answer).toContain("⚙ grep foo src")
    expect(h.rejections).toEqual([])
  })

  test("خلطُ أداةِ أثرٍ بالقراءة يُرفض كلُّه — القاعدةُ القديمة بنصّها، ولا يُوزَّع شيء", async () => {
    const h = await run(["نفّذ: read a.ts\nنفّذ: write b.ts <<<\nمحتوى", "تمّت."])
    expect(h.dispatched).toEqual([])
    expect(h.rejections[0]).toContain("استدعاء «نفّذ:» واحد فقط")
  })

  test("قارئٌ بسطرين، أو شرحٌ قبل أوّل نداء، أو خمسةُ نداءات: الرفضُ كامل", async () => {
    const multiline = await run(["نفّذ: read a.ts\nنفّذ: grep foo\nتكملة", "تمّت."])
    expect(multiline.dispatched).toEqual([])
    const prose = await run(["سأقرأ الآن\nنفّذ: read a.ts\nنفّذ: read b.ts", "تمّت."])
    expect(prose.dispatched).toEqual([])
    const five = await run(["نفّذ: read a.ts\nنفّذ: read b.ts\nنفّذ: read c.ts\nنفّذ: read d.ts\nنفّذ: read e.ts", "تمّت."])
    expect(five.dispatched).toEqual([])
  })

  test("المكرَّرُ داخل الحزمة أو المقروءُ سابقاً يُسقَط عند القبول — لا يقف نصفُها ولا يُعاد تشغيله", async () => {
    const inside = await run(["نفّذ: read a.ts\nنفّذ: read a.ts\nنفّذ: read b.ts", "تمّت."])
    expect(inside.dispatched).toEqual(["read a.ts", "read b.ts"])
    const earlier = await run(["نفّذ: read a.ts\nنفّذ: read b.ts", "تمّت."], { priorCommands: ["read a.ts"] })
    expect(earlier.dispatched).toEqual(["read b.ts"])
    expect(earlier.asks[1]!.prompt).toContain("أُسقط 1 مكرَّراً")
  })

  test("حين تطلب البوّابةُ أداةَ إصلاح تُعطَّل الحزمةُ عمداً: القاعدةُ هناك «أداةٌ واحدة» بنصّها", async () => {
    const h = await run(["نفّذ: read a.ts\nنفّذ: read b.ts", "نفّذ: write a.ts <<<\nإصلاح"], { requireEffectfulTool: true })
    // الحزمةُ لم تُوزَّع أصلاً، وأداةُ الإصلاح وحدها مضت — وهذا المقصود
    expect(h.dispatched).toEqual(["write a.ts <<<\nإصلاح"])
    expect(h.asks[1]!.prompt).toContain("لا حزمةَ قراءة")
  })

  test("نداءٌ واحدٌ يبقى نداءً واحداً — مسارُ الأداة المفردة لم يتغيّر", async () => {
    const h = await run(["نفّذ: read a.ts", "تمّت."])
    expect(h.dispatched).toEqual(["read a.ts"])
    expect(h.asks).toHaveLength(2)
    expect(h.asks[1]!.prompt).toContain("نتيجة الأداة «read a.ts»")
    expect(h.asks[1]!.prompt).not.toContain("حزمة القراءة")
  })
})
