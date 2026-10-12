/**
 * استيرادُ الذاكرة والتخصيصات من وكلاءٍ آخرين — «حط جزء في الاعدادات لاخذ الذاكرة من شات جي بي تي او كلود
 * او جيميناي او اي ايجنت يعمل علي مشاريع المستخدم كي يستخدم تخصيصات المستخدم» (2026-10-10).
 *
 * **لا مخزنَ ثانياً**: المالكُ الوحيد لتفضيلات المستخدم هو ملاحظاتُ المالك (`owner-memory.ts` ⇦ SqliteFactStore،
 * المفتاح `owner-note:`) — ما يُحفظ هنا يُحفظ بـ`saveOwnerMemory` وحدها، فيظهر في صفحة «الذاكرة والوعي» ويُنسى منها،
 * ويصل النموذجَ من المسار نفسِه الذي تصله به ملاحظةُ «تذكّر …» (factsForAutomaticRecall ⇦ recall ⇦ [PROJECT_MEMORY]).
 *
 * المسار: جمعٌ ⇦ حجبُ الأسرار ⇦ إزالةُ التكرار ⇦ قائمةُ مراجعة ⇦ **لا كتابةَ إلا بنقرة الحفظ** (إطار memory-import-save).
 * كلُّ قارئٍ هنا كودٌ حتميّ — لا نموذجَ يفسّر ملفّاً.
 *
 * الحقولُ المقروءة من ملفّات التصدير (بنصّها، وما غاب يُقال إنه غاب):
 *  - ChatGPT (تصدير البيانات .zip أو ملفّاته):
 *      conversations.json ⇦ رسائلُ `content.content_type == "user_editable_context"`: الحقلان `user_profile`
 *        («ماذا تريد أن يعرف ChatGPT عنك») و`user_instructions` («كيف تريد أن يردّ») — الأحدثُ `create_time` لكلٍّ منهما؛
 *        ورسائلُ المساعد إلى أداة الذاكرة `recipient == "bio"` ⇦ نصُّ `content.parts` (ما حفظه ChatGPT في «الذاكرة»).
 *      ملفُّ ذاكرةٍ إن وُجد (memories*.json / memory*.json / model_set_context*.json) ⇦ نصوصُ content|text|memory|value.
 *      user.json ⇦ حقولُ حسابٍ فقط (بريد/هاتف) — **لا يُستورد**.
 *  - Claude (تصدير البيانات .zip أو ملفّاته):
 *      projects.json ⇦ `prompt_template` لكلّ مشروع (تعليماتُ المشروع) مسبوقاً باسمه.
 *      memories*.json إن وُجد ⇦ `conversations_memory` و`project_memories` (وأيُّ content|text|memory).
 *      users.json / conversations.json ⇦ حسابٌ ومحادثات — تُعدّ ولا تُستورد.
 *  - Gemini (Google Takeout):
 *      ملفٌّ مسارُه يحمل «saved info» أو «gems» ⇦ نصوصُه (JSON: text|content|instruction(s)|description؛ HTML: أسطره).
 *      «My Activity / Gemini Apps» (MyActivity.json أو .html) ⇦ الطلباتُ التي تبدأ بـ«تذكّر/remember/from now on…» وحدها.
 *      وإن غاب «Saved info» يُقال صراحةً: التصديرُ لا يحمله — والبديلُ تبويبُ اللصق.
 */
import { createHash } from "node:crypto"
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { SqliteFactStore } from "@abdo/memory"
import { zipEntryNames, zipPart } from "./docx-read"
import { saveOwnerMemory } from "./owner-memory"
import { redactSecretValues, sweepResidualSecrets } from "./secret-command-guard"
import { classifyInboundSecret } from "./secret-intake"

export const IMPORT_AGENTS = Object.freeze(["claude-code", "codex", "gemini-cli", "qwen", "cursor", "windsurf", "cline", "copilot", "chatgpt", "claude", "gemini", "other"] as const)
export type ImportAgent = (typeof IMPORT_AGENTS)[number]
export const IMPORT_AGENT_LABEL: Readonly<Record<ImportAgent, string>> = Object.freeze({
  "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", qwen: "Qwen Code", cursor: "Cursor",
  windsurf: "Windsurf", cline: "Cline", copilot: "GitHub Copilot", chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", other: "Other",
})
export type ImportCategory = "profile" | "topic" | "area" | "person"
const CATEGORIES: readonly ImportCategory[] = ["profile", "topic", "area", "person"]

export const IMPORT_LIMITS = Object.freeze({
  /** ملفّاتٌ محلّيّة في المسح الواحد. */
  sources: 400,
  /** مجلّداتٌ فرعيّة تُفحص في كلّ جذر مشروع. */
  childDirsPerRoot: 120,
  /** ملفّاتُ ذاكرة Claude Code في كلّ مشروع (~/.claude/projects/<x>/memory). */
  memoryFilesPerProject: 80,
  /** قواعدُ في مجلّدٍ واحد (.cursor/rules، .clinerules/…). */
  rulesPerDir: 30,
  /** ما يُقرأ من كلّ ملفٍّ محلّيّ (والباقي يُعلن مقطوعاً). */
  localFileBytes: 256 * 1024,
  /** ملفُّ التصدير وكلُّ جزءٍ مفكوكٍ منه. */
  exportBytes: 400 * 1024 * 1024,
  /** بنودُ قائمة المراجعة ومجموعُ محارفها — الإطارُ الصادر مسقوفٌ بـ1MiB. */
  reviewItems: 300,
  reviewChars: 240_000,
  itemMinChars: 8,
  itemMaxChars: 1000,
  /** بندٌ عدّله المستخدمُ في المراجعة. */
  editedMaxChars: 2000,
  pasteChars: 200_000,
  /** بنودُ إطار الحفظ الواحد. */
  saveItems: 200,
})

