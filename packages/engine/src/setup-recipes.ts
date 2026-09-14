/**
 * وصفاتُ الإعداد المتعلَّمة — أمرُ المالك 2026-09-13: «لو المستخدم عنده ٣ مشاريع ونجح أنّه يعمل nginx وpm2
 * أو أيّ إعداد، يحفظ هذا الإعداد في الذاكرة كسكربت للتعلّم وتقليل استهلاك التوكن في الردّ القادم».
 *
 * الدرسُ (`lessons.ts`) يقطّر **الفشل**؛ هذه تقطّر **النجاح الذي يستحقّ التكرار**: أوامرُ إعدادٍ (nginx، pm2،
 * systemd، certbot، docker، تثبيتُ حزمٍ عامّة، سقالاتُ flutter/expo/swift/vite…) نجحت في دورٍ واحد تُجمع
 * بترتيبها سكربتاً باسمٍ مشتقٍّ من وسومها، ويُحفظ عند **مستوى المستخدم** لا المشروع — فالوصفةُ قيمتُها أنّها
 * تعبر المشاريع (موقعُ الشركة ثمّ متجرُها ثمّ ERP بالإعداد نفسه). بيانُ السرّ يُحجب قبل الجمع (`redact`).
 *
 * الصدقُ: الوصفةُ تُحفظ «مرشّحةً» من أوّل نجاح وتصير «مؤكَّدة» حين تُعاد في مشروعٍ آخر بنجاح؛ الشجرةُ خالصةٌ
 * (لا قرص هنا) — القراءةُ والكتابةُ عند المحرّك عبر `RecipeStore`.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ToolVerdict } from "@abdo/engine-host"
import { receiptFailed } from "./failure-tiering"

export interface RecipeStep { readonly command: string; readonly note?: string }
export interface Recipe {
  readonly slug: string
  readonly title: string
  readonly tags: readonly string[]
  readonly shell: "powershell" | "sh"
  readonly steps: readonly RecipeStep[]
  readonly status: "candidate" | "verified"
  readonly uses: number
  readonly projects: readonly string[]
  readonly createdAt: string
  readonly lastUsedAt: string
}

/** ما يُعدّ أمرَ إعدادٍ يستحقّ الحفظ — وسمٌ لكلّ نمط؛ الأوامرُ العاديّة (ls، cat، git status…) لا تدخل الوصفة. */
const SETUP_TAGS: ReadonlyArray<readonly [string, RegExp]> = [
  ["nginx", /\bnginx\b|sites-(?:available|enabled)/iu],
  ["pm2", /\bpm2\b/iu],
  ["systemd", /\bsystemctl\b|\bjournalctl\b/iu],
  ["certbot", /\bcertbot\b|\bacme\.sh\b/iu],
  ["docker", /\bdocker(?:-compose)?\b/iu],
  ["caddy", /\bcaddy\b/iu],
  ["apache", /\bapache2?\b|\ba2en(?:site|mod)\b/iu],
  ["postgres", /\bpsql\b|\bpg_ctl\b|\bcreatedb\b|postgresql/iu],
  ["prisma", /\bprisma\s+(?:migrate|db\s+push|generate)\b/iu],
  ["global-install", /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+(?:-g|--global)\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bscoop\s+install\b/iu],
  ["flutter", /\bflutter\s+(?:create|pub|build|doctor)\b|\bdart\s+pub\b/iu],
  ["expo", /\bcreate-expo-app\b|\bexpo\s+(?:prebuild|run|start)\b|\breact-native\s+(?:init|run-)/iu],
  ["swift", /\bswift\s+(?:package|build|run)\b|\bxcodebuild\b|\bxcrun\b/iu],
  ["scaffold", /\bcreate-(?:next-app|vite|react-app|remix|astro|t3-app)\b|\bnpm\s+create\b|\bbun\s+create\b|\bpnpm\s+create\b/iu],
  ["ssh", /\bssh\b\s+\S+@\S+|\bscp\b|\brsync\b/iu],
  ["firewall", /\bufw\b|\bfirewall-cmd\b|netsh\s+advfirewall/iu],
  ["dns-tls", /\bcloudflared\b|\bopenssl\s+req\b|\bmkcert\b/iu],
  ["env", /\bsetx\b|\bexport\s+\w+=|\$env:\w+\s*=/iu],
]

