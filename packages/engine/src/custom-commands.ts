/**
 * الأوامرُ المائلة المخصّصة — الفجوة #5 في جدول 2026-09-27 (Claude Code: ‎`.claude/commands/*.md`‎؛ Codex: prompts).
 *
 * ملفُّ Markdown يصير أمراً: ‎`.abdo/commands/<اسم>.md`‎ في المشروع، أو ‎`~/.abdo/commands/<اسم>.md`‎ للمستخدم (المشروعُ يغلب).
 * `/اسم وسائط` في المُركِّب يُبدَّل بنصّ الملفّ، و`$ARGUMENTS` فيه بالوسائط (أو تُلحق بآخره إن لم يرد). ترويسةٌ اختياريّة
 * `description:` تظهر في لوحة «/».
 *
 * الأمرُ **نصُّ طلب** لا شيفرة: يمرّ بعد ذلك بكلّ البوّابات كأيّ طلبٍ كتبه المستخدم، ولا يمنح إذناً. والاسمُ المحجوز
 * (`skill` للمهارات) وما لا ملفَّ له يبقيان كما كُتبا — «/usr/bin» ليس أمراً.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROJECT_COMMANDS_DIR = ".abdo/commands"
export const userCommandsDir = (): string => join(homedir(), ".abdo", "commands")
const NAME = /^[\p{L}\p{N}_-]{1,40}$/u
const RESERVED = new Set(["skill"])
const MAX_BODY = 16_000

export interface CustomCommand { readonly name: string; readonly description: string; readonly source: "project" | "user"; readonly path: string }

const parse = (raw: string): { readonly description: string; readonly body: string } => {
  const text = raw.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n")
  const front = /^---\n([\s\S]*?)\n---\n?/u.exec(text)
  if (front === null) return { description: "", body: text.trim() }
  const description = /^description:\s*(.+)$/mu.exec(front[1]!)?.[1]?.trim().replace(/^["']|["']$/gu, "") ?? ""
  return { description: description.slice(0, 160), body: text.slice(front[0].length).trim() }
}

const scan = (dir: string, source: CustomCommand["source"]): CustomCommand[] => {
  if (!existsSync(dir)) return []
  const out: CustomCommand[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".md")) continue
    const name = entry.slice(0, -3)
    if (!NAME.test(name) || RESERVED.has(name.toLowerCase())) continue
    const path = join(dir, entry)
    try { if (!statSync(path).isFile() || statSync(path).size > MAX_BODY * 4) continue } catch { continue }
    out.push({ name, description: parse(readFileSync(path, "utf8")).description, source, path })
  }
  return out
}

/** أوامرُ المشروع ثمّ المستخدم، والاسمُ المكرّر للمشروع. مرتّبةٌ بالاسم. */
export function listCustomCommands(projectDir: string, userDir: string = userCommandsDir()): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  for (const command of scan(userDir, "user")) byName.set(command.name.toLowerCase(), command)
  for (const command of scan(join(projectDir, PROJECT_COMMANDS_DIR), "project")) byName.set(command.name.toLowerCase(), command)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** `/اسم وسائط` ⇦ نصُّ الأمر موسَّعاً، أو `undefined` إن لم يكن أمراً مخصّصاً معروفاً (يبقى النصُّ كما كُتب). */
export function expandCustomCommand(body: string, projectDir: string, userDir: string = userCommandsDir()): { readonly name: string; readonly source: CustomCommand["source"]; readonly body: string } | undefined {
  const match = /^\/([\p{L}\p{N}_-]{1,40})(?:\s+([\s\S]*))?$/u.exec(body.trim())
  if (match === null) return undefined
  const command = listCustomCommands(projectDir, userDir).find((c) => c.name.toLowerCase() === match[1]!.toLowerCase())
  if (command === undefined) return undefined
  const args = (match[2] ?? "").trim()
  const template = parse(readFileSync(command.path, "utf8")).body.slice(0, MAX_BODY)
  const expanded = template.includes("$ARGUMENTS") ? template.split("$ARGUMENTS").join(args) : args.length > 0 ? `${template}\n\n${args}` : template
  return { name: command.name, source: command.source, body: expanded }
}

export const commandUsedLine = (name: string, source: CustomCommand["source"]): string =>
  `⌘ أمرٌ مخصّص /${name} من ${source === "project" ? `${PROJECT_COMMANDS_DIR}/${name}.md` : `~/.abdo/commands/${name}.md`} — نصُّه طلبٌ يمرّ بالبوّابات نفسِها ولا يمنح إذناً.`