export interface LocalSource {
  readonly id: string
  readonly agent: ImportAgent
  readonly path: string
  readonly bytes: number
  readonly where: "home" | "project"
}
export interface RawImportItem { readonly text: string; readonly agent: ImportAgent; readonly origin: string }
export interface ImportItem {
  readonly id: string
  readonly text: string
  readonly agent: ImportAgent
  readonly origin: string
  readonly redactions: number
  /** تلميحٌ لا حكم: صحّة/مال/دين/هويّة… — يُعرض غيرَ محدَّدٍ في المراجعة، ويُحفظ «حسّاساً» إن أبقاه المستخدم. */
  readonly sensitive: boolean
  readonly category: ImportCategory
}
export interface ImportReview {
  readonly items: readonly ImportItem[]
  /** ما وُجد وما غاب، بنصٍّ مقروء — الصدقُ قبل العدّ. */
  readonly found: readonly string[]
  readonly dropped: { readonly duplicates: number; readonly tooShort: number; readonly secrets: number }
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------
// المسحُ المحلّيّ — ملفّاتُ الوكلاء التي عند المستخدم أصلاً
// ---------------------------------------------------------------------------

const sizeOf = (path: string): number => { try { const s = statSync(path); return s.isFile() ? s.size : -1 } catch { return -1 } }
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory() } catch { return false } }
const entriesOf = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] } }
const sourceId = (path: string): string => createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 16)

export interface ScanInput {
  readonly home: string
  readonly projectRoots?: readonly string[]
  /** المشروعُ المختار الآن إن وُجد — يُفحص هو نفسُه. */
  readonly selectedProject?: string
}

/** ملفّاتُ تعليماتِ وكيلٍ داخل مجلّد مشروعٍ واحد — الأسماءُ كما يقرؤها كلُّ وكيل. */
const scanProject = (dir: string, add: (agent: ImportAgent, path: string, where: "home" | "project") => void): void => {
  add("claude-code", join(dir, "CLAUDE.md"), "project")
  add("claude-code", join(dir, "CLAUDE.local.md"), "project")
  add("claude-code", join(dir, ".claude", "CLAUDE.md"), "project")
  add("codex", join(dir, "AGENTS.md"), "project")
  add("gemini-cli", join(dir, "GEMINI.md"), "project")
  add("qwen", join(dir, "QWEN.md"), "project")
  add("cursor", join(dir, ".cursorrules"), "project")
  add("windsurf", join(dir, ".windsurfrules"), "project")
  add("copilot", join(dir, ".github", "copilot-instructions.md"), "project")
  const rules = (agent: ImportAgent, folder: string, pattern: RegExp) => {
    for (const entry of entriesOf(folder).filter((e) => e.isFile() && pattern.test(e.name)).map((e) => e.name).sort().slice(0, IMPORT_LIMITS.rulesPerDir)) add(agent, join(folder, entry), "project")
  }
  rules("cursor", join(dir, ".cursor", "rules"), /\.(mdc|md|txt)$/iu)
  rules("windsurf", join(dir, ".windsurf", "rules"), /\.md$/iu)
  rules("copilot", join(dir, ".github", "instructions"), /\.instructions\.md$/iu)
  const cline = join(dir, ".clinerules")
  if (isDir(cline)) rules("cline", cline, /\.(md|txt)$/iu)
  else add("cline", cline, "project")
}

/** المجلّداتُ التي تُعدّ مشاريع: المختارُ، وكلُّ جذرٍ مضبوط ومجلّداتُه الفرعيّة المباشرة (بلا المخفيّة وnode_modules). */
const projectDirs = (input: ScanInput): string[] => {
  const dirs: string[] = []
  if (input.selectedProject !== undefined && isAbsolute(input.selectedProject)) dirs.push(resolve(input.selectedProject))
  for (const root of input.projectRoots ?? []) {
    if (typeof root !== "string" || !isAbsolute(root) || !isDir(root)) continue
    dirs.push(resolve(root))
    const children = entriesOf(root).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort().slice(0, IMPORT_LIMITS.childDirsPerRoot)
    for (const child of children) dirs.push(join(root, child))
  }
  return [...new Map(dirs.map((d) => [d.toLowerCase(), d])).values()]
}

