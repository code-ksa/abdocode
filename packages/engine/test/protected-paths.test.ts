import { describe, expect, test } from "bun:test"
import { isInside, normalizeForCompare, protectedPathVerdict, PROTECTED_RULES } from "../src/protected-paths"

const ENV = {
  APPDATA: "C:\\Users\\o\\AppData\\Roaming",
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramData: "C:\\ProgramData",
}
const PROJECT = "C:\\work\\myapp"
const verdict = (p: string) => protectedPathVerdict(p, PROJECT, ENV)

describe("المساراتُ المحميّة — لا تُكتب ولو مُنحت الموافقة", () => {
  test("عملُ المشروع يمرّ — الحارسُ الذي يمنع كلَّ شيء يُطفأ أوّلَ يوم", () => {
    for (const p of [
      "C:\\work\\myapp\\src\\index.ts",
      "C:/work/myapp/package.json",
      "C:\\work\\myapp\\.git\\ORIG_HEAD",
      "C:\\Users\\o\\Desktop\\note.txt",
      "C:\\Users\\o\\AppData\\Roaming\\someotherapp\\x.json",
    ]) expect(`${p} → ${verdict(p).allowed}`).toBe(`${p} → true`)
  })

  test("جذورُ النظام وبيتُ الخزنة تُرفض بسببٍ مسمّى", () => {
    const cases: [string, string][] = [
      ["C:\\Windows\\System32\\drivers\\etc\\hosts", "system-root"],
      ["C:\\Program Files\\anything\\x.dll", "program-files"],
      ["C:\\Program Files (x86)\\y\\z", "program-files"],
      ["C:\\ProgramData\\shared\\config", "program-data"],
      ["C:\\Users\\o\\AppData\\Roaming\\abdocode\\vault\\k.sec", "vault-home"],
    ]
    for (const [p, rule] of cases) {
      const v = verdict(p)
      expect(`${p} → ${v.allowed}/${v.rule}`).toBe(`${p} → false/${rule}`)
      expect(v.why!.length).toBeGreaterThan(10)
    }
  })

  test("خطّافُ git داخل المشروع محميّ — الأثرُ المؤجَّل يلتفّ حول البوّابة كلِّها", () => {
    // الحارسُ يُبنى عادةً لما خارج المشروع، فيُكتب الخطّافُ داخله ويُنفَّذ في
    // أوّل إيداعٍ بلا موافقةٍ أصلاً. هذا هو البند الذي يُنسى.
    expect(verdict("C:\\work\\myapp\\.git\\hooks\\pre-commit").rule).toBe("git-hooks")
    expect(verdict("C:/work/myapp/.git/config").rule).toBe("git-config")
    // وبقيّةُ .git ليست محميّة: منعُها يمنع أدواتِ git المشروعة.
    expect(verdict("C:\\work\\myapp\\.git\\index").allowed).toBe(true)
  })

  test("الالتفافُ بـ`..` وبالفاصل المقلوب وبحالة الأحرف يُطبَّع قبل الحكم", () => {
    for (const p of [
      "C:\\work\\myapp\\..\\..\\Windows\\System32\\evil.dll",
      "C:/work/myapp/../../windows/system32/evil.dll",
      "c:\\WINDOWS\\System32\\evil.dll",
      "C:\\Windows\\.\\System32\\evil.dll",
      "C:\\work\\myapp\\.git\\hooks\\..\\hooks\\pre-push",
    ]) expect(`${p} → ${verdict(p).allowed}`).toBe(`${p} → false`)
  })

  test("المقارنةُ بحدود المقاطع: منعُ ما ليس محميّاً عطلٌ كالسماح لما هو محميّ", () => {
    // `C:\\WindowsApps` ليس داخل `C:\\Windows` — و`startsWith` وحدَها تخطئ هنا.
    expect(verdict("C:\\WindowsApps\\app\\file.txt").allowed).toBe(true)
    expect(verdict("C:\\Windows-old\\file.txt").allowed).toBe(true)
    expect(verdict("C:\\Users\\o\\AppData\\Roaming\\abdocode-notours\\x").allowed).toBe(true)
    // والتوأمُ: الحقيقيُّ ما زال ممنوعاً — وإلا كان التخفيفُ ثقباً.
    expect(verdict("C:\\Windows\\file.txt").allowed).toBe(false)
    expect(isInside("C:/a/b", "C:/a")).toBe(true)
    expect(isInside("C:/ab", "C:/a")).toBe(false)
    expect(isInside("C:/a", "C:/a")).toBe(true)
  })

  test("بيئةٌ ناقصةٌ لا تُسكِت الحارسَ عمّا تعرفه — والغيابُ لا يُخترع", () => {
    // مفتاحٌ غائبٌ يعني «لا أعرف هذا الجذر»، لا «لا جذورَ محميّة».
    const partial = protectedPathVerdict("C:\\Windows\\x", PROJECT, { SystemRoot: "C:\\Windows" })
    expect(partial.allowed).toBe(false)
    const none = protectedPathVerdict("C:\\Windows\\x", PROJECT, {})
    expect(none.allowed).toBe(true)
    // لكنّ محميّاتِ المشروع تبقى بلا بيئةٍ إطلاقاً — لا تعتمد عليها.
    expect(protectedPathVerdict("C:\\work\\myapp\\.git\\hooks\\x", PROJECT, {}).allowed).toBe(false)
  })

  test("المسارُ الفارغ يُرفض، والقواعدُ كلُّها مسمّاةٌ في قائمةٍ واحدة", () => {
    expect(verdict("   ").rule).toBe("empty")
    expect(normalizeForCompare("C:\\A\\B\\..\\C")).toBe("c:/a/c")
    // كلُّ قاعدةٍ يمكن أن تظهر في حكمٍ موجودةٌ في القائمة المُعلَنة.
    const seen = new Set([
      verdict("   ").rule, verdict("C:\\Windows\\x").rule, verdict("C:\\Program Files\\x").rule,
      verdict("C:\\ProgramData\\x").rule, verdict("C:\\Users\\o\\AppData\\Roaming\\abdocode\\x").rule,
      verdict("C:\\work\\myapp\\.git\\hooks\\x").rule, verdict("C:\\work\\myapp\\.git\\config").rule,
    ])
    for (const rule of seen) expect(PROTECTED_RULES).toContain(rule as never)
    expect(seen.size).toBe(PROTECTED_RULES.length)
  })
})

describe("الحارسُ موصولٌ — ويسبق السؤال", () => {
  test("الفحصُ يقع قبل بوّابة الموافقة على الكتابة، لا بعدها", async () => {
    const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
    // «الترتيب جزءٌ من الميزة»: حارسٌ يعمل بعد الموافقة ليس حارساً — يكون
    // المشغّل قد ضغط «موافق» على أثرٍ لا يُسترجع. يُثبَت بالموضع لا بالنيّة.
    const guard = source.indexOf("protectedPathVerdict(checked.abs, PROJECT_DIR, process.env)")
    const gate = source.indexOf('await gate(turnId, "edit"')
    expect(guard).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(0)
    expect(`guard before gate: ${guard < gate}`).toBe("guard before gate: true")
    // والرفضُ يحمل سببَه وقاعدتَه — رفضٌ بلا سببٍ يُجادَل ولا يُصلَح.
    expect(source).toContain("لا تُفتح بموافقة.")
    expect(source).toContain("(قاعدة ${shielded.rule})")
  })
})
