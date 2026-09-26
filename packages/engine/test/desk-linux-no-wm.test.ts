import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linuxScript, wslExe } from "../src/desktop-linux"
import { runDesktop } from "../src/desktop-control"
import { WSLG_DISTRO, wslRun } from "./fixtures/wslg-readiness"

/**
 * 🔴 **رفضٌ بلا سببٍ أضاع ليلةً على هذا الخطّ نفسِه.**
 *
 * WSLg يعرض النوافذ بلا مدير نوافذ يملك `_NET_ACTIVE_WINDOW`: `xdotool` يجد
 * اللوحَ والحقنُ الموجَّه بالمعرّف ينجح، لكن `getactivewindow` يفشل — فلا يُثبَت
 * التصدّر. والقناةُ ترفض بحقّ (لا حقنَ بلا إثبات)، لكنّها كانت ترفض بجملتين
 * كاذبتين: «could not bring the window to the front» و«focus moved» — والتركيزُ
 * لم ينتقل، إذ لا تركيزَ في الشاشة أصلاً. رفضٌ يكذب في سببِه يُرسل المشغّلَ
 * (والوكيلَ) إلى إصلاح ما ليس معطوباً؛ وقياسُ هذه الليلة أنّ **القدرةَ الناقصةَ
 * بلا سببٍ منطوق أخطرُ من الممنوعة بوضوح**.
 *
 * والبيئةُ **تُصطنع عند حدّ الأداة** لا تُنتظر: تنشيطُ WSLg غيرُ حتميّ (يعتمد
 * على إعطاء ويندوز التركيزَ للنافذة لحظتَها)، فاختبارٌ ينتظر الرفضَ يمرّ فارغاً
 * حين يصادف التنشيطُ نجاحاً. الجذعُ هنا `xdotool` مزيَّفٌ في أوّل PATH يعيد
 * **نصَّ الفشل المقيس حرفاً** — والسكربتُ المشحون هو نفسُه يُشغَّل ببايثون WSL
 * عبر المشغّل نفسِه، فلا يُختبر خيالُ شكلٍ بل الشيفرةُ التي تُسلَّم.
 */
const STUB_ID = "4194307"
const STUB_TITLE = "Abdo Stub Window"
// نصُّ الفشل كما قِيس على WSLg يوم 2026-09-26 — لا كما نتوقّعه.
const STUB = `#!/bin/bash
case "$1" in
  search) echo ${STUB_ID} ;;
  getwindowname) echo "${STUB_TITLE}" ;;
  getwindowpid) echo 4242 ;;
  getwindowgeometry) printf 'WINDOW=%s\\nX=0\\nY=0\\nWIDTH=240\\nHEIGHT=120\\n' ${STUB_ID} ;;
  windowactivate) exit 0 ;;
  getactivewindow)
    echo "XGetWindowProperty[_NET_ACTIVE_WINDOW] failed (code=1)" >&2
    echo "xdo_get_active_window reported an error" >&2
    exit 1 ;;
  *) exit 0 ;;
esac
`

const wslPython = process.platform === "win32" && wslRun("command -v python3 && command -v bash").ok

test.skipIf(!wslPython)("no window manager: the shipped script refuses by naming the absent property, not by blaming focus", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-xdotool-stub-"))
  const local = join(dir, "xdotool")
  writeFileSync(local, STUB, { encoding: "utf8" })
  const mnt = `/mnt/${local[0]!.toLowerCase()}${local.slice(2).replace(/\\/gu, "/")}`
  const stubDir = `/tmp/abdo-xdotool-stub-${Date.now()}`
  const placed = wslRun(`mkdir -p ${stubDir} && tr -d '\\r' < "${mnt}" > ${stubDir}/xdotool && chmod +x ${stubDir}/xdotool && ${stubDir}/xdotool search --name x`)
  expect(placed.out.trim()).toBe(STUB_ID)

  // المشغّلُ نفسُه بحرفٍ واحدٍ مختلف: الجذعُ أوّلَ PATH. لا فرعَ اختبارٍ في المنتَج.
  const runner = {
    async run(script: string, timeoutMs: number) {
      const child = Bun.spawn([wslExe(), "-d", WSLG_DISTRO, "-e", "bash", "-lc", `export PATH=${stubDir}:$PATH; python3 -`], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
      })
      child.stdin.write(script)
      await child.stdin.end()
      const timer = setTimeout(() => { try { child.kill() } catch { /* انتهى */ } }, timeoutMs)
      try {
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code: await child.exited, stdout: stdout.replace(/\u0000/gu, ""), stderr: stderr.replace(/\u0000/gu, ""), timedOut: false }
      } finally { clearTimeout(timer) }
    },
  }
  const shots = mkdtempSync(join(tmpdir(), "abdo-no-wm-shots-"))
  try {
    // القناةُ **ترى** النافذة: فالعطلُ ليس في X11 ولا في الجرد بل في إثبات التصدّر وحده.
    const listed = await runDesktop({ kind: "windows" }, { shotsDir: shots, runner, script: linuxScript })
    expect(listed.ok).toBe(true)
    expect((listed.windows ?? []).some((w) => w.title === STUB_TITLE)).toBe(true)

    const focus = await runDesktop({ kind: "focus", title: "stub" }, { shotsDir: shots, runner, script: linuxScript })
    expect(focus.ok).toBe(false)
    // السببُ مسمّى، والخاصيّةُ الغائبةُ بنصّها كي يُبحث عنها، والنافذةُ مُقرٌّ بوجودها.
    expect(focus.text).toContain("no window manager")
    expect(focus.text).toContain("_NET_ACTIVE_WINDOW")
    expect(focus.text).toContain(STUB_TITLE)
    // والتوأمُ السالب: الجملتان الكاذبتان لا تعودان.
    expect(focus.text).not.toContain("focus moved")
    expect(focus.text).not.toContain("could not bring the window to the front")
  } finally {
    wslRun(`rm -rf ${stubDir}`)
    for (const d of [dir, shots]) {
      for (let i = 0; i < 10; i += 1) { try { rmSync(d, { recursive: true, force: true }); break } catch { await Bun.sleep(200) } }
    }
  }
}, 120_000)
