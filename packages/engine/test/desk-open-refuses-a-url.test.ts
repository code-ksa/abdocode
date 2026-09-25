import { describe, expect, test } from "bun:test"
import { parseDesktopCommand } from "../src/desktop-control"

/**
 * 🔴 أداةٌ تقبل شكلاً خاطئاً ثمّ تُقلع شيئاً آخرَ **وتُعلن النجاح** أسوأُ من أداةٍ ترفض.
 *
 * مقيسٌ حيّاً: عجز متصفّحُ الوكيل عن الاتّصال، فجرّب النموذجُ
 * `desk open https://tailwindcss.com/…` — فأُقلعت **PowerShell** ورُبطت نافذتُها،
 * وعاد الإيصال: «أُقلعت ورُبطت نافذتُها الجديدة … — التالي: desk ui». فبنى الوكيلُ
 * على النجاح المزعوم ثلاثَ خطوات، ثمّ كتب PNG مختلَقاً مكانَ اللقطة المطلوبة.
 *
 * الرفضُ يسمّي البديل: التصفّحُ له أداتُه، وسطحُ المكتب يُقلع برامجَ لا روابط.
 */
describe("desk open launches a program, and says so when handed a link", () => {
  test("a URL is refused, and the refusal names the tool that does browse", () => {
    for (const url of ["https://example.com/x", "http://127.0.0.1:3000", "HTTPS://EXAMPLE.COM", "file:///c:/x.html"]) {
      const r = parseDesktopCommand(`open ${url}`)
      expect(r).toHaveProperty("error")
      const error = (r as { error: string }).error
      expect(error).toContain("open <رابط>")   // البديلُ مسمّى، لا «صيغة خاطئة» فحسب
      expect(r).not.toHaveProperty("kind")     // ولا يُقلع شيءٌ البتّة
    }
  })

  test("REAL PROGRAMS STILL OPEN (the positive twin): the guard did not close the door", () => {
    expect(parseDesktopCommand("open notepad")).toEqual({ kind: "open", app: "notepad" })
    expect(parseDesktopCommand("open chrome")).toEqual({ kind: "open", app: "chrome" })
    expect(parseDesktopCommand('open "C:\\Program Files\\App\\app.exe"')).toEqual({ kind: "open", app: "C:\\Program Files\\App\\app.exe" })
    // واسمٌ يحمل كلمةَ http في وسطه ليس رابطاً — الحارسُ يرسي على البادئة وحدها.
    expect(parseDesktopCommand("open httpd")).toEqual({ kind: "open", app: "httpd" })
  })
})
