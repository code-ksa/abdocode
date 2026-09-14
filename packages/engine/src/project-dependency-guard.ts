/** S4 — عقل التبعيات: مدخل واحد لكل حاجة، والحذف لا يسبق الاستيراد.
 *
 * الدليل الحي (تأهيل 2026-08-30): النموذج كدّس مزوّدات متكافئة
 * (prisma + sql.js + sqlite + better-sqlite3 معاً، وbcrypt + bcryptjs معاً)
 * ثم شغّل `npm audit fix --force` فأزال 355 حزمة دفعة واحدة — بينها
 * better-sqlite3 التي يستوردها مصدر المشروع، فانكسر البناء. الحارس يرُدّ
 * القرار الأعمى بسببٍ مسمّى ويترك القرار المشخَّص يمرّ.
 *
 * حارس انحدار ضيّق كأخوته: ليس مدير تبعيات، ولا يقرّر عن النموذج —
 * يمنع الصنفين المقيسين فقط: الحذف الأعمى، وتكديس المتكافئات.
 *
 * ⚠ تصحيحٌ مقيس (2026-09-06، سجلُّ المالك الحيّ): «المتكافئات» كانت قائمةَ أسماءٍ مسطّحة تعدّ `prisma` (CLI) و
 * `@prisma/client` (وقت التشغيل) عضوين متنافسين — فرفضت بناءَ مشروع Prisma الصحيح ورفضت تثبيت نصفه الناقص،
 * بينما `project-stack.ts` يحذّر إن غاب أحدُهما. الصيغةُ الآن **مجموعاتُ بدائل**: أعضاءُ المجموعة الواحدة رفاقٌ
 * يجتمعون، والمجموعاتُ بدائلُ لا تجتمع. والسائقُ (better-sqlite3…) يُتسامح معه مع ORM يعلن أنّه يقوده.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

interface AlternativeGroup {
  /** رفاقٌ يجتمعون: CLI + عميل + محوّلات. */
  readonly members: readonly string[]
  /** سائقُ قاعدةٍ يُتسامح معه بجوار هذه المجموعة حين يكون العضوُ المفتاح حاضراً (المحوّل أو الـORM نفسه). */
  readonly drivers?: Readonly<Record<string, readonly string[]>>
}
interface Family { readonly need: string; readonly groups: readonly AlternativeGroup[] }

/** الرفاقُ الإلزاميّون — المصدرُ الواحد مع project-stack.ts (الذي يحذّر إن غاب الرفيق). */
export const REQUIRED_COMPANIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  prisma: ["@prisma/client"],
  "drizzle-orm": ["drizzle-kit"],
})

/** عائلات المتكافئات: قدرةٌ واحدة، مجموعةٌ واحدة منها تكفي مشروعاً واحداً. */
export const EQUIVALENT_FAMILIES: readonly Family[] = [
  {
    need: "قاعدة SQLite/ORM",
    groups: [
      { members: ["better-sqlite3"] }, { members: ["sql.js"] }, { members: ["sqlite"] }, { members: ["sqlite3"] }, { members: ["@libsql/client"] },
      { members: ["prisma", "@prisma/client", "@prisma/adapter-better-sqlite3", "@prisma/adapter-libsql", "@prisma/adapter-pg"], drivers: { "@prisma/adapter-better-sqlite3": ["better-sqlite3"], "@prisma/adapter-libsql": ["@libsql/client"] } },
      { members: ["knex"], drivers: { knex: ["better-sqlite3", "sqlite3"] } },
      { members: ["typeorm"], drivers: { typeorm: ["better-sqlite3", "sqlite3"] } },
      { members: ["drizzle-orm", "drizzle-kit"], drivers: { "drizzle-orm": ["better-sqlite3", "@libsql/client", "sqlite3"] } },
    ],
  },
  { need: "تجزئة كلمات المرور", groups: ["bcrypt", "bcryptjs", "argon2", "@node-rs/bcrypt", "@node-rs/argon2"].map((m) => ({ members: [m] })) },
]

const familyOf = (pkg: string): Family | undefined => EQUIVALENT_FAMILIES.find((f) => f.groups.some((g) => g.members.includes(pkg)))
const groupOf = (family: Family, pkg: string): AlternativeGroup | undefined => family.groups.find((g) => g.members.includes(pkg))

/**
 * المجموعاتُ المتنافسة الحاضرة فعلاً: تُسقَط مجموعةُ سائقٍ يقودها ORM حاضرٌ (بعضوه المفتاح). أكثرُ من مجموعةٍ = تكديس.
 * يعود بالمجموعات المتنافسة (أعضاؤها الحاضرون) — فارغةً أو واحدةً = لا تكديس.
 */
