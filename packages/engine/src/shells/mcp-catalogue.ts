/**
 * سوقُ خوادم MCP — **ما نشحنه نحن وحده**.
 *
 * الغايةُ أن يصير ما بُني اليوم مستعمَلاً: بضغطةٍ بدل أمرٍ يُكتب بيد. والقائمةُ
 * **مغلقةٌ على ما يشحن داخل ثنائيّنا** — لا فهرسٌ يشير إلى حزم الآخرين ولا
 * أمرُ `npx` جاهزٌ ينزّل شيئاً عند أوّل نقرة. من أراد خادماً غريباً كتب أمرَه
 * بيده وعرف ما يشغّل؛ وما نقترحه نحن نتحمّل تبعتَه.
 *
 * والوحدةُ **نقيّة**: لا DOM ولا أُطر. المُخفِّضُ يُقاس وحده، والقشرةُ ترسمه.
 */

/** ما يطلبه القالبُ من المشغّل قبل أن يصير خادماً. */
export type PresetInput =
  | {
    readonly kind: "path"
    readonly label: string
    readonly placeholder: string
    /** يُلحَق بالأمر — مسارٌ ليس سرّاً، وسطرُ الأمر مكانُه الطبيعيّ. */
    readonly appendToArgv: true
  }
  | {
    /** لا مُدخلَ من المشغّل: الخادمُ يعمل بأمره وحده (الجسرُ يقرأ حالتَه من قرص المستخدم). */
    readonly kind: "none"
    readonly label: string
    readonly placeholder: string
  }
  | {
    readonly kind: "secret"
    readonly label: string
    readonly placeholder: string
    /** اسمُ متغيّر البيئة الذي يُمنح — **لا يُلحق بالأمر أبداً**. */
    readonly env: string
  }

export interface McpPreset {
  /** معرّفٌ مقترح — يُنسب به كلُّ أدوات الخادم. */
  readonly id: string
  readonly label: string
  readonly summary: string
  /** ما يُضاف بعد رأس أمر المحرّك. */
  readonly argv: readonly string[]
  readonly input: PresetInput
  /** ما يراه المستخدمُ قبل أن يضغط: ماذا يستطيع هذا الخادم. */
  readonly tools: readonly string[]
}

export const MCP_PRESETS: readonly McpPreset[] = Object.freeze([
  Object.freeze({
    id: "db",
    label: "قاعدة SQLite",
    summary: "قراءةُ قاعدةِ تطويرٍ محلّيّة — جداولُها ومخطّطُها واستعلاماتُ قراءة. الكتابةُ يرفضها المحرّك نفسُه (اتّصالٌ للقراءة)، و«ضمُّ ملفٍّ آخر» مرفوضٌ بالاسم.",
    argv: Object.freeze(["mcp-sqlite"]),
    input: Object.freeze({
      kind: "path" as const,
      label: "ملفّ القاعدة",
      placeholder: "C:/Projects/my-project/prisma/dev.db",
      appendToArgv: true as const,
    }),
    tools: Object.freeze(["tables", "schema", "query"]),
  }),
  Object.freeze({
    id: "repo",
    label: "مستودعُ جِت آخر",
    summary: "قراءةُ تاريخِ مستودعٍ **غير مشروعك الجاري** — سجلٌّ وفروعٌ وفرقٌ وملفٌّ عند مرجع. أداةُ git الأصليّة تقرأ مشروعك، وهذه تقرأ مرجعاً تنسخ منه أو مستودعَ عميلٍ تقارن به. وإعدادُ المستودع الغريب مُحيَّدٌ فلا يشغّل برنامجاً.",
    argv: Object.freeze(["mcp-git"]),
    input: Object.freeze({
      kind: "path" as const,
      label: "مجلّد المستودع",
      placeholder: "C:/Projects/reference-repo",
      appendToArgv: true as const,
    }),
    tools: Object.freeze(["log", "show", "diff", "file", "branches"]),
  }),
  Object.freeze({
    id: "pg",
    label: "قاعدة PostgreSQL",
    summary: "قراءةُ قاعدةِ بوستجرس بسلكٍ كتبناه (SCRAM وTLS) — جداولُها وأعمدتُها واستعلاماتُ قراءة، كلُّها داخل معاملةٍ للقراءة. والرابطُ يذهب إلى الخزنة لا إلى الإعدادات.",
    argv: Object.freeze(["mcp-postgres"]),
    input: Object.freeze({
      kind: "secret" as const,
      label: "رابط الاتصال",
      placeholder: "postgresql://user:pass@127.0.0.1:5432/app",
      env: "ABDO_PG_URL",
    }),
    tools: Object.freeze(["tables", "columns", "query"]),
  }),
  Object.freeze({
    id: "chrome",
    label: "إضافة المتصفّح (كروم/إيدج/سفاري)",
    summary: "يقود الوكيلُ متصفّحَك الحقيقيّ عبر إضافة عبدو كود: يقرأ التبويب الفعّال ويفتح روابط وينقر ويكتب في غير السرّيّ ويلتقط لقطة — بموافقتك وعلى هذا الجهاز وحده. بعد «وصّل» انسخ رمزَ الاقتران إلى نافذة الإضافة.",
    argv: Object.freeze(["mcp-chrome-bridge"]),
    input: Object.freeze({ kind: "none" as const, label: "لا مُدخل", placeholder: "" }),
    tools: Object.freeze(["page", "open", "look", "tap", "fill", "key", "scroll", "shot"]),
  }),
])

export const presetById = (id: string): McpPreset | undefined =>
  MCP_PRESETS.find((preset) => preset.id === id)

/**
 * يبني أمرَ الخادم من رأسِ أمرِ المحرّك ومُدخلِ المشغّل.
 *
 * **المسارُ يُلحق، والسرُّ لا.** سطرُ أمرِ أيّ عمليّةٍ مقروءٌ لكلّ عمليّةٍ على
 * الجهاز، فقالبٌ يُلحق رابطاً فيه كلمةُ مرورٍ يفتح ما أغلقناه في المحرّك.
 * والدالّةُ تحرسه بنوعها لا بالنيّة: `secret` لا تملك `appendToArgv` أصلاً.
 */
export const presetCommand = (
  preset: McpPreset,
  enginePrefix: readonly string[],
  value: string,
): readonly string[] | { readonly refusal: string } => {
  if (enginePrefix.length === 0) return { refusal: "لا يُعرف أمرُ المحرّك بعد — أعِد فتح التطبيق" }
  const trimmed = value.trim()
  if (preset.input.kind !== "none" && trimmed.length === 0) return { refusal: `${preset.input.label} مطلوب` }
  const argv = [...enginePrefix, ...preset.argv]
  if (preset.input.kind === "path") argv.push(trimmed)
  return argv
}

/** معرّفٌ لا يصطدم بمحفوظ: `db`, `db-2`, `db-3` … */
export const uniqueId = (wanted: string, taken: readonly string[]): string => {
  if (!taken.includes(wanted)) return wanted
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${wanted}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${wanted}-${Date.now().toString(36).slice(-4)}`
}

/** مقبضُ الخزنة المشتقّ — القاعدةُ نفسُها التي تستعملها الواجهة للمنح اليدويّ. */
export const presetHandle = (serverId: string, env: string): string =>
  `custom-${serverId}-${env.toLowerCase().split("_").join("-")}`

export * as McpCatalogue from "./mcp-catalogue"
