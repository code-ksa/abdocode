/** S6 — كتيّب صنف الخطأ: module-not-found يُشخَّص بالكود لا بالتخمين.
 *
 * الدليل الحي (تأهيل 2026-08-30): ~24 بناءً متتالياً حول `Can't resolve`
 * واحد، والنموذج يجرّب الصيغ عشوائياً (`@/lib/db` ثم `app/lib/db.ts` ثم
 * `@/app/lib/db.ts`) ولا ينظر إلى tsconfig. المشخّص هنا حتمي — سلّم
 * الأدوات: كود قبل نموذج — يقرأ tsconfig الفعلي ويجد الملف الفعلي ويسمّي
 * الصيغة الصحيحة حرفياً، فيصير الإصلاح نسخاً لا اجتهاداً.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

// نمطان دقيقان لا جامع عام: فاصلة «Can't» العليا كانت تسمّم بديلاً جامعاً
// (`Module not found[^'"]*`) فيلتقط «t resolve» بدل المسار (قيس بالاختبار).
const UNRESOLVED_PATTERNS = [/Can't resolve\s*['"]([^'"\n]+)['"]/giu, /Cannot find module\s*['"]([^'"\n]+)['"]/giu]

interface TsPaths {
  readonly declared: boolean
  readonly aliases: readonly { readonly prefix: string; readonly target: string }[]
}

const readTsPaths = (projectDir: string): TsPaths => {
  try {
    // tsconfig ليس JSON صارماً (تعليقات وفواصل زائدة) — تنظيف خفيف يكفي أغراضنا.
    const raw = readFileSync(join(projectDir, "tsconfig.json"), "utf-8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1")
    const parsed = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } }
    const paths = parsed.compilerOptions?.paths
    if (paths === undefined) return { declared: false, aliases: [] }
    const aliases = Object.entries(paths)
      .filter(([key, targets]) => key.endsWith("/*") && Array.isArray(targets) && targets.length > 0)
      .map(([key, targets]) => ({ prefix: key.slice(0, -1), target: targets[0].replace(/\*$/u, "") }))
    return { declared: true, aliases }
  } catch {
    return { declared: false, aliases: [] }
  }
}

/** بحث مسقوف عن ملفٍ باسمه المجرد داخل مجلدات المصدر. */
const findByBasename = (projectDir: string, name: string): string | undefined => {
  const wanted = name.replace(/\.[cm]?[jt]sx?$/iu, "")
  const pending = ["app", "src", "lib", "components", "pages"].filter((dir) => existsSync(join(projectDir, dir)))
  let visited = 0
  while (pending.length > 0) {
    const relative = pending.pop()!
    let entries
    try { entries = readdirSync(join(projectDir, relative), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > 2_000) return undefined
      const target = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") pending.push(target)
      } else if (entry.name.replace(/\.[cm]?[jt]sx?$/iu, "") === wanted && /\.[cm]?[jt]sx?$/iu.test(entry.name)) {
        return target
      }
    }
  }
  return undefined
}

const NODE_BUILTINS = new Set(["fs", "path", "os", "net", "tls", "crypto", "child_process", "worker_threads", "stream", "util", "zlib", "http", "https", "dns"])

/**
 * الكتيّب الثاني (قيس 2026-08-30): وحدة Node أصلية (better-sqlite3) تُحزم
 * لكود المتصفح فيفشل حل `fs` داخل node_modules. السببان المعروفان: غياب
 * `serverExternalPackages` في next.config، أو مكوّن "use client" يستورد
 * وحدة الخادم. التشخيص يسمّي الحزمة والعلاجين حرفياً.
 */
