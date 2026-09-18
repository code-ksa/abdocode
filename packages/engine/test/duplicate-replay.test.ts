import { describe, expect, test } from "bun:test"
import { DUPLICATE_REPLAY_LINE, pageGenerationOf, runTextAgentLoop, STATEFUL_ACTION, type TextAgentLoopOptions } from "@abdo/engine-host"

/**
 * S11 (2026-09-18) — الاستدعاءُ المكرَّر بوسائطه نفسها.
 *
 * مقيس على دفاتر المثبّتات: 86 نقطةَ حفظٍ انتهت «duplicate» — الحلقةُ تُقطع، والمضيف يفتح حقبةً بلا أداة،
 * والنموذجُ يعيد النداءَ نفسَه فيدور الدورُ 5–25 دقيقة. وحالةٌ مشروعة حُجبت: «save» بعد إرجاع حقلٍ بالمرجع نفسه.
 */
const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

type Run = { readonly dispatched: string[]; readonly prompts: string[]; readonly result: Awaited<ReturnType<typeof runTextAgentLoop>> }

/** حلقةٌ بردودٍ نصّيّة متتابعة وإيصالاتٍ ثابتة لكلّ أمر. */
const drive = async (replies: readonly string[], outputs: (command: string, nth: number) => string, extra: Partial<TextAgentLoopOptions> = {}): Promise<Run> => {
  const dispatched: string[] = []
  const prompts: string[] = []
  const queue = [...replies]
  const result = await runTextAgentLoop({
    input: "افعل", history: [], maxRounds: 12,
    isCallable: (name) => ["run", "read", "chrome.tap", "chrome.fill", "chrome.open", "chrome.page"].includes(name),
    volatile: (command) => /^chrome\.page\b/u.test(command),
    ask: async (prompt) => { prompts.push(prompt); return queue.shift() ?? "تم" },
    dispatch: async (command) => { dispatched.push(command); return outputs(command, dispatched.filter((c) => c === command).length) },
    ...extra,
  })
  return { dispatched, prompts, result }
}

