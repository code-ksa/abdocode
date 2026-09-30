/**
 * م11 — إصلاحٌ حتميّ معلَن لعادة النماذج (omni ثمّ super-120b، 2026-09-14): أمرٌ يبدأ بمسارٍ مقتبس ينتهي بـ.exe يفشل في PowerShell
 * بـ«Unexpected token» لأنّ المسارَ المقتبس تعبيرٌ لا نداء — يحتاج عامل النداء `&`. القواعدُ الثلاث للإصلاح الآليّ (سبرنت 47):
 * ميكانيكيّ (نمطٌ واحد)، محدود (لا يمسّ أمراً يحمل & أو . أو Start-Process أو cmd /c في صدره)، معلَن (يعود بملاحظةٍ تُبثّ للمشغّل).
 * الوحدة نقيّة.
 */

export interface CallRepair { readonly command: string; readonly note: string }

const QUOTED_EXE_HEAD = /^\s*(["'])(?:[A-Za-z]:\\|\\\\|\.{0,2}[\\/])[^"'\r\n]*\.(?:exe|cmd|bat|com)\1(?=\s|$)/iu

/** يعيد الأمرَ بعد إضافة `&` حين يبدأ بمسارٍ مقتبس قابلٍ للتنفيذ؛ وإلا undefined (لا إصلاح). */
export function powershellCallOperatorRepair(command: string): CallRepair | undefined {
  const head = command.trimStart()
  if (!QUOTED_EXE_HEAD.test(head)) return undefined
  return {
    command: `& ${head}`,
    note: "أُصلح الأمر آليّاً: أُضيف عاملُ النداء & قبل المسار المقتبس (PowerShell يعدّ المسارَ المقتبس تعبيراً لا نداءً).",
  }
}

/**
 * 09-30 — مقيس على مهمّة OpenRouter (المثبَّت 4.0.98): `npm install -D tailwindcss … && npx tailwindcss init -p` رُفض «&& غير مدعوم
 * في PowerShell 5.1» مرّتين في حقبةٍ واحدة، فذهب لكلٍّ منهما نداءُ نموذجٍ كامل ليعيد الصياغة. الترجمةُ حتميّة:
 * `A && B && C` ⇦ `A; if ($?) { B; if ($?) { C } }`، و`A || B` ⇦ `A; if (-not $?) { B }`. تُقسَم السلسلةُ خارج الاقتباس وحده؛
 * والخلطُ بين && و|| (أولويّةُ bash لا تُترجم بأمان) والصدفُ البعيدة (ssh/wsl/bash… تنفّذ هناك بلينكس) تبقى بلا إصلاح فيرفضها الحارس كما كان.
 */
const REMOTE_SHELL_HEAD = /^\s*(?:ssh|scp|wsl|bash|sh|zsh|plink|docker\s+(?:exec|run|compose))\b/iu

const splitTopLevel = (command: string): { readonly parts: string[]; readonly ops: string[] } | undefined => {
  const parts: string[] = []
  const ops: string[] = []
  let quote: string | undefined
  let current = ""
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    const pair = command.slice(i, i + 2)
    if (pair === "&&" || pair === "||") { parts.push(current.trim()); ops.push(pair); current = ""; i += 1; continue }
    current += ch
  }
  if (quote !== undefined) return undefined
  parts.push(current.trim())
  return { parts, ops }
}

/** يعيد الأمرَ مترجماً إلى PowerShell 5.1 حين يحمل سلسلةَ && خالصة أو || واحدة خارج الاقتباس؛ وإلا undefined. */
export function powershellChainRepair(command: string): CallRepair | undefined {
  if (!/&&|\|\|/u.test(command) || REMOTE_SHELL_HEAD.test(command)) return undefined
  const split = splitTopLevel(command)
  if (split === undefined || split.ops.length === 0) return undefined
  if (split.parts.some((part) => part.length === 0)) return undefined
  const kinds = new Set(split.ops)
  if (kinds.size > 1) return undefined
  if (kinds.has("||") && split.ops.length > 1) return undefined
  const [first, ...rest] = split.parts
  let tail = ""
  for (let i = rest.length - 1; i >= 0; i -= 1) tail = kinds.has("&&") ? `; if ($?) { ${rest[i]}${tail} }` : `; if (-not $?) { ${rest[i]}${tail} }`
  return {
    command: `${first}${tail}`,
    note: `أُصلح الأمر آليّاً: ${split.ops.length} × «${split.ops[0]}» تُرجمت إلى PowerShell 5.1 (${kinds.has("&&") ? "if ($?)" : "if (-not $?)"}) — المقاطعُ بترتيبها ويقف كلٌّ عند فشل سابقه.`,
  }
}
