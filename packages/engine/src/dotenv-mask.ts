/**
 * 10-08 (مقيس في بروفة النشر): `read .env` أعاد `APP_SECRET=<القيمة>` كاملةً إلى النموذج السحابيّ وإلى سجلّ الأدوات — قبل أن يحفظها
 * `secrets import` في الخزنة بلا عرض. قيمُ ملفّات البيئة لا تدخل السياق: الأسماءُ تُرى (ليعرف النموذجُ ما يحتاجه المشروع)
 * والقيمُ تُحجب بطولها؛ وعرضُها بالصدفة (cat/type/Get-Content…) يُردّ إلى secrets import. ملفّاتُ المثال (.env.example) تُقرأ كما هي.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

const EXAMPLE = /\.(?:example|sample|template|dist|defaults?)$/iu

export function isDotenvSecretFile(path: string): boolean {
  const name = basename(path.replace(/\\/gu, "/"))
  return /^\.env(?:\.[\w.-]+)?$/iu.test(name) && !EXAMPLE.test(name)
}

export function maskDotenv(text: string): string {
  return text.split(/(\r?\n)/u).map((part) => {
    const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/u.exec(part)
    if (m === null || m[2]!.trim().length === 0) return part
    return `${m[1]}•••• (${m[2]!.trim().length} حرفاً — محجوبة)`
  }).join("")
}

export const DOTENV_MASK_NOTE = "ℹ قيمُ ملفّ البيئة محجوبة في السياق — الأسماءُ وحدها تُرى. لحفظها في الخزنة: secrets import <الملفّ>، والنشرُ بها: deploy <خادم> --env."

/** عرضُ ملفّ بيئةٍ بالصدفة — يُردّ إلى secrets import. `undefined` = نظيف. */
export function dotenvShellViolation(cmd: string): string | undefined {
  const m = /\b(?:cat|type|more|less|head|tail|gc|Get-Content|Select-String|sls|findstr|grep|strings)\b[^|;&]*?(?:^|[\s'"\\/])(\.env(?:\.[\w.-]+)?)(?=$|[\s'"|;&])/iu.exec(cmd)
  if (m === null || EXAMPLE.test(m[1]!)) return undefined
  return `رُفض عرضُ «${m[1]}» بالصدفة: قيمُه أسرارٌ تصل النموذجَ والسجلّ. read ${m[1]} يُريك الأسماءَ والقيمُ محجوبة، وsecrets import ${m[1]} يحفظها في الخزنة.`
}

const dotenvKeys = (text: string): string[] =>
  [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gmu)].map((m) => m[1]!)

/**
 * 10-08 (مقيس في بروفة النشر): لم يجد النموذجُ .env (glob أعمى عن الملفّات النقطيّة) فكتب واحداً جديداً بـPORT وحده — فسقط APP_SECRET
 * من ملفّ المستخدم بلا رجعة. كتابةُ ملفّ بيئةٍ موجود تُرفض إن أسقطت مفتاحاً فيه، أو حملت القيمةَ المحجوبة التي يراها النموذج («••••»)
 * بدل القيمة. الإضافةُ بـedit؛ والملفُّ الجديد يُكتب كما هو. `undefined` = نظيف.
 */
export function dotenvOverwriteViolation(absPath: string, after: string): string | undefined {
  if (!isDotenvSecretFile(absPath)) return undefined
  const name = basename(absPath.replace(/\\/gu, "/"))
  if (/••••/u.test(after)) return `«${name}» يحمل القيمةَ المحجوبة («••••») لا القيمة — كتابتُه تمحو الأسرار. أضف مفتاحاً بـedit، والقيمُ الموجودة تبقى كما هي`
  if (!existsSync(absPath)) return undefined
  let before: string
  try { before = readFileSync(absPath, "utf8") } catch { return `«${name}» موجودٌ ولا يُقرأ — لا يُكتب فوقه` }
  const kept = new Set(dotenvKeys(after))
  const dropped = [...new Set(dotenvKeys(before))].filter((k) => !kept.has(k))
  if (dropped.length === 0) return undefined
  return `«${name}» موجودٌ وكتابتُه تُسقط ${dropped.length === 1 ? "المفتاح" : "المفاتيح"}: ${dropped.join("، ")} — قيمُها أسرارٌ لا تُستعاد. read ${name} يُريك الأسماء، وedit يضيف مفتاحاً دون أن يمسّ غيره`
}
