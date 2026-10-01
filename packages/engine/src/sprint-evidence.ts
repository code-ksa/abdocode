/**
 * 09-30 — مقيس على مهمّة OpenRouter (المصدر، بعد 4.0.99): أُغلق «Sprint 0» بدليلٍ نصُّه
 * «npm run build passes, npm test passes, page / renders with Header and Hero sections» — البناءُ والاختبارُ قيسا حقّاً،
 * أمّا «الصفحة تعرض الرأس والبطل» فلم يُفتح لها probe ولا page ولا shot بعد آخر تعديل: ادّعاءٌ مرّ لأنّ `sprint done` يكتفي بطول النصّ.
 * ساعةُ دليلٍ صغيرة: متى قيست صفحةٌ آخرَ مرّة، ومتى عُدّلت شيفرةٌ آخرَ مرّة. دليلٌ يذكر عرضَ صفحةٍ بلا قياسٍ بعد آخر تعديل يُرفض
 * ويُسمّى الإيصالُ الناقص؛ ودليلٌ لا يدّعي صفحةً (build/test وحدهما) يمرّ كما كان.
 *
 * 10-01 — قيس المشرفُ بنفسه بعد «كلُّ السبرنتات مغلقة»: `npm run build` **يفشل** (خطأُ نوعٍ في src/app/apps/page.tsx كتبه Sprint 12).
 * دليلُ Sprint 12 «أنشأنا صفحات /ori و/docs و/pricing… مكتملة» لا يسمّي قياساً فمرّ؛ وSprint 13 قاس بـprobe على خادم dev — وهو لا يفحص
 * الأنواع — فردّت الصفحاتُ 200 والبناءُ مكسور. الآن لكلّ ادّعاءٍ قياسُه: البناءُ بإيصال بناءٍ ناجحٍ بعد آخر تعديل، والاختبارُ باختبارٍ ناجح،
 * والصفحةُ بقياس صفحة؛ ودليلٌ لا يسمّي قياساً قطّ يُرفض.
 *
 * 10-01 (Q4 من «سقف الجودة») — مقيس على موقعٍ بناه الوكيل: القائمةُ الجوّاليّة
 * تتراكب بلا خلفيّة وشريطَ تمريرٍ أفقيّاً في موقعٍ «كلُّ سبرنتاته مغلقة». في مشروع ويب، سبرنتٌ عدّل واجهةً لا يُغلق حتى يمرّ `audit`
 * (فيضان، تراكب، روابط، وصول — على خمسة عروض) **بعد آخر تعديلٍ للواجهة** — PASS لا مجرّدُ تشغيل.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { editsCode } from "./verify-after-edit"

export interface EvidenceClock {
  pageAt: number
  codeAt: number
  buildAt: number
  testAt: number
  /** آخرُ تعديلٍ لملفّ واجهة (tsx/jsx/css/html/vue/svelte/astro). */
  uiAt: number
  /** آخرُ audit حكمُه PASS. */
  auditAt: number
  /** آخرُ audit حكمُه FAIL — يُسمّى في الرفض. */
  auditFailAt: number
  /** 10-01 — آخرُ قراءةٍ لملفٍّ ناتجٍ غير شيفرة (md/txt/json/csv/pdf/docx…): قياسُ سبرنتٍ ناتجُه مستند. */
  docAt?: number
  /** آخرُ كتابةٍ لملفٍّ ناتجٍ غير شيفرة — القراءةُ قبلها لا تقيسه. */
  docWriteAt?: number
}

export const newEvidenceClock = (): EvidenceClock => ({ pageAt: 0, codeAt: 0, buildAt: 0, testAt: 0, uiAt: 0, auditAt: 0, auditFailAt: 0, docAt: 0, docWriteAt: 0 })

/** ملفٌّ ناتجٌ غيرُ شيفرة: قراءتُه بعد آخر تعديلٍ قياسٌ له. html خارجها — صفحةٌ تُقاس بـprobe/audit. */
const DOC_FILE = /\.(?:md|markdown|txt|json|csv|tsv|ya?ml|pdf|docx|pptx|xlsx)$/iu

/** تعديلٌ يمسّ الواجهة: المسارُ في سطر الأداة ينتهي بامتداد واجهة. */
const UI_FILE = /(?:^|\s)\S+\.(?:tsx|jsx|css|scss|sass|less|html|vue|svelte|astro|mdx)(?=\s|$|:)/iu

