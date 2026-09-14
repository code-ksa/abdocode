import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { powershellRunner, runDesktop, type DesktopBound } from "../src/desktop-control"

// ب6ب — **اللوحُ الحيّ على نافذةٍ نملكها**: الإدخالُ يُقاس بأثره لا بنصّ السكربت المُنتَج.
// نافذتان حقيقيّتان (WinForms) تكتبان محتوى صندوقهما إلى ملفٍّ كلَّ ١٥٠ms، فنقرأ ما وصل فعلاً:
//   (أ) الإيجابيّ: تركيزٌ ثمّ كتابةٌ ⇦ **النصُّ في ملفّ النافذة الأولى** — الحقنُ يعمل حقّاً.
//   (ب) اللقطةُ المقيَّدة: صورةُ النافذة وحدها بمقاسها، لا سطحُ مكتب المستخدم كلُّه.
//   (ج) **التوأمُ السلبيّ بالأثر**: مقدّمةٌ تحرّكت إلى النافذة الثانية ⇦ الكتابةُ المربوطةُ بالأولى تُرفض،
//       و**السرُّ لا يظهر في أيٍّ من الملفّين** — لا في المقصودة ولا في التي سرقت المقدّمة.
// بلا هذا اللوح كان كلُّ ما نملكه أخضرَ يقول «السكربتُ يحتوي السطر»، وهو أخضرُ «لم يحدث شيء».

const FIXTURE = [
  "param([string]$Out, [string]$Title, [int]$X)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.Text = $Title",
  "$f.Width = 620",
  "$f.Height = 340",
  "$f.StartPosition = 'Manual'",
  "$f.Left = $X",
  "$f.Top = 90",
  "$t = New-Object System.Windows.Forms.TextBox",
  "$t.Multiline = $true",
  "$t.Dock = 'Fill'",
  "$f.Controls.Add($t)",
  "$timer = New-Object System.Windows.Forms.Timer",
  "$timer.Interval = 150",
  "$timer.Add_Tick({ [IO.File]::WriteAllText($Out, $t.Text, [Text.Encoding]::UTF8) })",
  "$timer.Start()",
  "$f.Add_Shown({ [void]$f.Activate(); [void]$t.Focus() })",
  "[System.Windows.Forms.Application]::Run($f)",
  "",
].join("\r\n")

const PS = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const read = (path: string): string => { try { return readFileSync(path, "utf8") } catch { return "" } }
const until = async (label: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await ok())) { if (Date.now() > deadline) throw Error(`timed out: ${label}`); await Bun.sleep(200) }
}

test.skipIf(process.platform !== "win32")("desk types into the window it bound, photographs that window alone, and refuses when another window steals the front", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-desk-live-"))
  const script = join(dir, "window.ps1")
  writeFileSync(script, FIXTURE)
  const stamp = `${process.pid}-${Math.floor(Date.now() / 1000) % 100_000}`
  const titleA = `abdo-desk-A-${stamp}`, titleB = `abdo-desk-B-${stamp}`
  const outA = join(dir, "a.txt"), outB = join(dir, "b.txt")
  const spawn = (title: string, out: string, x: number) => Bun.spawn([PS, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, out, title, String(x)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const a = spawn(titleA, outA, 60), b = spawn(titleB, outB, 720)
  const desk = (action: Parameters<typeof runDesktop>[0], bound?: DesktopBound) => runDesktop(action, { shotsDir: join(dir, "shots"), runner: powershellRunner, ...(bound === undefined ? {} : { bound }) })
  try {
    // النافذتان حيّتان حين يراهما النظام نفسُه — لا حين ننام رقماً من الثواني.
    await until("both windows visible", async () => {
      const list = await desk({ kind: "windows" })
      const titles = (list.windows ?? []).map((w) => w.title)
      return titles.some((t) => t.includes(titleA)) && titles.some((t) => t.includes(titleB))
    })

    // (أ) الإيجابيّ: تركيزٌ متحقَّقٌ منه ثمّ كتابةٌ ⇦ النصُّ في ملفّ النافذة الأولى.
    // المقدّمةُ موردٌ يتنازعه الجهازُ كلُّه: سويتةٌ كاملةٌ تشغّل إيدج ونوافذَ أخرى بالتوازي، فقد يُرفض الرفعُ مرّةً
    // ثمّ ينجح. تُعاد المحاولةُ لا يُضعَّف الحكم — والفشلُ بعد المحاولات يبقى فشلاً.
    let focusA = await desk({ kind: "focus", title: titleA })
    for (let i = 0; i < 6 && !focusA.ok; i += 1) { await Bun.sleep(400); focusA = await desk({ kind: "focus", title: titleA }) }
    expect(`${focusA.ok}: ${focusA.text}`).toStartWith("true")
    const boundA = focusA.bound!
    expect(boundA.hwnd).toBeGreaterThan(0)
    expect(boundA.title).toContain(titleA)

    const typed = "abdo مرحبا 77"
    let typeOut = await desk({ kind: "type", text: typed }, boundA)
    for (let i = 0; i < 4 && !typeOut.ok; i += 1) { await desk({ kind: "focus", title: titleA }); typeOut = await desk({ kind: "type", text: typed }, boundA) }
    expect(`${typeOut.ok}: ${typeOut.text}`).toStartWith("true")
    await until("the text reaches window A", () => read(outA).includes(typed), 15_000)
    expect(read(outA)).toContain(typed)
    expect(read(outB)).not.toContain(typed)

    // (ب) اللقطةُ المقيَّدة: مقاسُ الصورة = مقاسُ النافذة، لا الشاشةُ كلُّها.
    const shot = await desk({ kind: "shot", scope: "auto" }, boundA)
    expect(`${shot.ok}: ${shot.text}`).toStartWith("true")
    expect(shot.shot!.scope).toBe("window")
    expect(existsSync(shot.shot!.path)).toBe(true)
    const png = readFileSync(shot.shot!.path)
    expect(png.subarray(1, 4).toString()).toBe("PNG")
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    expect(`${width}×${height}`).toBe(`${boundA.right - boundA.left}×${boundA.bottom - boundA.top}`)

    // (ج) التوأمُ السلبيّ بالأثر: النافذةُ الثانية تأخذ المقدّمة، والكتابةُ المربوطةُ بالأولى تُرفض قبل أوّل حرف.
    const focusB = await desk({ kind: "focus", title: titleB })
    expect(`${focusB.ok}: ${focusB.text}`).toStartWith("true")
    const secret = "سر-لا-يكتب-99"
    const blocked = await desk({ kind: "type", text: secret }, boundA)
    expect(`${blocked.ok}: ${blocked.text}`).toStartWith("false")
    expect(blocked.text).toContain("focus moved")
    await Bun.sleep(600)
    expect(read(outA)).not.toContain(secret)
    expect(read(outB)).not.toContain(secret)
    // وما كُتب أوّلاً باقٍ كما هو: الرفضُ لم يمسّ النافذة المقصودة.
    expect(read(outA)).toContain(typed)
  } finally {
    a.kill(); b.kill()
    await Promise.all([a.exited, b.exited])
    for (let i = 0; i < 20; i += 1) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 300_000)
