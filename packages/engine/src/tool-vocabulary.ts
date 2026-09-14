/**
 * S13.5 (إصلاح) — مفرداتُ الأدوات في رسالة النظام تُشتقّ من المُعلَن.
 *
 * العطلُ المقيس (2026-09-03): سقفُ الوكيل كان يقصّ `{{tool-catalogue}}` ولا
 * يقصّ **النثر** المجاور له في رسالة النظام نفسها. فوكيلٌ قراءةً-فقط (مثل
 * `reviewer`) كان يُقال له في موجزه «سقفُك قراءةٌ فقط — لا كتابةَ ولا تنفيذ»
 * ثمّ يُقال له في الطلب نفسه «الأدوات الأساسية المسجلة: … وwrite وedit وrun»
 * مع شرحِ صيغة `write`. الاحتواءُ كان قائماً (الحارس يرفضها بالاسم)، لكنّ
 * النموذج يحرق جولاتٍ على رفضٍ محتوم، والرسالة تناقض موجزها.
 *
 * القاعدة هنا واحدة: **لا تُذكر أداةٌ لا تُعلَن**. والمصدر واحد — قائمةُ
 * الأسماء التي دخلت `toolDefinitions` فعلاً بعد قصّ السقف.
 *
 * الوحدة خالصةٌ من الأثر: نصٌّ من قائمةٍ، بلا بيئةٍ ولا قرص.
 */

import { decide, type ApprovalMode, type Effect, type RequestKind } from "./shells/shell"

/**
 * سطرُ السياسة — يُشتقّ من **النمط النافذ وسقف الأدوات**، لا يُكتب باليد.
 *
 * العطلُ المقيس (2026-09-03): رسالةُ النظام كانت تقول للنموذج بلا شرط
 * «والشبكة مقفلة افتراضياً» — جملةٌ ثابتةٌ لا تعرف النمط. والمالكُ كان في
 * «صلاحية كاملة»، حيث `MODES["full-access"].network === "allow"`. فالنموذج
 * صدّق الجملةَ ورفض التصفّح: «لا أملك القدرة على تصفّح الإنترنت».
 *
 * القاعدةُ هنا كقاعدة `toolVocabulary`: **لا يُقال إلا ما تحكم به البوّابة**.
 * المصدرُ جدولُ `MODES` نفسُه الذي يحكم وقتَ التنفيذ، وسقفُ الأدوات المعلَنة
 * — فصنفٌ لا تبلغه أداةٌ معلَنة لا يُذكر أصلاً (لا معنى لتحذيرِ وكيلٍ من
 * الشبكة وهو لا يملك أداةً تبلغها). وتغييرُ الجدول يغيّر الجملةَ معه.
 */
const KIND_AR: Readonly<Record<RequestKind, string>> = Object.freeze({
  read: "القراءة",
  edit: "تعديل الملفّات",
  command: "تنفيذ الأوامر",
  network: "الشبكة والمتصفّح",
  "outside-workspace": "ما خارج مجلّد المشروع",
})

const MODE_AR: Readonly<Record<ApprovalMode, string>> = Object.freeze({
  "read-only": "قراءة فقط",
  auto: "تلقائي",
  "full-access": "صلاحية كاملة",
})

export const policyLine = (
  mode: ApprovalMode,
  advertised: readonly string[],
  effectOf: (name: string) => RequestKind | undefined,
): string => {
  // صنفٌ «قابلٌ للبلوغ» = صنفٌ تحمله أداةٌ معلَنةٌ فعلاً في هذا الدور.
  const reachable = (Object.keys(KIND_AR) as RequestKind[])
    .filter((kind) => advertised.some((name) => effectOf(name) === kind))
  const byEffect = (want: Effect) => reachable.filter((kind) => decide(mode, kind) === want).map((kind) => KIND_AR[kind])
  const asks = byEffect("ask")
  const denied = byEffect("deny")
  const parts: string[] = [`أنت في نمط «${MODE_AR[mode]}».`]
  if (denied.length > 0) parts.push(`ممنوعٌ فيه: ${denied.join(" و")} — لا تقترحه.`)
  if (asks.length > 0) parts.push(`يحتاج موافقةً صريحة: ${asks.join(" و")} — اقترحه ولا تفترض الرفض.`)
  // فراغُ القائمتين ليس صمتاً: قولُ «كلُّ ما في سقفك يمرّ» هو ما يمنع النموذج
  // من اختراع قيدٍ لا وجود له — وهو الفخّ الذي أوقع الجملةَ الثابتة أصلاً.
  if (asks.length === 0 && denied.length === 0) parts.push("كلُّ ما في سقفك من أدوات يمرّ بلا استئذان.")
  return `${parts.join(" ")}\n`
}

