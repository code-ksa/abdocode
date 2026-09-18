/** S1 — وعي الدور: ما قُرئ وما كُتب، حاضرٌ في كل حقبة.
 *
 * تاريخ الحقب يُقصّ عند حدّه فتسقط القراءات القديمة من السياق، فيعيد
 * النموذج قراءة الملفات نفسها كل حقبة (قيس حيّاً: 259 أداة في 64 حقبة
 * أغلبها إعادة اكتشاف). هذه الوحدة تحفظ خلاصة الإيصالات — لا نصوصها —
 * وتحقنها سطراً مضغوطاً في تعليمة كل حقبة، فتحلّ المعرفة محلّ إعادة
 * القراءة من غير أن تمنعها: النموذج يبقى حرّاً في القراءة إن احتاج.
 *
 * التسجيل من الإيصالات المنفَّذة وحدها (أمرٌ ونتيجة)، لا من نيّة النموذج:
 * أداة اقتُرحت ورُفضت لا تدخل الوعي.
 */

import { ProjectIndex, TIER_ORDER, type SearchResult } from "@abdo/project-index"

export interface ReadRecord {
  readonly digest: string
  readonly epoch: number
  readonly times: number
}

// المفتاح هو ذيل القراءة كلّه (ملفٌ ثم حتى رقمَي سطر) لا المسار وحده:
// «read a.ts 1 20» و«read a.ts 21 40» مقطعان مختلفان لا قراءتان مكرّرتان،
// وإلا أوصى الموجز بعد مقطعَين بألّا يُقرأ الثالث — نقيض قاعدة القراءة بمقطع.
const READ_RECEIPT = /^read\s+(\S+(?:\s+\d+){0,2})/u
const DIGEST_IN_OUTPUT = /بصمة المحتوى ([a-f0-9]{8,64})/u
const WRITE_RECEIPT = /^(write|edit)\s+(\S+)/u

export class TurnAwareness {
  #reads = new Map<string, ReadRecord>()
  #writes = new Map<string, number>()
  #limit: number

  constructor(limit = 200) {
    this.#limit = Math.max(10, limit)
  }

