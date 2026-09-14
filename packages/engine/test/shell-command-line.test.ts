/**
 * قسمةُ سطر الأمر — منطقٌ يُختبر، لأنّ خطأه يُشغّل برنامجاً غيرَ المكتوب.
 *
 * الحالةُ التي دفعت إلى إخراجها من الصفحة: أمرُ خادم MCP يحمل مسارَ مجلّدٍ
 * عادةً، ومسارُ ويندوز فيه مسافةٌ كثيراً (`C:/Program Files/...`). قسمةٌ
 * بالمسافات وحدها تجعله جزأين، فيُشغَّل الأمرُ بمعطياتٍ مختلفة — ولا تشكو
 * الواجهة: يفشل شيءٌ بعيدٌ ولا يُعرف سببُه.
 */
import { describe, expect, test } from "bun:test"
import { splitCommandLine } from "../src/shells/shell"

describe("قسمةُ سطر الأمر", () => {
  test("المسافاتُ تفصل، والاقتباسُ يجمع ولا يدخل الناتج", () => {
    expect(splitCommandLine("npx -y server")).toEqual(["npx", "-y", "server"])
    // الحالةُ الحاكمة: مسارٌ فيه مسافة يبقى جزءاً واحداً بلا علامات اقتباس.
    expect(splitCommandLine('npx srv "C:/Program Files/work"'))
      .toEqual(["npx", "srv", "C:/Program Files/work"])
    expect(splitCommandLine("node 'my app.js' --flag"))
      .toEqual(["node", "my app.js", "--flag"])
  })

  test("المسافاتُ الزائدة تُبتلع، والفراغُ يعطي قائمةً فارغةً لا جزءاً فارغاً", () => {
    expect(splitCommandLine("   node    a.js   ")).toEqual(["node", "a.js"])
    expect(splitCommandLine("")).toEqual([])
    expect(splitCommandLine("     ")).toEqual([])
    // تبويبٌ وسطرٌ جديد مسافاتٌ أيضاً — لصقٌ من محرّرٍ لا يُنتج أجزاءً وهميّة.
    expect(splitCommandLine("node\ta.js\nb.js")).toEqual(["node", "a.js", "b.js"])
  })

  test("اقتباسٌ لم يُغلق يُغلق عند النهاية — ولا يُرفض السطرُ كلُّه لخطأٍ مطبعيّ", () => {
    expect(splitCommandLine('node "a b')).toEqual(["node", "a b"])
    // ونوعا الاقتباس لا يُلغي أحدُهما الآخر داخلَه.
    expect(splitCommandLine(`node "it's here"`)).toEqual(["node", "it's here"])
    expect(splitCommandLine(`node 'say "hi"'`)).toEqual(["node", 'say "hi"'])
  })

  test("اقتباسٌ ملتصقٌ يجمع ولا يقطع — والفارغُ المقتبَس لا يصير جزءاً", () => {
    expect(splitCommandLine('--path="C:/a b"/x')).toEqual(["--path=C:/a b/x"])
    // ‏`""` وحدها لا تُنتج جزءاً فارغاً: جزءٌ فارغٌ في argv يُربك برامجَ كثيرة.
    expect(splitCommandLine('node "" a')).toEqual(["node", "a"])
  })
})