/** يسرد الملفّات بمساراتها وأحجامها — لا يقرأ محتوى. الترتيب: البيتُ ثمّ المشروعُ المختار ثمّ ذاكرةُ Claude ثمّ الجذور. */
export function scanLocalAgentFiles(input: ScanInput): LocalSource[] {
  const out: LocalSource[] = []
  const seen = new Set<string>()
  const add = (agent: ImportAgent, path: string, where: "home" | "project"): void => {
    if (out.length >= IMPORT_LIMITS.sources) return
    const key = resolve(path).toLowerCase()
    if (seen.has(key)) return
    const bytes = sizeOf(path)
    if (bytes <= 0) return
    seen.add(key)
    out.push({ id: sourceId(path), agent, path: resolve(path), bytes, where })
  }
  const home = input.home
  add("claude-code", join(home, ".claude", "CLAUDE.md"), "home")
  add("codex", join(home, ".codex", "AGENTS.md"), "home")
  add("gemini-cli", join(home, ".gemini", "GEMINI.md"), "home")
  add("qwen", join(home, ".qwen", "QWEN.md"), "home")
  add("windsurf", join(home, ".codeium", "windsurf", "memories", "global_rules.md"), "home")
  const dirs = projectDirs(input)
  if (input.selectedProject !== undefined && dirs[0] !== undefined) scanProject(dirs[0], add)
  const claudeProjects = join(home, ".claude", "projects")
  for (const project of entriesOf(claudeProjects).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const memoryDir = join(claudeProjects, project, "memory")
    const files = entriesOf(memoryDir).filter((e) => e.isFile() && /\.md$/iu.test(e.name)).map((e) => e.name)
      .sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b))).slice(0, IMPORT_LIMITS.memoryFilesPerProject)
    for (const name of files) add("claude-code", join(memoryDir, name), "home")
  }
  for (const dir of dirs) scanProject(dir, add)
  return out
}

// ---------------------------------------------------------------------------
// النصّ ⇦ بنود — Markdown والقوائم الملصوقة
// ---------------------------------------------------------------------------

const squash = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()
const cap = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text)
const withHeading = (heading: string, text: string): string => (heading && !text.toLowerCase().startsWith(heading.toLowerCase()) ? `${heading}: ${text}` : text)
const BULLET = /^(?:[-*+•▪◦●]|\d{1,3}[.)])\s+(.*)$/u

/** Markdown ⇦ بنود: النقطةُ بند، والفقرةُ بند، والعنوانُ سياقٌ يسبق ما تحته، والكودُ يُتخطّى، وصفُّ الجدول بند. */
export function itemsFromMarkdown(text: string): string[] {
  const lines = text.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n").split("\n")
  const out: string[] = []
  let start = 0
  // ترويسةُ YAML (ملفّاتُ ذاكرة Claude Code): الوصفُ وحده بند، والباقي بياناتٌ وصفيّة.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, n) => n > 0 && line.trim() === "---")
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const description = line.match(/^description:\s*(.+)$/iu)?.[1]
        if (description !== undefined) out.push(description.replace(/^["']|["']$/gu, ""))
      }
      start = end + 1
    }
  }
  let heading = ""
  let paragraph: string[] = []
  let fenced = false
  const flush = () => { if (paragraph.length > 0) { out.push(withHeading(heading, paragraph.join(" "))); paragraph = [] } }
  for (const raw of lines.slice(start)) {
    const line = raw.trim()
    if (/^(```|~~~)/u.test(line)) { flush(); fenced = !fenced; continue }
    if (fenced) continue
    if (line.length === 0) { flush(); continue }
    const title = line.match(/^#{1,6}\s+(.*)$/u)?.[1]
    if (title !== undefined) { flush(); heading = squash(title.replace(/[*_`]/gu, "")).slice(0, 80); continue }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line) || /^\|?\s*:?-{3,}/u.test(line)) { flush(); continue }
    const bullet = line.match(BULLET)?.[1]
    if (bullet !== undefined) { flush(); out.push(withHeading(heading, bullet)); continue }
    if (line.startsWith("|")) {
      flush()
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean)
      if (cells.length > 0) out.push(withHeading(heading, cells.join(" — ")))
      continue
    }
    paragraph.push(line.replace(/^>\s?/u, ""))
  }
  flush()
  return out
}

