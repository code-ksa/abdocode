/**
 * سجلُّ الموصّلات — ما يستطيع المستخدم ربطَه بضغطة «وصّل» كما في كلود: جوجل (Gmail/Calendar/Drive) بخادمنا المدمج، وخوادمُ
 * MCP البعيدة (Slack، Linear، Notion، Asana، Atlassian، Figma، Intercom، GitHub) عبر الجسر `mcp-remote`.
 *
 * الوحدةُ نقيّة: تعريفاتٌ ومشتقّاتُ أسماء (مقابضُ الخزنة، أسماءُ البيئة الممنوحة، أمرُ الخادم). لا شبكةَ ولا قرص.
 *
 * قاعدةُ الأسرار: كلُّ رمزٍ في الخزنة تحت `custom-connector-<id>-<اسم>`، والخادمُ يقرؤه من بيئته عبر منح `secrets` — لا سطرَ أمرٍ
 * يحمل سرّاً. ما يحتاجه المالك (معرّفُ عميلٍ وسرّ) يُقال بالاسم في `ownerClient`.
 */
import { GOOGLE_SCOPES, GOOGLE_TOKEN_URL } from "../mcp-servers/google"
import { CONNECTOR_ENV } from "../mcp-servers/remote"

export type ConnectorKind = "google" | "remote"

export interface ConnectorSpec {
  readonly id: string
  readonly label: string
  readonly labelAr: string
  readonly kind: ConnectorKind
  /** موردُ MCP البعيد (للنوع remote) — منه يُكتشف خادمُ التفويض. */
  readonly resource?: string
  /** خادمُ تفويضٍ معروفٌ مسبقاً حين لا يعلن المورد بياناتِه (جوجل). */
  readonly authServer?: { readonly authorization_endpoint: string; readonly token_endpoint: string }
  readonly scope: string
  /** وسائطُ تفويضٍ خاصّة بالخدمة. */
  readonly authorizeExtra?: Readonly<Record<string, string>>
  /** هل تحتاج الخدمةُ معرّفَ عميلٍ (وسرّاً) يصنعه المالك؟ وإلا تسجيلٌ ديناميكيّ. */
  readonly ownerClient?: { readonly secret: boolean; readonly howTo: string }
  /** منفذُ loopback ثابتٌ إن كانت الخدمة تطلب تسجيلَ عنوان الرجوع بالضبط (سلاك). */
  readonly callbackPort?: number
  /** ما يراه المستخدم قبل الربط. */
  readonly tools: readonly string[]
  readonly category: string
}

