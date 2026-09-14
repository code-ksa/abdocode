/**
 * المساراتُ المحميّة — **لا تُكتب ولو مُنحت الموافقة**.
 *
 * الفكرةُ من hermes-agent، والتنفيذُ والقائمةُ لنا. والفرقُ بينها وبين بوّابة
 * النمط جوهريّ: البوّابةُ تسأل المشغّلَ فيأذن أو يمنع؛ وهذه **لا تسأل**.
 * المشغّلُ لا يُوافق على كتابةٍ في `C:\\Windows\\System32` لأنه أرادها، بل
 * لأنّ الطلبَ جاءه في سياقِ عملٍ يثق به فضغط «موافق» — والموافقةُ على أثرٍ
 * لا يُسترجع ليست حمايةً منه. فما هنا يُرفض **قبل** أن يُرفع السؤال.
 *
 * وما يُحمى ليس «كلَّ ما خارج المشروع»: ذلك يمنع أعمالاً مشروعةً كثيرة
 * (كتابةُ ملفٍّ في مجلّد المستخدم مثلاً)، وحارسٌ يمنع كلَّ شيء يُطفأ أوّلَ يوم.
 * القائمةُ ضيّقةٌ ومسمّاة، وكلُّ بندٍ فيها يجيب: «ماذا يُكسر إن كُتب؟»
 *
 * **والتطبيعُ قبل الحكم**: مسارٌ يُحكم عليه بنصّه الخام يُلتفّ عليه بـ`..`
 * وبفاصلٍ مقلوب وبحالة أحرفٍ مختلفة. يُطبَّع أوّلاً ثمّ يُقارَن، والمقارنةُ
 * **بحدود المقاطع** لا بالبادئة النصّية: `C:\\WindowsApps` ليس داخل
 * `C:\\Windows`، ومنعُه خطأٌ يشبه السماح.
 *
 * خالصةٌ من الأثر: مسارٌ وبيئةٌ يدخلان وحكمٌ يخرج — لا قرصَ ولا `process`.
 */

export interface ProtectedVerdict {
  readonly allowed: boolean
  /** سببٌ يقرؤه المشغّل — رفضٌ بلا سببٍ يُجادَل ولا يُصلَح. */
  readonly why?: string
  /** اسمُ القاعدة التي حكمت — فالسجلُّ يقول أيَّ حارسٍ عمل. */
  readonly rule?: string
}

const ALLOWED: ProtectedVerdict = Object.freeze({ allowed: true })

/**
 * تطبيعٌ للمقارنة: فاصلٌ موحَّد، وطيُّ `.` و`..`، وحالةُ أحرفٍ موحَّدة.
 *
 * لا يُستعمل ناتجُ هذه الدالّة للكتابة أبداً — للمقارنة وحدها. وحالةُ الأحرف
 * تُطوى لأن نظام ملفات ويندوز لا يفرّق، فحارسٌ يفرّق يُلتفّ عليه بحرفٍ كبير.
 */
export const normalizeForCompare = (input: string): string => {
  const unified = input.replace(/\\/gu, "/").trim()
  const absolute = /^[a-zA-Z]:/u.test(unified) || unified.startsWith("/")
  const out: string[] = []
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") { if (out.length > 0) out.pop(); continue }
    out.push(part)
  }
  const joined = out.join("/")
  return (absolute && /^[a-zA-Z]:/u.test(unified) ? joined : absolute ? "/" + joined : joined).toLowerCase()
}

/**
 * هل `child` داخل `parent`؟ **بحدود المقاطع** لا بالبادئة النصّية.
 *
 * `startsWith` وحدَها تجعل `C:/WindowsApps` داخل `C:/Windows` — ومنعُ ما ليس
 * محميّاً عطلٌ كالسماح لما هو محميّ: كلاهما حارسٌ يقول غيرَ الحقيقة.
 */
export const isInside = (child: string, parent: string): boolean => {
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  if (p.length === 0) return false
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/")
}

/**
 * البيئةُ كما تصل — بفهرسٍ مفتوح لا بحقولٍ اختياريّةٍ وحدها.
 *
 * الحقولُ الاختياريّةُ وحدها تجعل النوعَ «ضعيفاً»، فيرفض TypeScript تمريرَ
 * `process.env` إليه (لا خاصّيةَ مشتركة). والفهرسُ المفتوح هو الصادق أيضاً:
 * البيئةُ خريطةُ نصوصٍ، وما نسمّيه منها هو ما نقرؤه لا ما تحويه.
 */
export type ProtectedEnv = Readonly<Record<string, string | undefined>>

/**
 * جذورٌ لا يُكتب فيها بحال. كلُّ بندٍ يجيب «ماذا يُكسر إن كُتب؟»:
 * نظامُ التشغيل نفسُه، وما يُثبَّت للجميع، وبيتُ خزنتنا.
 */
const systemRoots = (env: ProtectedEnv): readonly { readonly path: string; readonly rule: string; readonly why: string }[] => {
  const rows: { path: string; rule: string; why: string }[] = []
  const push = (path: string | undefined, rule: string, why: string) => {
    if (typeof path === "string" && path.trim().length > 0) rows.push({ path, rule, why })
  }
  push(env.SystemRoot ?? env.windir, "system-root", "جذرُ نظام التشغيل — كتابةٌ فيه تكسر الجهاز لا المشروع")
  push(env.ProgramFiles, "program-files", "مُثبَّتاتُ الجهاز لكلّ المستخدمين")
  push(env["ProgramFiles(x86)"], "program-files", "مُثبَّتاتُ الجهاز لكلّ المستخدمين")
  push(env.ProgramData, "program-data", "بياناتُ برامجَ مشتركةٌ بين المستخدمين")
  // بيتُ الخزنة: لا يُكتب من أداةٍ أبداً — الطريقُ إليه أمرُ الخزنة وحده.
  if (typeof env.APPDATA === "string" && env.APPDATA.trim().length > 0) {
    rows.push({ path: `${env.APPDATA}/abdocode`, rule: "vault-home", why: "بيتُ الخزنة — يُكتب بأمر الخزنة وحده لا بأداةِ ملفّات" })
  }
  return Object.freeze(rows)
}