/** جوابُ مساعدٍ ملصوق: كلُّ سطرٍ حقيقة؛ سطرٌ ينتهي بنقطتين سياقٌ لما بعده؛ ومقدّماتُ المجاملة تسقط. */
export function itemsFromPaste(text: string): string[] {
  const out: string[] = []
  let heading = ""
  for (const raw of text.slice(0, IMPORT_LIMITS.pasteChars).replace(/\r\n?/gu, "\n").split("\n")) {
    let line = raw.trim()
    if (line.length === 0 || /^(```|~~~)/u.test(line)) continue
    const title = line.match(/^#{1,6}\s+(.*)$/u)?.[1]
    if (title !== undefined) { heading = squash(title.replace(/[*_`]/gu, "")).slice(0, 80); continue }
    line = (line.match(BULLET)?.[1] ?? line).replace(/^\*\*(.+?)[:：]?\*\*[:：]?\s*$/u, "$1:")
    if (/^(?:sure|of course|certainly|here(?:'s| is| are)|okay|ok|hi|hello|thanks|بالتأكيد|بالطبع|حسنا|حسنًا|إليك|اليك|مرحبا|شكرا)(?=[\s!,.:،؛]|$)/iu.test(line)) continue
    if (/[:：]$/u.test(line) && line.length <= 80) { heading = squash(line.slice(0, -1).replace(/[*_`]/gu, "")); continue }
    out.push(withHeading(heading, line))
  }
  return out
}

// ---------------------------------------------------------------------------
// الحجبُ — المفرداتُ القائمة نفسُها (لا تعبيرَ ثالث)
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu
export const EMAIL_MASK = "[email]"

/**
 * يحجب الاعتمادات بمفردات المحرّك نفسها: حاجبُ الجسد الوارد (`classifyInboundSecret`) ثمّ حاجبُ القيم
 * (`redactSecretValues`) ثمّ المصفاةُ الأخيرة (`sweepResidualSecrets`) — كما يفعل `redactForStore` قبل الكتابة.
 * `blocked`: بقي بعد الحجب ما يراه المصنِّفُ اعتماداً — فالبندُ يُسقط (وsaveOwnerMemory كانت سترفضه).
 */
export function redactImportText(text: string, maskEmails: boolean): { text: string; redactions: number; blocked: boolean } {
  const inbound = classifyInboundSecret(text)
  const values = redactSecretValues(inbound.redacted)
  const swept = sweepResidualSecrets(values.text)
  let out = swept.text
  let emails = 0
  if (maskEmails) out = out.replace(EMAIL, () => { emails += 1; return EMAIL_MASK })
  const redactions = inbound.redactions + values.redactions + swept.redactions + emails
  return { text: out, redactions, blocked: classifyInboundSecret(out).carriesSecret }
}

/** تلميحُ حساسيّة (ورثه من مستورد الصفحة القديم): صحّة، مال، دين، سياسة، هويّات. */
const SENSITIVE_HINT = /\b(?:health|illness|diagnos\w*|medication|salary|bank|iban|passport|religio\w*|politic\w*|ssn|national id)\b|(?:صحّ|صحة|مرض|دواء|راتب|بنك|آيبان|ايبان|جواز|ديان|سياس|هويّة|هوية وطنية)/iu

const dedupeKey = (text: string): string => text.toLowerCase().normalize("NFKC").replace(/[ً-ٟـ]/gu, "").replace(/[أإآ]/gu, "ا").replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** جمعٌ ⇦ حجب ⇦ إزالةُ التكرار ⇦ قائمةُ مراجعة مسقوفة. لا يكتب شيئاً. */
export function buildImportReview(raw: readonly RawImportItem[], found: readonly string[], opts: { readonly maskEmails: boolean }): ImportReview {
  const items: ImportItem[] = []
  const seen = new Set<string>()
  let duplicates = 0, tooShort = 0, secrets = 0, chars = 0, truncated = false
  for (const entry of raw) {
    const text = cap(squash(entry.text), IMPORT_LIMITS.itemMaxChars)
    if (text.length < IMPORT_LIMITS.itemMinChars) { tooShort += 1; continue }
    const red = redactImportText(text, opts.maskEmails)
    if (red.blocked) { secrets += 1; continue }
    const key = dedupeKey(red.text)
    if (key.length === 0) { tooShort += 1; continue }
    if (seen.has(key)) { duplicates += 1; continue }
    if (items.length >= IMPORT_LIMITS.reviewItems || chars + red.text.length > IMPORT_LIMITS.reviewChars) { truncated = true; break }
    seen.add(key)
    chars += red.text.length
    items.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 12),
      text: red.text, agent: entry.agent, origin: cap(squash(entry.origin), 300), redactions: red.redactions,
      sensitive: SENSITIVE_HINT.test(text), category: "profile",
    })
  }
  return { items, found: [...found], dropped: { duplicates, tooShort, secrets }, truncated }
}

// ---------------------------------------------------------------------------
// القرّاء — محلّيّ، لصق، تصدير
// ---------------------------------------------------------------------------

const readHead = (path: string, max: number): { text: string; truncated: boolean } => {
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(max)
    const n = readSync(fd, buffer, 0, max, 0)
    return { text: new TextDecoder().decode(buffer.subarray(0, n)).replace(/^﻿/u, ""), truncated: n === max && sizeOf(path) > max }
  } finally { closeSync(fd) }
}

/** ملفّاتٌ محلّيّة **من المسح وحده**: مسارٌ لا يعيده `scanLocalAgentFiles` الآن لا يُقرأ — فلا يصير الإطارُ قارئَ ملفّاتٍ عامّاً. */
export function readLocalSources(paths: readonly string[], scan: readonly LocalSource[], home: string): { raw: RawImportItem[]; found: string[] } {
  const byPath = new Map(scan.map((s) => [s.path.toLowerCase(), s]))
  const raw: RawImportItem[] = []
  const found: string[] = []
  for (const requested of paths) {
    const source = typeof requested === "string" ? byPath.get(resolve(requested).toLowerCase()) : undefined
    if (source === undefined) { found.push(`تُخطّي مسارٌ ليس من نتيجة الفحص: ${String(requested).slice(0, 200)}`); continue }
    try {
      const { text, truncated } = readHead(source.path, IMPORT_LIMITS.localFileBytes)
      const shown = source.where === "home" ? "~/" + relative(home, source.path).replace(/\\/gu, "/") : source.path
      const items = itemsFromMarkdown(text)
      for (const item of items) raw.push({ text: item, agent: source.agent, origin: shown })
      found.push(`${IMPORT_AGENT_LABEL[source.agent]} — ${shown}: ${items.length} بنداً${truncated ? ` (قُرئ أوّلُ ${IMPORT_LIMITS.localFileBytes / 1024}KB فقط)` : ""}`)
    } catch (error) {
      found.push(`تعذّرت قراءة ${source.path}: ${(error as Error).message.slice(0, 120)}`)
    }
  }
  return { raw, found }
}

export function readPasted(text: string, agent: ImportAgent): { raw: RawImportItem[]; found: string[] } {
  const items = itemsFromPaste(text)
  const origin = `لصق من ${IMPORT_AGENT_LABEL[agent]}`
  return { raw: items.map((item) => ({ text: item, agent, origin })), found: [`${origin}: ${items.length} سطراً${text.length > IMPORT_LIMITS.pasteChars ? ` (قُرئ أوّلُ ${IMPORT_LIMITS.pasteChars} حرفاً)` : ""}`] }
}

/** حزمةُ تصدير: zip أو مجلّدٌ مفكوك أو ملفٌّ واحد — أسماءٌ بشرطةٍ مائلة أماميّة وقارئٌ مسقوف. */
export interface Bundle { readonly names: readonly string[]; readonly read: (name: string) => string }

const openBundle = (path: string): Bundle => {
  if (!isAbsolute(path)) throw Error("مسارُ ملفّ التصدير يجب أن يكون مطلقاً")
  if (isDir(path)) {
    const names: string[] = []
    const walk = (dir: string, depth: number) => {
      for (const entry of entriesOf(dir)) {
        if (names.length >= 4000) return
        const full = join(dir, entry.name)
        if (entry.isDirectory() && depth < 5) walk(full, depth + 1)
        else if (entry.isFile()) names.push(relative(path, full).replace(/\\/gu, "/"))
      }
    }
    walk(path, 0)
    return { names, read: (name) => { const full = join(path, name); if (sizeOf(full) > IMPORT_LIMITS.exportBytes) throw Error(`${name} أكبر من السقف`); return readFileSync(full, "utf8").replace(/^﻿/u, "") } }
  }
  const size = sizeOf(path)
  if (size <= 0) throw Error("ملفُّ التصدير غير موجود أو فارغ")
  if (size > IMPORT_LIMITS.exportBytes) throw Error(`ملفُّ التصدير ${Math.round(size / 1048576)}MB — فوق السقف ${IMPORT_LIMITS.exportBytes / 1048576}MB`)
  const ext = extname(path).toLowerCase()
  if (ext === ".zip") {
    const bytes = new Uint8Array(readFileSync(path))
    const names = zipEntryNames(bytes)
    return { names, read: (name) => (zipPart(bytes, name, IMPORT_LIMITS.exportBytes) ?? "").replace(/^﻿/u, "") }
  }
  if (![".json", ".html", ".htm", ".txt", ".md"].includes(ext)) throw Error("ملفُّ التصدير: zip أو json أو html")
  const name = basename(path)
  return { names: [name], read: () => readFileSync(path, "utf8").replace(/^﻿/u, "") }
}

const named = (bundle: Bundle, pattern: RegExp): string[] => bundle.names.filter((name) => pattern.test(name))
const parseJson = (bundle: Bundle, name: string): unknown => { try { return JSON.parse(bundle.read(name)) } catch { return undefined } }
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined)

/** نصوصٌ تحت مفاتيحَ مسمّاةٍ في أيّ عمق (مسقوفة) — لملفّات ذاكرةٍ لا نعرف شكلها بيقين. */
const deepStrings = (value: unknown, keys: ReadonlySet<string>, out: string[] = [], depth = 0): string[] => {
  if (out.length >= 2000 || depth > 8) return out
  if (typeof value === "string" && depth === 0) { out.push(value); return out }
  if (Array.isArray(value)) { for (const item of value) { if (typeof item === "string") out.push(item); else deepStrings(item, keys, out, depth + 1) } return out }
  const obj = record(value)
  if (obj === undefined) return out
  for (const [key, child] of Object.entries(obj)) {
    if (typeof child === "string" && keys.has(key.toLowerCase())) out.push(child)
    else if (typeof child === "object" && child !== null) deepStrings(child, keys, out, depth + 1)
  }
  return out
}

/** نصُّ المستخدم داخل `user_editable_context`: ChatGPT يلفّه بتمهيدٍ ثابت ثمّ ``` نصّ ``` — نأخذ آخرَ كتلةٍ مسيّجة. */
export const unwrapChatGptContext = (value: string): string => {
  const blocks = [...value.matchAll(/```([\s\S]*?)```/gu)]
  return (blocks.length > 0 ? blocks[blocks.length - 1]![1]! : value).trim()
}

const MEMORY_FILE = /(?:^|\/)(?:memories|memory|model_set_context)[^/]*\.json$/iu
const MEMORY_KEYS = new Set(["content", "text", "memory", "value", "conversations_memory"])

export function readChatGptBundle(bundle: Bundle): { raw: RawImportItem[]; found: string[] } {
  const raw: RawImportItem[] = []
  const found: string[] = []
  const conversations = named(bundle, /(?:^|\/)conversations\.json$/iu)
  let profile: { text: string; at: number } | undefined, instructions: { text: string; at: number } | undefined
  const profileVersions = new Set<string>(), instructionVersions = new Set<string>()
  const bio: string[] = []
  let conversationCount = 0
  for (const name of conversations) {
    const parsed = parseJson(bundle, name)
    if (!Array.isArray(parsed)) { found.push(`${name}: ليس قائمةَ محادثات JSON`); continue }
    for (const conversation of parsed) {
      conversationCount += 1
      const mapping = record(record(conversation)?.mapping)
      if (mapping === undefined) continue
      for (const node of Object.values(mapping)) {
        const message = record(record(node)?.message)
        const content = record(message?.content)
        if (message === undefined || content === undefined) continue
        const at = typeof message.create_time === "number" ? message.create_time : 0
        if (content.content_type === "user_editable_context") {
          if (typeof content.user_profile === "string" && content.user_profile.trim()) {
            const text = unwrapChatGptContext(content.user_profile)
            profileVersions.add(text)
            if (profile === undefined || at >= profile.at) profile = { text, at }
          }
          if (typeof content.user_instructions === "string" && content.user_instructions.trim()) {
            const text = unwrapChatGptContext(content.user_instructions)
            instructionVersions.add(text)
            if (instructions === undefined || at >= instructions.at) instructions = { text, at }
          }
        }
        if (message.recipient === "bio") {
          const parts = Array.isArray(content.parts) ? content.parts.filter((p): p is string => typeof p === "string") : typeof content.text === "string" ? [content.text] : []
          const text = parts.join("\n").trim()
          if (text) bio.push(text)
        }
      }
    }
  }
  if (conversations.length === 0) found.push("conversations.json: غير موجود في هذا التصدير")
  else found.push(`conversations.json: ${conversationCount} محادثة`)
  const when = (at: number) => (at > 0 ? ` (${new Date(at * 1000).toISOString().slice(0, 10)})` : "")
  if (profile !== undefined) {
    for (const item of itemsFromMarkdown(profile.text)) raw.push({ text: item, agent: "chatgpt", origin: "ChatGPT › التخصيص › عنك (user_profile)" })
    found.push(`«عنك» (user_profile): وُجد${when(profile.at)}${profileVersions.size > 1 ? ` — ${profileVersions.size} نسخ، أُخذت الأحدث` : ""}`)
  } else found.push("«عنك» (user_profile): غير موجود في المحادثات المصدَّرة")
  if (instructions !== undefined) {
    for (const item of itemsFromMarkdown(instructions.text)) raw.push({ text: item, agent: "chatgpt", origin: "ChatGPT › التخصيص › أسلوب الردّ (user_instructions)" })
    found.push(`«كيف يردّ» (user_instructions): وُجد${when(instructions.at)}${instructionVersions.size > 1 ? ` — ${instructionVersions.size} نسخ، أُخذت الأحدث` : ""}`)
  } else found.push("«كيف يردّ» (user_instructions): غير موجود في المحادثات المصدَّرة")
  for (const text of bio) raw.push({ text, agent: "chatgpt", origin: "ChatGPT › الذاكرة (recipient=bio)" })
  found.push(bio.length > 0 ? `الذاكرة (رسائل bio): ${bio.length}` : "الذاكرة (رسائل bio): لا شيء في المحادثات المصدَّرة — الذاكرةُ المحفوظة قبل التصدير قد لا تظهر؛ استعمل تبويب اللصق")
  for (const name of named(bundle, MEMORY_FILE)) {
    const texts = deepStrings(parseJson(bundle, name), MEMORY_KEYS)
    for (const text of texts) for (const item of itemsFromMarkdown(text)) raw.push({ text: item, agent: "chatgpt", origin: `ChatGPT › ${name}` })
    found.push(`${name}: ${texts.length} نصّاً`)
  }
  if (named(bundle, /(?:^|\/)user\.json$/iu).length > 0) found.push("user.json: حقولُ حسابٍ فقط (بريد/هاتف) — لم يُستورد")
  return { raw, found }
}

export function readClaudeBundle(bundle: Bundle): { raw: RawImportItem[]; found: string[] } {
  const raw: RawImportItem[] = []
  const found: string[] = []
  const projectNames = new Map<string, string>()
  const projects = named(bundle, /(?:^|\/)projects\.json$/iu)
  for (const name of projects) {
    const parsed = parseJson(bundle, name)
    const list = Array.isArray(parsed) ? parsed : []
    let withInstructions = 0
    for (const item of list) {
      const project = record(item)
      if (project === undefined) continue
      const title = typeof project.name === "string" ? squash(project.name).slice(0, 60) : "مشروع"
      if (typeof project.uuid === "string") projectNames.set(project.uuid, title)
      if (typeof project.prompt_template === "string" && project.prompt_template.trim()) {
        withInstructions += 1
        for (const line of itemsFromMarkdown(project.prompt_template)) raw.push({ text: `[${title}] ${line}`, agent: "claude", origin: `Claude › ${name} › ${title} › prompt_template` })
      }
    }
    found.push(`${name}: ${list.length} مشروعاً، ${withInstructions} منها بتعليمات (prompt_template)`)
  }
  if (projects.length === 0) found.push("projects.json: غير موجود في هذا التصدير")
  const memories = named(bundle, MEMORY_FILE)
  for (const name of memories) {
    const parsed = parseJson(bundle, name)
    let count = 0
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const obj = record(entry)
      if (obj !== undefined && typeof obj.conversations_memory === "string") {
        for (const line of itemsFromMarkdown(obj.conversations_memory)) { raw.push({ text: line, agent: "claude", origin: `Claude › ${name} › conversations_memory` }); count += 1 }
      }
      const perProject = obj?.project_memories
      const pairs: [string, unknown][] = Array.isArray(perProject) ? perProject.map((v, i) => [String(i), v]) : Object.entries(record(perProject) ?? {})
      for (const [id, value] of pairs) {
        const title = projectNames.get(id) ?? (record(value) && typeof record(value)!.name === "string" ? String(record(value)!.name) : "")
        for (const text of deepStrings(value, MEMORY_KEYS)) for (const line of itemsFromMarkdown(text)) { raw.push({ text: title ? `[${title}] ${line}` : line, agent: "claude", origin: `Claude › ${name} › project_memories` }); count += 1 }
      }
      if (obj === undefined || (obj.conversations_memory === undefined && perProject === undefined)) {
        for (const text of deepStrings(entry, MEMORY_KEYS)) for (const line of itemsFromMarkdown(text)) { raw.push({ text: line, agent: "claude", origin: `Claude › ${name}` }); count += 1 }
      }
    }
    found.push(`${name}: ${count} بنداً من الذاكرة`)
  }
  if (memories.length === 0) found.push("ملفّ الذاكرة (memories.json): غير موجود في هذا التصدير — انسخ ذاكرةَ Claude من إعداداته والصقها في تبويب اللصق")
  if (named(bundle, /(?:^|\/)conversations\.json$/iu).length > 0) found.push("conversations.json: محادثات — لا تُستورد (ليست تفضيلات)")
  if (named(bundle, /(?:^|\/)users\.json$/iu).length > 0) found.push("users.json: حقولُ حسابٍ فقط — لم يُستورد")
  return { raw, found }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }
const htmlLines = (html: string): string[] =>
  html.replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, " ").replace(/<br\s*\/?>|<\/(?:div|p|li|tr|h\d)>/giu, "\n").replace(/<[^>]+>/gu, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, code: string) => code.startsWith("#x") || code.startsWith("#X") ? String.fromCodePoint(Number.parseInt(code.slice(2), 16)) : code.startsWith("#") ? String.fromCodePoint(Number.parseInt(code.slice(1), 10)) : ENTITIES[code.toLowerCase()] ?? whole)
    .split("\n").map(squash).filter(Boolean)
const REMEMBER = /^(?:please\s+)?(?:remember(?:\s+that)?|don'?t forget(?:\s+that)?|save (?:this|that)|note that|from now on|always)\b[\s,:]*|^(?:رجاءً?\s+)?(?:تذكّر|تذكر|احفظ|لا تنس(?:َ|ى)?|من الآن(?:\s+فصاعدًا|\s+فصاعدا)?|دائمًا|دائما)(?=[\s,:،؛]|$)[\s,:،؛]*/iu
/** ما يُقصّ من أوّل الطلب: فعلُ «تذكّر» وحده — «دائماً/من الآن» جزءٌ من المعنى فيبقى. */
const REMEMBER_VERB = /^(?:please\s+)?(?:remember(?:\s+that)?|don'?t forget(?:\s+that)?|save (?:this|that)|note that)\b[\s,:]*|^(?:رجاءً?\s+)?(?:تذكّر|تذكر|احفظ|لا تنس(?:َ|ى)?)(?:\s+أنّ|\s+أن|\s+ان)?(?=[\s,:،؛]|$)[\s,:،؛]*/iu
const PROMPTED =/^(?:Prompted|طلب|تم الطلب|Asked)\s*[:：]?\s*/iu

export function readGeminiBundle(bundle: Bundle): { raw: RawImportItem[]; found: string[] } {
  const raw: RawImportItem[] = []
  const found: string[] = []
  const saved = named(bundle, /saved[ _-]?info|(?:^|\/)gems?\b/iu)
  for (const name of saved) {
    const texts = /\.json$/iu.test(name) ? deepStrings(parseJson(bundle, name), new Set(["text", "content", "instruction", "instructions", "description"])) : htmlLines(bundle.read(name))
    for (const text of texts) for (const line of itemsFromMarkdown(text)) raw.push({ text: line, agent: "gemini", origin: `Gemini › ${name}` })
    found.push(`${name}: ${texts.length} نصّاً`)
  }
  if (saved.length === 0) found.push("«المعلومات المحفوظة» (Saved info): غير موجودة في هذا التصدير — Takeout لا يحملها عادةً؛ انسخها من إعدادات Gemini والصقها في تبويب اللصق")
  const activity = named(bundle, /gemini[^/]*\/[^/]*activity[^/]*\.(?:json|html?)$|myactivity\.(?:json|html?)$/iu).filter((name) => /gemini/iu.test(name) || bundle.names.length === 1)
  for (const name of activity) {
    let prompts: string[] = []
    if (/\.json$/iu.test(name)) {
      const parsed = parseJson(bundle, name)
      prompts = (Array.isArray(parsed) ? parsed : []).flatMap((entry) => { const title = record(entry)?.title; return typeof title === "string" ? [title] : [] }).map((title) => title.replace(PROMPTED, ""))
    } else prompts = htmlLines(bundle.read(name)).filter((line) => PROMPTED.test(line)).map((line) => line.replace(PROMPTED, ""))
    const remembered = prompts.map((p) => p.trim()).filter((p) => REMEMBER.test(p)).map((p) => p.replace(REMEMBER_VERB, "").trim()).filter(Boolean)
    for (const text of remembered) raw.push({ text, agent: "gemini", origin: `Gemini › ${name} › طلبُ «تذكّر»` })
    found.push(`${name}: ${prompts.length} طلباً، منها ${remembered.length} تبدأ بـ«تذكّر/remember»`)
  }
  if (activity.length === 0) found.push("سجلّ نشاط Gemini (My Activity): غير موجود في هذا التصدير")
  return { raw, found }
}

export type ExportVendor = "chatgpt" | "claude" | "gemini"
export function readExport(path: string, vendor: ExportVendor): { raw: RawImportItem[]; found: string[] } {
  const bundle = openBundle(path)
  const result = vendor === "chatgpt" ? readChatGptBundle(bundle) : vendor === "claude" ? readClaudeBundle(bundle) : readGeminiBundle(bundle)
  return { raw: result.raw, found: [`${basename(path)}: ${bundle.names.length} ملفّاً`, ...result.found] }
}

// ---------------------------------------------------------------------------
// الحفظ — بعد نقرة المراجعة وحدها، إلى المالك القائم
// ---------------------------------------------------------------------------

export interface SaveOutcome {
  readonly saved: readonly { readonly id: string; readonly title: string }[]
  readonly skipped: readonly { readonly text: string; readonly why: string }[]
}

/** عنوانٌ ثابتٌ للبند نفسِه: إعادةُ الاستيراد تحدّث الملاحظةَ لا تكرّرها (المفتاحُ owner-note:<العنوان>). */
export const importTitle = (agent: ImportAgent, text: string): string => {
  const head = squash(text)
  const hash = createHash("sha256").update(dedupeKey(text)).digest("hex").slice(0, 6)
  return `${IMPORT_AGENT_LABEL[agent]}: ${cap(head, 80)} #${hash}`
}

/**
 * يحفظ بنودَ المراجعة المختارة في ملاحظات المالك. المدخلُ من القشرة **غيرُ موثوق**: كلُّ بندٍ يُعاد فحصُه وحجبُه هنا
 * (البندُ المعدَّل قد يحمل ما لم يكن في المراجعة)، والحسّاسُ يحتاج مفتاح sensitiveMemoryEnabled كما في memory-note.
 */
export function saveImportedItems(store: SqliteFactStore, items: unknown, ctx: { readonly projectId: string; readonly allowSensitive: boolean; readonly maskEmails: boolean; readonly now?: number }): SaveOutcome {
  if (!Array.isArray(items) || items.length === 0) throw Error("لا بنودَ للحفظ — اختر بنداً واحداً على الأقلّ")
  if (items.length > IMPORT_LIMITS.saveItems) throw Error(`الحفظُ الواحد حتى ${IMPORT_LIMITS.saveItems} بنداً`)
  const now = ctx.now ?? Date.now()
  const importedAt = new Date(now).toISOString()
  const saved: { id: string; title: string }[] = []
  const skipped: { text: string; why: string }[] = []
  for (const input of items) {
    const item = record(input)
    const original = typeof item?.text === "string" ? squash(item.text) : ""
    if (original.length < IMPORT_LIMITS.itemMinChars || original.length > IMPORT_LIMITS.editedMaxChars) { skipped.push({ text: original.slice(0, 80), why: "نصٌّ فارغ أو خارج الحدود" }); continue }
    const agent: ImportAgent = (IMPORT_AGENTS as readonly string[]).includes(item?.agent as string) ? item!.agent as ImportAgent : "other"
    const category: ImportCategory = CATEGORIES.includes(item?.category as ImportCategory) ? item!.category as ImportCategory : "profile"
    const origin = typeof item?.origin === "string" ? cap(squash(item.origin), 300) : IMPORT_AGENT_LABEL[agent]
    const sensitive = item?.sensitive === true
    const red = redactImportText(original, ctx.maskEmails)
    if (red.blocked) { skipped.push({ text: original.slice(0, 80), why: "يحمل اعتماداً — الاعتماداتُ للخزنة لا للذاكرة" }); continue }
    if (sensitive && !ctx.allowSensitive) { skipped.push({ text: red.text.slice(0, 80), why: "حسّاس، وحفظُ الذاكرة الحسّاسة معطّل في الإعدادات" }); continue }
    const title = importTitle(agent, red.text)
    try {
      const fact = saveOwnerMemory(store, {
        projectId: ctx.projectId, title, text: red.text, sensitive, allowSensitive: ctx.allowSensitive, category,
        source: `owner-note:import:${agent}:${now}`, importedFrom: { agent, from: origin, importedAt },
      })
      saved.push({ id: fact.id, title })
    } catch (error) {
      skipped.push({ text: red.text.slice(0, 80), why: (error as Error).message.slice(0, 160) })
    }
  }
  return { saved, skipped }
}
