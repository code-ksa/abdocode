/**
 * 09-29 — فخُّ الأقواس المربّعة في PowerShell: `Remove-Item -Recurse -Force 'src/app/models/[id]'` لا يحذف شيئاً لأنّ
 * `[id]` نمطُ wildcard في `-Path`، ومع `-ErrorAction SilentlyContinue` يخرج برمز 0 فيظنّ النموذجُ أنّ الحذفَ تمّ.
 * مقيس على مهمّة «تطبيق مثل OpenRouter» (نيموترون 550b): بقي `[id]` و`[...id]` معاً بعد «حذفٍ» أخضر.
 * الحكمُ من القرص لا من رمز الخروج: إن كان المسارُ المقتبَس يحمل قوساً وما زال موجوداً بعد الأمر، يُقال ذلك ويُسمّى العلاج.
 */

const DELETE_VERB = /\b(?:Remove-Item|rm|del|rmdir|ri|erase)\b/iu

/** المسارُ المقتبَس الأوّل بعد فعل الحذف حين يحمل قوساً مربّعاً ولم يُذكر `-LiteralPath`. */
export function bracketDeletePath(cmd: string): string | undefined {
  if (!DELETE_VERB.test(cmd) || /-LiteralPath\b/iu.test(cmd)) return undefined
  const verbAt = cmd.search(DELETE_VERB)
  const tail = cmd.slice(verbAt)
  const quoted = /['"]([^'"]*[\[\]][^'"]*)['"]/u.exec(tail)
  if (quoted !== null) return quoted[1]
  const bare = /(?:^|\s)(?:-Path\s+)?([^\s'"]*[\[\]][^\s'"]*)/u.exec(tail.replace(DELETE_VERB, ""))
  return bare?.[1]
}

/** ملاحظةٌ تُلحَق بإيصال `run` حين يبقى المسارُ ذو القوس موجوداً بعد أمر حذف — فارغةٌ في كلّ حالةٍ أخرى. */
export function bracketDeleteNote(cmd: string, cwd: string, exists: (absolute: string) => boolean): string {
  const target = bracketDeletePath(cmd)
  if (target === undefined) return ""
  const absolute = /^[A-Za-z]:[\\/]|^[\\/]/u.test(target) ? target : `${cwd.replace(/[\\/]+$/u, "")}/${target}`
  if (!exists(absolute)) return ""
  return `\n⚠ المسارُ «${target}» ما زال موجوداً بعد الأمر: الأقواسُ المربّعة أحرفُ wildcard في PowerShell فلم يُطابَق شيء (ورمزُ الخروج 0 لا يعني الحذف). أعد الأمرَ بـ-LiteralPath: Remove-Item -LiteralPath '${target}' -Recurse -Force`
}
