/**
 * 10-01 — «سقفُ الجودة» Q3/Q2: فحصُ الإصدار كما يفعله المشرف بيده، أداةً واحدة.
 *
 * مقيس: «كلُّ السبرنتات الأربعة عشر مغلقة» بأدلّةٍ مقيسة، ثمّ قاس المشرفُ بنفسه — `npm run build` **يفشل** (خطأُ نوع)، والاختبارُ لا يمرّ إلا وخادمٌ
 * يعمل، والصفحاتُ ردّت 200 على خادم dev الذي لا يفحص الأنواع. فصارت أدواتُ المراجع أدواتٍ في المنتَج.
 * الأداةُ مركّبةٌ من أدوات المحرّك نفسِها (run، الخادم المُدار، probe، stop) عبر المُوزِّع الواحد — لا تنفيذٌ موازٍ. هذه الوحدةُ نصفُها النقيّ:
 * فحصُ حزمة العميل بحثاً عن أسرار (بكاشف المحرّك نفسِه `inboundSecretSpans`)، وحكمُ رؤوس الأمان، وعرضُ المراحل والحكم.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { inboundSecretSpans } from "./secret-command-guard"

export interface StageResult {
  readonly stage: string
  readonly ok: boolean
  /** تحذيرٌ لا يحجب (رؤوسُ أمانٍ ناقصة مثلاً). */
  readonly warn?: boolean
  readonly detail: string
}

/** ملفّاتُ حزمة العميل التي يخدمها Next.js بلا مصادقة (`/_next/static`). */
export function clientBundleFiles(projectDir: string, distDir = ".next", cap = 4000): string[] {
  const root = join(projectDir, distDir, "static")
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (out.length >= cap) return
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (isDir) walk(full)
      else if (/\.(?:js|mjs|json|map)$/u.test(name)) out.push(full)
    }
  }
  walk(root)
  return out
}

const BUNDLE_SECRET_KINDS = new Set(["api-key", "bearer-token", "connection-string"])

/** أسرارٌ في حزمة العميل — كلُّ موضعٍ باسم ملفّه ونوعِ هيئته، **بلا القيمة**. */
export function clientBundleSecrets(projectDir: string, distDir = ".next"): string[] {
  const hits: string[] = []
  for (const file of clientBundleFiles(projectDir, distDir)) {
    let text = ""
    try { text = readFileSync(file, "utf-8") } catch { continue }
    // الهيئاتُ الدقيقة وحدها: الكاشفُ مضبوطٌ على الرسائل الواردة (عدوانيّ)، وفي شيفرةٍ مصغَّرة يعدّ كلَّ base64 طويلٍ «اعتماداً مرمَّزاً» وكلَّ
    // «password» نصّاً كلمةَ مرور (قيس على حزمة الموقع: 20 إصابةً كلُّها من هذين). مفاتيحُ المزوّدين وحاملُ الرمز وسلسلةُ الاتصال تبقى.
    // ومقيسٌ ثانياً: واجهةٌ تعرض بادئاتِ مفاتيحَ مقنَّعة («sk-or-…» 15 حرفاً) ومطابقةٌ امتدّت 222 حرفاً من الشيفرة. المفتاحُ الحقيقيّ قطعةٌ واحدة
    // بلا فراغٍ ولا اقتباسٍ ولا فاصلة، بين 20 حرفاً (AKIA) و200.
    for (const span of inboundSecretSpans(text).filter((s) => BUNDLE_SECRET_KINDS.has(s.kind) && s.length >= 20 && s.length <= 200 && !/[\s"',]/u.test(text.slice(s.start, s.start + s.length)))) {
      hits.push(`${relative(projectDir, file).replace(/\\/gu, "/")} — ${span.kind}`)
      if (hits.length >= 20) return hits
    }
  }
  return hits
}

/** رؤوسُ الأمان على صفحةٍ من خادم الإنتاج — الناقصُ يُسمّى (تحذيرٌ حتى تُقرَّر مجموعةٌ موحّدة). */
export function securityHeaderGaps(headers: Headers | Record<string, string>): string[] {
  const get = (name: string): string => (headers instanceof Headers ? headers.get(name) : Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]) ?? ""
  const gaps: string[] = []
  const csp = get("content-security-policy")
  if (csp === "") gaps.push("Content-Security-Policy غائب")
  else if (/'unsafe-eval'/u.test(csp)) gaps.push("CSP يسمح بـ'unsafe-eval' في الإنتاج")
  if (!/frame-ancestors/u.test(csp) && get("x-frame-options") === "") gaps.push("لا frame-ancestors ولا X-Frame-Options (تضمينُ الصفحة في إطارٍ غريب)")
  if (get("x-content-type-options").toLowerCase() !== "nosniff") gaps.push("X-Content-Type-Options: nosniff غائب")
  if (get("referrer-policy") === "") gaps.push("Referrer-Policy غائب")
  if (get("x-powered-by") !== "") gaps.push(`X-Powered-By مكشوف (${get("x-powered-by")}) — poweredByHeader: false`)
  return gaps
}

export function renderReleaseCheck(stages: readonly StageResult[]): { readonly passed: boolean; readonly text: string } {
  const passed = stages.every((s) => s.ok || s.warn === true)
  const lines = stages.map((s) => `${s.ok ? "✓" : s.warn === true ? "△" : "✕"} ${s.stage}: ${s.detail}`)
  return { passed, text: [`release-check: ${passed ? "PASS" : "FAIL"} — ${stages.filter((s) => s.ok).length}/${stages.length} مرحلة`, ...lines].join("\n") }
}