const PAGE_TOOLS = new Set(["probe", "page", "shot", "look"])
const BUILD_RUN = /^run\s+(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|npx\s+next\s+build|next\s+build)\b/iu
const TEST_RUN = /^run\s+(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|node\s+--test|npx\s+(?:vitest\s+run|jest)|(?:python3?\s+-m\s+)?pytest|cargo\s+test)\b/iu
export const BUILD_FAILED = /Failed to compile|Build error occurred|Type error:|error TS\d+|ELIFECYCLE|exited with code [1-9]|انتهى الأمر برمز [1-9]/iu
export const TEST_FAILED = /(?:ℹ\s+fail\s+[1-9]|\b[1-9]\d*\s+fail(?:ed|ing)?\b|not ok\s+\d|Tests?:\s+\d+\s+failed|ELIFECYCLE|انتهى الأمر برمز [1-9])/iu

/** يسجّل إيصالاً: قياسُ صفحة، أو بناءٌ/اختبارٌ ناجح (يُقرأ خرجُه)، أو تعديلُ شيفرة. `command` سطرُ الأداة كما نُفّذ. */
export function noteEvidence(clock: EvidenceClock, command: string, ok: boolean, now = Date.now(), output = ""): void {
  if (!ok) return
  const line = command.trim()
  const word = line.split(/\s+/u, 1)[0]?.toLowerCase() ?? ""
  const target = line.split(/\s+/u, 3)[1] ?? ""
  if (word === "read" && DOC_FILE.test(target)) clock.docAt = now
  else if ((word === "write" || word === "edit") && DOC_FILE.test(target)) clock.docWriteAt = now
  if (PAGE_TOOLS.has(word)) clock.pageAt = now
  else if (word === "audit") {
    // الحكمُ من رأس التقرير — «audit: PASS» وحده يحسب؛ والتشغيلُ الذي فشل يُسجَّل ليُسمّى.
    if (/^audit: PASS\b/mu.test(output)) { clock.auditAt = now; clock.pageAt = now }
    else if (/^audit: FAIL\b/mu.test(output)) clock.auditFailAt = now
  }
  else if (BUILD_RUN.test(line)) { if (!BUILD_FAILED.test(output)) clock.buildAt = now }
  else if (TEST_RUN.test(line)) { if (!TEST_FAILED.test(output)) clock.testAt = now }
  else if (editsCode(line)) { clock.codeAt = now; if (UI_FILE.test(line.split("\n", 1)[0] ?? "")) clock.uiAt = now }
}

/**
 * ساعةُ الواجهة تعبر العمليّات: كلُّ «اكمل» محرّكٌ جديد، ودورٌ عدّل الواجهةَ ثمّ خرج كان يترك الدورَ التالي يُغلق السبرنتَ بلا audit
 * (الساعةُ في الذاكرة تبدأ صفراً). تُحفظ uiAt وauditAt وauditFailAt لكلّ مشروع في حالة المحرّك، ويُؤخذ الأحدثُ من الاثنين.
 */
export function readUiClock(file: string): Pick<EvidenceClock, "uiAt" | "auditAt" | "auditFailAt"> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>
    const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0)
    return { uiAt: n(v.uiAt), auditAt: n(v.auditAt), auditFailAt: n(v.auditFailAt) }
  } catch { return undefined }
}

export function writeUiClock(file: string, clock: EvidenceClock): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ uiAt: clock.uiAt, auditAt: clock.auditAt, auditFailAt: clock.auditFailAt }))
    renameSync(tmp, file)
  } catch { /* الحفظُ مساعِد — الساعةُ في الذاكرة تبقى حاكمةً للعمليّة الجارية */ }
}

export function mergeUiClock(clock: EvidenceClock, saved: Pick<EvidenceClock, "uiAt" | "auditAt" | "auditFailAt"> | undefined): void {
  if (saved === undefined) return
  clock.uiAt = Math.max(clock.uiAt, saved.uiAt)
  clock.auditAt = Math.max(clock.auditAt, saved.auditAt)
  clock.auditFailAt = Math.max(clock.auditFailAt, saved.auditFailAt)
}