  /** يُغذّى من onToolResult: الأمر كما نُفّذ ونصّ إيصاله. */
  observe(command: string, output: string, epoch: number): void {
    const read = READ_RECEIPT.exec(command.trim())
    if (read !== null) {
      const digest = DIGEST_IN_OUTPUT.exec(output)?.[1]
      // قراءة فاشلة (ملف غائب) لا تدخل الدفتر — الغياب ليس معرفة تدوم.
      if (digest === undefined) return
      const key = read[1].replace(/\s+/gu, " ")
      const prior = this.#reads.get(key)
      if (this.#reads.size >= this.#limit && prior === undefined) return
      this.#reads.set(key, {
        digest,
        epoch,
        times: (prior?.times ?? 0) + 1,
      })
      return
    }
    const write = WRITE_RECEIPT.exec(command.trim())
    if (write !== null) {
      if (this.#writes.size >= this.#limit && !this.#writes.has(write[2])) return
      this.#writes.set(write[2], epoch)
      // كتابة ملفٍ تبطل صلاحية قراءته السابقة: بصمته تغيّرت حتماً — الملفّ
      // كاملاً وكلّ مقاطعه (مفاتيحها «<ملف> <من> [إلى]»).
      const prefix = `${write[2]} `
      for (const key of [...this.#reads.keys()]) {
        if (key === write[2] || key.startsWith(prefix)) this.#reads.delete(key)
      }
    }
  }

  repeatedReads(): readonly string[] {
    return [...this.#reads.entries()].filter(([, r]) => r.times > 1).map(([file]) => file)
  }

  /** سطر الوعي المحقون في تعليمة الحقبة — مضغوط ومسقوف. */
  brief(maxChars = 900): string {
    if (this.#reads.size === 0 && this.#writes.size === 0) return ""
    const reads = [...this.#reads.entries()]
      .sort((a, b) => b[1].epoch - a[1].epoch)
      .map(([file, r]) => (r.times > 1 ? `${file} (قُرئ ${r.times} مرات — لم يتغيّر)` : file))
    const writes = [...this.#writes.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file)
    let text = "ما تعرفه من إيصالات هذا الدور — لا تعِد قراءة ما لم يتغيّر:\n"
    if (writes.length > 0) text += `كتبتَ: ${writes.join("، ")}\n`
    if (reads.length > 0) text += `قرأتَ: ${reads.join("، ")}\n`
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…\n`
    return text
  }
}

/**
 * خريطة مشروع باردة تُبنى مرة عند قبول الدور — حتمية، من القرص لا من
 * النموذج، ومسقوفة. تعطي النموذج شكل المشروع قبل أول فعل بدل حِقب
 * الاستكشاف اليدوي (list/read متتالية قيست في كل جولة تأهيل).
 */
export async function projectMap(projectDir: string, maxFiles = 80, goal?: string): Promise<string> {
  const manifests: string[] = []
  const sources: string[] = []
  // أنماط بسيطة لا متداخلة: Bun.Glob لا يفكّ الأقواس داخل الأقواس،
  // والنمط الواحد المتداخل كان يعيد صفر ملفات بصمت (قيس في اختبار S1).
  const MANIFEST_PATTERNS = ["package.json", "tsconfig.json", "next.config.*", "Cargo.toml", "pyproject.toml"]
  const SOURCE_PATTERNS = ["*.md", "app/**/*.{ts,tsx,js,jsx}", "src/**/*.{ts,tsx,js,jsx}", "lib/**/*.{ts,tsx}", "pages/**/*.{ts,tsx,js,jsx}"]
  const seen = new Set<string>()
  const collect = async (patterns: readonly string[], sink: string[]) => {
    for (const pattern of patterns) {
      for await (const file of new Bun.Glob(pattern).scan({ cwd: projectDir, onlyFiles: true })) {
        const clean = file.replace(/\\/g, "/")
        if (seen.has(clean) || /node_modules|\.next\/|dist\/|build\//.test(clean)) continue
        seen.add(clean)
        sink.push(clean)
        if (seen.size >= maxFiles) return
      }
    }
  }
  await collect(MANIFEST_PATTERNS, manifests)
  if (seen.size < maxFiles) await collect(SOURCE_PATTERNS, sources)
  if (manifests.length + sources.length === 0) return ""
  // 09-16 — الخريطةُ قائمةٌ مسقوفة؛ والفهرسُ يُسأل عن الهدف فيُحقن الأقربُ إليه قبل الحقبة الأولى
  // بدل أن يكتشفه النموذجُ بـlist/read متتالية. فشلُ الفهرسة لا يُسقط الخريطة.
  const nearest = goal === undefined || goal.trim().length === 0 ? "" : await nearestToGoal(projectDir, goal).catch(() => "")
  return (
    "خريطة المشروع (مقيسة من القرص الآن — هذه الملفات الموجودة فعلاً، لا تخمّن غيرها):\n" +
    (manifests.length > 0 ? `المانيفستات: ${manifests.sort().join("، ")}\n` : "") +
    (sources.length > 0 ? `المصدر: ${sources.sort().join("، ")}\n` : "") +
    nearest
  )
}

/** سقوفُ الفهرس: ملفّاتٌ أكثر من قائمة الخريطة (القائمةُ تُقرأ، والفهرسُ يُسأل) وبحجمٍ لا يبتلع الذاكرة. */
export const INDEX_MAX_FILES = 400
export const INDEX_MAX_FILE_BYTES = 64_000
export const INDEX_MAX_HITS = 12
const INDEX_PATTERN = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,php,kt,java,cs,rb,vue,svelte,md}"
const SKIP_DIR = /(?:^|\/)(?:node_modules|\.next|dist|build|target|\.git|coverage|\.turbo|vendor)\//u
const goalTokens = (goal: string): string[] => goal.match(/[\p{L}\p{N}_.-]{3,}/gu) ?? []

/**
 * الأقربُ للهدف من فهرس المشروع (@abdo/project-index — مسارٌ ثمّ رمزٌ ثمّ نصّ): كلماتُ الهدف
 * تُسأل مساراً ورمزاً، والهدفُ كلُّه نصّاً. حتميٌّ من القرص ومسقوف؛ غيابُ الإصابة فراغٌ لا تخمين.
 */
export async function nearestToGoal(projectDir: string, goal: string, maxFiles = INDEX_MAX_FILES): Promise<string> {
  const index = new ProjectIndex()
  let indexed = 0
  for await (const file of new Bun.Glob(INDEX_PATTERN).scan({ cwd: projectDir, onlyFiles: true })) {
    const clean = file.replace(/\\/g, "/")
    if (SKIP_DIR.test(clean)) continue
    const blob = Bun.file(`${projectDir}/${clean}`)
    if (blob.size > INDEX_MAX_FILE_BYTES) continue
    index.upsert(clean, await blob.text())
    indexed += 1
    if (indexed >= maxFiles) break
  }
  if (indexed === 0) return ""
  const best = new Map<string, SearchResult>()
  const add = (hit: SearchResult): void => {
    const prior = best.get(hit.path)
    if (prior === undefined || TIER_ORDER[hit.tier] < TIER_ORDER[prior.tier] || (hit.tier === prior.tier && hit.score > prior.score)) best.set(hit.path, hit)
  }
  for (const token of goalTokens(goal)) {
    for (const path of index.lookupPath(token)) add({ path, tier: "path", score: 1 })
    for (const hit of index.lookupSymbol(token)) add(hit)
  }
  for (const hit of index.fullText(goal)) add(hit)
  const hits = [...best.values()].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score).slice(0, INDEX_MAX_HITS)
  if (hits.length === 0) return ""
  const lines = hits.map((hit) => `${hit.path}${hit.symbol === undefined ? "" : ` (${hit.symbol.kind} ${hit.symbol.name})`} [${hit.tier}]`)
  return `الأقرب للهدف من فهرس المشروع (${indexed} ملفاً مفهرساً؛ مسارٌ ثمّ رمزٌ ثمّ نصّ): ${lines.join("، ")}\n`
}
