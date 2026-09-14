/**
 * تطابقُ التحرير — موضعٌ واحدٌ بالضبط، أو نيّةٌ معلَنة بكلِّ المواضع.
 *
 * العيبُ المقيس (2026-09-03): مسارُ `edit <ملف> :: قديم => جديد` النصّيّ كان
 * يفحص **الوجود** (`includes`) ثمّ يستبدل بـ`String.replace` بسلسلة — أي:
 *
 *   1. نصٌّ قديم يتكرّر ثلاث مرّات يُحرَّر **أوّلَه** بصمت. النموذج يقرأ
 *      «✍ عُدّل» فيبني عليه، والملفّ لم يتغيّر حيث ظنّ. عيبُ صحّةٍ لا أسلوب.
 *   2. بديلٌ يحمل `$&` أو `$1` كان يُفسَّر مرجعاً لا نصّاً حرفياً — فيُكتب
 *      غيرُ ما طلب النموذج. (المسارُ المنظَّم كان يتجنّبها بدالّةِ بديل؛
 *      المسار النصّيّ لم يكن.)
 *
 * والقاعدة هنا واحدةٌ للمسارين: **التطابق الفريد شرط**، وكثرةُ المواضع
 * رفضٌ **بالاسم** يقول كم موضعاً وُجد وكيف يُعبَّر عن نيّة «كلّها».
 * والاستبدالُ بـ`split/join` — حرفيٌّ بلا أنماطٍ ولا مراجع.
 *
 * الوحدة **خالصة**: لا قرص ولا حالة.
 */

/** الرايةُ التي يكتبها النموذج حين يقصد كلّ المواضع. */
export const EDIT_ALL_FLAG = "--all"

export interface EditPlan {
  readonly target: string
  readonly oldText: string
  readonly newText: string
  /** أُعلنت النيّة بكلّ المواضع صراحةً. */
  readonly all: boolean
}

/** خطّةٌ أو نصُّ رفضٍ عربيّ (السلسلة = رفض). */
export type EditParse = EditPlan | string

export const EDIT_USAGE = `الصيغة: edit <ملف> [${EDIT_ALL_FLAG}] :: النصّ القديم => النصّ الجديد`

/**
 * يحلّل ذيلَ الأمر (ما بعد كلمة `edit`). الفصلُ على **أوّل** `::`، وأمّا فاصلُ الطرفين فبثلاث درجات:
 *
 * ١) سطرٌ لا يحمل إلا `=>` — الفاصلُ الذي لا يلتبس (وهو نفسُه فاصلُ `medit`)، فيُقدَّم على كلّ ما عداه.
 * ٢) وإلّا: `=>` واحدةٌ في الذيل كلِّه — لا لبسَ أيضاً.
 * ٣) وإلّا **رفضٌ**: كان الفصلُ على **أوّل** `=>` فينقسم النصُّ القديم على سهمِ نفسِه —
 *    `edit x.ts :: const f = rows.map(r => r.id) => …` يجعل القديمَ «const f = rows.map(r» —
 *    ثمّ يطابق موضعاً واحداً فتُكتب بايتاتٌ مشوّهة **ويُروى نجاح**. والدوالُّ السهميّة أشيعُ ما نحرّر.
 */
export const parseEditCommand = (rest: string): EditParse => {
  const body = rest.trim()
  const cut = body.indexOf("::")
  if (cut < 0) return EDIT_USAGE
  const head = body.slice(0, cut).trim()
  const tail = body.slice(cut + 2)
  const line = tail.match(/\r?\n[ \t]*=>[ \t]*(?:\r?\n|$)/u)
  let oldText: string
  let newText: string
  if (line?.index !== undefined) {
    oldText = tail.slice(0, line.index).trim()
    newText = tail.slice(line.index + line[0].length).trim()
  } else {
    const arrow = tail.indexOf("=>")
    if (arrow < 0) return EDIT_USAGE
    if (countOccurrences(tail, "=>") > 1) {
      return `فاصلٌ ملتبس: في الأمر أكثرُ من «=>» فلا يُعرف أيُّها الفاصل (نصُّك يحمل دالّةً سهميّة؟). ضع «=>» في سطرٍ وحده بين القديم والجديد، أو استعمل medit — ${EDIT_USAGE}`
    }
    oldText = tail.slice(0, arrow).trim()
    newText = tail.slice(arrow + 2).trim()
  }

  // الرايةُ تُنزع من طرفٍ واحد (الصيغة المعلَنة تضعها بعد الاسم، والنموذج
  // يكتبها قبله أحياناً)، وما بقي من الرأس هو المسار **كاملاً بفراغاته**.
  //
  // العطلُ المقيس (2026-09-03): قصُّ الرأس على الفراغ كان يرفض `docs/my
  // notes.md` — وهو الشكل الذي يبنيه `runPatchTool` من `*** Update File:`
  // حرفياً. فرقعةٌ كانت تُحرَّر صارت تُرفض، والمسارُ المنظَّم (`args.path`)
  // يقبله في اللحظة نفسها: مفردتان لمسارٍ واحد، وهو أصلُ الافتراق.
  //
  // ورايةٌ غيرُ معروفة تبقى رفضاً بالاسم — تُقاس على طرفَي الرأس وحدهما، فلا
  // يبتلع المسارُ رايةً أخطأ النموذج في كتابتها.
  let all = false
  let path = head
  if (path.endsWith(` ${EDIT_ALL_FLAG}`)) {
    all = true
    path = path.slice(0, path.length - EDIT_ALL_FLAG.length).trim()
  } else if (path.startsWith(`${EDIT_ALL_FLAG} `)) {
    all = true
    path = path.slice(EDIT_ALL_FLAG.length).trim()
  }
  if (path.length === 0 || path === EDIT_ALL_FLAG) return EDIT_USAGE
  const firstWord = path.split(" ", 1)[0]!
  const lastWord = path.slice(path.lastIndexOf(" ") + 1)
  for (const word of firstWord === lastWord ? [firstWord] : [firstWord, lastWord]) {
    if (word.startsWith("--")) return `رايةٌ غير معروفة «${word.slice(0, 24)}» — ${EDIT_USAGE}`
  }
  return Object.freeze({ target: path, oldText, newText, all })
}

