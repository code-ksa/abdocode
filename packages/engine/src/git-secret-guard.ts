/**
 * 10-08 (مقيس قبل إطلاق المهمّة الكاملة): مشروعٌ فيه `.env.bak-20260917` غيرُ مستبعَدٍ في .gitignore (يستبعد `.env` و`.env*.local` وحدهما)،
 * وله remote على GitHub — و`git add .` كان سيُدخل الملفَّ بقيمه إلى السجلّ، فيصير دفعُه تسريباً لا يُمحى. `git add` الذي سيُدرج ملفَّ أسرارٍ
 * غيرَ مستبعَد يُرفض باسم الملفّ وبالإصلاح (.gitignore)، قبل أن يُنفَّذ. ملفّاتُ المثال (.env.example…) تمرّ.
 */
import { basename } from "node:path"
import { isDotenvSecretFile } from "./dotenv-mask"

export function isSecretFileName(path: string): boolean {
  const name = basename(path.replace(/\\/gu, "/"))
  return isDotenvSecretFile(name) || /\.(?:pem|key|p12|pfx|keystore|jks)$/iu.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/u.test(name)
}

const GIT_ADD = /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?add\b([^;&|]*)/iu

/** `status` = خرجُ `git status --porcelain --untracked-files=all` في المشروع (المستبعَدُ غائبٌ عنه أصلاً). `undefined` = نظيف. */
export function secretStagingViolation(cmd: string, status: string): string | undefined {
  const m = GIT_ADD.exec(cmd)
  if (m === null) return undefined
  const args = m[1]!.trim().split(/\s+/u).filter((a) => a.length > 0)
  const paths = args.filter((a) => !a.startsWith("-")).map((a) => a.replace(/^["']|["']$/gu, "").replace(/\\/gu, "/").replace(/^\.\//u, ""))
  const broad = args.some((a) => a === "-A" || a === "--all" || a === "-u" || a === "--update") || paths.length === 0 || paths.some((p) => p === "." || p === "*" || p === ":/" || p === "")
  const candidates = status.split(/\r?\n/u).map((line) => line.slice(3).trim().replace(/^"|"$/gu, "")).filter((p) => p.length > 0 && isSecretFileName(p))
  const hit = candidates.filter((file) => broad || paths.some((p) => file === p || file.startsWith(`${p.replace(/\/$/u, "")}/`)))
  if (hit.length === 0) return undefined
  return `رُفض: git add سيُدرج ${hit.length === 1 ? "ملفَّ أسرار" : "ملفّاتِ أسرار"} غيرَ مستبعَد: ${hit.join("، ")} — قيمُه تدخل السجلّ ويصير الدفعُ تسريباً لا يُمحى. ` +
    `أضف إلى .gitignore سطرَي «.env*» و«!.env.example» (أو اسمَ الملفّ نفسَه)، واحفظ ما يلزم منه في الخزنة بـ secrets import ${hit[0]}، ثمّ أعد git add.`
}
