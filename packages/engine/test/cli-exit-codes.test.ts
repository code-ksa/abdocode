// رموزُ الخروج — قِيست في كنس ما قبل الإطلاق 2026-09-03: `gate` كانت تُعلن
// الفشل وترجع **صفراً**، وفعلٌ مجهول يطبع المساعدة ويخرج بصفر. الأوّل فشلٌ
// مفتوح بنصّ قاعدتنا (من يؤتمت حولها يقرأ نجاحاً كاذباً)، والثاني يجعل خطأ
// الكتابة لا يُفرَّق عن طلب المساعدة. يُثبَّتان هنا بالمصدر لا بالتشغيل، لأن
// تشغيل البوّابة يستدعي بناءً كاملاً.
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("رموز الخروج من سطر الأوامر", () => {
  test("البوّابة الحمراء تخرج بـ2 — لا صفراً", () => {
    const arm = source.slice(source.indexOf('case "gate": {'), source.indexOf('case "fixture": {'))
    expect(arm).toContain("const out = gate(rest[0])")
    expect(arm).toContain('if (out.startsWith("✗") || out.startsWith("بوابة غير معروفة")) process.exitCode = 2')
    // الطباعةُ قبل الرمز: المشغّل يقرأ السبب ثم يقرأ الرمز.
    expect(arm.indexOf("console.log(out)")).toBeLessThan(arm.indexOf("process.exitCode = 2"))
  })

  test("الفعل المجهول يُسمّى ويخرج بـ2، والمساعدة تبقى صفراً", () => {
    const tail = source.slice(source.lastIndexOf('case "help":'))
    expect(tail).toContain('case "help":\r\n      console.log(HELP)\r\n      break')
    expect(tail).toContain("أمرٌ غير معروف")
    expect(tail).toContain("${String(command).slice(0, 40)}")
    const unknown = tail.slice(tail.indexOf("default:"))
    expect(unknown).toContain("process.exitCode = 2")
  })

  test("سردُ الوكلاء أمرُ مشغّلٍ يعمل بلا نموذج، ويقول رفضَه", () => {
    const arm = source.slice(source.indexOf('case "agents": {'), source.indexOf('case "recall": {'))
    expect(arm).toContain("agentsCommand()")
    const helper = source.slice(source.indexOf("const agentsCommand"), source.indexOf("const agentCatalogue"))
    expect(helper).toContain("const catalogue = agentCatalogue()")
    expect(helper).toContain("describeAgents(catalogue)")
    expect(helper).toContain("catalogue.refusals")
    // لا يسبب أي نداء نموذج: كلا مدخلي المشغّل والنص يعيدان الفهرس المحلي.
    expect(source).toContain('case "agents": return agentsCommand()')
    expect(helper).not.toContain("await ask(")
    expect(source).toContain("  agents         ")
  })
})