export function competingGroups(family: Family, declared: ReadonlySet<string>): string[][] {
  const present = family.groups.map((g) => ({ g, members: g.members.filter((m) => declared.has(m)) })).filter((p) => p.members.length > 0)
  const tolerated = new Set<AlternativeGroup>()
  for (const { g, members } of present) {
    for (const [key, drivers] of Object.entries(g.drivers ?? {})) {
      if (!members.includes(key)) continue
      for (const other of present) if (other.g !== g && other.members.every((m) => drivers.includes(m))) tolerated.add(other.g)
    }
  }
  return present.filter((p) => !tolerated.has(p.g)).map((p) => p.members)
}

/** استيرادات bare-module من مصدر المشروع — مسح مسقوف كتدقيق المصادقة. */
export function sourceImports(projectDir: string): Set<string> {
  const found = new Set<string>()
  const pending = ["app", "src", "lib", "server", "pages", "components"].filter((name) => existsSync(join(projectDir, name)))
  let visited = 0
  try {
    while (pending.length > 0) {
      const relative = pending.pop()!
      for (const entry of readdirSync(join(projectDir, relative), { withFileTypes: true })) {
        if (++visited > 2_000) return found
        const target = `${relative}/${entry.name}`
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") pending.push(target)
          continue
        }
        if (!/\.[cm]?[jt]sx?$/iu.test(entry.name)) continue
        if (statSync(join(projectDir, target)).size > 500_000) continue
        const source = readFileSync(join(projectDir, target), "utf-8")
        for (const match of source.matchAll(/\bimport\s+(?:[^"'\n]*?\s+from\s+)?["']([^"'\n]+)["']|\brequire\(\s*["']([^"'\n]+)["']\s*\)/g)) {
          const spec = match[1] ?? match[2]
          if (spec === undefined || spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("node:")) continue
          // الحزمة هي المقطع الأول (أو مقطعان لنطاق @scope).
          const parts = spec.split("/")
          found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
        }
      }
    }
  } catch { /* مسحٌ ناقص خيرٌ من انهيار الحارس؛ التدقيق الكامل عند البوابة */ }
  return found
}

const declaredDependencies = (projectDir: string): { deps: Record<string, string>; dev: Record<string, string> } => {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return { deps: manifest.dependencies ?? {}, dev: manifest.devDependencies ?? {} }
  } catch {
    return { deps: {}, dev: {} }
  }
}
const declaredSet = (projectDir: string): Set<string> => { const { deps, dev } = declaredDependencies(projectDir); return new Set([...Object.keys(deps), ...Object.keys(dev)]) }

/** يفحص أمر تشغيلٍ قبل تنفيذه. `undefined` يعني مسموحاً. */
export function dependencyCommandViolation(cmd: string, projectDir: string): string | undefined {
  const trimmed = cmd.trim()
  // الحذف الأعمى: --force تزيل وتُرقّي بقرار الأداة لا بقرار مشخَّص.
  if (/\b(?:npm|pnpm|yarn|bun)\s+audit\s+fix\s+--force\b/iu.test(trimmed)) {
    return "رُفض npm audit fix --force: يزيل ويرقّي حزماً بقرار أعمى (أزال 355 حزمة في جولة مقيسة وكسر البناء). أصلح الثغرة المسماة بترقية حزمتها وحدها"
  }
  const uninstall = trimmed.match(/\b(?:npm|pnpm)\s+(?:uninstall|remove|rm|un)\s+(.+)$|\bbun\s+remove\s+(.+)$|\byarn\s+remove\s+(.+)$/iu)
  if (uninstall !== null) {
    const packages = (uninstall[1] ?? uninstall[2] ?? uninstall[3] ?? "").split(/\s+/).filter((p) => p.length > 0 && !p.startsWith("-"))
    const imported = sourceImports(projectDir)
    const used = packages.filter((p) => imported.has(p))
    if (used.length > 0) {
      return `رُفض حذف ${used.join("، ")}: مصدر المشروع يستوردها الآن. أصلح الاستيرادات أولاً (أو أبقِ الحزمة)، ثم احذف — الحذف قبل الاستيراد يكسر البناء`
    }
    return undefined
  }
  const install = trimmed.match(/\b(?:npm|pnpm)\s+(?:install|add|i)\s+(.+)$|\bbun\s+add\s+(.+)$|\byarn\s+add\s+(.+)$/iu)
  if (install !== null) {
    const packages = (install[1] ?? install[2] ?? install[3] ?? "").split(/\s+/).filter((p) => p.length > 0 && !p.startsWith("-"))
    const declared = declaredSet(projectDir)
    for (const pkg of packages) {
      // نزع لاحقة الإصدار: name@1.2.3 و@scope/name@next كلاهما يعودان للاسم.
      const bare = pkg.startsWith("@")
        ? pkg.split("/").slice(0, 2).join("/").replace(/(.)@[^@]*$/u, "$1")
        : pkg.split("@")[0]
      const family = familyOf(bare)
      if (family === undefined) continue
      const own = groupOf(family, bare)!
      // الحكمُ على الحالة بعد التثبيت: رفيقُ مجموعةٍ حاضرة يمرّ، وبديلٌ لمجموعةٍ حاضرة يُرفض.
      const after = new Set(declared); after.add(bare)
      const competing = competingGroups(family, after)
      const others = competing.filter((members) => !members.some((m) => own.members.includes(m)))
      if (competing.length > 1 && others.length > 0) {
        return `رُفض تثبيت ${bare}: يوجد مكافئ منصّب لنفس الحاجة (${family.need}): ${others.flat().join("، ")}. استعمل المنصّب، أو أزله أولاً (بعد إصلاح استيراداته) إن كان التبديل مقصوداً — لا عضوين من عائلة واحدة`
      }
    }
  }
  return undefined
}

