/**
 * 10-01 — «سقفُ الجودة» Q1: فحصُ الواجهة المُصيَّرة بقياسٍ لا بادّعاء.
 *
 * لقطةٌ لموقعٍ بناه عبدو كود (بناءٌ أخضر واختباراتٌ خضراء): قائمةُ الجوّال فوق المحتوى بلا خلفيّة، اسمُ الموقع فوق أيقونة، تمريرٌ أفقيّ —
 * «اصلح طريقة تنفيذه للواجهات… وفق معايير… مشاريعنا». القواعدُ **ليست مخترعة**: هي قواعدُ عدّتنا المُختبَرة `scripts/ui-audit/lib.mjs`
 * (UI-AUDIT-02، 19 اختباراً) منقولةً إلى المنتَج العامّ — العروضُ، الفيضانُ وأضيقُ فائض (RTL يفيض يساراً)، الفيضانُ عند خطّ جذرٍ 44px،
 * أخطاءُ الطرفيّة، الطلباتُ الفاشلة، lang/dir، 100dvh، الروابطُ الداخليّة. ويُزاد ما قيس ناقصاً اليومَ نفسَه: الطلباتُ التي لا تتوقّف،
 * وتراكبُ النصوص، وأساسيّاتُ الوصول (h1 واحد، alt، أسماءُ الأزرار والحقول).
 * الوحدةُ نقيّة: لا متصفّح ولا شبكة — المشغّلُ في cli يقيس ويستدعي هنا.
 */

export const AUDIT_WIDTHS: readonly number[] = [360, 390, 412, 768, 1366]
export const SCALED_ROOT_FONT_PX = 44
export const AUDIT_MAX_LINKS = 40
export const RUNAWAY_WINDOW_MS = 3000
export const RUNAWAY_LIMIT = 6
/** مساراتٌ لا تُطلب أبداً ولو ربطت بها الصفحة (GET وحده، ولا جلسةَ تُنهى) — من NEVER_REQUEST في lib.mjs. */
export const NEVER_REQUEST = /\/(api\/auth|auth|logout|signout|sign-out|delete|remove|unsubscribe)(\/|$|\?)/iu

export interface OverflowBox { readonly scrollWidth: number; readonly clientWidth: number; readonly culprit: string | null }
export interface PageMeasurement {
  readonly status: number
  readonly error?: string
  readonly consoleErrors: readonly string[]
  readonly failedRequests: readonly string[]
  readonly runawayRequests: number
  readonly lang: string | null
  readonly dir: string | null
  readonly overflow: { readonly default: OverflowBox; readonly scaled: OverflowBox } | null
  readonly inlineDvh: boolean
  readonly textLength: number
  readonly h1Count: number
  readonly imgNoAlt: number
  readonly unnamedControls: readonly string[]
  readonly unlabeledFields: readonly string[]
  readonly overlaps: readonly string[]
}
export interface AuditFinding {
  readonly path: string
  readonly width: number
  readonly check: string
  readonly severity: "error" | "warn" | "info"
  readonly measured: string
  readonly expected: string
  readonly detail: string
}

/**
 * يُقيَّم داخل الصفحة (Runtime.evaluate) ويعيد JSON. منقولٌ من MEASURE_IN_PAGE في audit.mjs، وزيدت عليه الحقولُ الجديدة.
 * نصٌّ JS خالص — لا TypeScript — كي يبقى كما هو في الحزمة المترجمة.
 */
