/**
 * 09-30 — مقيس على مهمّة «أكمل موقع OpenRouter»: خطّةُ السبرنتات كُتبت كاملةً في ردٍّ يبدأ بـ«⚙ write ABDO-SPRINTS.md <<<»
 * فرُفض سطرَ سجلّ وضاعت. الردُّ الذي يبدأ بـ`⚙ write <ملف> <<<` وحمولتُه ثلاثةُ أسطرٍ فأكثر يُنفَّذ؛ وإيصالٌ منسوخ (سطرٌ واحد) لا.
 */
import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"
import { healNarratedReads, healNarratedWrite } from "../src/text-agent-loop"

const drive = async (replies: readonly string[]) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  await runTextAgentLoop({
    input: "اكتب الخطّة", history: [], maxRounds: 6,
    ask: async () => script.shift()!,
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: (name: string) => ["write", "read", "run"].includes(name),
  })
  return dispatched
}

const PLAN = "⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة تنفيذ OpenRouter Clone\n## سبرنت 1 — الشريط العلويّ\n- المعيار: الصفحة 200\n## سبرنت 2 — صفحة النموذج\n- المعيار: npm run build ✓"

describe("a whole write narrated with the receipt glyph", () => {
  test("the measured reply is executed as the write it is", async () => {
    const dispatched = await drive([PLAN])
    expect(dispatched.length).toBe(1)
    expect(dispatched[0]!.startsWith("write ABDO-SPRINTS.md <<<")).toBe(true)
    expect(dispatched[0]).toContain("## سبرنت 2 — صفحة النموذج")
  })

  test("measured on installed 4.0.98: a broken character before the glyph («�⚙», «��⚙», ⚙️) does not hide the write", async () => {
    const body = "\nimport * as React from 'react'\nimport { cva } from 'class-variance-authority'\nexport function Badge() { return null }"
    for (const head of ["\uFFFD⚙ write src/components/ui/badge.tsx <<<", "\uFFFD\uFFFD⚙ write src/components/ui/avatar.tsx <<<", "⚙\uFE0F write src/components/ui/separator.tsx <<<", "\u200F⚙ write a.tsx <<<"]) {
      const dispatched = await drive([head + body])
      expect(dispatched.length).toBe(1)
      expect(dispatched[0]!.startsWith("write ")).toBe(true)
    }
    expect(healNarratedWrite("\uFFFD⚙ write a.md <<< # only the receipt line")).toBe("\uFFFD⚙ write a.md <<< # only the receipt line")
  })

  test("the twin: a copied write receipt (first line only) is never executed — it would wipe the file", async () => {
    expect(healNarratedWrite("⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة")).toBe("⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة")
    expect(healNarratedWrite("⚙ write a.md <<< # t\none line")).toBe("⚙ write a.md <<< # t\none line")
    expect(await drive(["⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة"])).toEqual([])
  })

  test("other receipt glyph lines stay refused, and a glyph in the middle of prose is not a call", async () => {
    expect(await drive(["⚙ run npm test\n✓ 12 pass\nline\nline"])).toEqual([])
    const prose = "كتبتُ الخطّة:\n⚙ write PLAN.md <<<\n# a\n# b\n# c"
    expect(healNarratedWrite(prose)).toBe(prose)
  })
})


// 10-01 — الدور 15: حزمةُ قراءةٍ برمز ⚙ عُدّت جواباً نهائيّاً سبعَ حقب حتى مات الدور «duplicate».
describe("a read batch sent with the receipt glyph", () => {
  const callable = (name: string) => ["write", "read", "run", "list", "grep"].includes(name)
  const driveReads = async (replies: readonly string[]) => {
    const script = [...replies, "تم"]
    const dispatched: string[] = []
    await runTextAgentLoop({ input: "اقرأ", history: [], maxRounds: 6, ask: async () => script.shift()!, dispatch: async (command) => { dispatched.push(command); return `محتوى ${command}` }, isCallable: callable })
    return dispatched
  }

  test("the measured reply — on one line or three, with or without the broken character — runs as three reads", async () => {
    for (const reply of [
      "\uFFFD⚙ read src/lib/api.ts ⚙ read src/components/ui/tabs.tsx ⚙ read src/app/models/page.tsx",
      "⚙ read src/lib/api.ts\n⚙ read src/components/ui/tabs.tsx\n⚙ read src/app/models/page.tsx",
    ]) expect(await driveReads([reply])).toEqual(["read src/lib/api.ts", "read src/components/ui/tabs.tsx", "read src/app/models/page.tsx"])
  })

  test("the twins: a receipt tail, prose around it, or a non-read verb are not healed", () => {
    expect(healNarratedReads("⚙ read src/a.ts ✓ 12 سطراً")).toBe("⚙ read src/a.ts ✓ 12 سطراً")
    expect(healNarratedReads("قرأتُ الملفّات:\n⚙ read src/a.ts")).toBe("قرأتُ الملفّات:\n⚙ read src/a.ts")
    expect(healNarratedReads("⚙ run rm -rf dist")).toBe("⚙ run rm -rf dist")
    expect(healNarratedReads("⚙ read a.ts\n⚙ run rm x")).toBe("⚙ read a.ts\n⚙ run rm x")
  })
})