// تبعيات التشغيل التي توضع خطأً في devDependencies (كتالوج 7.4).
const RUNTIME_DEPS = new Set(["next", "react", "react-dom", "express", "fastify", "vue", "svelte", "@angular/core"])

/** تدقيق ما قبل البوابة: كتدقيق المصادقة، يعيد فحص الحالة القائمة. */
export function dependencyAudit(projectDir: string): string | undefined {
  const { deps, dev } = declaredDependencies(projectDir)
  const declared = new Set([...Object.keys(deps), ...Object.keys(dev)])
  const imported = sourceImports(projectDir)
  const missing = [...imported].filter((pkg) => !declared.has(pkg) && familyOf(pkg) !== undefined)
  if (missing.length > 0) {
    return `المصدر يستورد ${missing.join("، ")} وليست في package.json — أعد تثبيتها أو أصلح الاستيرادات لتستعمل المنصّب فعلاً`
  }
  for (const family of EQUIVALENT_FAMILIES) {
    const competing = competingGroups(family, declared)
    if (competing.length > 1) {
      const present = competing.flat()
      const used = present.filter((member) => imported.has(member))
      // ما يُبقى مجموعةٌ كاملة (رفاقُ المستورَد)، لا العضوُ المستورَد وحده — كي لا يُنصح بحذف prisma وإبقاء عميله.
      const keepGroup = used.length > 0 ? competing.find((members) => members.some((m) => used.includes(m))) ?? used : undefined
      const keep = keepGroup !== undefined ? keepGroup.join("، ") : "ما يستورده المصدر"
      return `عائلة «${family.need}» منصّبة ${competing.length} مرات (${present.join("، ")}) — أبقِ ${keep} وأزل الباقي بعد التأكد أن لا مصدر يستورده`
    }
  }
  // 7.4 — تبعية تشغيلٍ في devDependencies تكسر الإنتاج.
  const misplaced = [...RUNTIME_DEPS].filter((pkg) => pkg in dev && !(pkg in deps))
  if (misplaced.length > 0) {
    return `تبعيات تشغيل في devDependencies (${misplaced.join("، ")}) — تغيب عن الإنتاج فيكسر. انقلها إلى dependencies`
  }
  return undefined
}

/** 7.5 — سكربتات مانيفست غير متوقعة تُزرع صامتةً (مثل postinstall من حزمة). */
export function unexpectedScriptViolation(projectDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}
    for (const hook of ["postinstall", "preinstall", "prepare", "prepublish"]) {
      const body = scripts[hook]
      // سكربت دورة حياةٍ يشغّل أداة حزمةٍ خارجية (زُرع) لا سكربتات المشروع.
      if (body !== undefined && /\b(?:prisma|husky|patch-package|node-gyp|[a-z-]+ sync)\b/i.test(body) && !/^(?:npm|node|bun|tsc|next) /.test(body)) {
        return `سكربت ${hook} مزروع في package.json: «${body}». إن لم تطلبه صراحةً فأزله — بعض الحزم تحقنه ليعمل عند كل تثبيت.`
      }
    }
  } catch { /* لا مانيفست — لا حكم */ }
  return undefined
}