export const MEASURE_SCRIPT = String.raw`(() => {
  const scaledPx = ${SCALED_ROOT_FONT_PX};
  const de = document.documentElement, body = document.body;
  // 10-01 (مقيس على الموقع): «widest: path width=3 x=-620» سمّى أعمقَ عنصرٍ فائض (مسارَ أيقونة SVG) — لا يُصلَح ولا يُعثر عليه في الشيفرة.
  // الآن: الجذرُ — عنصرٌ فائض أبوه غيرُ فائض، الأبعدُ خروجاً — بسلسلة آبائه ومقتطفِ نصّه، ومعه الورقةُ للسياق. ما تحت position:fixed لا يصنع تمريراً فيُستبعد.
  const elLabel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const widest = () => {
    const cw = de.clientWidth, hb = de.getBoundingClientRect(); const outs = new Set(); let leaf = null;
    const fixedUnder = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === "fixed") return true; return false };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      const out = r.width > cw + 1 || r.left < hb.left - 1 || r.right > hb.right + 1;
      if (!out || fixedUnder(el)) continue;
      outs.add(el);
      if (!leaf || r.width < leaf.r.width) leaf = { el, r };
    }
    let root = null, rootBy = -1;
    for (const el of outs) {
      if (el.parentElement && outs.has(el.parentElement)) continue;
      const r = el.getBoundingClientRect(); const by = Math.max(hb.left - r.left, r.right - hb.right, r.width - cw);
      if (by > rootBy) { root = { el, r }; rootBy = by }
    }
    if (!root) return null;
    const chain = []; for (let p = root.el.parentElement, i = 0; p && p !== document.body && i < 2; p = p.parentElement, i += 1) chain.unshift(elLabel(p));
    const text = (root.el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return "root " + [...chain, elLabel(root.el)].join(" > ") + " width=" + Math.round(root.r.width) + " x=" + Math.round(root.r.left - hb.left) + (text ? " «" + text + "»" : "") + (leaf && leaf.el !== root.el ? " · leaf " + elLabel(leaf.el) : "");
  };
  const measure = () => ({ scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, culprit: de.scrollWidth > de.clientWidth ? widest() : null });
  const def = measure();
  const prev = de.style.fontSize; de.style.fontSize = scaledPx + "px"; void de.offsetWidth;
  const scaled = measure(); de.style.fontSize = prev; void de.offsetWidth;
  const visible = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "")).slice(0, 60);
  const accName = (el) => {
    const aria = el.getAttribute("aria-label") || "";
    const by = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
    const imgAlt = [...el.querySelectorAll("img[alt]")].map((i) => i.getAttribute("alt")).join(" ");
    const svgTitle = [...el.querySelectorAll("svg title")].map((t) => t.textContent).join(" ");
    return (aria + " " + by + " " + (el.innerText || "") + " " + (el.getAttribute("title") || "") + " " + imgAlt + " " + svgTitle).trim();
  };
  const unnamedControls = [...document.querySelectorAll("button, a[href], [role=button]")].filter((el) => visible(el) && accName(el).length === 0).slice(0, 8).map(label);
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => !/^(hidden|submit|button|reset|image)$/i.test(el.getAttribute("type") || "") && visible(el));
  const unlabeledFields = fields.filter((el) => {
    if ((el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || "").trim()) return false;
    if (el.id && document.querySelector("label[for=\"" + CSS.escape(el.id) + "\"]")) return false;
    return !el.closest("label");
  }).slice(0, 8).map(label);
  // تراكبُ النصوص: عنصران مرئيّان يحمل كلٌّ منهما نصّاً مباشراً، لا أحدُهما سلفُ الآخر، ويتقاطعان بأكثر من 30% من أصغرهما.
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (texts.length >= 500) break;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own || !visible(el)) continue;
    texts.push({ el, r: el.getBoundingClientRect() });
  }
  const overlaps = [];
  for (let i = 0; i < texts.length && overlaps.length < 6; i++) {
    for (let j = i + 1; j < texts.length && overlaps.length < 6; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (smaller > 0 && (w * h) / smaller > 0.3) overlaps.push(label(a.el) + " «" + (a.el.innerText || "").trim().slice(0, 20) + "» ⟂ " + label(b.el) + " «" + (b.el.innerText || "").trim().slice(0, 20) + "»");
    }
  }
  return JSON.stringify({
    lang: de.getAttribute("lang"), dir: de.getAttribute("dir") || getComputedStyle(de).direction,
    overflow: { default: def, scaled },
    inlineDvh: [...document.querySelectorAll("style")].some((s) => /100dvh/.test(s.textContent || "")),
    links: [...new Set([...document.querySelectorAll("a[href]")].map((x) => x.href))],
    textLength: (body && body.innerText ? body.innerText : "").trim().length,
    h1Count: [...document.querySelectorAll("h1")].filter(visible).length,
    imgNoAlt: [...document.querySelectorAll("img:not([alt])")].filter(visible).length,
    unnamedControls, unlabeledFields, overlaps,
  });
})()`