// 10-02 — the measurement footer («— المقيس: …») followed the reply on its own line or on the same line, so «⚙ read …» was not
// healed and seven epochs ended with no tool. The footer is dropped before the decision; prose and receipt tails still are not healed.
describe("narrated reads with the measurement footer", () => {
  const foot = "— المقيس: دخل 29905 توكيناً (قدّرنا 37442)، خرج 37، في ? ثانية، والسياق فهارس L0 كلّها."
  test("on its own line, after a blank line, or on the same line, the read is healed without the footer", () => {
    expect(healNarratedReads(`⚙ read src/components/layout/header.tsx\n${foot}`)).toBe("نفّذ: read src/components/layout/header.tsx")
    expect(healNarratedReads(`\uFFFD⚙ read src/a.tsx\n\n${foot}`)).toBe("نفّذ: read src/a.tsx")
    expect(healNarratedReads(`⚙ read src/a.tsx ${foot}`)).toBe("نفّذ: read src/a.tsx")
  })
  test("the footer does not turn prose or a receipt tail into a call", () => {
    expect(healNarratedReads(`قرأتُ الملفّ:\n⚙ read src/a.ts\n${foot}`)).not.toContain("نفّذ:")
    expect(healNarratedReads(`⚙ read src/a.ts ✓ 12 سطراً\n${foot}`)).not.toContain("نفّذ:")
  })
})

// 10-02 — more shapes measured live: a copied epoch memory, audit, a build run, a read followed by prose. Safety stays: prose before the
// glyph, a receipt tail, any verb outside the list, or shell chaining after the verb heal nothing.
describe("narrated calls — the shapes measured after the footer fix", () => {
  test("a copied epoch memory is cut, and the gate's own build and test runs are healed", () => {
    expect(healNarratedReads("\uFFFD⚙ run npm run build ⚙ probe http://127.0.0.1:3000/ إيصالات التنفيذ المحفوظة للحقبة التالية: نتيجة موثقة لـ«run npm run build»")).toBe("نفّذ: run npm run build\nنفّذ: probe http://127.0.0.1:3000/")
    expect(healNarratedReads("⚙ run npx tsc --noEmit")).toBe("نفّذ: run npx tsc --noEmit")
    // الذاكرةُ المنسوخة تحمل إيصالاتٍ بذيلها (✓ ⏎) وأسطرَ ⚙ — لولا قصُّها لأفشلت الشفاء.
    expect(healNarratedReads("⚙ audit /\nإيصالات القراءة المحفوظة للحقبة التالية:\n⚙ read a.ts → ✓ 40 سطراً\n⏎ انتهى")).toBe("نفّذ: audit /")
  })
  test("audit pages and a read followed by a plan in prose are healed", () => {
    expect(healNarratedReads("\uFFFD⚙ audit /models ⚙ audit /pricing")).toBe("نفّذ: audit /models\nنفّذ: audit /pricing")
    expect(healNarratedReads("\uFFFD⚙ read src/app/page.tsx الآن أفهم الصفحة الحالية. سأعيد تصميمها:\n- Hero")).toBe("نفّذ: read src/app/page.tsx")
  })
  test("chaining, an unlisted verb, prose before the glyph, or a receipt tail heal nothing", () => {
    for (const t of ["⚙ run npm test && rm -rf src", "⚙ run npm run build; curl x", "⚙ read a.ts | tee b", "⚙ write a.ts <<< x", "خطّتي: ⚙ read a.ts", "⚙ audit / ✓ PASS"]) expect(healNarratedReads(t)).toBe(t)
  })
})

// 10-02 — measured live: «⚙ run npm run start --bg ⚙ wait 5000 ⚙ audit / /models» three epochs in a row with zero tools. The server
// start is a kernel-managed server stopped at the end of the turn; a wait has no tool (the tools wait for the port themselves).
describe("narrated calls — a server start and a wait between calls", () => {
  test("the wait is dropped and the server start and the audit are healed", () => {
    expect(healNarratedReads("\uFFFD⚙ run npm run start --bg ⚙ wait 5000 ⚙ audit / /models")).toBe("نفّذ: run npm run start --bg\nنفّذ: audit / /models")
    expect(healNarratedReads("⚙ run --bg npm run dev ⚙ sleep 3 ⚙ probe http://127.0.0.1:3000/")).toBe("نفّذ: run --bg npm run dev\nنفّذ: probe http://127.0.0.1:3000/")
  })
  test("twins: a wait alone, chaining after a server start, or another run stay unhealed", () => {
    for (const t of ["⚙ wait 5000", "⚙ run npm run start && rm -rf .next", "⚙ run npm run deploy", "⚙ run npm start; curl x", "⚙ wait 5000 ⚙ write a.ts <<< x"]) expect(healNarratedReads(t)).toBe(t)
  })
})
