// نقلُ إضافات ومهارات مفتوحة (Apache-2.0) إلى حزم عبدو كود المضمَّنة — `extensions/bundled/<id>/`.
//
// المصادر (نسخٌ مثبّتةٌ على SHA في مجلّد `--upstream`): anthropics/claude-plugins-official (الإضافات التطويرية)،
// anthropics/knowledge-work-plugins (إضافات العمل)، anthropics/skills (المهارات). ما رخصتُه ليست Apache-2.0 **لا يُنقل**
// (claude-security ملكيّة؛ docx/pdf/pptx/xlsx ملكيّة) — يُسجَّل في التقرير ويُكتب له أصلٌ بديل عندنا.
//
// شكلُ الحزمة عندنا (Rust `Manifest` بـdeny_unknown_fields): abdocode-extension.json {schemaVersion:1,id(≤16 slug),name,version,
// description,skills:[dirs],mcpServers:[]} + skills/<name>/SKILL.md (name: slug ≤48 + description:). لا وكلاءَ ولا خطّافاتِ ولا
// أوامرَ في الحزمة: الأوامرُ تصير مهارات، والوكلاءُ يصيرون مهاراتٍ + ملفّاتِ `agents/*.agent.md` لدليل الوكلاء (STATE_ROOT/agents)،
// والخطّافاتُ تُسقَط بالتصميم (تنفيذٌ مؤجَّل بلا موافقة).
//
// الالتزام بالرخصة: LICENSE الأصليّ يُنسخ، وNOTICE.md يسمّي الأصل والـSHA والتعديل، وكلُّ ملفٍّ عُدِّل يحمل سطرَ تغيير (Apache §4b).
// وإعادةُ التسمية: «Claude Code» و«Anthropic» في النثر ⇦ «Abdo Code» (لا تُمسّ الرخصُ ولا الروابط ولا سطورُ حقوق النشر).
//
//   node scripts/port-plugins.mjs --upstream <dir> [--out extensions/bundled] [--report <file>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { execSync } from "node:child_process"

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const upstream = resolve(arg("--upstream", "upstream"))
const out = resolve(arg("--out", "extensions/bundled"))
const reportFile = arg("--report", join(out, "PORT-REPORT.md"))
const MAX_SKILL = 64 * 1024
const TEXT = /\.(md|txt|json|ya?ml|toml|py|js|mjs|ts|sh|ps1|html|css|csv|xml|svg)$/i

const sha = (repo) => { try { return execSync("git rev-parse HEAD", { cwd: join(upstream, repo), encoding: "utf8" }).trim() } catch { return "unknown" } }
const SHAS = { "claude-plugins-official": sha("claude-plugins-official"), "knowledge-work-plugins": sha("knowledge-work-plugins"), skills: sha("skills") }