/** قياسُ صفحةٍ بعرضٍ ⇦ نتائج. منقولٌ من analyzeMeasurement في lib.mjs + الفحوصُ الجديدة. */
export function analyzePage(m: PageMeasurement, ctx: { readonly path: string; readonly width: number; readonly expectedDir?: string }): AuditFinding[] {
  const out: AuditFinding[] = []
  const add = (check: string, severity: AuditFinding["severity"], measured: string | number, expected: string | number, detail = "") =>
    out.push({ path: ctx.path, width: ctx.width, check, severity, measured: String(measured), expected: String(expected), detail })
  if (m.error !== undefined || m.status === 0) { add("status", "error", m.status, "200", m.error ?? "no response"); return out }
  if (m.status >= 500) add("status", "error", m.status, "2xx/3xx", "server error")
  else if (m.status >= 400) add("status", "warn", m.status, "2xx/3xx", "client error on a page")

  if (m.consoleErrors.length > 0) add("console-errors", "error", m.consoleErrors.length, 0, m.consoleErrors.slice(0, 3).join(" | "))
  if (m.failedRequests.length > 0) add("failed-requests", "error", m.failedRequests.length, 0, m.failedRequests.slice(0, 3).join(" | "))
  if (m.runawayRequests > RUNAWAY_LIMIT) add("runaway-requests", "error", m.runawayRequests, `<=${RUNAWAY_LIMIT} in ${RUNAWAY_WINDOW_MS / 1000}s after load`, "the page keeps requesting after it settled (a fetch inside an effect that re-renders itself, or polling)")

  if (m.lang === null || m.lang === "") add("lang", "warn", "none", "ar|en", "<html> has no lang")
  if (ctx.expectedDir !== undefined && m.dir !== ctx.expectedDir) add("dir", "error", m.dir ?? "none", ctx.expectedDir, "html dir differs from the project's direction")
  else if (m.lang !== null && /^ar/iu.test(m.lang) && m.dir !== "rtl") add("dir", "error", m.dir ?? "none", "rtl", "lang=ar page is not rtl")

  const d = m.overflow?.default, s = m.overflow?.scaled
  if (d !== undefined && d.scrollWidth > d.clientWidth) add("overflow", "error", `${d.scrollWidth}>${d.clientWidth}`, "no horizontal scroll", d.culprit !== null ? `widest: ${d.culprit}` : "")
  if (s !== undefined && s.scrollWidth > s.clientWidth) add("overflow@44px", "warn", `${s.scrollWidth}>${s.clientWidth}`, "no horizontal scroll at root 44px", s.culprit !== null ? `widest: ${s.culprit}` : "")
  if (m.inlineDvh) add("100dvh", "warn", "inline <style>", "svh / min-height", "Firefox Android scroll jump")

  if (m.overlaps.length > 0) add("text-overlap", "error", m.overlaps.length, 0, m.overlaps.slice(0, 3).join(" | "))
  if (m.status < 400 && m.textLength >= 50 && m.h1Count !== 1) add("h1", "warn", m.h1Count, 1, "one visible h1 per page")
  if (m.imgNoAlt > 0) add("img-alt", "error", m.imgNoAlt, 0, "img without alt (alt=\"\" for decorative)")
  if (m.unnamedControls.length > 0) add("unnamed-control", "error", m.unnamedControls.length, 0, m.unnamedControls.slice(0, 4).join(" | "))
  if (m.unlabeledFields.length > 0) add("unlabeled-field", "error", m.unlabeledFields.length, 0, m.unlabeledFields.slice(0, 4).join(" | "))
  if (m.status < 400 && m.textLength < 50) add("rendered-text", "warn", m.textLength, ">=50 chars", "page rendered almost no text after hydration")
  return out
}

/** روابطٌ داخليّة مكسورة (مقيسةٌ مرّةً للموقع كلّه) ⇦ نتيجةٌ واحدة. */
export function analyzeLinks(links: readonly { readonly url: string; readonly status: number }[]): AuditFinding[] {
  const broken = links.filter((l) => l.status === 0 || l.status >= 400)
  if (broken.length === 0) return []
  return [{ path: "*", width: 0, check: "broken-links", severity: "error", measured: String(broken.length), expected: "0", detail: broken.slice(0, 4).map((l) => `${l.status} ${l.url}`).join(" | ") }]
}

