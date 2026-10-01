/**
 * 10-01 — أفكارُ هيرمس 22 (جردُ الوضعيّة) و11 (تماسكُ الصلاحيات).
 *
 * أداةُ `posture`: ما المفتوحُ الآن وما يناقض بعضُه بعضاً — من الإعدادات النافذة والمفاتيح كما يحلّها المحرّك نفسُه، بلا أسرارٍ ولا قيم.
 * كانت الإجابةُ عن «هل إعدادي آمن؟» تمرّ بالنموذج يقرأ ملفَّ الإعدادات ويخمّن؛ الآن جدولٌ حتميّ: وقائع، ثمّ مخاطرُ مسمّاة بسببها.
 */

export interface PostureInput {
  readonly mode: string
  readonly workMode?: string
  readonly remoteControl: boolean
  readonly computerUse: boolean
  readonly desktopControl: boolean
  readonly updateCheck: boolean
  readonly sensitiveMemory: boolean
  readonly customProviders: readonly { readonly id: string; readonly baseUrl: string; readonly local?: boolean }[]
  readonly mcpServers: number
  /** الحالةُ النافذة لكلّ مفتاحٍ يمسّ الأمن أو الجودة — كما يحلّها المحرّك (pluginOnNow). */
  readonly plugins: Readonly<Record<string, boolean>>
  readonly trustedProjects: number
}

export interface PostureFinding { readonly level: "risk" | "note"; readonly text: string }

const FULL = /^full(?:-access)?$/u

/** تماسكُ الصلاحيات: ما يناقض بعضُه بعضاً أو يفتح أكثرَ ممّا يظهر. */
export function postureFindings(p: PostureInput): PostureFinding[] {
  const out: PostureFinding[] = []
  const on = (name: string): boolean => p.plugins[name] === true
  const off = (name: string): boolean => p.plugins[name] === false
  const full = FULL.test(p.mode)
  if (full && off("unattendedDeny")) out.push({ level: "risk", text: "وصولٌ كامل والرفضُ بلا مُوافِقٍ حاضر مطفأ (unattendedDeny): دورٌ في الخلفيّة أو من بُعد ينفّذ الأوامرَ الهدّامة بلا سؤال" })
  if (full && p.remoteControl) out.push({ level: "risk", text: "التحكّمُ عن بُعد مفعَّل مع وصولٍ كامل: من يملك الجلسةَ البعيدة يملك الجهاز — اجعل النمطَ «سؤال» أو أطفئ التحكّمَ عن بُعد حين لا تحتاجه" })
  if (full && (p.computerUse || p.desktopControl)) out.push({ level: "risk", text: "التحكّمُ بسطح المكتب مفعَّل مع وصولٍ كامل: نقراتٌ ولوحةُ مفاتيح بلا سؤال" })
  if (off("inboundGuard")) out.push({ level: "risk", text: "حجرُ النصّ الوارد مطفأ (inboundGuard): نصُّ صفحةٍ أو ملفٍّ يحمل تعليماتٍ يصل النموذجَ كأنّه منك" })
  if (off("secretIntake")) out.push({ level: "risk", text: "الإدخالُ المُعان للأسرار مطفأ (secretIntake): مفتاحٌ يُلصق في المحادثة يصل النموذجَ والسجلّ" })
  for (const c of p.customProviders) {
    let url: URL | undefined
    try { url = new URL(c.baseUrl) } catch { out.push({ level: "risk", text: `مزوّدٌ مخصّص «${c.id}» بعنوانٍ غير صالح` }); continue }
    const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])$/u.test(url.hostname)
    if (url.protocol === "http:" && !(c.local === true && loopback)) out.push({ level: "risk", text: `مزوّدٌ مخصّص «${c.id}» على http بلا تشفير (${url.host}) — المفتاحُ يمرّ مكشوفاً` })
  }
  if (p.mcpServers > 0 && off("mcpClient")) out.push({ level: "note", text: `${p.mcpServers} خادم MCP معرَّف وعميلُ MCP مطفأ (mcpClient) — الخوادمُ لا تُستعمل` })
  if (full && on("standingGrants")) out.push({ level: "note", text: "المنحُ القائمة مفعّلةٌ مع وصولٍ كامل — لا تضيف شيئاً (الكاملُ لا يسأل أصلاً)" })
  if (p.sensitiveMemory) out.push({ level: "note", text: "الذاكرةُ الحسّاسة مفعّلة: ما يُصنَّف حسّاساً يُحفظ ويُسترجع" })
  if (!p.updateCheck) out.push({ level: "note", text: "فحصُ التحديثات مطفأ: إصلاحاتُ الأمن لا تصلك تلقائياً" })
  if (off("auditGate")) out.push({ level: "note", text: "بوّابةُ جودة الواجهات مطفأة (auditGate): سبرنتُ الواجهة يُغلق بلا audit" })
  if (off("verifyAfterEdit")) out.push({ level: "note", text: "التحقّقُ بعد التعديل مطفأ (verifyAfterEdit): لا اختبارَ يعمل بعد الكتابة" })
  return out
}

/** التقريرُ: الوقائعُ ثمّ المخاطرُ ثمّ الملاحظات — بلا قيمِ أسرار. */
export function renderPosture(p: PostureInput): string {
  const findings = postureFindings(p)
  const risks = findings.filter((f) => f.level === "risk")
  const notes = findings.filter((f) => f.level === "note")
  const offList = Object.entries(p.plugins).filter(([, v]) => !v).map(([k]) => k)
  const facts = [
    `النمط: ${p.mode}${p.workMode ? ` · وضعُ العمل: ${p.workMode}` : ""}`,
    `التحكّمُ عن بُعد: ${p.remoteControl ? "مفعَّل" : "مطفأ"} · سطحُ المكتب: ${p.computerUse || p.desktopControl ? "مفعَّل" : "مطفأ"}`,
    `مزوّدون مخصّصون: ${p.customProviders.length}${p.customProviders.length > 0 ? ` (${p.customProviders.map((c) => { try { return `${c.id}@${new URL(c.baseUrl).host}` } catch { return c.id } }).join("، ")})` : ""} · خوادمُ MCP: ${p.mcpServers} · مشاريعُ موثوقة: ${p.trustedProjects}`,
    `مفاتيحُ مطفأة: ${offList.length > 0 ? offList.join("، ") : "لا شيء"}`,
  ]
  return [
    `posture: ${risks.length === 0 ? "لا مخاطر مسمّاة" : `${risks.length} خطر`}${notes.length > 0 ? ` · ${notes.length} ملاحظة` : ""}`,
    ...facts.map((f) => `· ${f}`),
    ...risks.map((f) => `✕ ${f.text}`),
    ...notes.map((f) => `△ ${f.text}`),
  ].join("\n")
}

/** المفاتيحُ التي يقرؤها الجرد — ما يمسّ الأمن أو الجودة. */
export const POSTURE_PLUGINS = Object.freeze(["unattendedDeny", "inboundGuard", "secretIntake", "standingGrants", "mcpClient", "osSandbox", "denialBreaker", "verifyAfterEdit", "auditGate", "providerProbe", "delegation"] as const)
