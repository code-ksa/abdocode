import { describe, expect, test } from "bun:test"

/**
 * 🔴 **الرفضُ لم يمنع الاختلاق — أنتجه.**
 *
 * مقيسٌ حيّاً على مهمّةٍ تطلب لقطةَ موقعٍ مرجعيّ: ردّ منفذُ التحكّم مرّتين
 * «Browser control port is in use; close the app-owned browser before retrying»،
 * فلجأ الوكيلُ إلى توليد HTML، ثمّ **كتب PNG بحجم 1×1 (69 بايتاً)** مكانَ اللقطة —
 * وسقطت ثلاثةُ بنودٍ في الحَكَم على لقطةٍ لم تُلتقط.
 *
 * وشاغلُ المنفذِ في الغالب **متصفّحُ المحرّك نفسِه من دورٍ سابق**: أطلقه المحرّك،
 * ثمّ رفض أن يكلّمه. فالانشغالُ صار **سؤالاً**: يُسأل CDP، فإن ردّ وسلّم صفحةً
 * فهو متصفّحُنا ونكمل عليه؛ وإن لم يردّ فالرفضُ يبقى **حاملاً سببَه**.
 *
 * مُثبتٌ بجولتين متتاليتين: الأولى (منفذٌ حرّ) أطلقت وحفظت 81,661 بايتاً،
 * والثانية (المنفذُ مشغولٌ بالأولى) وصلت بالقائم وحفظت 79,201 بايتاً.
 */
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("a busy control port is asked, not refused", () => {

  test("the busy branch attaches to whatever holds the port before giving up", () => {
    const lease = source.indexOf('lease = Bun.serve({ hostname: "127.0.0.1", port, fetch:')
    expect(lease).toBeGreaterThan(0)
    // المحاولةُ قبل الرفض، وفي النطاق نفسِه — لا في مكانٍ بعيدٍ قد لا يُبلَغ.
    const tail = source.slice(lease, lease + 1800)
    expect(tail).toContain("await existing.attach()")
    expect(tail).toContain("surface = existing")
    expect(tail).toContain("await existing.navigate(url)")
  })

  test("and when it truly does not answer, the refusal carries its reason", () => {
    const lease = source.indexOf('lease = Bun.serve({ hostname: "127.0.0.1", port, fetch:')
    const tail = source.slice(lease, lease + 1800)
    // رسالةٌ بلا سببٍ تترك المشغّلَ يخمّن ما يُغلق — وهو ما كلّفنا عشرَ ثوانٍ ولقطةً مختلَقة.
    expect(tail).toMatch(/error instanceof Error \? error\.message : String\(error\)/u)
    // والرفضُ القديمُ المطلقُ لم يعد موجوداً في الملفّ بحال.
    expect(source).not.toContain("Browser control port is in use; close the app-owned browser before retrying")
  })
})