/**
 * مساراتٌ محميّةٌ **داخل** المشروع نفسه. هذه هي التي تُنسى: الحارسُ يُبنى
 * لِما خارج المشروع، ثمّ يُكتب خطّافُ git داخله فيُنفَّذ في أوّل إيداعٍ بلا
 * موافقةٍ أصلاً — أثرٌ مؤجَّلٌ يلتفّ حول البوّابة كلِّها.
 */
const INSIDE_PROJECT: readonly { readonly suffix: string; readonly rule: string; readonly why: string }[] = Object.freeze([
  { suffix: ".git/hooks", rule: "git-hooks", why: "خطّافُ git يُنفَّذ لاحقاً بلا موافقة — كتابتُه تنفيذٌ مؤجَّل" },
  { suffix: ".git/config", rule: "git-config", why: "إعدادُ git يوجّه الريموت والخطّافات — تغييرُه يحوّل الدفع إلى وجهةٍ أخرى" },
])

/**
 * الحكم. `projectDir` يُمرَّر ولا يُقرأ من البيئة — فالوحدةُ خالصةٌ وتُختبر.
 */
export function protectedPathVerdict(
  target: string,
  projectDir: string,
  env: ProtectedEnv,
): ProtectedVerdict {
  const path = typeof target === "string" ? target.trim() : ""
  if (path.length === 0) return Object.freeze({ allowed: false, why: "مسارٌ فارغ", rule: "empty" })

  for (const row of INSIDE_PROJECT) {
    if (isInside(path, `${projectDir}/${row.suffix}`)) {
      return Object.freeze({ allowed: false, why: row.why, rule: row.rule })
    }
  }
  for (const row of systemRoots(env)) {
    if (isInside(path, row.path)) return Object.freeze({ allowed: false, why: row.why, rule: row.rule })
  }
  return ALLOWED
}


// ---------------------------------------------------------------------------
// سطحُ الأوامر — الحدُّ الثاني، وحدُّه مُعلَن
// ---------------------------------------------------------------------------

/**
 * أفعالُ كتابةٍ في PowerShell/cmd. الحضورُ وحده لا يكفي للرفض: يلزم معه
 * **مسارٌ محميّ**. فالقراءةُ من `C:\Windows` مشروعةٌ تماماً، والمنعُ الأعمى
 * لكلّ ذكرٍ لها يجعل الحارسَ يُطفأ في أوّل يوم.
 */
const WRITE_VERBS = /\b(?:Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Set-Acl|icacls|attrib|del|erase|rd|rmdir|mkdir|takeown)\b|>>?\s*(?![>&])/iu

/**
 * مساراتٌ يذكرها أمر. استخراجٌ **تقريبيّ** عن قصد: هدفُه التقاطُ ما يُكتب
 * إليه صراحةً، لا محاكاةُ مُفسِّر الصدفة.
 */
export const pathsInCommand = (cmd: string): readonly string[] => {
  const found = new Set<string>()
  // مسارُ ويندوز مطلق، مقتبساً أو عارياً.
  for (const m of cmd.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'|([A-Za-z]:[\\/][^\s"';|&,)]*)/gu)) {
    const value = m[1] ?? m[2] ?? m[3]
    if (typeof value === 'string' && value.length > 0) found.add(value)
  }
  // بيتُ المستخدم.
  for (const m of cmd.matchAll(/(~[\\/][^\s"';|&,)]*)/gu)) found.add(m[1]!)
  return Object.freeze([...found])
}

/**
 * حكمُ الأمر: يُرفض حين يجتمع **فعلُ كتابةٍ ومسارٌ محميّ**.
 *
 * ⚠ **حدُّه مُعلَن ولا يُدّعى غيرُه**: هذا استدلالٌ على نصّ الأمر، لا حَكَمٌ
 * كاملٌ على ما سيكتبه. أمرٌ يبني مسارَه من متغيّرٍ أو يفكّ ترميزاً لا يُرى
 * هنا. الحارسُ الحاكمُ يبقى عند طبقة أدوات الملفّات؛ وهذا يغلق البابَ الواسعَ
 * الظاهر — والبابُ الضيّقُ يبقى مفتوحاً ويُقال إنه مفتوح.
 */
export function protectedCommandVerdict(
  cmd: string,
  projectDir: string,
  env: ProtectedEnv,
): ProtectedVerdict {
  if (!WRITE_VERBS.test(cmd)) return ALLOWED
  for (const candidate of pathsInCommand(cmd)) {
    const said = protectedPathVerdict(candidate, projectDir, env)
    if (!said.allowed) {
      return Object.freeze({
        allowed: false,
        why: `${said.why} (المسار «${candidate}» في أمرٍ يكتب)`,
        rule: said.rule,
      })
    }
  }
  return ALLOWED
}

/** أسماءُ القواعد — للاختبار وللسجلّ، فلا تُكتب سلاسلُ أسماءٍ في موضعين. */
export const PROTECTED_RULES = Object.freeze([
  "empty", "git-hooks", "git-config", "system-root", "program-files", "program-data", "vault-home",
] as const)