/** الإضافاتُ التطويرية — اسمُ الأصل ⇦ معرّفُنا (≤16) واسمُنا المعروض. */
const DEV = [
  ["agent-sdk-dev", "agent-sdk-dev", "Agent SDK dev"], ["claude-code-setup", "abdo-code-setup", "Abdo Code setup"], ["claude-md-management", "abdo-md-mgmt", "ABDO.md management"],
  ["code-modernization", "code-modernize", "Code modernization"], ["code-review", "code-review", "Code review"], ["code-simplifier", "code-simplifier", "Code simplifier"],
  ["commit-commands", "commit-commands", "Commit commands"], ["cwc-makers", "cwc-makers", "CWC makers"], ["explanatory-output-style", "explain-style", "Explanatory output style"],
  ["feature-dev", "feature-dev", "Feature dev"], ["frontend-design", "frontend-design", "Frontend design"], ["hookify", "hookify", "Hookify"],
  ["learning-output-style", "learning-style", "Learning output style"], ["math-olympiad", "math-olympiad", "Math olympiad"], ["mcp-server-dev", "mcp-server-dev", "MCP server dev"],
  ["mcp-tunnels", "mcp-tunnels", "MCP tunnels"], ["playground", "playground", "Playground"], ["plugin-dev", "plugin-dev", "Plugin dev"],
  ["pr-review-toolkit", "pr-review-kit", "PR review toolkit"], ["project-artifact", "project-artifact", "Project artifact"], ["ralph-loop", "ralph-loop", "Ralph loop"],
  ["rust-analyzer-lsp", "rust-lsp", "Rust analyzer LSP"], ["skill-creator", "skill-creator", "Skill creator"],
]
/** إضافاتُ العمل. */
const WORK = [
  ["design", "design", "Design"], ["productivity", "productivity", "Productivity"], ["marketing", "marketing", "Marketing"], ["engineering", "engineering", "Engineering"],
  ["data", "data", "Data"], ["finance", "finance", "Finance"], ["product-management", "product-mgmt", "Product management"], ["sales", "sales", "Sales"],
  ["operations", "operations", "Operations"], ["legal", "legal", "Legal"], ["enterprise-search", "ent-search", "Enterprise search"], ["small-business", "small-business", "Small business"],
  ["human-resources", "human-resources", "Human resources"], ["customer-support", "customer-support", "Customer support"], ["bio-research", "bio-research", "Bio research"],
  ["pdf-viewer", "pdf-viewer", "PDF viewer"],
]
/** المهاراتُ المفتوحة (Apache-2.0 لكلٍّ LICENSE.txt خاصّ) — تُجمع في حزمة abdo-skills. */
const SKILLS = ["canvas-design", "web-artifacts-builder", "mcp-builder", "theme-factory", "brand-guidelines", "internal-comms", "algorithmic-art", "slack-gif-creator", "skill-creator", "frontend-design", "webapp-testing"]
/** ما لا يُنقل — رخصةٌ ملكيّة (تُقرأ من الملفّ نفسِه لا من الذاكرة). */
const isApache = (file) => existsSync(file) && /Apache License\s+Version 2\.0/.test(readFileSync(file, "utf8"))

/** إعادةُ التسمية في النثر — لا تمسّ الروابط ولا سطور الحقوق ولا الرخص. */
const RENAMES = [
  [/\bClaude Code\b/g, "Abdo Code"], [/\bclaude code\b/g, "abdo code"], [/\bClaude Desktop\b/g, "Abdo Code Desktop"],
  [/\bCLAUDE\.md\b/g, "ABDO.md"], [/\bCLAUDE\.local\.md\b/g, "ABDO.local.md"], [/~\/\.claude\b/g, "~/.abdo"], [/\.claude\/(?=agents|commands|skills|settings|plugins)/g, ".abdo/"],
  [/\$\{CLAUDE_PLUGIN_ROOT\}/g, "${extension}"], [/\$CLAUDE_PLUGIN_ROOT\b/g, "${extension}"],
  [/\bAnthropic's\b/g, "Abdo Code's"], [/\bAnthropic\b(?![^\n]*(https?:\/\/|©|Copyright|All rights reserved|Apache))/g, "Abdo Code"],
  [/\bClaude\b(?![^\n]*(https?:\/\/|©|Copyright))/g, "Abdo Code"],
  [/\bthe Read tool\b/g, "the `read` tool"], [/\bthe Write tool\b/g, "the `write` tool"], [/\bthe Edit tool\b/g, "the `edit` tool"], [/\bthe Bash tool\b/g, "the `run` tool"],
  [/\bthe Grep tool\b/g, "the `grep` tool"], [/\bthe Glob tool\b/g, "the `glob` tool"], [/\bthe WebFetch tool\b/g, "the `fetch` tool"], [/\bthe WebSearch tool\b/g, "the `search` tool"],
  [/\bthe Task tool\b/g, "the `delegate` tool"], [/\bTodoWrite\b/g, "the plan board"],
]
const TOOL_MAP = { read: "read", write: "write", edit: "edit", multiedit: "edit", bash: "run", grep: "grep", glob: "glob", ls: "list", webfetch: "fetch", websearch: "search", task: "delegate", agent: "delegate", notebookread: "read", notebookedit: "edit", todowrite: "", lsp: "" }

const slug = (s, max) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "")
const frontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fields: {}, body: text, raw: "" }
  const fields = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const k = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!k) continue
    let value = k[2].trim()
    // كتلةُ YAML (> أو |) أو قيمةٌ فارغة: الأسطرُ التالية المُزاحة تُضمّ سطراً واحداً.
    if (/^[>|][-+]?$/.test(value) || value === "") {
      const acc = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) { acc.push(lines[i + 1].trim()); i += 1 }
      value = acc.join(" ")
    }
    fields[k[1].toLowerCase()] = value.replace(/^["']|["']$/g, "")
  }
  return { fields, body: text.slice(m[0].length), raw: m[1] }
}
const oneLine = (s, max = 900) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max)
const changeNote = (origin, rel) => `<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/${origin.repo}@${origin.sha.slice(0, 12)} ${rel} (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->`