/** المساراتُ من بناء Next.js (app-path-routes-manifest) — بلا ديناميكيّ ولا api ولا داخليّ؛ وإلا «/» وحدها. */
export function routesFromManifest(manifest: unknown): string[] {
  if (manifest === null || typeof manifest !== "object") return ["/"]
  const routes = Object.values(manifest as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .filter((r) => !r.includes("[") && !r.startsWith("/api") && !r.startsWith("/_") && !/\.(?:ico|png|svg|xml|txt|json|webmanifest)$/u.test(r))
  const unique = [...new Set(routes)].sort()
  return unique.length > 0 ? unique : ["/"]
}

/** الحكمُ والتقرير: PASS حين لا خطأ؛ التحذيراتُ تُسمّى ولا تحجب. */
export function renderAudit(findings: readonly AuditFinding[], pages: number, widths: readonly number[]): { readonly passed: boolean; readonly text: string } {
  const errors = findings.filter((f) => f.severity === "error")
  const warns = findings.filter((f) => f.severity === "warn")
  const passed = errors.length === 0
  const rows = [...errors, ...warns].slice(0, 40).map((f) => `${f.severity === "error" ? "✕" : "△"} ${f.path}${f.width > 0 ? ` @${f.width}` : ""} · ${f.check}: ${f.measured} (المتوقَّع ${f.expected})${f.detail ? ` — ${f.detail}` : ""}`)
  const head = `audit: ${passed ? "PASS" : "FAIL"} — ${pages} صفحة × ${widths.length} عرض (${widths.join("/")}) · ${errors.length} خطأ · ${warns.length} تحذير`
  return { passed, text: [head, ...rows, ...(errors.length + warns.length > 40 ? [`… و${errors.length + warns.length - 40} أخرى`] : [])].join("\n") }
}

/**
 * 10-01 — مقيس على الموقع أثناء Sprint 14 (الستايل): Tailwind 4 يترجم `bg-[--surface]` إلى `background-color:--surface` — قيمةٌ باطلة
 * فالخلفيةُ **شفّافة**: درجُ الجوّال بلا خلفيّة، العيبُ الذي ظهر في لقطة المستخدم. صيغةُ 4: `bg-(--surface)` أو `bg-[var(--surface)]`
 * (أو رمزٌ في @theme يولّد `bg-surface`). فحصٌ ثابت في audit: في مشروع Tailwind ≥ 4 كلُّ صنفٍ `-[--x]` خطأ بملفّه وسطره — فلا تُغلق البوّابة عليه.
 */
const TW4_VAR_CLASS = /(?<![\w-])((?:[a-z]+:)*[a-z][a-z0-9-]*?)-\[(--[a-z0-9-]+)\](\/\d+)?/gu

export function tailwindMajor(packageJson: string): number | undefined {
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const v = pkg.dependencies?.["tailwindcss"] ?? pkg.devDependencies?.["tailwindcss"]
    const m = v === undefined ? null : /(\d+)/u.exec(v)
    return m === null ? undefined : Number(m[1])
  } catch { return undefined }
}

