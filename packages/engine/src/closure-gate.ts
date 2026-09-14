/** S10 — بوابة الإقفال: قبولٌ لا يُخدَع.
 *
 * كتالوج 8.6 و1.5: اختبارٌ أخضر يزيّف القاعدة فلا يقيس شيئاً («11/11»
 * بالـmocking)، وفحص صحةٍ يرد 200 والقاعدة ساقطة (KF-25). هذه الوحدة
 * تكشف الصنفين قبل الإعلان: اختبارٌ يستبدل القاعدة كلها بوهمٍ يُوسم، وفحص
 * HTTP بلا دليل بيانات لا يُعتدّ به قبولاً.
 */

import type { ToolVerdict } from "@abdo/engine-host"
import { receiptSucceeded } from "./failure-tiering"

const clean = (s: string) => s.replace(/\s+/g, " ").trim()

/**
 * يفحص ملفّ اختبارٍ: هل يقيس الشيفرة الحقيقية أم يستبدلها بوهمٍ كامل؟
 * ليس رفضاً لكلّ mock — الوهم المشروع يعزل حدوداً خارجية؛ المرفوض أن
 * تُستبدل الوحدةُ محلّ الاختبار نفسها بوهمٍ فلا يبقى ما يُقاس.
 */
export function mockedAwayViolation(target: string, source: string): string | undefined {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(target)) return undefined
  const src = clean(source)
  // الوحدة تحت الاختبار: أقرب استيرادٍ نسبيّ (./ ../) — لا مكتبةٌ خارجية.
  const under = new Set<string>()
  for (const m of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    under.add(m[1].replace(/\.[cm]?[jt]sx?$/i, "").split("/").pop() ?? "")
  }
  // vi.mock/jest.mock على وحدةٍ نسبيّة (الشيفرة نفسها) لا خارجية.
  for (const m of source.matchAll(/(?:vi|jest)\.mock\(\s*["'](\.[^"']+)["']/g)) {
    const name = m[1].replace(/\.[cm]?[jt]sx?$/i, "").split("/").pop() ?? ""
    if (under.has(name)) {
      return `اختبارٌ يستبدل الوحدة تحت الاختبار «${name}» بوهمٍ كامل (mock على استيرادٍ نسبيّ) — فلا يقيس الشيفرة الحقيقية («11/11» كاذبة). ابنِ الحقيقيّ (قاعدةٌ مؤقتة/ملف tmp) واختبر سلوكه.`
    }
  }
  // مؤشر آخر: اختبارٌ بلا أيّ expect حقيقيّ على ناتج الوحدة.
  const hasExpect = /\bexpect\s*\(/.test(src)
  const hasAssertion = /toBe|toEqual|toContain|toThrow|toHaveBeen|toMatch|resolves|rejects/.test(src)
  if (hasExpect && !hasAssertion) {
    return "اختبارٌ يستدعي expect بلا مطابقةٍ فعلية (toBe/toEqual/...) — لا يفشل مهما كسرت الشيفرة."
  }
  return undefined
}

/** صنف «النسخة المحلية»: اختبارٌ يعيد تعريف الوحدة داخل ملفه فيختبر
 * نسخته لا المصدر الحقيقي — أخضر أبداً مهما كُسر المصدر. وقع مرتين في
 * ليلة واحدة (Kotlin نسخ object كاملاً، وSQL تجاهل ملف الاستعلامات).
 * الكشف: تصريحٌ في ملف اختبار (object/class/fun/def/function) يحمل اسم
 * تصريحٍ قائمٍ في مصدرٍ شقيق (الجذر أو src/) — يُرَدّ قبل الكتابة.
 */
export function localCopyInTestViolation(target: string, source: string, projectDir: string): string | undefined {
  const t = target.replaceAll("\\", "/").toLowerCase()
  if (!/(?:^|\/)(?:test[^/]*|[^/]*_test|[^/]*\.test)\.(?:kt|py|php)$/u.test(t)) return undefined
  const declPattern = /\b(?:object|class)\s+([A-Z]\w+)|\bfun\s+(\w+)\s*\(|\bdef\s+(\w+)\s*\(|\bfunction\s+(\w+)\s*\(/gu
  const testDecls = new Set<string>()
  for (const m of source.matchAll(declPattern)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (name !== undefined && name !== "main" && name !== "check") testDecls.add(name)
  }
  if (testDecls.size === 0) return undefined
  const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs")
  const { join } = require("node:path") as typeof import("node:path")
  const candidates: string[] = []
  for (const dir of [projectDir, join(projectDir, "src")]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const lower = entry.toLowerCase()
      if (!/\.(?:kt|py|php)$/u.test(lower)) continue
      if (/(?:^|\b)(?:test|_test)/u.test(lower)) continue
      try { if (statSync(full).isFile() && statSync(full).size < 256_000) candidates.push(full) } catch { /* تخطَّ ما لا يُقرأ */ }
    }
  }
  for (const file of candidates) {
    let text: string
    try { text = readFileSync(file, "utf-8") } catch { continue }
    for (const m of text.matchAll(declPattern)) {
      const name = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (name !== undefined && testDecls.has(name)) {
        return `ملف الاختبار يعيد تعريف «${name}» المعرَّفة في ${file.split(/[\\/]/u).pop()} — فيختبر نسخته المحلية لا المصدر الحقيقي. احذف النسخة من الاختبار واستدعِ الوحدة الأصلية مباشرة.`
      }
    }
  }
  return undefined
}

/** كتالوج 15.x — بوابة رمز الخروج الصامتة: هدفٌ ينصّ «يطبع fib(7)=13»
 * سلّمه النموذج بمحمّلٍ يخرج 0 بلا طباعة، ورضيت البوابة برمز الخروج وحده.
 * هنا يُستخرج «دليل الخرج» المعلَن في نص الهدف: سطر `دليل الخرج: X`
 * الصريح، أو ادّعاء «يطبع/تطبع/prints X» الملازم لأمر تشغيل. الاستخراج
 * حرفيّ متحفّظ — ما يُقتبس من الهدف يجب أن يكون حرفياً صالحاً (ملحق ٢٩).
 */
// يقصّ الغلاف حتى الثبات: علامات اقتباسٍ وترقيمٌ متداخلا الترتيب
// («X». أو "X"، أو `X`;) — قصّةٌ واحدة لا تكفي، فالحلقة حتى لا تغيّر.
const stripWrapping = (s: string): string => {
  let value = clean(s)
  for (;;) {
    const next = value.replace(/^["'«»`]+/u, "").replace(/["'«»`.。؛،;,!]+$/u, "").trim()
    if (next === value) return value
    value = next
  }
}

export function declaredOutputEvidence(goal: string): string[] {
  const evidence: string[] = []
  for (const m of goal.matchAll(/دليل الخرج\s*[::]\s*([^\n،؛;]+)/gu)) {
    const item = stripWrapping(m[1] ?? "")
    if (item.length > 0) evidence.push(item)
  }
  // ⚠️ فخ مدفوع: \b في JS لا يطابق العربية (ليست \w) — الحدود بـ\p{L}.
  // السوابق العربية تُغطّى (ويطبع/فيطبع/سيطبع/ستطبع/وسيطبع…) — الصيغة
  // الطبيعية للهدف العربي تحمل واو العطف والسين، وبوابةٌ لا تتسلح عليها
  // بوابةٌ نائمة (المسح العدائي 2026-09-01).
  // الادّعاء الضمني يُلزم فقط بحمولته الحرفية: المقتبس يؤخذ نصّه، وغير
  // المقتبس يؤخذ منه أول رمزٍ يحمل رقماً/مساواة — لا الجملة كلها. الوصف
  // الإنشائي («يطبع رسالة استخدام») ليس دليل خرج (درس القفل الذاتي 15.y).
  for (const m of goal.matchAll(/(?:(?<!\p{L})[وف]?س?[يت]طبع(?!\p{L})|\bprints?\b)\s+([^\n،؛;]+)/gu)) {
    const raw = (m[1] ?? "").trim()
    const quoted = raw.match(/^["'«`]([^"'«»`]+)["'»`]/u)
    if (quoted !== null) {
      const item = clean(quoted[1] ?? "")
      if (item.length > 0) evidence.push(item)
      continue
    }
    const token = raw.split(/\s+/u).find((t) => /[0-9٠-٩=]/u.test(t))
    if (token === undefined) continue
    const item = stripWrapping(token)
    if (item.length > 0) evidence.push(item)
  }
  return [...new Set(evidence)]
}

// أوامر قراءةٍ وصدى لا تنفيذ: خرجها محتوى ملفٍ أو صدى وسيطة، لا سلوك
// البرنامج — «run type main.py» يعرض print("fib(7)=13") دون تنفيذها.
const READBACK_COMMAND = /^run\s+(?:echo|printf|type|cat|more|less|head|tail|findstr|grep|rg|sls|select-string|get-content|gc|strings|hexdump|od|write-output)\b/iu

/**
 * يحكم: هل ظهر كل دليل خرجٍ معلَنٍ في الهدف داخل إيصال تشغيلٍ **ناجحٍ**
 * فعليّ؟ أربعة منافذ مقيسة مغلقة هنا (المسح العدائي 2026-09-01):
 * - إيصال فاشل يقتبس المصدر في رسالة الخطأ لا يُحتسب (النجاح شرط).
 * - صدى الأمر نفسه في رأس الإيصال يُقصّ قبل المطابقة.
 * - أمرٌ يحمل الدليل في نصّه (echo/findstr على النص المتوقع) لا يُحتسب.
 * - أوامر القراءة الارتجاعية (type/cat/grep…) خرجُها محتوى لا سلوك.
 * إيصالات الكتابة لا تُحتسب أصلاً — الدليل stdout من تنفيذٍ حقيقيّ.
 */
export function outputEvidenceVerdict(
  goal: string,
  receipts: readonly { readonly command: string; readonly output: string; readonly verdict?: ToolVerdict }[],
): string | undefined {
  const expected = declaredOutputEvidence(goal)
  if (expected.length === 0) return undefined
  const usable = receipts
    .filter((r) => /^run\b/iu.test(r.command.trim()))
    .filter((r) => !READBACK_COMMAND.test(r.command.trim()))
    .filter((r) => receiptSucceeded(r.output, r.verdict))
    .map((r) => ({
      command: clean(r.command).toLowerCase(),
      // صدى الأمر في رأس الإيصال ($ cmd) ليس خرجاً — يُقصّ قبل المطابقة.
      output: clean(r.output.replace(/^\$ [^\n]*\n?/u, "")).toLowerCase(),
    }))
  for (const item of expected) {
    const needle = clean(item).toLowerCase()
    const carried = usable.some((r) => !r.command.includes(needle) && r.output.includes(needle))
    if (!carried) {
      return `الهدف ينصّ على خرجٍ بعينه «${item}» ولا يوجد إيصال تشغيلٍ ناجحٍ يحمله في خرجه (لا في نصّ أمره ولا عبر قراءةٍ ارتجاعية) — رمز الخروج وحده ليس دليلاً على السلوك (كتالوج 15.x). شغّل برنامج الهدف نفسه وأظهر الخرج حرفياً قبل التسليم.`
    }
  }
  return undefined
}

/**
 * دليلُ المتصفّح (2026-09-13): هدفٌ يطلب «افتحه في متصفّحك / التقط الصفحة / تحقّق بالنقر» لا يُقفل ببناءٍ أخضر وخادمٍ
 * يعمل — الجولةُ المقيسة بنت المشروع وشغّلت الخادم وانتهت بلا open ولا shot. الشرطُ إيصالُ متصفّحٍ ناجح من الصنف المطلوب.
 */
export function browserProofVerdict(
  goal: string,
  receipts: readonly { readonly command: string; readonly output: string; readonly verdict?: ToolVerdict }[],
  browserAvailable = true,
): string | undefined {
  // مراجعة 09-14: «click handler» أو «زرّ يلتقط screenshot» ليست طلبَ تحقّقٍ في المتصفّح — يلزم سياقُ متصفّحٍ صريح؛ ومتصفّحٌ موقوفٌ = لا شرط (وإلا صار الدورُ غيرَ قابلٍ للإقفال أبداً).
  if (!browserAvailable) return undefined
  if (!/متصفّح|متصفح|browser|localhost|127\.0\.0\.1|https?:\/\//iu.test(goal)) return undefined
  const wantsOpen = /(?:افتح|يفتح|افتحه|افتحها|شغّله|open)[^\n]{0,60}(?:متصفّح|متصفح|browser)|(?:في|in)\s+(?:متصفّحك|متصفحك|the browser|your browser)/iu.test(goal)
  const wantsShot = /shot\b|لقطة|التقط|screenshot/iu.test(goal)
  const wantsClick = /بالنقر|انقر|اضغط على الروابط|click/iu.test(goal)
  const ok = receipts.filter((r) => receiptSucceeded(r.output, r.verdict)).map((r) => r.command.trim().toLowerCase())
  const has = (re: RegExp) => ok.some((c) => re.test(c))
  const missing: string[] = []
  if (wantsOpen && !has(/^(?:open|ui)\s/u)) missing.push("open <الرابط> (فتحُ الصفحة في متصفّح الوكيل)")
  if (wantsShot && !has(/^shot\b/u)) missing.push("shot full (لقطةُ الصفحة)")
  if (wantsClick && !has(/^tap\s/u)) missing.push("tap <مرجع> (النقرُ الفعليّ على الروابط)")
  if (missing.length === 0) return undefined
  return `الهدف يطلب تحقّقاً في المتصفّح ولا إيصالَ ناجح له: ${missing.join("، ")} — البناءُ الأخضر والخادمُ العامل لا يثبتان الصفحة؛ افتحها والتقطها وانقر قبل التسليم.`
}

export interface HttpProbe {
  readonly path: string
  readonly status: number
  readonly body: string
}

/**
 * يحكم على أدلة الفحص الحيّ: صفحةٌ عامةٌ يكفيها 200، لكن مسار بياناتٍ
 * (/api/…) يحتاج جسماً غير فارغٍ وغير خطأ — 200 وحده لا يثبت أن القاعدة
 * تعمل (KF-25). يعيد سبب الرفض أو undefined إن كانت الأدلة كافية.
 */
export function httpEvidenceVerdict(probes: readonly HttpProbe[]): string | undefined {
  if (probes.length === 0) return "لا دليل HTTP حيّ — القبول يحتاج فحصاً على خادمٍ يعمل، لا بناءً فقط."
  for (const p of probes) {
    if (p.status >= 500) return `${p.path} ردّ ${p.status} — عطل خادم، ليس قبولاً.`
    const isData = /\/api\//i.test(p.path)
    if (isData) {
      if (p.status !== 200) return `${p.path} ردّ ${p.status} — مسار بياناتٍ يجب أن يرد 200 ببيانات.`
      const body = clean(p.body)
      if (body.length === 0) return `${p.path} ردّ 200 بجسمٍ فارغ — لا دليل أن القاعدة تعمل (KF-25).`
      if (/"error"|\bفشل\b|exception|stack trace/i.test(body)) return `${p.path} ردّ 200 لكن جسمه خطأ: ${body.slice(0, 80)}.`
    } else if (p.status !== 200 && p.status !== 401 && p.status !== 403) {
      return `${p.path} ردّ ${p.status} — الصفحة العامة يجب أن تخدم (200) أو تحمي (401/403).`
    }
  }
  return undefined
}
