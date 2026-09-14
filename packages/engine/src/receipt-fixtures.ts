/** إعادة تشغيل الحوادث — كل كاشفٍ وكل كتيّبٍ يشحن مع أثر حادثته.
 *
 * فكرة ممتصّة (anton ‏ACC، الطبقة الثالثة: fixtures + اختبارٌ لكل واحدة)،
 * معادةُ الصياغة فوق **كواشفنا** ومفردات **أحكامنا** — لا سطر منقول. اليوم
 * تعيش معرفة الحوادث نثراً في تعليقات الاختبارات وحرفياً في جداولها؛ هنا
 * تصير سجلات قابلة للتشغيل: نصُّ الإيصال كاملاً، والحكم المتوقَّع من كل
 * كاشف، ومصدرُ السجل بصدق (`tap` حيّ، `frame` من سجلّ أُطر مقطوع،
 * `catalog` من كتالوج السيناريوهات، `synthetic` مصنوع).
 *
 * القوانين الحاكمة:
 * - **فشلٌ مغلق**: سطرٌ مشوَّه يرفع `FixtureFormatError` باسم الملف والسطر —
 *   لا يُتخطّى بصمت. غيابُ ملف التقاطٍ رفضٌ لا التقاطٌ فارغ.
 * - **مفرداتٌ واحدة**: `verdict.reason` من `REASONS`، و`tier` من
 *   `FailureTier`، و`playbooks` من معرّفات `PLAYBOOKS` — لا قاموس ثانٍ.
 * - **الحجب قبل الكتابة**: لا بايت يُكتب على القرص قبل مرور النصّ بمفردات
 *   `secret-command-guard` (حجبٌ ثم مصفاةٌ طويلة)، وترقيةُ سجلٍّ بقي فيه ما
 *   يشبه سرّاً تُرفض ولا تكتب شيئاً.
 * - **الالتقاط مساعِدٌ لا حاكم**: كل خطأ نظام ملفّاتٍ في المِلقَط يُبتلع
 *   ويُعدّ، ولا يصعد إلى الدور أبداً.
 * - **الصدق في الوسم**: سجلٌّ لم يُلتقط حياً يُوسم `synthetic` — لا يُدّعى أثراً.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { REASONS, type ToolVerdict, type ToolVerdictReason } from "@abdo/engine-host"
import { adapterErrorVerdict } from "./adapter-error-verdict"
import { PLAYBOOKS } from "./error-playbooks"
import { WallTracker, classifyFailureTier, exitZero, receiptFailed, type FailureTier } from "./failure-tiering"
import { moduleResolutionHints } from "./module-resolution-hint"
import { PlaybookMiner } from "./playbook-miner"
import { projectTestPassed } from "./project-test-acceptance"
import { redactSecretValues, residualSecretMatches, sweepResidualSecrets } from "./secret-command-guard"
import { distillFact } from "./turn-memory"

// ---------------------------------------------------------------------------
// الشكل
// ---------------------------------------------------------------------------

export const FIXTURE_FAMILIES = Object.freeze([
  "tiering", "walls", "miner", "playbooks", "facts", "acceptance", "adapter", "module-resolution",
] as const)
export type FixtureFamily = (typeof FIXTURE_FAMILIES)[number]

export const FIXTURE_SOURCES = Object.freeze(["tap", "frame", "catalog", "synthetic"] as const)
export type FixtureSource = (typeof FIXTURE_SOURCES)[number]

/** الحقائق المقطَّرة تُقارَن بنوعها ومفتاحها — لا بنصّها المعروض. */
export interface FactShape { readonly kind: string; readonly key: string }
export interface AdapterShape { readonly reason: string; readonly denied: boolean; readonly unmapped: boolean }
/**
 * حكمُ بوّابة القبول على إيصالٍ واحد — `exitZero` (failure-tiering) و
 * `projectTestPassed` (project-test-acceptance)، وكلاهما كاشفٌ نقيٌّ مُصدَّر.
 * بدونه كانت عائلة `acceptance` تسند إلى كواشف العائلات الأخرى وحدها، فتُعدّ
 * «مغطّاة» بينما تخريبُ بوّابة القبول لا يُحمِّر سجلاً واحداً.
 */
export interface AcceptanceShape { readonly exitZero: boolean; readonly testPassed: boolean }

export interface FixtureExpect {
  readonly failed?: boolean
  readonly tier?: FailureTier
  /** معرّفات الكتيّبات المطابقة، بترتيب السجلّ، بلا سقف (السقف عرضٌ لا حكم). */
  readonly playbooks?: readonly string[]
  /** دورةُ `repeat` التي أعطى فيها متتبّع الجدران حكماً أولَ مرّة، أو null. */
  readonly wallAt?: number | null
  readonly minerAt?: number | null
  readonly fact?: FactShape | null
  readonly adapter?: AdapterShape | null
  readonly acceptance?: AcceptanceShape | null
  readonly moduleHintContains?: readonly string[]
}

export const EXPECT_KEYS = Object.freeze([
  "failed", "tier", "playbooks", "wallAt", "minerAt", "fact", "adapter", "acceptance", "moduleHintContains",
] as const)

/**
 * عائلةٌ لها كاشفُها الخاصّ **يلزمها** أن تثبّته: سجلٌّ في عائلةٍ لا يسند إلى
 * كاشفها هو تغطيةٌ مُدّعاة (كانت `acceptance` كذلك: ثلاثةُ سجلات تسند إلى
 * أوراكل العائلات الأخرى وحدها). عائلةُ المسارات مستثناة عمداً: مفتاحها
 * يحتاج قرصاً مُهيّأً فلا يحسبه الالتقاط، فاشتراطُه هنا يجعل `fixture capture`
 * يكتب سجلاً يرفضه المحمّل بعده — وسجلاتُها الثلاثة تثبّته أصلاً.
 */
const FAMILY_REQUIRED_KEY: Readonly<Record<string, string>> = Object.freeze({
  adapter: "adapter",
  acceptance: "acceptance",
})