const STRONG_TAGS: ReadonlySet<string> = new Set(["nginx", "pm2", "systemd", "certbot", "docker", "caddy", "apache", "flutter", "expo", "swift", "scaffold"])

export function setupTagsOf(command: string): string[] {
  const tags: string[] = []
  for (const [tag, pattern] of SETUP_TAGS) if (pattern.test(command)) tags.push(tag)
  return tags
}

const stripRun = (cmd: string): string => cmd.replace(/^run\s+(?:--bg\s+)?/iu, "").trim()

/** يجمع أوامرَ الإعداد الناجحة في دورٍ واحد ويصوغها وصفةً عند الإقفال — أو لا شيء إن لم يكن ما جُمع إعداداً. */
export class RecipeCollector {
  readonly #steps: { command: string; tags: string[] }[] = []
  readonly #redact: (text: string) => string
  constructor(redact: (text: string) => string) { this.#redact = redact }

  observe(cmd: string, output: string, verdict?: ToolVerdict): void {
    if (!/^run\b/iu.test(cmd) || receiptFailed(output, verdict)) return
    const command = this.#redact(stripRun(cmd))
    if (command.length === 0 || command.length > 600 || /\[REDACTED|\*{4,}/u.test(command)) return
    const tags = setupTagsOf(command)
    if (tags.length === 0) return
    if (this.#steps.some((s) => s.command === command)) return
    this.#steps.push({ command, tags })
  }

  get size(): number { return this.#steps.length }

  /** وصفةٌ حين تحمل خطوةً قويّة (خادم/سقالة) أو خطوتين فأكثر — أمرُ تثبيتٍ يتيم ليس وصفة. */
  finish(project: string, platform: NodeJS.Platform = process.platform, now = new Date()): Recipe | undefined {
    const tags = [...new Set(this.#steps.flatMap((s) => s.tags))]
    const strong = tags.some((t) => STRONG_TAGS.has(t))
    if (this.#steps.length === 0 || (!strong && this.#steps.length < 2)) return undefined
    const ordered = [...tags].sort((a, b) => Number(STRONG_TAGS.has(b)) - Number(STRONG_TAGS.has(a)) || a.localeCompare(b))
    const head = ordered.slice(0, 3).join("-")
    const digest = createHash("sha256").update(this.#steps.map((s) => s.command).join("\n")).digest("hex").slice(0, 6)
    const stamp = now.toISOString()
    return Object.freeze({
      slug: `${head}-${digest}`,
      title: `إعداد ${ordered.slice(0, 3).join(" + ")} (${this.#steps.length} خطوات)`,
      tags: ordered,
      shell: platform === "win32" ? "powershell" : "sh",
      steps: this.#steps.map((s) => Object.freeze({ command: s.command })),
      status: "candidate",
      uses: 1,
      projects: [project],
      createdAt: stamp,
      lastUsedAt: stamp,
    })
  }
}

/** السكربتُ القابل للتشغيل — كلُّ خطوةٍ تقف عند فشلها (وصفةٌ نصفُها منفَّذ أسوأُ من لا وصفة). */
export function recipeScript(recipe: Recipe): string {
  const header = `# ${recipe.title} — عبدو كود، تعلّمها من ${recipe.projects.length} مشروع (${recipe.status === "verified" ? "مؤكَّدة" : "مرشّحة"})`
  if (recipe.shell === "powershell") {
    return [header, "$ErrorActionPreference = 'Stop'", ...recipe.steps.map((s) => `${s.command}\nif ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "failed: ${s.command.replace(/"/gu, "'")}" }`)].join("\n") + "\n"
  }
  return [header, "set -euo pipefail", ...recipe.steps.map((s) => s.command)].join("\n") + "\n"
}

/** دمجُ وصفةٍ جديدة في المحفوظ: السكربتُ نفسُه في مشروعٍ آخر يؤكّدها ويزيد عدّها؛ الأوّلُ يبقى مرشّحاً. */
export function mergeRecipe(previous: Recipe | undefined, fresh: Recipe): Recipe {
  if (previous === undefined) return fresh
  const projects = [...new Set([...previous.projects, ...fresh.projects])]
  return Object.freeze({
    ...previous,
    uses: previous.uses + 1,
    projects,
    lastUsedAt: fresh.lastUsedAt,
    status: projects.length > 1 ? "verified" : previous.status,
  })
}

/** سطورٌ موجزة للحقن قبل النداء الأوّل حين تذكر رسالةُ المستخدم وسماً محفوظاً — لا أكثر من خمس، ولا شيء إن لم تُذكر. */
export function recipeBrief(recipes: readonly Recipe[], userText: string, max = 5): string {
  const text = userText.toLowerCase()
  const hits = recipes.filter((r) => r.tags.some((t) => text.includes(t) || (TAG_ARABIC[t] ?? []).some((w) => text.includes(w))))
  if (hits.length === 0) return ""
  const lines = hits.slice(0, max).map((r) => `- ${r.slug}: ${r.title} — ${r.status === "verified" ? "مؤكَّدة" : "مرشّحة"}، ${r.steps.length} خطوات (نفّذ: recipe ${r.slug} لقراءتها)`)
  return `📜 وصفاتُ إعدادٍ محفوظة من مشاريع سابقة (اقرأها بدل إعادة الاكتشاف):\n${lines.join("\n")}\n\n`
}

const TAG_ARABIC: Readonly<Record<string, readonly string[]>> = {
  nginx: ["نجينكس", "انجينكس", "إنجنكس"], pm2: ["بي ام 2", "بي إم 2"], docker: ["دوكر", "دوكر"], certbot: ["شهادة", "ssl"],
  flutter: ["فلاتر"], expo: ["رياكت نيتيف", "ريأكت نيتف", "اكسبو"], swift: ["سويفت"], scaffold: ["مشروع جديد", "سقالة"], postgres: ["بوستجرس"], systemd: ["خدمة"],
}

/** المخزنُ على القرص عند مستوى المستخدم: `<root>/recipes/<slug>.json` + السكربت بجانبه. */
export class RecipeStore {
  readonly #dir: string
  constructor(root: string) { this.#dir = join(root, "recipes") }
  get dir(): string { return this.#dir }

  all(): Recipe[] {
    if (!existsSync(this.#dir)) return []
    const out: Recipe[] = []
    for (const name of readdirSync(this.#dir)) {
      if (!name.endsWith(".json")) continue
      try { const parsed = JSON.parse(readFileSync(join(this.#dir, name), "utf8")) as Recipe; if (typeof parsed.slug === "string" && Array.isArray(parsed.steps)) out.push(parsed) } catch { /* ملفٌ تالف يُتجاهل لا يُسقط الدور */ }
    }
    return out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
  }

  get(slug: string): Recipe | undefined { return this.all().find((r) => r.slug === slug) }

  save(fresh: Recipe): Recipe {
    mkdirSync(this.#dir, { recursive: true })
    const merged = mergeRecipe(this.get(fresh.slug), fresh)
    writeFileSync(join(this.#dir, `${merged.slug}.json`), JSON.stringify(merged, null, 2) + "\n")
    writeFileSync(join(this.#dir, `${merged.slug}.${merged.shell === "powershell" ? "ps1" : "sh"}`), recipeScript(merged))
    return merged
  }

  forget(slug: string): boolean {
    const hit = this.get(slug)
    if (hit === undefined) return false
    for (const ext of ["json", "ps1", "sh"]) rmSync(join(this.#dir, `${slug}.${ext}`), { force: true })
    return true
  }
}

/** عرضُ الوصفة للنموذج/المستخدم: العنوانُ، الوسومُ، ثمّ الخطواتُ مرقّمةً — والسكربتُ الجاهز في المسار. */
export function describeRecipe(recipe: Recipe, scriptPath: string): string {
  return [
    `📜 ${recipe.title} [${recipe.slug}] — ${recipe.status === "verified" ? "مؤكَّدة" : "مرشّحة"}، استُعملت ${recipe.uses}× في ${recipe.projects.length} مشروع`,
    `الوسوم: ${recipe.tags.join(", ")}`,
    ...recipe.steps.map((s, i) => `${i + 1}. ${s.command}`),
    `السكربت الجاهز: ${scriptPath} — راجع الخطوات على المشروع الحاليّ (مسارات/أسماء) قبل تشغيله بـ run.`,
  ].join("\n")
}