/** سطرُ لهجةِ الطرفية — لا معنى له لوكيلٍ لا يملك `run`. */
export const terminalDialectLine = (advertised: readonly string[]): string =>
  advertised.includes("run")
    ? "الطرفية Windows PowerShell 5.1 وليست bash: لا تستعمل rm -rf أو ls -la أو mkdir -p؛ استعمل أوامر PowerShell أو أدوات list/write المدمجة.\n"
    : ""

/**
 * الأسطرُ الثلاثة التي كانت مثبَّتةً حرفياً: صيغةُ الكتابة متعددة الأسطر،
 * والأمثلة، وقائمةُ الأدوات المسجَّلة. كلُّ سطرٍ يظهر فقط إن كانت أداتُه
 * معلَنة — والقائمة تُبنى من `advertised` لا من ستّة أسماء مكتوبة باليد
 * (كانت تكذب في الاتجاهين: تُخفي المعلَن الزائد وتَعِد بالمقصوص).
 */
export const toolVocabulary = (advertised: readonly string[], planningPhase: boolean): string => {
  const has = (name: string): boolean => advertised.includes(name)
  const parts: string[] = []
  if (has("write")) {
    parts.push("للكتابة متعددة الأسطر استعمل «نفّذ: write <ملف> <<<» ثم المحتوى كاملاً: ثلاث علامات < بالضبط ولا تضع علامة إغلاق. اكتب ملفاً واحداً في كل رد، ولا تستخدم سياج ``` أو اقتباساً أو backtick حول المحتوى، ولا تلحق رسالة نجاح داخل الملف.\n")
  }
  const examples: string[] = []
  if (planningPhase && has("read")) examples.push("«نفّذ: read ABDO-SPRINTS.md»")
  if (has("list")) examples.push("«نفّذ: list .»")
  if (!planningPhase && has("run")) examples.push("«نفّذ: run npm run build»")
  if (examples.length > 0) parts.push(`أمثلة صحيحة: ${examples.join(" أو ")}.\n`)
  if (has("run")) parts.push("لا تخرج أمراً عارياً مثل npm أو npx: أوامر الطرفية دائماً «نفّذ: run <الأمر>». ")
  parts.push(advertised.length > 0
    ? `الأدوات المسجلة لك: ${advertised.join(" و")}.\n`
    : "لا أداةَ معلَنةً لك في هذا الدور — أجب بما تعرف ولا تقترح أمراً.\n")
  return parts.join("")
}

/**
 * إضافةُ المتصفّح الحقيقيّ (جسرُ MCP «mcp-chrome-bridge») — قيس (سجلّ المالك 2026-09-06): «اتصل بإضافتك على كروم» فأجاب النموذج
 * «لا أملك أداةً» لأنّ أدوات الجسر لا تدخل السجلّ إلا بعد التوصيل، ولا شيءَ في النظام يذكرها. السطرُ هنا لا يعلن أداةً
 * (القاعدة: لا تُذكر أداةٌ لا تُعلَن) بل يقول للنموذج ما يطلبه من المستخدم. فارغٌ حين الأدوات معلَنةٌ فعلاً.
 */
export const browserBridgeHint = (
  saved: readonly { readonly id: string; readonly command: readonly string[] }[],
  advertised: readonly string[],
): string => {
  const bridge = saved.find((s) => s.command.includes("mcp-chrome-bridge"))
  if (bridge === undefined) return "\nلا أداةَ متصفّحٍ حقيقيّ (كروم/إيدج) الآن؛ إن طلب المستخدم متصفّحه الحقيقيّ فقل له: الإعدادات ← الاتصالات ← «إضافة المتصفّح» ← «أضِف» ثمّ «وصّل» ولصقُ رمز الاقتران في نافذة الإضافة — ولا تقل إنّ الإضافة غير موجودة. متصفّحُ الوكيل الداخليّ (open/page/tap/fill) متاحٌ بلا ذلك.\n"
  if (advertised.some((name) => name.startsWith(`${bridge.id}.`))) return ""
  return `\nإضافةُ المتصفّح الحقيقيّ محفوظةٌ باسم «${bridge.id}» وغيرُ موصولةٍ الآن؛ أدواتُ ${bridge.id}.page/open/look/tap/fill/key/scroll/shot تظهر بعد أن يضغط المستخدم «وصّل» في الإعدادات ← الاتصالات ويلصق رمزَ الاقتران في نافذة الإضافة في كروم — اطلب منه ذلك ولا تقل إنّ الإضافة غير موجودة.\n`
}