describe("S11 — الاستدعاءُ المكرَّر: إيصالُه السابق يُعاد بدل حقبةٍ فارغة", () => {
  test("بلا الخيار = الإرث حرفياً: التكرارُ يقطع الحقبة «duplicate» بلا إعادة", async () => {
    const { dispatched, prompts, result } = await drive(["نفّذ: run npm test", "نفّذ: run npm test", "تم"], () => "انتهى الأمر برمز 1")
    expect(dispatched).toEqual(["run npm test"])
    expect(result.stopReason).toBe("duplicate")
    expect(result.duplicateReplays).toBe(0)
    expect(prompts.some((p) => p.includes(DUPLICATE_REPLAY_LINE))).toBe(false)
  })

  test("بالخيار: التكرارُ لا يُنفَّذ ولا يقطع — الإيصالُ السابق يعود للنموذج بالسطر الصريح ويُعدّ، والحلقةُ تمضي", async () => {
    const { dispatched, prompts, result } = await drive(["نفّذ: run npm test", "نفّذ: run npm test", "تم"], () => "FAIL src/a.test.ts — انتهى الأمر برمز 1", { duplicateReplay: { budget: 3 } })
    expect(dispatched).toEqual(["run npm test"])
    const replay = prompts[2]!
    expect(replay).toContain("نتيجة «run npm test» (إيصالٌ سابق — لم تُنفَّذ الأداة ثانيةً):")
    expect(replay).toContain("FAIL src/a.test.ts")
    expect(replay).toContain(`${DUPLICATE_REPLAY_LINE} (1/3).`)
    expect(replay.indexOf("FAIL src/a.test.ts")).toBeLessThan(replay.indexOf(DUPLICATE_REPLAY_LINE))
    expect(result.duplicateReplays).toBe(1)
    expect(result.stopReason).toBe("tool-failed")
    expect(result.commands).toEqual(["run npm test"])
  })

  test("السقفُ يعضّ: بعد نفاد الميزانيّة يعود «duplicate» كما كان؛ وميزانيّةُ صفر = لا إعادة", async () => {
    // (تنفيذٌ ناجح لصنف write/edit/patch/run يحرّك جيلَ مساحة العمل فلا يكون تكرارُه مكرَّراً — الإرث؛ فالمقيسُ هنا أفعالُ المتصفّح والفاشل.)
    const capped = await drive(["نفّذ: chrome.tap r1", "نفّذ: chrome.tap r1", "نفّذ: chrome.tap r1", "نفّذ: chrome.tap r1"], () => "نقرتُ.", { duplicateReplay: { budget: 2 } })
    expect(capped.dispatched).toEqual(["chrome.tap r1"])
    expect(capped.result.duplicateReplays).toBe(2)
    expect(capped.result.stopReason).toBe("duplicate")
    const zero = await drive(["نفّذ: chrome.tap r1", "نفّذ: chrome.tap r1"], () => "نقرتُ.", { duplicateReplay: { budget: 0 } })
    expect(zero.result.duplicateReplays).toBe(0)
    expect(zero.result.stopReason).toBe("duplicate")
  })

  test("جيلُ الصفحة تغيّر منذ التنفيذ السابق ⇦ التكرارُ يُنفَّذ؛ ولم يتغيّر ⇦ يُعاد إيصالُه", async () => {
    const outputs = (command: string): string => command.startsWith("chrome.open") ? "انتقلتُ في كروم المستخدم — الجيل 2، والمراجعُ القديمة بطلت." : "نقرتُ «حفظ» في متصفّح المستخدم."
    const moved = await drive(["نفّذ: chrome.tap r5", "نفّذ: chrome.open https://a.test/", "نفّذ: chrome.tap r5", "تم"], outputs, { duplicateReplay: { budget: 3 } })
    expect(moved.dispatched).toEqual(["chrome.tap r5", "chrome.open https://a.test/", "chrome.tap r5"])
    expect(moved.result.duplicateReplays).toBe(0)
    // التنقّلُ نفسُه لا يُعاد بحجّة جيله هو: chrome.open مرّتين بالرابط نفسه ⇦ إعادةُ إيصال.
    const sameOpen = await drive(["نفّذ: chrome.open https://a.test/", "نفّذ: chrome.open https://a.test/", "تم"], outputs, { duplicateReplay: { budget: 3 } })
    expect(sameOpen.dispatched).toEqual(["chrome.open https://a.test/"])
    expect(sameOpen.result.duplicateReplays).toBe(1)
    // والجيلُ يُقرأ من إيصالات الحقب السابقة أيضاً.
    const prior = await drive(["نفّذ: chrome.tap r5", "تم"], outputs, {
      duplicateReplay: { budget: 3 },
      priorReceipts: [{ command: "chrome.tap r5", output: "نقرتُ «حفظ»." }, { command: "chrome.open https://b.test/", output: "انتقلتُ — الجيل 4، والمراجعُ القديمة بطلت." }],
    })
    expect(prior.dispatched).toEqual(["chrome.tap r5"])
    expect(prior.result.duplicateReplays).toBe(0)
  })

  test("فعلٌ حاليٌّ على نموذج (tap/fill/key/select) يُنفَّذ ثانيةً إن نُفّذت أداةٌ أخرى بينهما؛ وفوراً بلا شيءٍ بينهما يُعاد إيصالُه؛ وrun ليس فعلاً حاليّاً", async () => {
    expect(STATEFUL_ACTION.test("chrome.tap r9")).toBe(true)
    expect(STATEFUL_ACTION.test("fill r3 x")).toBe(true)
    expect(STATEFUL_ACTION.test("run npm test")).toBe(false)
    expect(STATEFUL_ACTION.test("chrome.page")).toBe(false)
    const outputs = () => "نُفّذ."
    // «save» بعد إرجاع حقلٍ بالمرجع نفسه — الحالةُ المقيسة المحجوبة.
    const save = await drive(["نفّذ: chrome.tap r9", "نفّذ: chrome.fill r3 القيمة القديمة", "نفّذ: chrome.tap r9", "نفّذ: chrome.tap r9", "تم"], outputs, { duplicateReplay: { budget: 3 } })
    expect(save.dispatched).toEqual(["chrome.tap r9", "chrome.fill r3 القيمة القديمة", "chrome.tap r9"])
    expect(save.result.duplicateReplays).toBe(1)
    // run فاشل بعد أداةٍ أخرى ما زال مكرَّراً: يُعاد إيصالُه لا يُنفَّذ (الناجحُ يحرّك الجيلَ فليس مكرَّراً — الإرث).
    const run = await drive(["نفّذ: run npm test", "نفّذ: read a.ts", "نفّذ: run npm test", "تم"], (command) => command === "read a.ts" ? "const a = 1" : "انتهى الأمر برمز 1", { duplicateReplay: { budget: 3 } })
    expect(run.dispatched).toEqual(["run npm test", "read a.ts"])
    expect(run.result.duplicateReplays).toBe(1)
  })

  test("الإيصالُ يُعاد من حقبةٍ سابقة (priorReceipts) لا من هذه الحقبة وحدها؛ والقراءةُ المكرَّرة ثانيةً تدخل الإعادةَ نفسَها بدل «duplicate»", async () => {
    const fromPrior = await drive(["نفّذ: run npm run build", "تم"], () => "unreachable", { duplicateReplay: { budget: 3 }, priorReceipts: [{ command: "run npm run build", output: "TS2304 in src/a.ts — انتهى الأمر برمز 1 (الحقبة 1)", verdict: { ok: false, reason: "exit_code", denied: false } }] })
    expect(fromPrior.dispatched).toEqual([])
    expect(fromPrior.prompts[1]).toContain("TS2304 in src/a.ts — انتهى الأمر برمز 1 (الحقبة 1)")
    expect(fromPrior.prompts[1]).toContain(DUPLICATE_REPLAY_LINE)
    expect(fromPrior.result.duplicateReplays).toBe(1)
    // قراءةٌ ثالثة بالمسار نفسه: الأولى تُنفَّذ، الثانية «إعادة استخدام قراءة موثقة» (الإرث)، الثالثة إعادةُ S11 لا قطع.
    const reads = await drive(["نفّذ: read a.ts", "نفّذ: read a.ts", "نفّذ: read a.ts", "تم"], () => "const a = 1", { duplicateReplay: { budget: 3 } })
    expect(reads.dispatched).toEqual(["read a.ts"])
    expect(reads.prompts[2]).toContain("إعادة استخدام قراءة موثقة")
    expect(reads.prompts[3]).toContain(DUPLICATE_REPLAY_LINE)
    expect(reads.result.stopReason).toBe("complete")
  })

  test("الاستدعاءُ الأصيل: الإيصالُ المُعاد يصل رسالةَ أداةٍ بمعرّف النداء نفسه", async () => {
    let asks = 0
    const result = await runTextAgentLoop({
      input: "شغّل", history: [], isCallable: (name) => name === "run", duplicateReplay: { budget: 3 },
      ask: async () => {
        asks += 1
        if (asks <= 2) return { kind: "native", text: "", command: "run npm test", call: { id: `c${asks}`, name: "abdo_run", input: { command: "npm test" } } }
        return "تم"
      },
      dispatch: async () => "1 fail — انتهى الأمر برمز 1",
    })
    expect(result.commands).toEqual(["run npm test"])
    expect(result.duplicateReplays).toBe(1)
    const replayed = result.continuation.find((m) => m.role === "tool" && m.toolCallId === "c2")
    expect(replayed?.content).toContain(DUPLICATE_REPLAY_LINE)
    expect(replayed?.content).toContain("1 fail — انتهى الأمر برمز 1")
  })

  test("pageGenerationOf: آخرُ ذكرٍ يحكم، وبلا ذكرٍ undefined", () => {
    expect(pageGenerationOf("انتقلتُ — الجيل 3؛ ثمّ الجيل 7، والمراجعُ القديمة بطلت.")).toBe(7)
    expect(pageGenerationOf("جيل 2 — 14 عنصراً")).toBeUndefined()
    expect(pageGenerationOf("")).toBeUndefined()
  })

  test("cli.ts: السقفُ ثلاثٌ في الدور، والميزانيّةُ تُمرَّر بما بقي، والعدُّ يتراكم عبر الحقب، ونقطةُ الحفظ تقوله", () => {
    expect(cliSource).toContain("const DUPLICATE_REPLAY_CAP = 3")
    expect(cliSource).toContain("let duplicateReplaysUsed = 0")
    expect(cliSource).toContain("duplicateReplay: { budget: Math.max(0, DUPLICATE_REPLAY_CAP - duplicateReplaysUsed) },")
    expect(cliSource).toContain("duplicateReplaysUsed += loop.duplicateReplays")
    expect(cliSource).toContain("· إعادة المكرَّر=${loop.duplicateReplays}`)")
  })
})