const nativeModuleHint = (output: string, projectDir: string): string => {
  const inNodeModules = output.match(/\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\/[^\n]*\n[^\n]*Can't resolve '([^']+)'/u)
    ?? output.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/][^\n]*?Can't resolve '([^']+)'/u)
  if (inNodeModules === null || !NODE_BUILTINS.has(inNodeModules[2])) return ""
  const pkg = inNodeModules[1].replace(/\\/g, "/")
  let configured = false
  for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
    try {
      if (new RegExp(`serverExternalPackages[^\\]]*['"\`]${pkg}['"\`]`, "u").test(readFileSync(join(projectDir, name), "utf-8"))) configured = true
    } catch { /* غياب الملف ليس خطأ هنا */ }
  }
  return (
    `\nتشخيص وحدة الخادم (محسوب): «${pkg}» وحدة Node أصلية تُحزم لكود المتصفح فيفشل حل '${inNodeModules[2]}'. العلاج:\n` +
    (configured
      ? `١) serverExternalPackages تحمل «${pkg}» فعلاً — إذن مكوّنٌ عليه "use client" يستورد وحدة تستعملها؛ اعزل وصول القاعدة في Server Components وroute handlers فقط، ومرّر البيانات للـclient عبر props أو fetch.\n`
      : `١) أضف إلى next.config: serverExternalPackages: ['${pkg}'].\n` +
        `٢) تأكد ألا يستورد أي ملف "use client" وحدةً تستعمل «${pkg}» — وصول القاعدة في Server Components وroute handlers فقط.\n`)
  )
}

/**
 * الكتيّب الثالث (قيس 2026-08-30، جولة e2e-1788091422516): مسار API جديد
 * أسقط البناء عند «Failed to collect page data» — شيفرة قاعدة/بيئة تعمل
 * وقت استيراد الوحدة، وNext يستورد المسارات كلها أثناء البناء حيث لا
 * قاعدة ولا env. العلاج القانوني ثابت فيُملى حرفياً.
 */
const pageDataCollectionHint = (output: string): string => {
  const failed = output.match(/Failed to collect page data for (\/[^\s"']+)/u)
  if (failed === null) return ""
  return (
    `\nتشخيص جمع بيانات الصفحات (محسوب): «${failed[1]}» يشغّل شيفرةً تعتمد القاعدة أو البيئة وقتَ استيراد الوحدة، وNext يستورد المسارات أثناء البناء حيث لا قاعدة ولا env. العلاج:\n` +
    `١) انقل أي وصول لقاعدة البيانات أو process.env من أعلى الملف إلى داخل دالة المعالج (GET/POST) نفسها — التهيئة كسولة lazy لا عند الاستيراد.\n` +
    `٢) أضف في أول الملف: export const dynamic = "force-dynamic" لمسارات API التي تقرأ القاعدة.\n`
  )
}

/** الملفّ المستورِد من سطر الخطأ الذي يذكر هذا المستورَد. */
const findImporter = (output: string, spec: string): string | undefined => {
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // ./app/lib/x:2:1  أو  tests/a.test.ts(2,43): error ...'spec'
  const near = new RegExp(`(?:^|\\n)\\.?/?([\\w./-]+\\.[cm]?[jt]sx?)[(:][^\\n]*${esc}`, "u").exec(output)
    ?? new RegExp(`([\\w./-]+\\.[cm]?[jt]sx?)[^\\n]*${esc}`, "u").exec(output)
  return near?.[1]?.replace(/^\.\//u, "")
}

/** المسار النسبيّ الصحيح من ملفٍ مستورِد إلى ملفٍ هدف (كلاهما نسبةً للجذر). */
const correctRelative = (importer: string, target: string): string => {
  const fromDir = importer.replace(/\\/g, "/").split("/").slice(0, -1)
  const to = target.replace(/\\/g, "/").replace(/\.[cm]?[jt]sx?$/iu, "").split("/")
  let i = 0
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i += 1
  const up = fromDir.length - i
  const rel = [...Array.from({ length: up }, () => ".."), ...to.slice(i)].join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

/**
 * يُبنى من ناتج بناءٍ فاشل: سطرُ تشخيصٍ مسمّى لكل مستوردٍ لم يُحل.
 * سلسلة فارغة تعني «لا شيء أقوله» — لا ضوضاء على ناتجٍ سليم.
 */
export function moduleResolutionHints(output: string, projectDir: string): string {
  const pageData = pageDataCollectionHint(output)
  if (pageData.length > 0) return pageData
  const native = nativeModuleHint(output, projectDir)
  if (native.length > 0) return native
  const specs = new Set<string>()
  for (const pattern of UNRESOLVED_PATTERNS) for (const match of output.matchAll(pattern)) specs.add(match[1])
  if (specs.size === 0) return ""
  const ts = readTsPaths(projectDir)
  const hints: string[] = []
  for (const spec of [...specs].slice(0, 6)) {
    if (!spec.startsWith(".") && !spec.startsWith("@/") && !/[\\/]/.test(spec) && !spec.endsWith(".ts")) continue // حزمة npm غائبة — شأن حارس التبعيات
    const parts: string[] = []
    if (/\.[cm]?[jt]sx?$/iu.test(spec)) parts.push("لا تكتب الامتداد في الاستيراد")
    const actual = findByBasename(projectDir, basename(spec))
    if (actual !== undefined) {
      const bare = actual.replace(/\.[cm]?[jt]sx?$/iu, "")
      const alias = ts.aliases.find(() => true)
      // المسار النسبيّ الصحيح من الملف المستورِد — يعمل في tsc وvitest معاً،
      // بخلاف الاسم المستعار الذي قد لا يحلّه vitest بلا إعدادٍ إضافيّ.
      const importer = findImporter(output, spec)
      const relative = importer !== undefined ? correctRelative(importer, actual) : undefined
      const isTest = importer !== undefined && /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\//iu.test(importer)
      if (relative !== undefined && isTest) {
        parts.push(`الملف الفعلي ${actual}؛ في ملفّات الاختبار استعمل المسار النسبيّ الصحيح '${relative}' (الاسم المستعار @/ قد لا يحلّه vitest بلا إعداد)`)
      } else if (alias !== undefined) {
        parts.push(`الملف الفعلي ${actual}؛ الصيغة الصحيحة بحسب tsconfig الحالي: '${alias.prefix}${bare.replace(/^\.\//u, "")}'` + (relative !== undefined ? ` أو نسبياً '${relative}'` : ""))
      } else {
        parts.push(
          `الملف الفعلي ${actual}؛ لا توجد paths في tsconfig الآن — أضف داخل compilerOptions: "paths": {"@/*": ["./*"]} ثم استورد '@/${bare}' (بلا baseUrl، أزيلت في TS7)` + (relative !== undefined ? `، أو نسبياً '${relative}'` : ""),
        )
      }
    } else {
      parts.push("لا ملف بهذا الاسم في المشروع — أنشئه أو صحّح الاسم")
    }
    hints.push(`«${spec}»: ${parts.join("؛ ")}`)
  }
  if (hints.length === 0) return ""
  return `\nتشخيص المسارات (محسوب من tsconfig والقرص، انسخه لا تجتهد):\n${hints.join("\n")}`
}
