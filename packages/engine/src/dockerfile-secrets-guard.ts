/**
 * 10-08 (مقيس في بروفة النشر): Dockerfile فيه `COPY . .` في مشروعٍ له .env ولا .dockerignore ⇦ المفاتيحُ تُخبز في الصورة
 * (وكلُّ من يحمل الصورةَ يقرؤها بـdocker history/run). يُرفض قبل الكتابة بسببٍ مسمّى وطريقٍ واضح؛ وما لا ينسخ المشروعَ كلَّه يمرّ.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const COPIES_CONTEXT = /^\s*(?:COPY|ADD)\s+(?:--[a-z-]+=\S+\s+)*\.\/?\s+\S+/imu

export function dockerfileSecretsViolation(projectDir: string, target: string, content: string): string | undefined {
  if (!/^(?:Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.Dockerfile)$/iu.test(basename(target.replace(/\\/gu, "/")))) return undefined
  if (!COPIES_CONTEXT.test(content)) return undefined
  let envFiles: string[] = []
  try { envFiles = readdirSync(projectDir).filter((n) => /^\.env(?:\.[\w.-]+)?$/iu.test(n) && !/\.(?:example|sample|template)$/iu.test(n)) } catch { return undefined }
  if (envFiles.length === 0) return undefined
  const ignore = existsSync(join(projectDir, ".dockerignore")) ? readFileSync(join(projectDir, ".dockerignore"), "utf8") : ""
  if (/^\s*\.env\*?\s*$/mu.test(ignore) || /^\s*\*\*\/\.env\*?\s*$/mu.test(ignore)) return undefined
  return `${basename(target)} ينسخ المشروعَ كلَّه إلى الصورة (COPY/ADD .) وفيه ${envFiles.join("، ")} ولا .dockerignore يستبعده — المفاتيحُ تُخبز في الصورة. ` +
    "اكتب أوّلاً .dockerignore فيه سطر «.env*» (ومعه node_modules و.git)، أو انسخ الملفّاتِ اللازمة بأسمائها؛ والأسرارُ تصل الخادمَ بـ deploy --env لا بالصورة."
}
