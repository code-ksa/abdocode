/**
 * 10-10 «اعمل موقعاً مثل n8n بجميع خصائصه… يأخذ ريفرنس التصميم بفتح الموقع في متصفّحه ويشوف شاشاته وقوائمه كلّها، ثمّ
 * Inspect ⇦ <html> ⇦ Copy element … ثمّ يخطّط سبرنتات تغطّي كلّ بنود الموقع». مهمّةُ استنساخٍ من مرجعٍ حيّ لها ترتيبٌ يُخسَر بنسيانه:
 * من يبدأ الكتابةَ قبل أن يزور الصفحاتِ يبني صفحةً واحدة ويدّعي البقيّة. موجزٌ قصير يُلحق حين يسمّي الطلبُ موقعاً مرجعاً — لا في كلّ نداء.
 */

const CLONE_WORDS = /(?:مثل|زي|شبه|على غرار|نسخة من|نسخةً من|استنسخ|انسخ تصميم|clone|replica|copy of|like)\s+(?:موقع\s+|منصّ?ة\s+|تطبيق\s+)?[\p{L}\p{N}.-]{2,}|ريفرنس|reference site|مرجع(?:َ)? التصميم|موقعٍ? مرجع/iu

/** Pure. Whether the request asks to rebuild a site after a live reference (and is not just a casual "like"). */
export function asksReferenceClone(text: string): boolean {
  const head = String(text ?? "").slice(0, 6000)
  return CLONE_WORDS.test(head) && /موقع|site|website|صفح|page|داشبورد|dashboard|منصّ?ة|platform|تصميم|design|https?:\/\/|\.(?:io|com|net|org|ai|app|dev)\b/iu.test(head)
}

/** الموجزُ نفسُه — خطواتٌ بأدوات عبدو كود، بالترتيب الذي لا يُقفز. */
export function referenceCloneBrief(text: string): string {
  if (!asksReferenceClone(text)) return ""
  return [
    "\n[REFERENCE_CLONE] استنساخُ موقعٍ من مرجعٍ حيّ — بهذا الترتيب، ولا تكتب شيفرةَ التطبيق قبل الخطوة 5:",
    "1. open <المرجع> ثمّ page: اجمع روابطَ القائمة الرئيسيّة والقوائم المنسدلة والفوتر في قائمةٍ واحدة؛ زُر كلَّ رابطٍ منها (لا الصفحةَ الرئيسيّة وحدها).",
    "2. لكلّ صفحة: page save (= DevTools Inspect ⇦ <html> ⇦ Copy element، يحفظ HTML وCSS وJS في .abdo/reference/) ثمّ shot full ثمّ page styles. اقرأ المحفوظَ بالقطعة بـread، لا تلصقه في الردّ.",
    "3. اكتب REFERENCE.md: جدولٌ بكلّ صفحةٍ وأقسامها ومكوّناتها وتفاعلاتها (قوائم، تبويبات، نماذج) والألوانِ والخطوطِ والمسافات بالأرقام من page styles.",
    "4. ما يحتاج دخولاً: اضغط زرَّ الدخول، وخطوةُ الحساب (جوجل/كلمة مرور) يكملها المستخدمُ بيده — handoff وانتظر؛ لا تكتب كلمةَ مرور. بعد الدخول افحص الداشبورد وكلَّ شاشاته بالخطوتين 1–2.",
    "5. ABDO-SPRINTS.md: سبرنتاتٌ تغطّي كلَّ سطرٍ في REFERENCE.md، مع جدول تتبّع (البند ⇦ السبرنت). اعرض الخطّةَ وتوقّف حتى يراجعها المستخدم.",
    "6. التنفيذ بعد «اكمل»: templates ثمّ project-template لأحدث Next + Tailwind + shadcn، وPrisma مع PostgreSQL (حاويةٌ محلّية إن لزم)؛ كلُّ صفحةٍ تُقارَن بمرجعها (shot ثمّ design compare) قبل إغلاق سبرنتها.",
    "",
  ].join("\n")
}