/** دليلٌ يدّعي عرضَ صفحةٍ أو ردَّها — بالعربيّة أو الإنجليزيّة. */
const PAGE_CLAIM = /(?:\bpage\s*\/|\brenders?\b|\bshows?\b|\bdisplays?\b|\bvisible\b|\bprobe\b|\bshot\b|\bscreenshot\b|\bHTTP\s*200\b|\b200\s*OK\b|(?:^|\s)\/[a-z][\w/-]*\s+(?:→|=>|->)?\s*200\b|\breturn\s+200\b|تظهر|يظهر|تعرض|يعرض|تُعرض|ظاهر|الصفحة\s+ترد|ترد\s+200)/iu
const BUILD_CLAIM = /(?:\bbuild\b|\bcompiled?\b|بناء|البناء|يبني)/iu
const TEST_CLAIM = /(?:\btests?\b|\bnpm\s+test\b|اختبار|الاختبار|الاختبارات)/iu
/** 10-01 — مقيس: سبرنتٌ ناتجُه welcome.md رُفض 25 مرّةً والدليلُ «read welcome.md ✓ — يذكر 4 شرائح» صحيح: لم يكن للمستند صنفٌ من القياس. */
const DOC_CLAIM = /\bread\s+[^\s`'"]+\.(?:md|markdown|txt|json|csv|tsv|ya?ml|pdf|docx|pptx|xlsx)\b/iu

/** سببُ رفض إغلاق السبرنت، أو `undefined` حين يُقبل الدليل. */
export function sprintEvidenceRefusal(evidence: string, clock: EvidenceClock, options: { readonly web?: boolean } = {}): string | undefined {
  const claims = { page: PAGE_CLAIM.test(evidence), build: BUILD_CLAIM.test(evidence), test: TEST_CLAIM.test(evidence), doc: DOC_CLAIM.test(evidence) }
  if (!claims.page && !claims.build && !claims.test && !claims.doc)
    return "رُفض إغلاقُ السبرنت: الدليلُ لا يسمّي قياساً — اذكر ما شغّلتَ ونتيجتَه بعد آخر تعديل (npm run build ✓، npm test ✓، probe <المسار> 200، أو read <الملفّ الناتج> لمستندٍ غير شيفرة…) ثمّ أعد sprint done."
  const stale = (at: number) => at === 0 || at < clock.codeAt
  if (claims.page && stale(clock.pageAt)) {
    const why = clock.pageAt === 0 ? "لم تُقَس أيُّ صفحةٍ في هذه الجلسة" : "آخرُ قياسٍ لصفحةٍ سبق آخرَ تعديلٍ للشيفرة"
    return `رُفض إغلاقُ السبرنت: الدليلُ يدّعي عرضَ صفحة و${why}. قِسها الآن — probe <المسار> (الردّ) أو page/shot على الصفحة (العناصر) — ثمّ أعد sprint done بما قيس.`
  }
  if (claims.doc && !claims.page && !claims.build && !claims.test) {
    const docAt = clock.docAt ?? 0
    if (docAt === 0 || docAt < clock.codeAt || docAt < (clock.docWriteAt ?? 0))
      return "رُفض إغلاقُ السبرنت: الدليلُ يقيس مستنداً ناتجاً ولا قراءةَ له بعد آخر كتابة — اقرأه الآن (read <الملفّ>) ثمّ أعد sprint done بما فيه."
  }
  if (claims.build && stale(clock.buildAt))
    return "رُفض إغلاقُ السبرنت: الدليلُ يدّعي نجاحَ البناء ولا بناءَ ناجحاً بعد آخر تعديلٍ للشيفرة — شغّل npm run build الآن (خادمُ dev لا يفحص الأنواع)، وأصلح ما يكسره، ثمّ أعد sprint done."
  if (claims.test && stale(clock.testAt))
    return "رُفض إغلاقُ السبرنت: الدليلُ يدّعي نجاحَ الاختبارات ولا تشغيلَ ناجحاً لها بعد آخر تعديلٍ للشيفرة — شغّلها الآن (وإن احتاجت خادماً فشغّله أوّلاً)، ثمّ أعد sprint done."
  if (options.web === true && clock.uiAt > 0 && clock.auditAt < clock.uiAt) {
    const failed = clock.auditFailAt >= clock.uiAt
    return `رُفض إغلاقُ السبرنت: عدّلتَ الواجهةَ ${failed ? "وآخرُ audit بعد التعديل حكمُه FAIL" : "ولم يمرّ audit بعد آخر تعديلٍ لها"} — شغّل الخادمَ (run --bg npm run start أو dev) ثمّ audit على المسارات التي مسستَها، وأصلح كلَّ ✕ (فيضانٌ أفقيّ، تراكبٌ، روابطُ مكسورة، أزرارٌ بلا اسم) حتى «audit: PASS»، ثمّ أعد sprint done.`
  }
  return undefined
}