/** صنفُ Tailwind ≥ 4 بمتغيّرٍ في قيمةٍ اعتباطيّة بالصيغة القديمة — خطأٌ لكلّ ملفّ (العددُ وأوّلُ مثالٍ بسطره). */
export function tailwindV4VarFindings(files: readonly { readonly path: string; readonly text: string }[], major: number | undefined): AuditFinding[] {
  if (major === undefined || major < 4) return []
  const out: AuditFinding[] = []
  for (const f of files) {
    // كلُّ ملفّ مصدر (متغيّراتُ cva في ‎.ts‎ أصنافٌ حقيقيّة) — عدا الاختبارات.
    if (/\.(?:test|spec)\.[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)\//u.test(f.path)) continue
    const hits = [...f.text.matchAll(TW4_VAR_CLASS)]
    if (hits.length === 0) continue
    const first = hits[0]!
    const line = f.text.slice(0, first.index!).split("\n").length
    const fixed = `${first[1]}-(${first[2]})${first[3] ?? ""}`
    out.push({ path: `${f.path}:${line}`, width: 0, check: "tailwind-v4-var", severity: "error", measured: `${hits.length}× مثل ${first[0]}`, expected: fixed, detail: "Tailwind 4 يترجم [--x] قيمةً باطلة (الخلفيةُ/اللونُ شفّاف) — اكتبها (--x) أو [var(--x)]" })
  }
  return out
}

/** 10-01 — توجيهاتُ الإصدار 3 في CSS مشروعِ Tailwind 4. مقيس: النموذجُ كتب `@tailwind base;` في globals.css فانكسر البناء
 * («Cannot apply unknown utility class») ثمّ أنزل Tailwind إلى 3.4 بدل إصلاح النمط. خطأٌ لكلّ ملفّ بسطره الأوّل. */
const TW3_DIRECTIVE = /^\s*@tailwind\s+(?:base|components|utilities)\b/gmu
export function tailwindV4DirectiveFindings(files: readonly { readonly path: string; readonly text: string }[], major: number | undefined): AuditFinding[] {
  if (major === undefined || major < 4) return []
  const out: AuditFinding[] = []
  for (const f of files) {
    const hits = [...f.text.matchAll(TW3_DIRECTIVE)]
    if (hits.length === 0) continue
    const line = f.text.slice(0, hits[0]!.index!).split("\n").length
    out.push({ path: `${f.path}:${line}`, width: 0, check: "tailwind-v4-directive", severity: "error", measured: `${hits.length}× ${hits[0]![0].trim()}`, expected: '@import "tailwindcss";', detail: "توجيهُ الإصدار 3 في مشروع Tailwind 4: الأسطرُ الثلاثة تصير `@import \"tailwindcss\";` والألوانُ في @theme — لا تُنزل الإصدار." })
  }
  return out
}

/**
 * 10-01 (Q4) — معاييرُ الواجهات والخلفيّة والأمان والرفع للإنتاج (أكتوبر 2026).
 * ما يعرفه المشرفُ قبل أن يكتب واجهة، مقطَّراً من عيوبٍ قيست على موقعٍ بناه عبدو كود (درجٌ جوّاليّ بلا خلفيّة، فيضانٌ أفقيّ، روابطُ مكسورة،
 * رؤوسُ أمانٍ غائبة). يُحقن في طبقة المشروع لمشاريع الويب وحدها، والبوّابةُ في sprint-evidence تُلزم به عند الإغلاق.
 */
export const WEB_STANDARDS_BRIEF = [
  "معاييرُ الواجهات والإنتاج (أكتوبر 2026) — طبّقها وأنت تكتب، فإغلاقُ سبرنتٍ مسّ الواجهة يحتاج «audit: PASS» بعد آخر تعديل:",
  "1. الجوّالُ أوّلاً (360/390/412 ثمّ 768/1366): لا عرضَ ثابتٍ أعرضُ من الشاشة، وmin-w-0 مع truncate للنصوص داخل flex؛ overflow-x:hidden لا يُصلح — أصلح العنصرَ الأعرض.",
  "2. القوائمُ والطبقات: درجُ الجوّال بخلفيّةٍ معتمة وغطاءٍ تحته، يُغلق بـEsc وبالغطاء وبالرابط، ويقفل تمريرَ الصفحة، ولا يُرسم شيءٌ منه وهو مغلق؛ z-index من سلّمٍ واحد.",
  "3. العربيّة: <html dir=\"rtl\" lang=\"ar\"> وخصائصُ منطقيّة (ms/me/ps/pe/start/end) لا left/right.",
  "4. الوصول (WCAG 2.2 AA): تباينُ النصّ ≥ 4.5:1، حلقةُ تركيزٍ ظاهرة، aria-label لكلّ زرٍّ أيقونيّ، label لكلّ حقل، هدفُ لمسٍ ≥ 24px، h1 واحدٌ لكلّ صفحة، ورابطُ «تخطَّ إلى المحتوى».",
  "5. الألوانُ رموزٌ في CSS (متغيّرات) — لا hex داخل المكوّنات؛ والصورُ بأبعادٍ أو aspect-ratio وalt. في Tailwind 4 يُكتب المتغيّرُ bg-(--surface) أو bg-[var(--surface)] (أو رمزٌ في @theme يولّد bg-surface) — bg-[--surface] قيمةٌ باطلة فالخلفيةُ شفّافة. وأوّلُ CSS العامّ فيه @import \"tailwindcss\"; لا @tailwind base/components/utilities، وإضافةُ postcss هي @tailwindcss/postcss — ولا تُنزل الإصدار لتُصلح نمطاً.",
  "6. الأداء: Server Components افتراضاً و\"use client\" لأصغر جزءٍ تفاعليّ، next/font للخطوط، لا سكربتاتٍ حاجبة، ولا طلباتٍ تتكرّر بلا توقّف.",
  "7. الأمن: لا سرَّ في كود العميل (NEXT_PUBLIC_ للعامّ وحده)، تحقّقٌ (zod) لكلّ مدخلٍ في API، مصادقةٌ على كلّ مسارٍ يغيّر بيانات، ورؤوسُ أمانٍ في next.config (CSP وframe-ancestors وnosniff وReferrer-Policy وpoweredByHeader:false).",
  "8. البحثُ والإجابة: metadata لكلّ صفحة (عنوانٌ ≤ 60 ووصفٌ 50–160 وcanonical وOpen Graph)، sitemap وrobots وllms.txt، وJSON-LD للكيان، والمحتوى في HTML قبل JavaScript.",
  "9. الروابط: لا رابطَ داخليّاً إلى صفحةٍ غير موجودة — أنشئها أو احذف الرابط.",
  "10. التحقّق: بعد تعديل الواجهة run --bg npm run start ثمّ audit على المسارات التي مسستَها حتى PASS؛ وقبل التسليم release-check؛ وللصفحات العامّة seo.",
].join("\n")
