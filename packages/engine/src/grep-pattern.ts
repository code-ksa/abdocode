/**
 * نمطُ grep كما يكتبه النموذج: GNU grep يقرأ `a\|b` «أ أو ب» (صيغتُه الافتراضيّة)، وJS يقرؤه أنبوباً حرفيّاً.
 * 🔴 مقيس 2026-09-28: نموذجٌ بحث عن «كلمة\|أخرى» في ملفّات ملاحظات المشروع فعاد «لا مطابقة» عن ملفٍّ يحمل
 * الكلمةَ تسعَ مرّات — فاستنتج أنّ ما يبحث عنه لم يُكتب قطّ. نفيٌ كاذبٌ أسوأُ من فشل. فـ`\|` تناوبٌ (والحرفيُّ `[|]`)، وخطٌّ مائلٌ مهروب قبلها
 * (`\\|`) لا يُمسّ؛ و`\(` تبقى قوساً حرفيّاً كما يعنيه النموذجُ عادةً. نمطٌ غيرُ صالح ⇦ undefined.
 */
export function grepRegex(pattern: string, ignoreCase: boolean): { re: RegExp; translated: boolean } | undefined {
  let translated = false
  let out = ""
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1]!
      if (next === "|") { out += "|"; translated = true } else out += ch + next
      i += 1
      continue
    }
    out += ch
  }
  try { return { re: new RegExp(out, ignoreCase ? "i" : ""), translated } } catch { return undefined }
}
