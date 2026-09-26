/**
 * التشغيلاتُ الخلفيّةُ لهذه الجلسة — مالكٌ واحدٌ لخلقِ العمليّة الخلفيّة وسجلِّها.
 *
 * كانت تسكن `cli.ts` مباشرةً، فكانت **آخرَ أثرٍ مباشرٍ** فيه: بوّابةُ التركيب تعدّ خلقَ
 * العمليّة المباشرَ هناك «تنفيذاً موازياً غيرَ مسجَّل»، والتسجيلُ نفسُه ممنوعٌ فيها:
 * «انقُل الملكيّةَ إلى الحزمة المالكة». وأخواتُه انتُقلت قبله، فهذا آخرُها.
 *
 * ✅ **وقد صار يمرّ بمُطلِق العزل (2026-09-27، أمرُ المالك «نفّذ»)**: كان يُقلع بـ`Bun.spawn`
 * خارج `launchControlledProcess`، ففاته ما تناله المقدّمة — تحقّقُ صياغةِ الأمر، وحلُّ
 * `cwd` **داخل** نطاق المشروع، والخطّةُ وفحصُ الانزياح (TOCTOU) والبوّابةُ والرفضُ المسمّى.
 * والطَّورُ المنفصلُ (`detach`) يفعل ذلك كلَّه ثمّ **يعود بالمعرّف بلا انتظار**، فالعمرُ
 * لهذه الوحدة كما كان. وأمرُ `run` في المقدّمة والخلفيّ يمرّان الآن بالبابِ نفسِه.
 *
 * ⚠ **وما يبقى مقيساً بحدّه**: سلطةُ الأثر في المعمار لـ`@abdo/kernel`، والنواةُ تُدخِل
 * خمسةَ محوّلاتٍ فقط (‏`write`، `git-read`، `git-change`، `package`، `network`) وجردُها
 * مثبَّتٌ ٦/٦/٦ — فالشِّلُّ **كلُّه**، مقدّمةً وخلفيّةً، خارجَ دفترِ النواة. وذاك نوعُ أثرٍ
 * جديدٌ في النواة، قرارٌ أوسعُ من هذا الملفّ ومُعلَنٌ لا مُنفَّذٌ خفيةً.
 *
 * والقواعدُ محفوظةٌ كما كانت مقيسة:
 * - **البيئةُ تُجرَّد من أسرارها** قبل الخلق: عمليّةٌ خلفيّةٌ ترث `ABDO_SHELL_TOKEN`
 *   ومفاتيحَ المزوّدين تسلّمها لكلِّ ما تشغّله، والحدُّ الذي يملك خلقَ العمليّة يملك
 *   تجريدَ بيئتها. فالبيئةُ **تُمرَّر إليه مجرَّدةً** ولا يقرؤها من `process`.
 * - **سقفُ ثلاثين دقيقة** ثمّ قتلٌ بشجرة العمليّات.
 * - **الجلسةُ التي خلقت العمليّة تقتلها** عند خروجها (ب10): كانت تبقى بعد إغلاق التطبيق
 *   تكتب في سجلٍّ لا يقرؤه أحد.
 * - **والسجلُّ صار مكتوباً بأيدينا UTF-8**: كان PowerShell يكتب إعادةَ التوجيه `*>`
 *   بـUTF-16LE مع BOM فيُقرأ بحيلةِ كشفِ ترميز (قِيس: «t\x00i\x00…»). الآن يمرّ الخرجُ من
 *   تيّارَي الطفل إلى ملفٍّ نكتبه، فلا حيلةَ ولا BOM — ومَن قرأ الحيلةَ يجدها محفوظةً
 *   لملفّاتٍ قديمةٍ قد تكون على القرص.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, launchControlledProcess } from "@abdo/tools"

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

/** رفضٌ مسمّى من المُطلِق — يُرفع إلى المُنادي كما هو، فلا يُقرأ عطلاً في الأداة. */
export class BackgroundLaunchRefused extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(detail)
    this.name = "BackgroundLaunchRefused"
  }
}

export async function startBackgroundRun(
  cmd: string,
  cwd: string,
  logDir: string,
  env: Record<string, string | undefined>,
): Promise<BackgroundRun> {
  mkdirSync(logDir, { recursive: true })
  const id = `bg-${sequence + 1}`
  const log = join(logDir, `${id}.log`)
  writeFileSync(log, "", "utf8")
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") childEnv[key] = value

  const launched = await launchControlledProcess({
    executable: "powershell",
    argv: ["-NoProfile", "-Command", `$OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`],
    cwd,
    env: childEnv,
    isolationProfile: INHERIT_PROFILE,
    capability: UNMEASURED_CAPABILITY,
    timeoutMs: BACKGROUND_CAP_MS,
    evidence: { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false },
    detach: true,
  })

  if (launched.outcome !== "detached") {
    const detail = "detail" in launched ? launched.detail : `المُطلِقُ أعاد «${launched.outcome}»`
    throw new BackgroundLaunchRefused("reasonCode" in launched ? launched.reasonCode : launched.outcome, detail)
  }

  sequence += 1
  const run: BackgroundRun = {
    id,
    cmd,
    log,
    startedAt: Date.now(),
    pid: launched.pid,
    kill: launched.kill,
  }
  // التيّارانِ يُصرَّفان إلى السجلّ: تيّارٌ لا يُقرأ يملأ أنبوبَه فيجمّد الطفل.
  void drain(launched.stdout, log)
  void drain(launched.stderr, log)
  // وحالةُ الخروج تُراقَب، وإلّا قال السجلُّ «جارٍ» إلى الأبد بعد أن انتهى.
  void launched.exited.then((code) => { run.exitCode = code ?? undefined })
  const cap = setTimeout(() => { if (run.exitCode === undefined) { run.stopped = true; run.kill() } }, BACKGROUND_CAP_MS)
  cap.unref?.()
  runs.set(id, run)
  return run
}

const drain = async (stream: ReadableStream, log: string): Promise<void> => {
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      try { appendFileSync(log, new TextDecoder().decode(chunk), "utf8") } catch { /* القرصُ ليس حاكماً */ }
    }
  } catch { /* أُغلق التيّار */ }
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
    // سجلُّنا UTF-8، وحيلةُ UTF-16LE تبقى لملفّاتٍ كتبها إصدارٌ أقدمُ على القرص نفسِه.
    text = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le").slice(1) : buf.toString("utf-8").replace(/^﻿/u, "")
  } catch { text = "" }
  const tail = text.split(/\r?\n/u).filter((l, i, a) => !(i === a.length - 1 && l === "")).slice(-lines)
  const state = run.exitCode === undefined
    ? `جارٍ منذ ${Math.round((Date.now() - run.startedAt) / 1000)} ث`
    : run.stopped ? "أُوقف" : `انتهى برمز ${run.exitCode}`
  return `${run.id} · ${state} · ${run.cmd.slice(0, 120)}\n${tail.length ? tail.join("\n") : "(لا خرجَ بعد)"}`
}
