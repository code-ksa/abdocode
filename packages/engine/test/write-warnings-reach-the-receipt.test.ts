import { describe, expect, test } from "bun:test"

/**
 * 🔴 حارسٌ لا يصل إيصالَه كودٌ ميّت.
 *
 * مقيسٌ مرّتين في هذا المستودع: إطارٌ مُعالَجٌ بلا مدخلٍ في العقد لم يعمل قطّ، وزرٌّ
 * في الواجهة نادى اسماً لا يستقبله أحد — والسويتةُ خضراءُ في الحالتين، لأنّ وحدةَ
 * الحارس مُختبَرةٌ وحدها. فالمسمارُ هنا لا يسأل «هل الدالّةُ صحيحة؟» بل **«هل
 * عائدُها يخرج إلى المستخدم؟»**: كلُّ تحذيرٍ يُحسب عند الكتابة يُقرأ في تعبير
 * الإيصال نفسِه، فلا يمكن أن يُحسب ويُرمى.
 *
 * والمسمارُ **يعضّ**: حذفُ حدٍّ واحدٍ من جمع الإيصال يُحمِره، وهو ما جُرِّب.
 */
describe("every warning computed at the write site reaches the write receipt", () => {
  const WARNINGS = [
    // [المتغيّر، الدالّةُ التي تُنتجه]
    ["suiteWarning", "negativeOnlySuite("],
    ["eolWarning", "lineEndingViolation("],
    ["fabWarning", "fabricatedImage("],
  ] as const

  test("each warning is both COMPUTED by its guard and READ by the receipt expression", async () => {
    const source = (await Bun.file(new URL("../src/cli.ts", import.meta.url)).text())
      .split(String.fromCharCode(13) + String.fromCharCode(10))
      .join(String.fromCharCode(10))

    // تعبيرُ الإيصال سطرٌ واحد — يُقتطع بمرساةٍ ثابتة كي لا يمرّ ذكرٌ للمتغيّر في مكانٍ آخر.
    const receipt = source.split(String.fromCharCode(10)).find((line) => line.includes("output: r.output.startsWith("))
    expect(receipt).toBeDefined()

    for (const [variable, guard] of WARNINGS) {
      // (١) يُحسب من حارسه، لا من نصٍّ مكتوبٍ بيد.
      expect(source).toContain(`const ${variable} = `)
      expect(source).toContain(guard)
      // (٢) ويُقرأ في الإيصال — وهذا الشرطُ هو ما يمنع الكودَ الميّت.
      expect(receipt).toContain(variable)
    }
  })

  test("the guards are imported from their own modules, not re-implemented inline", async () => {
    const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
    expect(source).toContain('from "./negative-only-suite"')
    expect(source).toContain('from "./line-ending-guard"')
    expect(source).toContain('from "./fabricated-artifact-guard"')
  })
})