export interface FixtureProject {
  readonly files: readonly string[]
  readonly tsconfig?: unknown
}

export interface ReceiptFixture {
  readonly id: string
  readonly family: FixtureFamily
  readonly source: FixtureSource
  readonly truncated: boolean
  readonly captured: string
  readonly incident: string
  readonly catalog?: string
  readonly command: string
  readonly output: string
  readonly verdict?: ToolVerdict
  readonly repeat: number
  readonly project?: FixtureProject
  readonly expect: FixtureExpect
}

const TIERS: readonly FailureTier[] = Object.freeze(["self_inflicted", "transient", "external_wall", "unclassified"])
const FIXTURE_FILE = /^receipts-[a-z0-9-]+\.jsonl$/u
export const fixtureFileFor = (family: FixtureFamily): string => `receipts-${family}.jsonl`

// ---------------------------------------------------------------------------
// المحمّل — فشلٌ مغلق باسم الملف والسطر
// ---------------------------------------------------------------------------

export class FixtureFormatError extends Error {
  readonly file: string
  readonly line: number
  readonly reason: string
  constructor(file: string, line: number, reason: string) {
    super(`${file}:${line}: ${reason}`)
    this.name = "FixtureFormatError"
    this.file = file
    this.line = line
    this.reason = reason
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ALLOWED_TOP = new Set([
  "id", "family", "source", "truncated", "captured", "incident", "catalog",
  "command", "output", "verdict", "repeat", "project", "expect",
])

const parseVerdict = (value: unknown, fail: (reason: string) => never): ToolVerdict => {
  if (!isPlainObject(value)) fail("verdict كائنٌ {ok:…} أو غائب")
  const ok = value.ok
  if (typeof ok !== "boolean") fail("verdict.ok منطقيّ إلزاميّ")
  if (ok === true) {
    for (const key of Object.keys(value)) if (key !== "ok") fail(`verdict الناجح لا يحمل ${key}`)
    return { ok: true }
  }
  const reason = value.reason
  if (typeof reason !== "string" || !REASONS.includes(reason as ToolVerdictReason)) {
    fail(`verdict.reason غير معروف «${String(reason).slice(0, 40)}» — المفردات من REASONS`)
  }
  const denied = value.denied
  if (typeof denied !== "boolean") fail("verdict.denied منطقيّ إلزاميّ في الحكم الفاشل")
  const detail = value.detail
  if (detail !== undefined && typeof detail !== "string") fail("verdict.detail نصٌّ أو غائب")
  for (const key of Object.keys(value)) {
    if (key !== "ok" && key !== "reason" && key !== "denied" && key !== "detail") fail(`verdict لا يحمل ${key}`)
  }
  return detail === undefined
    ? { ok: false, reason: reason as ToolVerdictReason, denied }
    : { ok: false, reason: reason as ToolVerdictReason, denied, detail }
}

const parseExpect = (value: unknown, family: string, fail: (reason: string) => never): FixtureExpect => {
  if (!isPlainObject(value)) fail("expect كائنٌ إلزاميّ — سجلٌّ بلا توقّعٍ لا يفحص شيئاً")
  // `{}` تفلت من الفحص أعلاه وتفحص صفرَ مفاتيح: سجلٌّ يُعدّ ناجحاً في
  // `verify` وهو لا يسأل الكواشف شيئاً. الرفض بالسبب نفسه.
  if (Object.keys(value).length === 0) fail("expect كائنٌ إلزاميّ — سجلٌّ بلا توقّعٍ لا يفحص شيئاً (`{}` توقّعٌ فارغ)")
  const required = FAMILY_REQUIRED_KEY[family]
  if (required !== undefined && !(required in value)) {
    fail(`expect.${required} إلزاميّ لعائلة «${family}» — سجلٌّ لا يسند إلى كاشف عائلته تغطيةٌ مُدّعاة`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!(EXPECT_KEYS as readonly string[]).includes(key)) fail(`expect.${key} مفتاحٌ غير معروف — المعروف ${EXPECT_KEYS.join("، ")}`)
    switch (key) {
      case "failed":
        if (typeof entry !== "boolean") fail("expect.failed منطقيّ")
        break
      case "tier":
        if (typeof entry !== "string" || !TIERS.includes(entry as FailureTier)) fail(`expect.tier غير معروف «${String(entry).slice(0, 40)}»`)
        break
      case "playbooks": {
        if (!Array.isArray(entry) || entry.some((v) => typeof v !== "string")) fail("expect.playbooks قائمة نصوص")
        const ids = new Set(PLAYBOOKS.map((p) => p.id))
        for (const id of entry as string[]) if (!ids.has(id)) fail(`expect.playbooks: معرّف كتيّبٍ غير موجود «${id}»`)
        break
      }
      case "wallAt":
      case "minerAt":
        if (entry !== null && (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1)) fail(`expect.${key} عددٌ صحيحٌ ≥1 أو null`)
        break
      case "fact":
        if (entry !== null) {
          if (!isPlainObject(entry) || typeof entry.kind !== "string" || typeof entry.key !== "string") fail("expect.fact كائن {kind,key} أو null")
          for (const k of Object.keys(entry as Record<string, unknown>)) if (k !== "kind" && k !== "key") fail(`expect.fact لا يحمل ${k}`)
        }
        break
      case "adapter":
        if (entry !== null) {
          if (!isPlainObject(entry) || typeof entry.reason !== "string" || typeof entry.denied !== "boolean" || typeof entry.unmapped !== "boolean") {
            fail("expect.adapter كائن {reason,denied,unmapped} أو null")
          }
          if (!REASONS.includes((entry as Record<string, unknown>).reason as ToolVerdictReason)) fail(`expect.adapter.reason غير معروف «${String((entry as Record<string, unknown>).reason).slice(0, 40)}»`)
        }
        break
      case "acceptance":
        if (entry !== null) {
          if (!isPlainObject(entry) || typeof entry.exitZero !== "boolean" || typeof entry.testPassed !== "boolean") {
            fail("expect.acceptance كائن {exitZero,testPassed} أو null")
          }
          for (const k of Object.keys(entry as Record<string, unknown>)) if (k !== "exitZero" && k !== "testPassed") fail(`expect.acceptance لا يحمل ${k}`)
        }
        break
      case "moduleHintContains":
        if (!Array.isArray(entry) || entry.length === 0 || entry.some((v) => typeof v !== "string" || v.length === 0)) fail("expect.moduleHintContains قائمة نصوص غير فارغة")
        break
      default:
        fail(`expect.${key} مفتاحٌ غير معروف`)
    }
    out[key] = entry
  }
  return Object.freeze(out) as FixtureExpect
}

/** يحمّل سجلات JSONL؛ سطرٌ مشوَّه = `FixtureFormatError` باسم الملف والسطر (1-based). */
export function parseFixtureJsonl(text: string, file: string): ReceiptFixture[] {
  const records: ReceiptFixture[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const line = index + 1
    // التعليقُ الصريح للنوع مقصود: به وحده يعرف المحلِّل أن النداء لا يعود،
    // فتضييقُ الأنواع بعد كل فحصٍ يسري (وإلا صارت كل قيمةٍ unknown بعده).
    const fail: (reason: string) => never = (reason) => { throw new FixtureFormatError(file, line, reason) }
    if (raw.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      fail(`JSON غير صالح: ${error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80)}`)
    }
    if (!isPlainObject(parsed)) fail("السطر كائنُ JSON واحد")
    const record = parsed as Record<string, unknown>
    for (const key of Object.keys(record)) if (!ALLOWED_TOP.has(key)) fail(`حقلٌ غير معروف «${key}»`)
    const id = record.id
    if (typeof id !== "string" || id.trim().length === 0) fail("id نصٌّ غير فارغ")
    if (seen.has(id as string)) fail(`id مكرّر «${id as string}»`)
    seen.add(id as string)
    const family = record.family
    if (typeof family !== "string" || !(FIXTURE_FAMILIES as readonly string[]).includes(family)) {
      fail(`family غير معروفة «${String(family).slice(0, 40)}» — المعروف ${FIXTURE_FAMILIES.join("، ")}`)
    }
    const source = record.source
    if (typeof source !== "string" || !(FIXTURE_SOURCES as readonly string[]).includes(source)) {
      fail(`source غير معروف «${String(source).slice(0, 40)}» — المعروف ${FIXTURE_SOURCES.join("، ")}`)
    }
    const truncatedRaw = record.truncated
    if (truncatedRaw !== undefined && typeof truncatedRaw !== "boolean") fail("truncated منطقيّ")
    const truncated: boolean = truncatedRaw === undefined ? false : (truncatedRaw as boolean)
    const captured = record.captured
    if (typeof captured !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(captured)) fail("captured تاريخٌ YYYY-MM-DD")
    const incident = record.incident
    if (typeof incident !== "string" || incident.trim().length === 0 || incident.length > 200) fail("incident نصٌّ غير فارغ ≤200 محرفاً")
    const catalog = record.catalog
    if (catalog !== undefined && (typeof catalog !== "string" || catalog.length === 0)) fail("catalog نصٌّ أو غائب")
    const command = record.command
    if (typeof command !== "string" || command.trim().length === 0) fail("command نصٌّ غير فارغ")
    const output = record.output
    if (typeof output !== "string" || output.length === 0) fail("output نصٌّ غير فارغ — سجلٌّ بلا إيصالٍ لا يُعاد تشغيله")
    const verdict = record.verdict === undefined ? undefined : parseVerdict(record.verdict, fail)
    const repeatRaw = record.repeat
    if (repeatRaw !== undefined && (typeof repeatRaw !== "number" || !Number.isInteger(repeatRaw) || repeatRaw < 1 || repeatRaw > 20)) {
      fail("repeat عددٌ صحيح بين 1 و20")
    }
    const repeat: number = repeatRaw === undefined ? 1 : (repeatRaw as number)
    let project: FixtureProject | undefined
    if (record.project !== undefined) {
      const value = record.project
      if (!isPlainObject(value) || !Array.isArray(value.files) || value.files.some((f) => typeof f !== "string" || f.length === 0)) {
        fail("project كائن {files:[…], tsconfig?} أو غائب")
      }
      project = Object.freeze({
        files: Object.freeze([...(value as Record<string, unknown>).files as string[]]),
        ...((value as Record<string, unknown>).tsconfig === undefined ? {} : { tsconfig: (value as Record<string, unknown>).tsconfig }),
      })
    }
    const expect = parseExpect(record.expect, family as string, fail)
    records.push(Object.freeze({
      id: id as string,
      family: family as FixtureFamily,
      source: source as FixtureSource,
      truncated,
      captured,
      incident,
      ...(catalog === undefined ? {} : { catalog: catalog as string }),
      command,
      output,
      ...(verdict === undefined ? {} : { verdict }),
      repeat,
      ...(project === undefined ? {} : { project }),
      expect,
    }))
  }
  return records
}

// ---------------------------------------------------------------------------
// الكواشف — المصدر الوحيد للحكم المتوقَّع
// ---------------------------------------------------------------------------

export interface Expectations {
  readonly failed: boolean
  readonly tier: FailureTier
  readonly playbooks: readonly string[]
  readonly wallAt: number | null
  readonly minerAt: number | null
  readonly fact: FactShape | null
  readonly adapter: AdapterShape | null
  readonly acceptance: AcceptanceShape | null
  readonly moduleHint: string
}

/** كل معرّفات الكتيّبات المطابقة — بلا سقف العرض (السقف ثلاثةٌ في النصّ المعروض). */
export const matchingPlaybooks = (output: string): string[] =>
  PLAYBOOKS.filter((p) => !(p.not?.test(output) ?? false) && p.when.test(output)).map((p) => p.id)

const firstHitIndex = (repeat: number, hit: (index: number) => boolean): number | null => {
  for (let index = 1; index <= repeat; index++) if (hit(index)) return index
  return null
}

/**
 * يحسب توقّعات سجلٍّ من الكواشف الحيّة. نقيّة إلا حين يُمرَّر `projectDir`:
 * عندها وحدها تُستشار عائلة `module-resolution` (تقرأ القرص وtsconfig).
 */
export function expectationsFor(record: ReceiptFixture, projectDir?: string): Expectations {
  const { output, command, verdict, repeat } = record
  const wallTracker = new WallTracker()
  const wallAt = firstHitIndex(repeat, () => wallTracker.observe(output, verdict) !== undefined)
  const miner = new PlaybookMiner()
  const minerAt = firstHitIndex(repeat, () => miner.observe(output, verdict) !== undefined)
  const fact = distillFact(command, output, verdict)
  const adapter = record.family === "adapter"
    ? (() => {
        const mapped = adapterErrorVerdict(output)
        return mapped.verdict.ok
          ? null
          : { reason: mapped.verdict.reason as string, denied: mapped.verdict.denied, unmapped: mapped.unmapped }
      })()
    : null
  // بوّابة القبول: كاشفاها النقيّان يُسألان لعائلتها وحدها، كما الـadapter.
  const acceptance = record.family === "acceptance"
    ? { exitZero: exitZero(output, verdict), testPassed: projectTestPassed(output, verdict) }
    : null
  return Object.freeze({
    failed: receiptFailed(output, verdict),
    tier: classifyFailureTier(output),
    playbooks: Object.freeze(matchingPlaybooks(output)),
    wallAt,
    minerAt,
    fact: fact === undefined ? null : { kind: fact.kind, key: fact.key },
    adapter,
    acceptance,
    moduleHint: projectDir === undefined ? "" : moduleResolutionHints(output, projectDir),
  })
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const show = (value: unknown): string => JSON.stringify(value)

export interface FixtureVerdict {
  readonly ok: boolean
  readonly diffs: readonly string[]
}

/** يقارن ما سُجِّل بما تقوله الكواشف الآن؛ المفتاح الغائب لا يُقيَّم. */
export function evaluateFixture(record: ReceiptFixture, projectDir?: string): FixtureVerdict {
  const actual = expectationsFor(record, projectDir)
  const diffs: string[] = []
  const expected = record.expect
  const check = (key: string, want: unknown, got: unknown): void => {
    if (!sameJson(want, got)) diffs.push(`${key}: المتوقَّع ${show(want)} · الواقع ${show(got)}`)
  }
  if (expected.failed !== undefined) check("failed", expected.failed, actual.failed)
  if (expected.tier !== undefined) check("tier", expected.tier, actual.tier)
  if (expected.playbooks !== undefined) check("playbooks", expected.playbooks, actual.playbooks)
  if (expected.wallAt !== undefined) check("wallAt", expected.wallAt, actual.wallAt)
  if (expected.minerAt !== undefined) check("minerAt", expected.minerAt, actual.minerAt)
  if (expected.fact !== undefined) check("fact", expected.fact, actual.fact)
  if (expected.adapter !== undefined) check("adapter", expected.adapter, actual.adapter)
  if (expected.acceptance !== undefined) check("acceptance", expected.acceptance, actual.acceptance)
  if (expected.moduleHintContains !== undefined) {
    if (projectDir === undefined) {
      diffs.push("moduleHintContains: يحتاج مجلّد مشروعٍ مُهيّأ — لم يُمرَّر")
    } else {
      for (const needle of expected.moduleHintContains) {
        if (!actual.moduleHint.includes(needle)) diffs.push(`moduleHintContains: «${needle}» غائبة عن التشخيص المحسوب`)
      }
    }
  }
  return Object.freeze({ ok: diffs.length === 0, diffs: Object.freeze(diffs) })
}

/** يفرش سقالة مشروعٍ صغيرة لعائلة `module-resolution` — مدخل fs صريح. */
export function materialiseProject(project: FixtureProject, dir: string): void {
  for (const file of project.files) {
    const target = join(dir, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, "export {}\n", "utf8")
  }
  if (project.tsconfig !== undefined) writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(project.tsconfig, null, 2)}\n`, "utf8")
}

// ---------------------------------------------------------------------------
// الرفض — بالاسم دائماً، ولا كتابة عند أيّ رفض
// ---------------------------------------------------------------------------

export const FIXTURE_REFUSALS = Object.freeze({
  disabled: "«fixture» معطَّل: plugins.receiptFixtures=false",
  compiled: "رُفض: الالتقاط من شجرة المصدر فقط — الثنائيّ المُصرَّف لا يكتب في شجرة الاختبارات",
  usage: "الصيغة: fixture list | fixture verify | fixture capture <turnId> <seq> <family> [حادثة…] | fixture capture --from-log <ملف> <turnId> <index> <family> [حادثة…]",
  noTapFile: (turnId: string): string => `رُفض: لا ملف التقاط للدور «${turnId}» — plugins.receiptFixtures كان معطَّلاً أو لم يُنفَّذ أمر run`,
  noSeq: (seq: number, turnId: string): string => `رُفض: لا سطر برقم ${seq} في التقاط الدور «${turnId}»`,
  unknownFamily: (family: string): string => `رُفض: عائلة غير معروفة «${family}» — المعروف ${FIXTURE_FAMILIES.join("، ")}`,
  duplicateId: (id: string): string => `رُفض: المعرّف «${id}» موجود في الملف — الالتقاط لا يدهس سجلاً قائماً بلا --force`,
  residualSecret: "رُفض: بقي ما يشبه سرّاً بعد الحجب — حرّره يدوياً ثم أعد الالتقاط (لم يُكتب شيء)",
  noLog: (path: string): string => `رُفض: لا ملف أُطر عند «${path}»`,
  noFrame: (index: number, turnId: string): string => `رُفض: لا إطار tool-result رقم ${index} للدور «${turnId}» في السجلّ`,
  frameWithoutJudgement: "رُفض: الإطار مقطوعٌ بلا حقل verdict وبلا علامة رمز خروج — لا حكم يُسجَّل منه (plugins.toolVerdict كان معطَّلاً)",
  noFixtures: (dir: string): string => `رُفض: لا ملفات fixtures في «${dir}»`,
})

// ---------------------------------------------------------------------------
// المِلقَط — جانبيٌّ، محجوب، مسقوف، لا يرمي أبداً
// ---------------------------------------------------------------------------

export const TAP_DIR_NAME = "receipt-tap"
export const TAP_LINE_CAP = 400
/** إيصالات التنفيذ وحدها: إيصال read/write يردّد محتوى ملفٍ ولا يُغذّي كاشفاً. */
const RUN_RECEIPT = /^run\b/iu

export interface ReceiptTap {
  readonly dir: string
  readonly file: string
  readonly count: number
  readonly errors: number
  readonly redactions: number
  observe(command: string, output: string, verdict: ToolVerdict | undefined, epoch: number): void
}

const safeTurnId = (turnId: string): string => {
  const cleaned = String(turnId ?? "").replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120)
  return cleaned.length === 0 || /^\.+$/u.test(cleaned) ? "turn" : cleaned
}

/** حجبٌ ثم مصفاةٌ طويلة — لا بايت يُكتب قبل المرور بهما. */
export function redactForDisk(text: string): { text: string; redactions: number } {
  const first = redactSecretValues(text)
  const second = sweepResidualSecrets(first.text)
  return { text: second.text, redactions: first.redactions + second.redactions }
}

/**
 * الحكمُ أيضاً يُحجب — و`detail` أخطرُ حقلٍ في السجل كلِّه: cli.ts يملؤه من
 * مخرَج الأداة حرفياً (`output.slice(0,160)`, `result.error.slice(0,160)`)،
 * وخطأُ `run` الفاشل مبنيٌّ من سطر الأمر كاملاً (`${failureClass}: ${display}`)
 * فيحمل الاعتماد الذي مُرِّر فيه. كان يُنسخ خاماً بجوار `command` و`output`
 * المحجوبين، فيسقط الضمان كلُّه على الحقل الوحيد المنسوخ من الخرج.
 */
export function redactVerdict(
  verdict: ToolVerdict,
  redact: (text: string) => { text: string; redactions: number },
): { verdict: ToolVerdict; redactions: number } {
  if (verdict.ok || typeof verdict.detail !== "string" || verdict.detail.length === 0) return { verdict, redactions: 0 }
  const safe = redact(verdict.detail)
  return { verdict: { ...verdict, detail: safe.text }, redactions: safe.redactions }
}

/** نصُّ `detail` إن وُجد — لفحص البقايا عليه كما يُفحص الأمر والمخرَج. */
export const verdictDetailOf = (verdict: ToolVerdict | undefined): string =>
  verdict === undefined || verdict.ok || typeof verdict.detail !== "string" ? "" : verdict.detail

/**
 * يفتح مِلقَط دورٍ واحد. لا يلمس القرص حتى أوّل إيصال `run` مقبول —
 * فالمفتاحُ المطفأ لا يُنشئ مجلّداً ولا ملفاً (هنا لا يُبنى المِلقَط أصلاً).
 */
export function openReceiptTap(stateRoot: string, turnId: string): ReceiptTap {
  const dir = join(stateRoot, TAP_DIR_NAME)
  const file = join(dir, `${safeTurnId(turnId)}.jsonl`)
  let count = 0
  let errors = 0
  let redactions = 0
  let capped = false
  const append = (line: string): void => {
    mkdirSync(dir, { recursive: true })
    appendFileSync(file, `${line}\n`, "utf8")
  }
  return {
    dir,
    file,
    get count() { return count },
    get errors() { return errors },
    get redactions() { return redactions },
    observe(command, output, verdict, epoch) {
      try {
        if (capped) return
        if (typeof command !== "string" || !RUN_RECEIPT.test(command.trimStart())) return
        if (typeof output !== "string" || output.length === 0) return
        if (count >= TAP_LINE_CAP) {
          capped = true
          append(JSON.stringify({ capped: true }))
          return
        }
        const safeCommand = redactForDisk(command)
        const safeOutput = redactForDisk(output)
        // الحكمُ يمرّ بالمفردات نفسها قبل الكتابة — لا حقلَ يُستثنى.
        const safeVerdict = verdict === undefined ? undefined : redactVerdict(verdict, redactForDisk)
        const hidden = safeCommand.redactions + safeOutput.redactions + (safeVerdict?.redactions ?? 0)
        append(JSON.stringify({
          seq: count + 1,
          epoch: typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0,
          ts: new Date().toISOString(),
          command: safeCommand.text,
          output: safeOutput.text,
          ...(safeVerdict === undefined ? {} : { verdict: safeVerdict.verdict }),
          redactions: hidden,
        }))
        count += 1
        redactions += hidden
      } catch {
        // مساعِدٌ لا حاكم: قرصٌ ممتلئ أو مسارٌ ممنوع لا يُسقط الدور.
        errors += 1
      }
    },
  }
}

// ---------------------------------------------------------------------------
// الترقية — من التقاطٍ أو من سجلّ أُطر إلى سجلٍّ في شجرة الاختبارات
// ---------------------------------------------------------------------------

export interface CaptureCommon {
  readonly family: string
  readonly fixturesDir: string
  readonly incident?: string
  readonly id?: string
  readonly repeat?: number
  readonly force?: boolean
  readonly captured?: string
}
export interface CaptureFromTapOptions extends CaptureCommon {
  readonly stateRoot: string
  readonly turnId: string
  readonly seq: number
}
export interface CaptureFromFrameLogOptions extends CaptureCommon {
  readonly logPath: string
  readonly turnId: string
  readonly index: number
}

export type CaptureResult =
  | { readonly ok: true; readonly path: string; readonly record: ReceiptFixture; readonly redactions: number; readonly note?: string }
  | { readonly ok: false; readonly refusal: string }

const today = (override?: string): string => override ?? new Date().toISOString().slice(0, 10)

const existingRecords = (path: string): ReceiptFixture[] =>
  existsSync(path) ? parseFixtureJsonl(readFileSync(path, "utf8"), path) : []

const orderedRecord = (record: ReceiptFixture): Record<string, unknown> => ({
  id: record.id,
  family: record.family,
  source: record.source,
  truncated: record.truncated,
  captured: record.captured,
  incident: record.incident,
  ...(record.catalog === undefined ? {} : { catalog: record.catalog }),
  command: record.command,
  output: record.output,
  ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
  repeat: record.repeat,
  ...(record.project === undefined ? {} : { project: record.project }),
  expect: record.expect,
})

export const serialiseFixture = (record: ReceiptFixture): string => JSON.stringify(orderedRecord(record))

/** يبني سجلاً محجوباً ويكتبه، أو يرفض بالاسم ولا يكتب شيئاً. */
const buildAndWrite = (input: {
  common: CaptureCommon
  id: string
  source: FixtureSource
  truncated: boolean
  command: string
  output: string
  verdict?: ToolVerdict
  note?: string
}): CaptureResult => {
  const { common } = input
  if (!(FIXTURE_FAMILIES as readonly string[]).includes(common.family)) return { ok: false, refusal: FIXTURE_REFUSALS.unknownFamily(common.family) }
  const family = common.family as FixtureFamily
  // الترقية تحجب **بالمفردات وحدها** لا بالمصفاة الطويلة: المصفاة تمحو بصمات
  // الأدلّة وأسماء الحزم الطويلة فتُفقِد السجلَّ الأثرَ الذي جئنا نحفظه. فما
  // بقي شبيهاً بسرٍّ بعدها يُرفض ليراه إنسان — لا يُطمس صامتاً. (المِلقَط
  // المحلّيّ يكنس أيضاً: ملفٌّ على قرصنا لا سجلٌّ يُودَع.)
  const command = redactSecretValues(input.command)
  const output = redactSecretValues(input.output)
  // **كلُّ** نصٍّ يُكتب في السطر يُحجب، لا حقلان منه: الحكمُ يحمل `detail`
  // المنسوخ من الخرج، والحادثةُ نصٌّ يكتبه المشرف وقد ينسخ فيه ما لصق.
  const verdictSafe = input.verdict === undefined ? undefined : redactVerdict(input.verdict, redactSecretValues)
  const incident = redactSecretValues((input.common.incident ?? "بلا وصفٍ — يحرّره المشرف").slice(0, 200))
  const redactions = command.redactions + output.redactions + (verdictSafe?.redactions ?? 0) + incident.redactions
  // فشلٌ مغلق: ما بقي شبيهاً بسرٍّ بعد الحجب يمنع الكتابة كلَّها — في أيّ حقل.
  const residual = [
    ...residualSecretMatches(command.text),
    ...residualSecretMatches(output.text),
    ...residualSecretMatches(verdictDetailOf(verdictSafe?.verdict)),
    ...residualSecretMatches(incident.text),
  ]
  if (residual.length > 0) return { ok: false, refusal: FIXTURE_REFUSALS.residualSecret }
  const path = join(common.fixturesDir, fixtureFileFor(family))
  let existing: ReceiptFixture[]
  try {
    existing = existingRecords(path)
  } catch (error) {
    return { ok: false, refusal: `رُفض: ملف السجلات القائم معطوب — ${error instanceof Error ? error.message : String(error)}` }
  }
  const clash = existing.some((r) => r.id === input.id)
  if (clash && common.force !== true) return { ok: false, refusal: FIXTURE_REFUSALS.duplicateId(input.id) }
  const draft: ReceiptFixture = {
    id: input.id,
    family,
    source: input.source,
    truncated: input.truncated,
    captured: today(common.captured),
    incident: incident.text,
    command: command.text,
    output: output.text,
    ...(verdictSafe === undefined ? {} : { verdict: verdictSafe.verdict }),
    repeat: common.repeat ?? 1,
    expect: {},
  }
  const computed = expectationsFor(draft)
  const record: ReceiptFixture = Object.freeze({
    ...draft,
    expect: Object.freeze({
      failed: computed.failed,
      tier: computed.tier,
      playbooks: computed.playbooks,
      wallAt: computed.wallAt,
      minerAt: computed.minerAt,
      fact: computed.fact,
      ...(family === "adapter" ? { adapter: computed.adapter } : {}),
      ...(family === "acceptance" ? { acceptance: computed.acceptance } : {}),
    }),
  })
  const line = serialiseFixture(record)
  mkdirSync(common.fixturesDir, { recursive: true })
  if (clash) {
    const kept = existing.map((r) => (r.id === input.id ? line : serialiseFixture(r)))
    writeFileSync(path, `${kept.join("\n")}\n`, "utf8")
  } else {
    appendFileSync(path, `${line}\n`, "utf8")
  }
  return { ok: true, path, record, redactions, ...(input.note === undefined ? {} : { note: input.note }) }
}

export function captureFromTap(options: CaptureFromTapOptions): CaptureResult {
  const tapFile = join(options.stateRoot, TAP_DIR_NAME, `${safeTurnId(options.turnId)}.jsonl`)
  if (!existsSync(tapFile)) return { ok: false, refusal: FIXTURE_REFUSALS.noTapFile(options.turnId) }
  let picked: Record<string, unknown> | undefined
  for (const raw of readFileSync(tapFile, "utf8").split(/\r?\n/u)) {
    if (raw.trim().length === 0) continue
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { continue }
    if (!isPlainObject(parsed) || parsed.seq !== options.seq) continue
    picked = parsed
    break
  }
  if (picked === undefined) return { ok: false, refusal: FIXTURE_REFUSALS.noSeq(options.seq, options.turnId) }
  const command = typeof picked.command === "string" ? picked.command : ""
  const output = typeof picked.output === "string" ? picked.output : ""
  if (output.length === 0) return { ok: false, refusal: FIXTURE_REFUSALS.noSeq(options.seq, options.turnId) }
  let verdict: ToolVerdict | undefined
  if (picked.verdict !== undefined) {
    try {
      verdict = parseVerdict(picked.verdict, (reason) => { throw new Error(reason) })
    } catch (error) {
      return { ok: false, refusal: `رُفض: حكمٌ مشوَّه في سطر الالتقاط — ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return buildAndWrite({
    common: options,
    id: options.id ?? `${safeTurnId(options.turnId)}/ep${String(picked.epoch ?? 0)}/${options.seq}`,
    source: "tap",
    truncated: false,
    command,
    output,
    ...(verdict === undefined ? {} : { verdict }),
  })
}

/**
 * احتياطُ سجلّ الأُطر: الأُطر المحفوظة **مقطوعة الرأس** (500 حرفاً عند
 * الانبعاث)، فعلامة رمز الخروج الختامية ضائعة — لذا يُوسم السجل
 * `truncated:true` ويُبنى حكمه من حقل `verdict` وحده؛ ولا حكمَ ولا علامة =
 * رفضٌ لا سجلٌّ يكذب.
 */
export function captureFromFrameLog(options: CaptureFromFrameLogOptions): CaptureResult {
  if (!existsSync(options.logPath)) return { ok: false, refusal: FIXTURE_REFUSALS.noLog(options.logPath) }
  let seen = 0
  let picked: Record<string, unknown> | undefined
  for (const raw of readFileSync(options.logPath, "utf8").split(/\r?\n/u)) {
    if (raw.trim().length === 0) continue
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { continue }
    if (!isPlainObject(parsed)) continue
    if (parsed.kind !== "tool-result" || parsed.turnId !== options.turnId) continue
    seen += 1
    if (seen !== options.index) continue
    picked = parsed
    break
  }
  if (picked === undefined) return { ok: false, refusal: FIXTURE_REFUSALS.noFrame(options.index, options.turnId) }
  const command = typeof picked.cmd === "string" ? picked.cmd : ""
  const output = typeof picked.output === "string" ? picked.output : ""
  if (command.length === 0 || output.length === 0) return { ok: false, refusal: FIXTURE_REFUSALS.noFrame(options.index, options.turnId) }
  let verdict: ToolVerdict | undefined
  if (picked.verdict !== undefined) {
    try {
      verdict = parseVerdict(picked.verdict, (reason) => { throw new Error(reason) })
    } catch (error) {
      return { ok: false, refusal: `رُفض: حكمٌ مشوَّه في الإطار — ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const hasExitMarker = /(?:انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\s*\d+\b/iu.test(output)
  if (verdict === undefined && !hasExitMarker) return { ok: false, refusal: FIXTURE_REFUSALS.frameWithoutJudgement }
  const truncated = output.length >= 500
  return buildAndWrite({
    common: options,
    id: options.id ?? `${safeTurnId(options.turnId)}/frame/${options.index}`,
    source: "frame",
    truncated,
    command,
    output,
    ...(verdict === undefined ? {} : { verdict }),
    ...(truncated ? { note: "مقطوع — الحكم من حقل verdict لا من نصّ الرمز" } : {}),
  })
}

// ---------------------------------------------------------------------------
// الجرد والتحقّق — ما يراه المشرف بلا تشغيل bun test
// ---------------------------------------------------------------------------

export const fixtureFilesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((name) => FIXTURE_FILE.test(name)).sort() : []

export interface LoadedFixtures {
  readonly records: readonly ReceiptFixture[]
  readonly files: readonly string[]
}

/** يحمّل كل `receipts-*.jsonl`؛ سطرٌ مشوَّه يرمي `FixtureFormatError` بموضعه. */
export function loadFixtures(dir: string): LoadedFixtures {
  const files = fixtureFilesIn(dir)
  const records: ReceiptFixture[] = []
  for (const name of files) {
    const path = join(dir, name)
    for (const record of parseFixtureJsonl(readFileSync(path, "utf8"), path)) records.push(record)
  }
  return Object.freeze({ records: Object.freeze(records), files: Object.freeze(files) })
}

export interface FixtureInventory {
  readonly total: number
  readonly byFamily: Readonly<Record<string, number>>
  readonly bySource: Readonly<Record<string, number>>
  readonly live: number
  readonly synthetic: number
  readonly uncoveredPlaybooks: readonly string[]
  readonly emptyFamilies: readonly string[]
}

/** جردٌ صادق: الحيّ (tap/frame/catalog) يُعدّ منفصلاً عن المصنوع. */
export function listFixtures(dir: string): FixtureInventory {
  const { records } = loadFixtures(dir)
  const byFamily: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const covered = new Set<string>()
  for (const record of records) {
    byFamily[record.family] = (byFamily[record.family] ?? 0) + 1
    bySource[record.source] = (bySource[record.source] ?? 0) + 1
    for (const id of record.expect.playbooks ?? []) covered.add(id)
  }
  return Object.freeze({
    total: records.length,
    byFamily: Object.freeze(byFamily),
    bySource: Object.freeze(bySource),
    live: records.filter((r) => r.source !== "synthetic").length,
    synthetic: records.filter((r) => r.source === "synthetic").length,
    uncoveredPlaybooks: Object.freeze(PLAYBOOKS.map((p) => p.id).filter((id) => !covered.has(id))),
    emptyFamilies: Object.freeze(FIXTURE_FAMILIES.filter((family) => (byFamily[family] ?? 0) === 0)),
  })
}

// ---------------------------------------------------------------------------
// أمر المشرف — النصوص هنا، وcli.ts يوصل لا غير
// ---------------------------------------------------------------------------

export interface FixtureCommandContext {
  readonly enabled: boolean
  readonly compiled: boolean
  readonly fixturesDir: string
  readonly stateRoot: string
  readonly captured?: string
}

const numberArg = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

const describeCapture = (result: CaptureResult): string => {
  if (!result.ok) return result.refusal
  const expect = result.record.expect
  return [
    `✓ سُجّل «${result.record.id}» في ${result.path}`,
    `المصدر=${result.record.source} · مقطوع=${result.record.truncated ? "نعم" : "لا"} · حُجب=${result.redactions}`,
    `الحكم المحسوب: فشل=${String(expect.failed)} · الطبقة=${String(expect.tier)} · كتيّبات=${(expect.playbooks ?? []).join("، ") || "—"} · جدار@${String(expect.wallAt)} · تعدين@${String(expect.minerAt)} · حقيقة=${expect.fact === null || expect.fact === undefined ? "—" : expect.fact.key}`,
    ...(result.note === undefined ? [] : [result.note]),
    "راجعه: `expect` محسوبٌ من الكواشف الحالية — إن كان الكاشف هو الخطأ فحرّر السطر بيدك.",
  ].join("\n")
}

/** ينفّذ `fixture …` ويعيد نصّاً للمشرف — لا يرمي، ويرفض بالاسم. */
export function runFixtureCommand(args: readonly string[], ctx: FixtureCommandContext): string {
  if (!ctx.enabled) return FIXTURE_REFUSALS.disabled
  const [sub, ...rest] = args.filter((a) => a.length > 0)
  if (sub === undefined) return FIXTURE_REFUSALS.usage
  if (sub === "list") {
    let inventory: FixtureInventory
    try {
      inventory = listFixtures(ctx.fixturesDir)
    } catch (error) {
      return error instanceof FixtureFormatError ? `رُفض: ${error.message}` : `رُفض: ${String(error)}`
    }
    if (inventory.total === 0) return FIXTURE_REFUSALS.noFixtures(ctx.fixturesDir)
    return [
      `سجلات الحوادث: ${inventory.total} (حيّ=${inventory.live} · مصنوع=${inventory.synthetic})`,
      `بالعائلة: ${Object.entries(inventory.byFamily).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
      `بالمصدر: ${Object.entries(inventory.bySource).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
      inventory.emptyFamilies.length === 0 ? "كل العائلات مغطّاة." : `عائلات بلا سجل: ${inventory.emptyFamilies.join("، ")}`,
      inventory.uncoveredPlaybooks.length === 0
        ? `كل كتيّبات السجلّ (${PLAYBOOKS.length}) لها سجلّ حادثة.`
        : `كتيّبات بلا سجل (${inventory.uncoveredPlaybooks.length}): ${inventory.uncoveredPlaybooks.join("، ")}`,
    ].join("\n")
  }
  if (sub === "verify") {
    let loaded: LoadedFixtures
    try {
      loaded = loadFixtures(ctx.fixturesDir)
    } catch (error) {
      return error instanceof FixtureFormatError ? `✗ ${error.message}` : `رُفض: ${String(error)}`
    }
    if (loaded.records.length === 0) return FIXTURE_REFUSALS.noFixtures(ctx.fixturesDir)
    const lines: string[] = []
    let passed = 0
    for (const record of loaded.records) {
      // عائلة المسارات تحتاج قرصاً مُهيّأً — تُتحقَّق في bun test لا هنا.
      if (record.expect.moduleHintContains !== undefined) continue
      const verdict = evaluateFixture(record)
      if (verdict.ok) passed += 1
      else lines.push(`✗ ${record.id}: ${verdict.diffs.join(" · ")}`)
    }
    const skipped = loaded.records.filter((r) => r.expect.moduleHintContains !== undefined).length
    const head = `${lines.length === 0 ? "✓" : "✗"} ${passed}/${loaded.records.length - skipped} سجلاً يطابق الكواشف الحالية (${loaded.files.length} ملفاً${skipped > 0 ? ` · ${skipped} مؤجَّلاً لقرص الاختبار` : ""})`
    return [head, ...lines].join("\n")
  }
  if (sub === "capture") {
    if (ctx.compiled) return FIXTURE_REFUSALS.compiled
    const flags = rest.filter((a) => a.startsWith("--"))
    const words = rest.filter((a) => !a.startsWith("--"))
    const force = flags.includes("--force")
    const idFlag = flags.find((f) => f.startsWith("--id="))?.slice("--id=".length)
    const repeatFlag = numberArg(flags.find((f) => f.startsWith("--repeat="))?.slice("--repeat=".length))
    const common = {
      fixturesDir: ctx.fixturesDir,
      force,
      ...(idFlag === undefined || idFlag.length === 0 ? {} : { id: idFlag }),
      ...(repeatFlag === undefined ? {} : { repeat: repeatFlag }),
      ...(ctx.captured === undefined ? {} : { captured: ctx.captured }),
    }
    const logIndex = rest.indexOf("--from-log")
    if (logIndex >= 0) {
      // `capture --from-log <ملف> <turnId> <index> <family> [حادثة…]`
      const logPath = rest[logIndex + 1]
      const tail = words.filter((w) => w !== logPath)
      const [turnId, indexText, family, ...incident] = tail
      const index = numberArg(indexText)
      if (logPath === undefined || turnId === undefined || index === undefined || family === undefined) return FIXTURE_REFUSALS.usage
      return describeCapture(captureFromFrameLog({
        ...common,
        logPath,
        turnId,
        index,
        family,
        ...(incident.length === 0 ? {} : { incident: incident.join(" ") }),
      }))
    }
    const [turnId, seqText, family, ...incident] = words
    const seq = numberArg(seqText)
    if (turnId === undefined || seq === undefined || family === undefined) return FIXTURE_REFUSALS.usage
    return describeCapture(captureFromTap({
      ...common,
      stateRoot: ctx.stateRoot,
      turnId,
      seq,
      family,
      ...(incident.length === 0 ? {} : { incident: incident.join(" ") }),
    }))
  }
  return FIXTURE_REFUSALS.usage
}