/** نظافةُ البياض: بوّابةُ النشر (`git diff --check`) ترفض بياضاً زائداً في أيّ سطر — يُنزع من كلّ نصٍّ نكتبه (لا من الرخص المنسوخة كما هي). */
// وسطرٌ أخيرٌ واحد: «new blank line at EOF» يرفضه الفحصُ أيضاً.
const tidy = (text) => text.replace(/[ \t]+(?=\r?\n)/g, "").replace(/[ \t]+$/, "").replace(/(?:\r?\n)+$/, "\n")
const writeText = (file, text) => writeFileSync(file, tidy(String(text)))

function rename(text) {
  let t = tidy(text), n = 0
  // بصماتُ الصور والملفّات (hex ≥ 40 أو integrity base64) ليست أسراراً، لكنّ حارسَ الاعتماد في المحرّك يطابقها — تُستبدل بعلامةٍ مقروءة.
  t = t.replace(/\b(sha(?:256|384|512|1)[:-])[A-Za-z0-9+/=_-]{40,}/g, (m, head) => { n += 1; return `${head}<digest>` }).replace(/\b[0-9a-f]{40,64}\b/g, () => { n += 1; return "<digest>" })
  for (const [re, to] of RENAMES) t = t.replace(re, (m) => { n += 1; return typeof to === "string" ? to : to(m) })
  return { text: t, count: n }
}

function writeSkill(dir, name, description, body, origin, rel, stats) {
  const id = slug(name, 48)
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`skill id invalid: ${name}`)
  const { text, count } = rename(body)
  const described = rename(String(description || ""))
  stats.renamed += count + described.count
  let file = `---\nname: ${id}\ndescription: ${oneLine(described.text, 900) || id}\n---\n${changeNote(origin, rel)}\n${text.replace(/^\s+/, "")}`
  if (Buffer.byteLength(file) > MAX_SKILL) { file = file.slice(0, MAX_SKILL - 200) + "\n\n<!-- truncated to the 64KB skill limit; full text in the origin repository -->\n"; stats.truncated.push(`${basename(dir)}/${id}`) }
  if (/(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i.test(file)) stats.suspicious.push(`${basename(dir)}/${id}`)
  const skillDir = join(dir, "skills", id)
  mkdirSync(skillDir, { recursive: true })
  writeText(join(skillDir, "SKILL.md"), tidy(file))
  return { id, description: oneLine(description, 200) }
}

/** ينسخ ملفّات مهارةٍ مساندة (سكربتات/قوالب نصّية) دون الثنائيّات الكبيرة. */
function copySupport(srcDir, dstDir, stats) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "SKILL.md") continue
    const s = join(srcDir, entry.name), d = join(dstDir, entry.name)
    if (entry.isDirectory()) { mkdirSync(d, { recursive: true }); copySupport(s, d, stats); continue }
    // رخصُ الخطوط (…-OFL.txt) تُرافق خطوطاً لا نشحنها (ثنائيّات) — لا تُنسخ وحدها؛ THIRD_PARTY_NOTICES يبقى في الحزمة.
    if (!TEXT.test(entry.name) || statSync(s).size > 512 * 1024 || /-OFL\.txt$/i.test(entry.name)) { stats.skippedBinary.push(relative(upstream, s)); continue }
    const { text, count } = rename(readFileSync(s, "utf8"))
    stats.renamed += count
    writeText(d, text)
  }
}

