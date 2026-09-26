/**
 * التشغيلاتُ الخلفيّةُ لهذه الجلسة — مالكٌ واحدٌ لخلقِ العمليّة الخلفيّة وسجلِّها.
 *
 * كانت تسكن `cli.ts` مباشرةً، فكانت **آخرَ أثرٍ مباشرٍ** فيه: بوّابةُ التركيب
 * (`architecture/composition.manifest.json` عبر `scripts/composition-gate.ts`) تعدّ
 * `Bun.spawn(` في `cli.ts` «تنفيذاً موازياً غيرَ مسجَّل»، والتسجيلُ نفسُه صار
 * ممنوعاً في البوّابة: «انقُل الملكيّةَ إلى الحزمة المالكة». وأخواتُه انتُقلت
 * قبله (دفترُ الجلسة، حلقةُ الخدمة، حلُّ الأسرار)، فهذا آخرُها.
 *
 * ⚠ **الفرقُ المقيس — يُقال بحدّه لا أوسع ولا أضيق (قِيس 2026-09-27):**
 *
 * 1. **الشِّلُّ كلُّه خارج سلطة أثر النواة، لا التشغيلُ الخلفيُّ وحده.** النواةُ تُدخِل
 *    خمسةَ محوّلاتٍ فقط (write، git-read، git-change، package، network)، وبوّابةُ جردِها
 *    تثبّت ٦ قدراتٍ في ٦ تطبيقات. فأمرُ `run` في المقدّمة **أيضاً** لا يمرّ بدفتر
 *    النواة — وادّعاءُ أنّ الخلفيَّ استثناءٌ وحدَه كان أضيقَ من الحقيقة.
 *
 * 2. **وما يفترق فيه الخلفيُّ عن المقدّمة مقيسٌ أيضاً**: المقدّمةُ تمرّ بـ`runCommandTool`
 *    ثمّ `launchControlledProcess`، فتنال إصلاحَ صياغةِ الأمر والتحقّقَ منها، وحلَّ
 *    `cwd` **داخل** نطاق المشروع، واحتواءَ شجرةِ العمليّات ببنائه، وإيصالَ إطلاقٍ
 *    بأدلّته. والخلفيُّ يُطلق هنا مباشرةً: بيئةٌ مجرَّدةٌ وسقفٌ وقتلٌ بالشجرة عند
 *    الإيقاف — **بلا** احتواءٍ ببنائه وبلا إيصالِ إطلاق. فالإيصالُ يقول ذلك للمشغّل
 *    والنموذج، ولا يُترك يوهم أنّ `--bg` مكافئٌ للمقدّمة.
 *
 * 3. **والقرارُ الباقي بشكلَيه** (كلاهما أوسعُ من تنظيمِ ملفّ، فيُعلَن ولا يُنفَّذ خفيةً):
 *    إمّا **طَورٌ منفصلٌ في مُطلِق العزل** يُطلق ويعود بالمعرّف بلا انتظار — ويمسّ وحدةً
 *    هويّتُها مثبَّتةٌ بهاشٍ يحرسه فحصُ TOCTOU، فرفعُ نسخةٍ مقصودٌ لا إصلاحٌ عابر؛ وإمّا
 *    **نوعُ أثرٍ للشِّلّ في النواة** — ويمسّ جردَها المثبَّت ٦/٦/٦. وأيُّهما جرى فهذا
 *    الملفُّ أوّلُ ما يُحدَّث.
 *
 * والقواعدُ محفوظةٌ كما كانت مقيسة:
 * - **البيئةُ تُجرَّد من أسرارها** قبل الخلق: عمليّةٌ خلفيّةٌ ترث `ABDO_SHELL_TOKEN`
 *   ومفاتيحَ المزوّدين تسلّمها لكلِّ ما تشغّله، والحدُّ الذي يملك خلقَ العمليّة
 *   يملك تجريدَ بيئتها. فالبيئةُ **تُمرَّر إليه مجرَّدةً** ولا يقرؤها من `process`.
 * - **سقفُ ثلاثين دقيقة** ثمّ قتلٌ بشجرة العمليّات.
 * - **الجلسةُ التي خلقت العمليّة تقتلها** عند خروجها (ب10): كانت تبقى بعد إغلاق
 *   التطبيق تكتب في سجلٍّ لا يقرؤه أحد.
 * - **الترميزُ يُكتشف لا يُفترض**: PowerShell 5.1 يكتب إعادةَ التوجيه `*>`
 *   بـUTF-16LE مع BOM (قِيس: «t\x00i\x00…»).
 */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface BackgroundRun {
  readonly id: string
  readonly cmd: string
  readonly log: string
  readonly startedAt: number
  readonly pid: number
  exitCode?: number
  stopped?: boolean
  kill: () => void
}

export const BACKGROUND_CAP_MS = 30 * 60_000

const runs = new Map<string, BackgroundRun>()
let sequence = 0

/** تشغيلاتُ هذه الجلسة بمعرّفاتها — للقراءة (اللوحُ والإطارات). */
export const backgroundRuns: ReadonlyMap<string, BackgroundRun> = runs

export function startBackgroundRun(
  cmd: string,
  cwd: string,
  logDir: string,
  env: Record<string, string | undefined>,
): BackgroundRun {
  mkdirSync(logDir, { recursive: true })
  const id = `bg-${++sequence}`
  const log = join(logDir, `${id}.log`)
  const child = Bun.spawn(
    ["powershell", "-NoProfile", "-Command", `$OutputEncoding=[Text.Encoding]::UTF8; & { ${cmd} } *> '${log.replace(/'/gu, "''")}'`],
    { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, env },
  )
  const run: BackgroundRun = {
    id,
    cmd,
    log,
    startedAt: Date.now(),
    pid: child.pid,
    kill: () => {
      try { Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore" }) } catch { /* لا شجرة */ }
      try { child.kill() } catch { /* انتهى */ }
    },
  }
  void child.exited.then((code) => { run.exitCode = code })
  const cap = setTimeout(() => { if (run.exitCode === undefined) { run.stopped = true; run.kill() } }, BACKGROUND_CAP_MS)
  cap.unref?.()
  runs.set(id, run)
  return run
}

export function stopAllBackgroundRuns(): void {
  for (const run of runs.values()) {
    if (run.exitCode === undefined) { run.stopped = true; try { run.kill() } catch { /* انتهت */ } }
  }
}

export function backgroundLogs(id: string, lines: number): string {
  const run = runs.get(id)
  if (run === undefined) return `لا تشغيلَ خلفيّاً بالمعرّف «${id.slice(0, 16)}» في هذه الجلسة — المعرّفات: ${[...runs.keys()].join("، ") || "لا شيء"}`
  let text = ""
  try {
    const buf = readFileSync(run.log)
    text = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le").slice(1) : buf.toString("utf-8").replace(/^﻿/u, "")
  } catch { text = "" }
  const tail = text.split(/\r?\n/u).filter((l, i, a) => !(i === a.length - 1 && l === "")).slice(-lines)
  const state = run.exitCode === undefined
    ? `جارٍ منذ ${Math.round((Date.now() - run.startedAt) / 1000)} ث`
    : run.stopped ? "أُوقف" : `انتهى برمز ${run.exitCode}`
  return `${run.id} · ${state} · ${run.cmd.slice(0, 120)}\n${tail.length ? tail.join("\n") : "(لا خرجَ بعد)"}`
}