export type EditApply =
  | { readonly ok: true; readonly after: string; readonly replaced: number }
  | { readonly ok: false; readonly why: string; readonly occurrences: number }

/** يعدّ المواضع الحرفيّة (بلا تداخل) — `split` وحدها، بلا تعبيرٍ نمطيّ. */
export const countOccurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1

/** مسافةُ تحرير محدودة (Levenshtein) بين نصّين قصيرين — للتلميح لا للحكم. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/**
 * أقربُ الأسطر الموجودة فعلاً إلى أوّل سطرٍ من النصّ القديم غير المطابق (بلا بياضٍ طرفيّ): تلميحٌ يجعل المحاولةَ التالية مطابقةً لا
 * تخميناً — مقيس 09-14: قوسٌ زائد في old_text أعاد النموذجَ ثلاث مرّات إلى الرفض نفسِه. يعيد حتى `limit` أسطر بتشابهٍ يتجاوز النصف.
 */
export const nearestLines = (before: string, oldText: string, limit = 2): string[] => {
  const probe = (oldText.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 200)
  if (probe.length === 0) return []
  const seen = new Set<string>()
  const scored: { line: string; score: number }[] = []
  for (const raw of before.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    const candidate = line.slice(0, 200)
    const distance = editDistance(probe, candidate)
    // بادئةٌ مشتركة طويلة (النموذجُ يقصّ السطرَ أو يزيد عليه) تُعدّ قريبةً ولو طال الذيل
    const prefixHit = probe.length >= 10 && candidate.length >= 10 && (candidate.startsWith(probe) || probe.startsWith(candidate))
    const score = prefixHit ? 0.9 : 1 - distance / Math.max(probe.length, candidate.length)
    if (score > 0.5) scored.push({ line: candidate, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.line)
}

/** ذيلُ الرفض: «أقربُ الأسطر الموجودة: «…»» أو فارغٌ حين لا شبيه. */
export const nearestHint = (before: string, oldText: string): string => {
  const near = nearestLines(before, oldText)
  return near.length === 0 ? "" : ` أقربُ الأسطر الموجودة فعلاً: ${near.map((l) => `«${l}»`).join(" · ")} — انسخ السطرَ حرفيّاً في old_text.`
}

/**
 * يطبّق التحرير أو يرفض بالاسم. الرفضُ يسمّي العدد والمخرج، فالنموذج يعرف
 * ماذا يفعل: يوسّع السياق ليصير فريداً، أو يعلن النيّة بكلّ المواضع.
 */
export const applyEdit = (before: string, plan: Pick<EditPlan, "oldText" | "newText" | "all">): EditApply => {
  if (plan.oldText.length === 0) {
    return { ok: false, why: "رُفض التحرير: النصّ القديم فارغ — التحرير يطابق نصّاً لا يخمّن", occurrences: 0 }
  }
  const occurrences = countOccurrences(before, plan.oldText)
  if (occurrences === 0) {
    return { ok: false, why: `النصّ القديم غير موجود حرفياً — التحرير يطابق نصّاً لا يخمّن.${nearestHint(before, plan.oldText)}`, occurrences: 0 }
  }
  if (occurrences > 1 && !plan.all) {
    return {
      ok: false,
      occurrences,
      why:
        `رُفض التحرير: النصّ القديم يتطابق ${occurrences} مواضع في الملفّ، والتحرير يطابق موضعاً واحداً بالضبط. ` +
        `وسّع السياق حتى يصير فريداً (أسطرٌ قبله وبعده)، أو اكتب «${EDIT_ALL_FLAG}» بعد اسم الملفّ إن كنت تقصد المواضع كلّها.`,
    }
  }
  // حرفيٌّ في الطرفين: `split/join` لا يفسّر `$&` ولا `$1` في البديل.
  const after = plan.all ? before.split(plan.oldText).join(plan.newText) : replaceFirst(before, plan.oldText, plan.newText)
  return { ok: true, after, replaced: plan.all ? occurrences : 1 }
}

const replaceFirst = (before: string, oldText: string, newText: string): string => {
  const at = before.indexOf(oldText)
  return at < 0 ? before : before.slice(0, at) + newText + before.slice(at + oldText.length)
}
