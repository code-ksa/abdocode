var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// ../engine/src/shells/mcp-catalogue.ts
var exports_mcp_catalogue = {};
__export(exports_mcp_catalogue, {
  uniqueId: () => uniqueId,
  presetHandle: () => presetHandle,
  presetCommand: () => presetCommand,
  presetById: () => presetById,
  McpCatalogue: () => exports_mcp_catalogue,
  MCP_PRESETS: () => MCP_PRESETS
});
var MCP_PRESETS = Object.freeze([
  Object.freeze({
    id: "db",
    label: "قاعدة SQLite",
    summary: "قراءةُ قاعدةِ تطويرٍ محلّيّة — جداولُها ومخطّطُها واستعلاماتُ قراءة. الكتابةُ يرفضها المحرّك نفسُه (اتّصالٌ للقراءة)، و«ضمُّ ملفٍّ آخر» مرفوضٌ بالاسم.",
    argv: Object.freeze(["mcp-sqlite"]),
    input: Object.freeze({
      kind: "path",
      label: "ملفّ القاعدة",
      placeholder: "C:/Projects/my-project/prisma/dev.db",
      appendToArgv: true
    }),
    tools: Object.freeze(["tables", "schema", "query"])
  }),
  Object.freeze({
    id: "repo",
    label: "مستودعُ جِت آخر",
    summary: "قراءةُ تاريخِ مستودعٍ **غير مشروعك الجاري** — سجلٌّ وفروعٌ وفرقٌ وملفٌّ عند مرجع. أداةُ git الأصليّة تقرأ مشروعك، وهذه تقرأ مرجعاً تنسخ منه أو مستودعَ عميلٍ تقارن به. وإعدادُ المستودع الغريب مُحيَّدٌ فلا يشغّل برنامجاً.",
    argv: Object.freeze(["mcp-git"]),
    input: Object.freeze({
      kind: "path",
      label: "مجلّد المستودع",
      placeholder: "C:/Projects/reference-repo",
      appendToArgv: true
    }),
    tools: Object.freeze(["log", "show", "diff", "file", "branches"])
  }),
  Object.freeze({
    id: "pg",
    label: "قاعدة PostgreSQL",
    summary: "قراءةُ قاعدةِ بوستجرس بسلكٍ كتبناه (SCRAM وTLS) — جداولُها وأعمدتُها واستعلاماتُ قراءة، كلُّها داخل معاملةٍ للقراءة. والرابطُ يذهب إلى الخزنة لا إلى الإعدادات.",
    argv: Object.freeze(["mcp-postgres"]),
    input: Object.freeze({
      kind: "secret",
      label: "رابط الاتصال",
      placeholder: "postgresql://user:pass@127.0.0.1:5432/app",
      env: "ABDO_PG_URL"
    }),
    tools: Object.freeze(["tables", "columns", "query"])
  }),
  Object.freeze({
    id: "chrome",
    label: "إضافة المتصفّح (كروم/إيدج/سفاري)",
    summary: "يقود الوكيلُ متصفّحَك الحقيقيّ عبر إضافة عبدو كود: يقرأ التبويب الفعّال ويفتح روابط وينقر ويكتب في غير السرّيّ ويلتقط لقطة — بموافقتك وعلى هذا الجهاز وحده. بعد «وصّل» انسخ رمزَ الاقتران إلى نافذة الإضافة.",
    argv: Object.freeze(["mcp-chrome-bridge"]),
    input: Object.freeze({ kind: "none", label: "لا مُدخل", placeholder: "" }),
    tools: Object.freeze(["page", "open", "look", "tap", "fill", "key", "scroll", "shot"])
  })
]);
var presetById = (id) => MCP_PRESETS.find((preset) => preset.id === id);
var presetCommand = (preset, enginePrefix, value) => {
  if (enginePrefix.length === 0)
    return { refusal: "لا يُعرف أمرُ المحرّك بعد — أعِد فتح التطبيق" };
  const trimmed = value.trim();
  if (preset.input.kind !== "none" && trimmed.length === 0)
    return { refusal: `${preset.input.label} مطلوب` };
  const argv = [...enginePrefix, ...preset.argv];
  if (preset.input.kind === "path")
    argv.push(trimmed);
  return argv;
};
var uniqueId = (wanted, taken) => {
  if (!taken.includes(wanted))
    return wanted;
  for (let n = 2;n < 100; n += 1) {
    const candidate = `${wanted}-${n}`;
    if (!taken.includes(candidate))
      return candidate;
  }
  return `${wanted}-${Date.now().toString(36).slice(-4)}`;
};
var presetHandle = (serverId, env) => `custom-${serverId}-${env.toLowerCase().split("_").join("-")}`;
export {
  uniqueId,
  presetHandle,
  presetCommand,
  presetById,
  exports_mcp_catalogue as McpCatalogue,
  MCP_PRESETS
};