function agentFile(dir, name, fields, body, origin, rel, stats) {
  const id = slug(name, 32)
  const tools = String(fields.tools || "").split(/[,\s\[\]"']+/).map((t) => TOOL_MAP[t.toLowerCase()] ?? "").filter(Boolean)
  const list = [...new Set(tools.length ? tools : ["read", "list", "glob", "grep"])]
  const { text } = rename(body)
  const trimmed = text.trim().slice(0, 3800)
  mkdirSync(join(dir, "agents"), { recursive: true })
  writeText(join(dir, "agents", `${id}.agent.md`), tidy(`---\nname: ${id}\ndescription: ${oneLine(fields.description, 220) || id}\ntools: ${list.join(", ")}\n---\n${changeNote(origin, rel)}\n${trimmed}${text.length > 3800 ? "\n\n<!-- trimmed to the 4000-char agent limit; the full text is the skill of the same name -->" : ""}\n`))
  return { id, tools: list }
}

function portPlugin(repo, srcName, id, displayName, kind, stats, base = "") {
  const src = join(upstream, repo, base, srcName)
  if (!existsSync(src)) { stats.missing.push(`${repo}/${srcName}`); return null }
  const licenseFile = existsSync(join(src, "LICENSE")) ? join(src, "LICENSE") : join(upstream, repo, "LICENSE")
  if (!isApache(licenseFile)) { stats.refused.push(`${repo}/${srcName} — license is not Apache-2.0 (${existsSync(licenseFile) ? readFileSync(licenseFile, "utf8").split(/\r?\n/).find((l) => l.trim()) : "no LICENSE"})`); return null }
  const origin = { repo, sha: SHAS[repo] }
  if (base) srcName = base + "/" + srcName
  const manifestFile = join(src, ".claude-plugin", "plugin.json")
  const meta = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : { name: srcName }
  const dir = join(out, id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const features = { skills: [], commands: [], agents: [], hooks: [], connectors: [], lsp: [], other: [] }
  // المهارات كما هي
  const skillsRoot = join(src, "skills")
  if (existsSync(skillsRoot)) for (const s of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!s.isDirectory()) continue
    const file = join(skillsRoot, s.name, "SKILL.md")
    if (!existsSync(file)) continue
    const { fields, body } = frontmatter(readFileSync(file, "utf8"))
    const rec = writeSkill(dir, fields.name || s.name, fields.description, body, origin, `skills/${s.name}/SKILL.md`, stats)
    copySupport(join(skillsRoot, s.name), join(dir, "skills", rec.id), stats)
    features.skills.push(rec)
  }
  // الأوامرُ تصير مهارات
  const commandsRoot = join(src, "commands")
  if (existsSync(commandsRoot)) for (const c of readdirSync(commandsRoot)) {
    if (!c.endsWith(".md")) continue
    const { fields, body } = frontmatter(readFileSync(join(commandsRoot, c), "utf8"))
    const name = `cmd-${c.replace(/\.md$/, "")}`
    const rec = writeSkill(dir, name, fields.description || `Command /${c.replace(/\.md$/, "")} ported as a skill`, body.replace(/\$ARGUMENTS/g, "(the user's request)"), origin, `commands/${c}`, stats)
    features.commands.push({ ...rec, command: `/${c.replace(/\.md$/, "")}` })
  }
  // الوكلاءُ: مهارةٌ كاملة + ملفُّ وكيل
  const agentsRoot = join(src, "agents")
  if (existsSync(agentsRoot)) for (const a of readdirSync(agentsRoot)) {
    if (!a.endsWith(".md")) continue
    const { fields, body } = frontmatter(readFileSync(join(agentsRoot, a), "utf8"))
    const name = fields.name || a.replace(/\.md$/, "")
    const rec = writeSkill(dir, `agent-${name}`, fields.description || `Agent ${name} instructions`, body, origin, `agents/${a}`, stats)
    const ag = agentFile(dir, name, fields, body, origin, `agents/${a}`, stats)
    features.agents.push({ ...rec, agent: ag.id, tools: ag.tools })
  }
  // الخطّافات تُسقَط وتُسجَّل
  for (const h of ["hooks/hooks.json", "hooks.json"]) if (existsSync(join(src, h))) { try { const j = JSON.parse(readFileSync(join(src, h), "utf8")); features.hooks.push(...Object.keys(j.hooks || j)) } catch { features.hooks.push(h) } }
  // موصّلات .mcp.json
  if (existsSync(join(src, ".mcp.json"))) { try { const j = JSON.parse(readFileSync(join(src, ".mcp.json"), "utf8")); for (const [k, v] of Object.entries(j.mcpServers || j)) features.connectors.push({ id: k, type: v.type || (v.command ? "stdio" : "?"), url: v.url || "", command: v.command ? [v.command, ...(v.args || [])].join(" ") : "" }) } catch { features.other.push(".mcp.json unreadable") } }
  if (existsSync(join(src, ".lsp.json"))) { try { const j = JSON.parse(readFileSync(join(src, ".lsp.json"), "utf8")); features.lsp.push(...Object.keys(j)) } catch { features.other.push(".lsp.json unreadable") } }
  for (const extra of ["README.md", "CONNECTORS.md"]) if (existsSync(join(src, extra))) { const { text } = rename(readFileSync(join(src, extra), "utf8")); writeText(join(dir, extra), `${changeNote(origin, extra)}\n${text}`) }
  cpSync(licenseFile, join(dir, "LICENSE"))
  const description = oneLine(rename(meta.description || `${displayName} for Abdo Code`).text, 1000)
  mergeOverlay(dir, id, features, stats)
  const manifest = { schemaVersion: 1, id, name: `${displayName} (Abdo Code)`, version: String(meta.version || "1.0.0"), description, skills: [...features.skills, ...features.commands, ...features.agents].map((s) => `skills/${s.id}`), mcpServers: [] }
  if (manifest.skills.length === 0) { stats.empty.push(id); manifest.skills = [] }
  writeText(join(dir, "abdocode-extension.json"), JSON.stringify(manifest, null, 2) + "\n")
  writeText(join(dir, "NOTICE.md"), `# NOTICE\n\nThis Abdo Code bundle is derived from **anthropics/${repo}** (directory \`${srcName}\`, commit \`${origin.sha}\`), licensed under the Apache License 2.0 (see LICENSE). Modified by TechnologyKSA on 2026-09-06: product names, paths and tool references adapted to Abdo Code; Claude Code commands and agents were converted into Abdo Code skills; hooks were dropped by design. Original copyright notices are retained. "Claude" and "Anthropic" are trademarks of Anthropic, PBC and are used here only to describe origin.\n`)
  writeText(join(dir, "FEATURES.md"), featuresDoc(displayName, id, kind, origin, srcName, features, manifest))
  return { id, name: displayName, kind, skills: features.skills.length, commands: features.commands.length, agents: features.agents.length, hooks: features.hooks.length, connectors: features.connectors.length }
}

function featuresDoc(displayName, id, kind, origin, srcName, f, manifest) {
  const L = []
  L.push(`# ${displayName} — ميزاتُ الحزمة المثبَتة`)
  L.push(``, `- **المعرّف**: \`${id}\` · **النوع**: ${kind} · **الإصدار**: ${manifest.version}`, `- **الأصل**: anthropics/${origin.repo} / \`${srcName}\` @ \`${origin.sha.slice(0, 12)}\` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)`, `- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة \`/skill ${id}/<المهارة>\` في أوّل سطرٍ من رسالتك`, ``)
  L.push(`## المهارات (${f.skills.length})`, ``); for (const s of f.skills) L.push(`- \`/skill ${id}/${s.id}\` — ${s.description}`); if (!f.skills.length) L.push(`- (لا مهاراتٍ مستقلّة في الأصل)`)
  L.push(``, `## الأوامرُ المنقولة مهاراتٍ (${f.commands.length})`, ``); for (const c of f.commands) L.push(`- ${c.command} ⇦ \`/skill ${id}/${c.id}\` — ${c.description}`); if (!f.commands.length) L.push(`- (لا أوامر)`)
  L.push(``, `## الوكلاء (${f.agents.length})`, ``); for (const a of f.agents) L.push(`- \`${a.agent}\` (أدوات: ${a.tools.join(", ")}) — نصُّه الكامل \`/skill ${id}/${a.id}\`، وملفُّه \`agents/${a.agent}.agent.md\` يُنسخ إلى دليل الوكلاء ليعمل بـ\`delegate ${a.agent} :: <المهمّة>\``); if (!f.agents.length) L.push(`- (لا وكلاء)`)
  L.push(``, `## الموصّلات التي يطلبها الأصل (${f.connectors.length})`, ``); for (const c of f.connectors) L.push(`- **${c.id}** — ${c.type}${c.url ? ` ${c.url}` : ""}${c.command ? ` \`${c.command}\`` : ""} — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس`); if (!f.connectors.length) L.push(`- (لا موصّلات)`)
  L.push(``, `## ما أُسقط بالتصميم`, ``)
  L.push(f.hooks.length ? `- الخطّافات (${f.hooks.join(", ")}): عبدو كود لا يشغّل تنفيذاً مؤجَّلاً بلا موافقة — تُستبدل ببوّابات القبول والدروس.` : `- لا خطّافات في الأصل.`)
  if (f.lsp.length) L.push(`- خوادم LSP (${f.lsp.join(", ")}): تُضبط من لوحة المطوّر عند توفّر أداة LSP في السجلّ.`)
  for (const o of f.other) L.push(`- ${o}`)
  L.push(``, `## الإثبات`, ``, `- تُفحص هذه الحزمة في \`extensions/test/bundled-extensions.test.ts\`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.`, ``)
  return L.join("\n")
}

/** طبقةُ أصولنا فوق المنقول: extensions/overlays/<id>/skills/<name>/SKILL.md — مهاراتٌ كتبناها لحزمٍ جاء أصلُها فارغاً أو ناقصاً. */
function mergeOverlay(dir, id, features, stats) {
  const overlay = join(out, "..", "overlays", id, "skills")
  if (!existsSync(overlay)) return
  for (const s of readdirSync(overlay, { withFileTypes: true })) {
    if (!s.isDirectory() || !existsSync(join(overlay, s.name, "SKILL.md"))) continue
    const { fields } = frontmatter(readFileSync(join(overlay, s.name, "SKILL.md"), "utf8"))
    mkdirSync(join(dir, "skills", s.name), { recursive: true })
    cpSync(join(overlay, s.name), join(dir, "skills", s.name), { recursive: true })
    features.skills.push({ id: fields.name || s.name, description: oneLine(fields.description, 200) + " (أصلُ عبدو كود)" })
    stats.overlaid = (stats.overlaid || 0) + 1
  }
}

function portSkillsBundle(stats) {
  const id = "abdo-skills"
  const dir = join(out, id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const origin = { repo: "skills", sha: SHAS.skills }
  const recs = []
  const licenses = []
  for (const s of SKILLS) {
    const src = join(upstream, "skills", "skills", s)
    const lic = join(src, "LICENSE.txt")
    if (!existsSync(src)) { stats.missing.push(`skills/${s}`); continue }
    if (!isApache(lic)) { stats.refused.push(`skills/${s} — LICENSE.txt is not Apache-2.0`); continue }
    const { fields, body } = frontmatter(readFileSync(join(src, "SKILL.md"), "utf8"))
    const rec = writeSkill(dir, fields.name || s, fields.description, body, origin, `skills/${s}/SKILL.md`, stats)
    copySupport(src, join(dir, "skills", rec.id), stats)
    licenses.push(`## ${s}\n\n${readFileSync(lic, "utf8").split(/\r?\n/).slice(0, 4).join("\n")}\n`)
    recs.push(rec)
  }
  const f0 = { skills: recs }
  mergeOverlay(dir, id, f0, stats)
  cpSync(join(upstream, "skills", "skills", SKILLS[0], "LICENSE.txt"), join(dir, "LICENSE"))
  if (existsSync(join(upstream, "skills", "THIRD_PARTY_NOTICES.md"))) writeText(join(dir, "THIRD_PARTY_NOTICES.md"), tidy(readFileSync(join(upstream, "skills", "THIRD_PARTY_NOTICES.md"), "utf8")))
  const manifest = { schemaVersion: 1, id, name: "Abdo Code skills (open set)", version: "1.0.0", description: "مهاراتٌ مفتوحة منقولة لعبدو كود: تصميمٌ على لوحة، منتجات ويب تفاعلية، بناءُ خوادم MCP، مصنعُ ثيمات، هويّةٌ بصرية، اتصالاتٌ داخلية، فنٌّ خوارزمي، صانعُ GIF لسلاك، صانعُ المهارات، تصميمُ الواجهات، واختبارُ تطبيقات الويب.", skills: recs.map((r) => `skills/${r.id}`), mcpServers: [] }
  writeText(join(dir, "abdocode-extension.json"), JSON.stringify(manifest, null, 2) + "\n")
  writeText(join(dir, "NOTICE.md"), `# NOTICE\n\nSkills in this bundle are derived from **anthropics/skills** (commit \`${SHAS.skills}\`); each skill is licensed under the Apache License 2.0 by Anthropic, PBC (per-skill LICENSE.txt in the origin; one copy kept as LICENSE here). Modified by TechnologyKSA on 2026-09-06: product names, paths and tool references adapted to Abdo Code. Bundled fonts and media of the origin were NOT copied (binary assets); THIRD_PARTY_NOTICES.md is carried forward for the tools some skills call (FFmpeg is GPLv3 and must stay an external dependency).\n\n${licenses.join("\n")}`)
  const f = { skills: recs, commands: [], agents: [], hooks: [], connectors: [], lsp: [], other: ["الخطوطُ والوسائط الثنائية للأصل لم تُنسخ (canvas-design/slack-gif-creator) — تُنزَّل عند الحاجة من الأصل."] }
  writeText(join(dir, "FEATURES.md"), featuresDoc("Abdo Code skills", id, "skills", origin, "skills/*", f, manifest))
  return { id, name: "Abdo Code skills", kind: "skills", skills: recs.length, commands: 0, agents: 0, hooks: 0, connectors: 0 }
}

const stats = { renamed: 0, truncated: [], suspicious: [], skippedBinary: [], missing: [], refused: [], empty: [] }
mkdirSync(out, { recursive: true })
const rows = []
for (const [srcName, id, name] of DEV) { const r = portPlugin("claude-plugins-official", srcName, id, name, "developer", stats, "plugins"); if (r) rows.push(r) }
for (const [srcName, id, name] of WORK) { const r = portPlugin("knowledge-work-plugins", srcName, id, name, "knowledge-work", stats); if (r) rows.push(r) }
rows.push(portSkillsBundle(stats))
const report = [`# تقرير النقل — ${new Date().toISOString().slice(0, 10)}`, ``, `المصادر: ${Object.entries(SHAS).map(([k, v]) => `anthropics/${k}@${v.slice(0, 12)}`).join(" · ")}`, ``, `| الحزمة | النوع | مهارات | أوامر⇦مهارات | وكلاء | خطّافات (أُسقطت) | موصّلات |`, `|---|---|---|---|---|---|---|`]
for (const r of rows) report.push(`| \`${r.id}\` ${r.name} | ${r.kind} | ${r.skills} | ${r.commands} | ${r.agents} | ${r.hooks} | ${r.connectors} |`)
report.push(``, `- إعاداتُ تسمية في النثر: ${stats.renamed}`, `- مرفوضٌ لرخصته: ${stats.refused.length ? stats.refused.map((x) => `\n  - ${x}`).join("") : "لا شيء"}`, `- مفقودٌ في الأصل: ${stats.missing.join(", ") || "لا شيء"}`, `- مهاراتٌ قُصّت إلى 64KB: ${stats.truncated.join(", ") || "لا شيء"}`, `- ملفّاتٌ فيها ما يشبه اعتماداً (تُراجع): ${stats.suspicious.join(", ") || "لا شيء"}`, `- حزمٌ بلا مهارات: ${stats.empty.join(", ") || "لا شيء"}`, `- ثنائيّاتٌ لم تُنسخ: ${stats.skippedBinary.length}`, `- مهاراتٌ من طبقة أصولنا: ${stats.overlaid || 0}`)
writeText(reportFile, report.join("\n") + "\n")
console.log(report.join("\n"))
