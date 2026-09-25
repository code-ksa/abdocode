import { describe, expect, test } from "bun:test"
import { familiesFor, familiesFromResult, resultCarriesIntent } from "../src/tool-exposure"

/**
 * 🔴 ما لا يُعرض لا يُطلَب.
 *
 * قِيس حيّاً: مهمّةٌ نصُّها «اقرأ TASK.md ونفّذ المراحلَ الأربعَ فيه» — والمرحلةُ الأولى
 * في الملفّ تطلب لقطةً من موقعٍ مرجعيّ. ولا كلمةَ متصفّحٍ في الطلب نفسِه، فبقيت عائلةُ
 * المتصفّح مغلقةً طوال الدور، ولم يرَ النموذجُ أداةً واحدةً منها، فسقطت ثلاثةُ بنودٍ في
 * الحَكَم على لقطةٍ لم تُلتقط.
 */
describe("intent can live in what the agent reads, not only in what was asked", () => {
  test("the goal line alone misses a demand that lives inside the file it points at", () => {
    const goal = "اقرأ TASK.md في جذر المشروع ونفّذ المراحلَ الأربعَ فيه بالكامل، والتزم بالقيود."
    expect([...familiesFor(goal)]).toEqual([])   // هذا هو العطلُ بعينه
  })

  test("reading an instruction file opens the families its text names", () => {
    const families = new Set<string>()
    const task = "المرحلة 1: افتح الموقع المرجعيّ واحفظ لقطةً في docs/reference-stats.png"
    expect(familiesFromResult("read", "read TASK.md", task, families)).toEqual(["browser"])
    expect(families.has("browser")).toBe(true)
    // ولا يُعاد فتحُ المفتوح: العائدُ فارغٌ فلا يتكرّر الإعلان في كلّ قراءة.
    expect(familiesFromResult("read", "read TASK.md", task, families)).toEqual([])
  })

  test("ORDINARY SOURCE IS NOT AN INSTRUCTION: the saving the exposure exists for survives", () => {
    const families = new Set<string>()
    // ملفُّ واجهةٍ عاديّ يحمل «page» و«design» و«ui» — ولو مُسح لفُتحت العائلةُ في كلّ قراءة.
    const source = "export default function Page() { return <div className='ui design'>page</div> }"
    expect(familiesFromResult("read", "read src/app/page.tsx", source, families)).toEqual([])
    expect(families.size).toBe(0)
    expect(resultCarriesIntent("read", "read src/app/page.tsx")).toBe(false)
    expect(resultCarriesIntent("read", "read TASK.md")).toBe(true)
    expect(resultCarriesIntent("read", "read docs/BRIEF-2.md")).toBe(true)
    expect(resultCarriesIntent("read", "C:\\proj\\README.md")).toBe(true)
    // وما جُلب من الشبكة آمرٌ دائماً — لا اسمَ ملفٍّ يُحتكم إليه.
    expect(resultCarriesIntent("fetch", "fetch https://example.com")).toBe(true)
    // وأداةٌ لا تجلب نصّاً خارجيّاً لا تُمسح أصلاً.
    expect(resultCarriesIntent("write", "write TASK.md")).toBe(false)
    expect(resultCarriesIntent("run", "cat TASK.md")).toBe(false)
  })

  test("a file merely NAMED like an instruction but holding nothing opens nothing", () => {
    const families = new Set<string>()
    expect(familiesFromResult("read", "read README.md", "# مشروعُ حسابات\n\nدالّتان في src/.", families)).toEqual([])
    expect(families.size).toBe(0)
  })
})
