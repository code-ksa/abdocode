// سوقُ عبدو كود — البذرةُ المشحونة مع البناء (أمر المالك 2026-09-14: «ماركت بليس للبلاجينز والاسكيلز، والمستخدمون ينزّلونها كلَّها مجّاناً»).
// كلُّ مدخلٍ مثبَّتٌ إلى كوميت في code-ksa/abdocode-addons وبصمةِ SHA-256 من SHA256SUMS عند الكوميت نفسه؛
// التنزيلُ يمرّ بالمسار الأصليّ القائم (extensions_download يتحقّق من البايتات ⇦ مراجعةٌ ⇦ تثبيتٌ معطَّلاً ⇦ تفعيلٌ صريح).
// الفهرسُ البعيد (release/marketplace.json على main) يُدمَج فوق هذه البذرة عند «تحديث السوق» — الشكلُ نفسُه.
export const MARKETPLACE_INDEX_URL = "https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/marketplace.json";
export const MARKETPLACE_KINDS = ["skills", "mcp", "mixed"];
export const MARKETPLACE_CATALOGUE = [
  {
    "id": "abdo-workflow",
    "name": "AbdoCode project workflows",
    "nameAr": "سير عمل مشاريع عبدو كود",
    "description": "Sprint planning, evidence-based project resume, browser verification and workspace document work. Uses existing authorized tools.",
    "descriptionAr": "تخطيط السبرنتات، واستئناف المشروع بالدليل، والتحقّق بالمتصفّح، والعمل على مستندات مساحة العمل — بالأدوات المصرَّح بها وحدها.",
    "kind": "skills",
    "tags": ["planning", "verification", "documents"],
    "skills": ["project-resume", "sprint-plan", "browser-check", "cowork"],
    "publisher": "code-ksa",
    "commit": "70a181f31a8ecd9c2ee3a3629adb3f22033d3587",
    "url": "https://raw.githubusercontent.com/code-ksa/abdocode-addons/70a181f31a8ecd9c2ee3a3629adb3f22033d3587/release/workflow.json",
    "sha256": "95a5f1d87a554d1b4afef6a2546eeb1e14df0a599ec169219bc2076a3c8ce349",
    "bytes": 4214
  },
  {
    "id": "gmail-readonly",
    "name": "Gmail (read only)",
    "nameAr": "جيميل (قراءة فقط)",
    "description": "Read Gmail through its official API. Requires Node.js 18+ and a user-authorized OAuth token with gmail.readonly access. No send, delete or modify tools.",
    "descriptionAr": "قراءة جيميل عبر واجهته الرسميّة. يحتاج Node.js 18+ ورمزَ OAuth بصلاحيّة gmail.readonly يضعه المستخدم في الخزنة. لا إرسال ولا حذف ولا تعديل.",
    "kind": "mixed",
    "tags": ["mail", "mcp", "read-only"],
    "skills": ["mail-review"],
    "requires": "Node.js 18+",
    "publisher": "code-ksa",
    "commit": "70a181f31a8ecd9c2ee3a3629adb3f22033d3587",
    "url": "https://raw.githubusercontent.com/code-ksa/abdocode-addons/70a181f31a8ecd9c2ee3a3629adb3f22033d3587/release/gmail-readonly.json",
    "sha256": "526a5730ec7dfd9045625e5d3a69d3ecf3f4b4bb71dbdafdd0db4921ca644836",
    "bytes": 5642
  }
];
// الشكلُ المقبول لمدخلٍ بعيد — تُطبَّق القاعدةُ نفسُها في Rust (marketplace.rs) قبل أن يصل الفهرسُ إلى الواجهة؛ هنا حارسٌ ثانٍ للبذرة والدمج.
const PINNED = /^https:\/\/raw\.githubusercontent\.com\/code-ksa\/[A-Za-z0-9._-]+\/[0-9a-f]{40}\/[A-Za-z0-9._\/-]+\.json$/u;
export function validMarketEntry(entry) {
  return !!entry && typeof entry === "object"
    && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(String(entry.id ?? ""))
    && typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 80
    && MARKETPLACE_KINDS.includes(entry.kind)
    && PINNED.test(String(entry.url ?? ""))
    && /^[0-9a-f]{64}$/u.test(String(entry.sha256 ?? ""))
    && Array.isArray(entry.skills ?? []) && Array.isArray(entry.tags ?? []);
}
// يدمج فهرساً بعيداً فوق البذرة: المعرِّفُ مفتاحٌ والبعيدُ الصالح يفوز؛ الفاسدُ يُسقَط ولا يُرفع.
export function mergeMarket(seed, remote) {
  const byId = new Map(seed.filter(validMarketEntry).map((e) => [e.id, e]));
  for (const entry of Array.isArray(remote) ? remote : []) if (validMarketEntry(entry)) byId.set(entry.id, entry);
  return [...byId.values()];
}
