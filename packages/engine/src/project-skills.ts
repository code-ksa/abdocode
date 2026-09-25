/**
 * 🔴 **مهارةٌ تُكتب ولا تُقرأ ليست مهارة — إنّها ملفٌّ ميّت.**
 *
 * `skill save` يقطّر دوراً ناجحاً إلى `.abdo/skills/<اسم>/SKILL.md` منذ 09-16.
 * و`skill list` يقرأ **حزمَ الامتدادات المفعَّلة وحدها** — فما قطّره الوكيلُ أمسِ
 * لا يظهر له اليوم، ولا يُذكر في السطر الذي يراه النموذج. الحلقةُ مفتوحة: نكتب
 * ولا نعود. وهذا بالضبط نمطُنا المتكرّر: **ما لا يُعرض لا يُطلَب**.
 *
 * فهذه الوحدةُ النصفُ الغائب: تقرأ مهاراتِ المشروع من قرصه، وتُسمّيها مصدرَها
 * (`project/<اسم>`) كي لا تختلط بحزمةٍ مُوقَّعة، وتُسلّمها للسرد وللتحميل.
 *
 * الوحدةُ **خالصةٌ من السياسة**: تقرأ ما في المجلّد وتعيده. البوّابةُ والقفلُ
 * وحارسُ الاعتمادات في المحرّك حيث هي لبقيّة المهارات — لا بابَ ثانياً.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** الاسمُ نفسُه الذي يقبله `skill save` — فما لا يستطيع كتابتَه لا يُقرأ. */
export const PROJECT_SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/u
export const PROJECT_SKILL_PREFIX = "project/"
const MAX_BODY = 64 * 1024
const MAX_SKILLS = 200

export interface ProjectSkill {
  readonly ref: string
  readonly name: string
  readonly description: string
  readonly file: string
}

/** الوصفُ من صدر الملفّ: سطرُ `> ...` إن وُجد، وإلا أوّلُ سطرٍ غيرِ عنوانٍ ولا فارغ. */
const describe = (markdown: string): string => {
  const lines = markdown.split(/\r?\n/u, 40)
  for (const line of lines) {
    const quoted = /^>\s*(.+)$/u.exec(line.trim())
    if (quoted !== null) return quoted[1].trim().slice(0, 200)
  }
  for (const line of lines) {
    const text = line.trim()
    if (text.length === 0 || text.startsWith("#") || text.startsWith("```")) continue
    return text.slice(0, 200)
  }
  return ""
}

/** مهاراتُ هذا المشروع وحدَه — مرتّبةً بالاسم كي يكون السردُ ثابتاً بين الأدوار. */
export function projectSkills(projectDir: string): ProjectSkill[] {
  const root = join(projectDir, ".abdo", "skills")
  if (!existsSync(root)) return []
  let entries: string[]
  try { entries = readdirSync(root) } catch { return [] }
  const out: ProjectSkill[] = []
  for (const name of entries.sort()) {
    if (out.length >= MAX_SKILLS) break
    if (!PROJECT_SKILL_NAME.test(name)) continue
    const file = join(root, name, "SKILL.md")
    try {
      if (!statSync(file).isFile()) continue
      const body = readFileSync(file, "utf8").slice(0, MAX_BODY)
      out.push({ ref: `${PROJECT_SKILL_PREFIX}${name}`, name, description: describe(body), file })
    } catch { /* مجلّدٌ بلا ملفّ، أو ملفٌّ لا يُقرأ — يُتخطّى ولا يُسقط السرد */ }
  }
  return out
}

/** هل هذا المرجعُ مهارةَ مشروع؟ */
export function isProjectSkillRef(ref: string): boolean {
  if (!ref.startsWith(PROJECT_SKILL_PREFIX)) return false
  return PROJECT_SKILL_NAME.test(ref.slice(PROJECT_SKILL_PREFIX.length))
}

/**
 * جسمُ مهارةِ مشروعٍ بمرجعها — أو رفضٌ **مسمّى**.
 * والاسمُ يُفحص قبل لمس القرص: مرجعٌ فيه `..` أو فاصلُ مسارٍ لا يصل `join` أصلاً.
 */
export function projectSkillBody(projectDir: string, ref: string): string {
  if (!isProjectSkillRef(ref)) throw Error(`مرجعُ مهارةِ المشروع يكون project/<اسم>، وجاء «${ref.slice(0, 40)}».`)
  const name = ref.slice(PROJECT_SKILL_PREFIX.length)
  const file = join(projectDir, ".abdo", "skills", name, "SKILL.md")
  if (!existsSync(file)) throw Error(`لا مهارةَ «${name}» في هذا المشروع (.abdo/skills/${name}/SKILL.md).`)
  return readFileSync(file, "utf8").slice(0, MAX_BODY)
}