export const CONNECTORS: readonly ConnectorSpec[] = Object.freeze([
  Object.freeze({ id: "google", label: "Google (Gmail · Calendar · Drive)", labelAr: "جوجل (Gmail · التقويم · Drive)", kind: "google" as const, authServer: { authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: GOOGLE_TOKEN_URL }, scope: GOOGLE_SCOPES.join(" "), authorizeExtra: { access_type: "offline", prompt: "consent" }, ownerClient: { secret: true, howTo: "Google Cloud Console ← APIs & Services ← Credentials ← OAuth client ID ← Desktop app؛ ثمّ فعّل Gmail API وCalendar API وDrive API." }, tools: ["gmail_search", "gmail_read", "gmail_draft", "gmail_send_draft", "calendar_events", "calendar_create", "drive_search", "drive_read"], category: "email-calendar-files" }),
  Object.freeze({ id: "slack", label: "Slack", labelAr: "سلاك", kind: "remote" as const, resource: "https://mcp.slack.com/mcp", scope: "channels:history channels:read chat:write groups:history groups:read im:history im:read mpim:history mpim:read search:read.public search:read.private users:read", ownerClient: { secret: true, howTo: "api.slack.com/apps ← Create App ← OAuth & Permissions: أضف Redirect URL `http://127.0.0.1:9371/callback` وانسخ Client ID وClient Secret." }, callbackPort: 9371, tools: ["slack_search", "slack_read_channel", "slack_post_message", "slack_list_channels"], category: "chat" }),
  Object.freeze({ id: "linear", label: "Linear", labelAr: "Linear", kind: "remote" as const, resource: "https://mcp.linear.app/mcp", scope: "read write", tools: ["issues", "projects", "comments"], category: "project-tracker" }),
  Object.freeze({ id: "notion", label: "Notion", labelAr: "Notion", kind: "remote" as const, resource: "https://mcp.notion.com/mcp", scope: "default", tools: ["search", "pages", "databases"], category: "knowledge-base" }),
  Object.freeze({ id: "asana", label: "Asana", labelAr: "Asana", kind: "remote" as const, resource: "https://mcp.asana.com/v2/mcp", scope: "default", tools: ["tasks", "projects"], category: "project-tracker" }),
  Object.freeze({ id: "atlassian", label: "Atlassian (Jira · Confluence)", labelAr: "Atlassian (Jira · Confluence)", kind: "remote" as const, resource: "https://mcp.atlassian.com/v1/mcp", scope: "read:jira-work write:jira-work read:confluence-content.all offline_access", tools: ["jira", "confluence"], category: "project-tracker" }),
  Object.freeze({ id: "figma", label: "Figma", labelAr: "Figma", kind: "remote" as const, resource: "https://mcp.figma.com/mcp", scope: "default", tools: ["files", "nodes", "images"], category: "design" }),
  Object.freeze({ id: "intercom", label: "Intercom", labelAr: "Intercom", kind: "remote" as const, resource: "https://mcp.intercom.com/mcp", scope: "default", tools: ["conversations", "contacts"], category: "user-feedback" }),
  // مقيس 2026-09-14: كلاهما يردّ 401 مع resource_metadata، وPRM يعلن خادمَ التفويض والنطاقات — الشكلُ نفسُه كـNotion.
  Object.freeze({ id: "granola", label: "Granola (meeting notes)", labelAr: "Granola (ملاحظات الاجتماعات)", kind: "remote" as const, resource: "https://mcp.granola.ai/mcp", scope: "mcp", tools: ["meetings", "notes", "search"], category: "knowledge-base" }),
  Object.freeze({ id: "gamma", label: "Gamma (presentations · docs)", labelAr: "Gamma (عروض · مستندات)", kind: "remote" as const, resource: "https://mcp.gamma.app/mcp", scope: "generate gamma:read", tools: ["generate", "gammas"], category: "design" }),
  Object.freeze({ id: "github", label: "GitHub", labelAr: "GitHub", kind: "remote" as const, resource: "https://api.githubcopilot.com/mcp/", scope: "repo read:org", tools: ["repos", "issues", "pull_requests", "search"], category: "code" }),
])

export const connectorById = (id: string): ConnectorSpec | undefined => CONNECTORS.find((c) => c.id === id)

/** مقابضُ الخزنة لموصّل — كلُّها تحت `custom-connector-<id>-` فتعبر حارسَ المقابض (custom-) وتُقرأ بالمنح. */
export const connectorHandles = (id: string) => Object.freeze({
  access: `custom-connector-${id}-access`,
  refresh: `custom-connector-${id}-refresh`,
  clientId: `custom-connector-${id}-client-id`,
  clientSecret: `custom-connector-${id}-client-secret`,
  tokenUrl: `custom-connector-${id}-token-url`,
})

/** منحُ البيئة للخادم — الأسماءُ نفسُها التي يقرؤها `mcp-remote` و`mcp-google`. */
export function connectorGrants(id: string, hasSecret: boolean): readonly { env: string; handle: string }[] {
  const h = connectorHandles(id)
  return [
    { env: CONNECTOR_ENV.access, handle: h.access },
    { env: CONNECTOR_ENV.refresh, handle: h.refresh },
    { env: CONNECTOR_ENV.clientId, handle: h.clientId },
    { env: CONNECTOR_ENV.tokenUrl, handle: h.tokenUrl },
    ...(hasSecret ? [{ env: CONNECTOR_ENV.clientSecret, handle: h.clientSecret }] : []),
  ]
}

/** أمرُ خادم MCP للموصّل — رأسُ أمر المحرّك ثمّ الأمرُ الفرعيّ؛ لا سرَّ فيه. */
export function connectorCommand(spec: ConnectorSpec, enginePrefix: readonly string[]): readonly string[] {
  if (enginePrefix.length === 0) throw new Error("لا يُعرف أمرُ المحرّك بعد")
  return spec.kind === "google" ? [...enginePrefix, "mcp-google"] : [...enginePrefix, "mcp-remote", spec.resource ?? ""]
}

/** معرّفُ الخادم في settings.mcpServers لموصّلٍ — ثابتٌ كي يعرفه التوصيل التلقائيّ. */
export const connectorServerId = (id: string): string => `connector-${id}`
