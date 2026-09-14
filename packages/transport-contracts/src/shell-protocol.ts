/**
 * Product shell protocol used by the desktop length-prefixed local carrier.
 * Transport owns this untrusted boundary so the engine cannot drift from it.
 */
export type Direction = "in" | "out"

export interface FrameSpec {
  readonly kind: string
  readonly dir: Direction
  readonly required?: readonly string[]
  readonly allowed?: readonly string[]
  readonly idempotent?: boolean
  readonly summary: string
}

const inbound = (
  kind: string,
  summary: string,
  allowed: readonly string[] = [],
  required: readonly string[] = [],
  idempotent = false,
): FrameSpec => ({ kind, dir: "in", allowed: ["kind", ...allowed], required, idempotent, summary })

export const SHELL_FRAMES: readonly FrameSpec[] = [
  inbound("submit", "دورٌ جديد؛ المعرّف المكرّر يُجاب بقبوله الأصلي", ["turn", "mode", "conversationMode", "attachments"], ["turn"], true),
  inbound("interrupt", "قطعُ الدور الجاري باسمه", ["turnId"], ["turnId"]),
  inbound("steer", "توجيهٌ لاحق للدور الجاري دون إعادة آثاره", ["turnId", "instruction"], ["turnId", "instruction"]),
  inbound("resume", "استئناف الأحداث بعد مؤشّر", ["seen"], ["seen"]),
  inbound("approve", "منحُ موافقةٍ معلّقة", ["turnId", "scope"], ["turnId"]),
  inbound("grant-revoke", "نقضُ منحٍ قائمٍ لهذه الجلسة", ["request", "target"], ["request", "target"]),
  inbound("denial-reset", "محوُ عدّاد رفضٍ متكرّر", ["request", "target"], ["request", "target"]),
  inbound("deny", "رفضُ موافقةٍ معلّقة", ["turnId"], ["turnId"]),
  inbound("mode-set", "تبديل نمط الصلاحية", ["mode"], ["mode"]),
  inbound("model-set", "ربط نموذجٍ بمرجع مزوّد/نموذج", ["name"], ["name"]),
  inbound("models", "طلب كتالوج النماذج مجموعاً بالمزوّد"),
  inbound("project-set", "تبديل مجلد المشروع", ["path"], ["path"]),
  inbound("hello", "تعريف القشرة بنفسها ومصادقة قناة الطفل عند طلبها", ["shell", "token"]),
  inbound("trust-grant", "توثيق مشروعٍ بيد المشغّل", ["path"], ["path"]),
  inbound("history", "طلب الجلسات مجموعةً"),
  inbound("recall", "استئناف جلسةٍ بأدوارها", ["session"], ["session"]),
  inbound("session-new", "حدُّ جلسةٍ جديد", ["conversationMode"]),
  inbound("memory-list", "قراءة ملاحظات المالك للمشروع والجلسة"),
  inbound("memory-note", "حفظ ملاحظة مالك صريحة — بصنفٍ اختياريّ: profile|topic|area|person", ["title", "text", "scope", "sensitive", "category"], ["title", "text"]),
  inbound("memory-forget", "إبطال ملاحظة مالك صريحة", ["id"], ["id"]),
  inbound("settings-get", "قراءة الإعدادات", ["requestId"]),
  inbound("usage-get", "قراءة خلاصة دفتر الاستهلاك السحابي المحلي", ["requestId"]),
  inbound("meter-get", "قراءة خلاصة العدّاد المحلي لكلّ نداء — مجاميعُ بلا أسماء", ["requestId"]),
  inbound("background-list", "لوحةُ المهامّ الخلفيّة: تشغيلاتُ run --bg والخوادمُ المُدارة بحالتها وذيلِ سجلّها (09-14)", ["requestId"]),
  inbound("remote-control-get", "حالةُ عبدو ريموت كونترول للإعدادات: العناوين ورمزُ الاقتران وعددُ العملاء", ["requestId"]),
  inbound("remote-control-regenerate", "رمزُ اقترانٍ جديد للريموت — يُبطل المعروضَ ولا يفصل الأجهزةَ المقترنة"),
  inbound("bridge-pairing-get", "قراءة رمز اقتران إضافة المتصفّح من ملفّ الحالة على قرص المستخدم", ["requestId"]),
  inbound("extensions-bundled-list", "قراءة الحزم المضمَّنة مع عبدو كود بجوار المحرّك — وصفٌ لا تثبيت", ["requestId"]),
  inbound("connector-list", "قراءة الموصّلات (جوجل، سلاك، Linear، Notion…) وحالةَ ربطِ كلٍّ منها من الخزنة", ["requestId"]),
  inbound("connector-auth", "ربطُ موصّلٍ بحساب المستخدم: OAuth في متصفّحه ورموزٌ إلى الخزنة وخادمُ MCP إلى الإعدادات", ["id"], ["id"]),
  inbound("connector-forget", "فصلُ موصّل: مسحُ رموزه من الخزنة وإزالةُ خادمه", ["id"], ["id"]),
  inbound("settings-set", "حفظ إعداداتٍ دون أسرار؛ expectedPluginsRevision سياجٌ اختياري لكتابات plugins", ["settings", "expectedPluginsRevision"], ["settings"]),
  inbound("vault-status", "حضور مفاتيح المزوّدين بنعم/لا"),
  inbound("external-connect", "توصيل مزوّد أدوات خارجي بقرار المالك", ["id", "command", "protocol"], ["id", "command"]),
  inbound("external-disconnect", "فصل مزوّد خارجي", ["id"], ["id"]),
  // لوحُ الخوادم (plugins.serversPanel). القياسُ **طلبٌ** لا اشتراك: اللوحُ
  // يسأل فيقيس المحرّكُ لحظتَها ويردّ — فلا حالةَ تُبثّ دورياً وتهرم بين بثّتين.
  inbound("servers", "طلبُ قياسِ الخوادم المُدارة الآن", [], [], true),
  inbound("server-stop", "إيقافُ خادمٍ مُدارٍ بمنفذه — بيد المشغّل وحده", ["port"], ["port"]),

  { kind: "ready", dir: "out", summary: "المحرّك جاهزٌ ومعه الإعدادات" },
  { kind: "admission", dir: "out", required: ["turnId", "seq", "fresh"], summary: "قبول دور" },
  { kind: "delta", dir: "out", required: ["turnId", "text"], summary: "قطعة بث عابرة" },
  { kind: "event", dir: "out", required: ["seq", "turnId", "payload"], summary: "حدث دائم مرقّم" },
  { kind: "done", dir: "out", required: ["turnId"], summary: "تمام دور" },
  { kind: "unresolved", dir: "out", required: ["turnId", "why"], summary: "دور بلا تمام مسجّل" },
  { kind: "interrupted", dir: "out", required: ["turnId"], summary: "دور قوطع" },
  { kind: "steered", dir: "out", required: ["turnId"], summary: "توجيه الدور الجاري قُبل" },
  { kind: "refused", dir: "out", required: ["why"], summary: "رفض مسمّى" },
  { kind: "approval", dir: "out", required: ["turnId", "request"], summary: "طلب موافقة على أثر" },
  { kind: "grants", dir: "out", required: ["grants"], summary: "المنح القائمة لهذه الجلسة" },
  { kind: "approval-expired", dir: "out", required: ["turnId"], summary: "انتهت مهلة سؤال موافقة فصار رفضاً" },
  { kind: "denials", dir: "out", required: ["denials"], summary: "عدّادات الرفض المتكرّر في هذه الجلسة" },
  { kind: "diff", dir: "out", required: ["turnId", "path", "diff"], summary: "معاينة كتابة" },
  { kind: "plan", dir: "out", required: ["turnId", "steps"], summary: "خطة حية" },
  { kind: "tool", dir: "out", required: ["turnId", "cmd"], summary: "أداة ستنفّذ" },
  { kind: "tool-result", dir: "out", required: ["turnId", "output"], summary: "ناتج أداة" },
  { kind: "history", dir: "out", required: ["sessions"], summary: "الجلسات" },
  { kind: "archive", dir: "out", required: ["session", "turns"], summary: "أدوار جلسة" },
  { kind: "session", dir: "out", required: ["id"], summary: "جلسة جديدة" },
  { kind: "memory-notes", dir: "out", required: ["facts"], summary: "ملاحظات المالك النشطة" },
  { kind: "memory-saved", dir: "out", required: ["id", "title", "scope"], summary: "حُفظت ملاحظة مالك" },
  { kind: "memory-forgotten", dir: "out", required: ["id"], summary: "أُبطلت ملاحظة مالك" },
  { kind: "memory-inferred", dir: "out", required: ["id", "topic", "note", "confidence", "turnId"], summary: "ذاكرةٌ مستنتَجة من تصحيحٍ في رسالة المستخدم — غير مؤكَّدة حتى يؤكّدها" },
  { kind: "memory-recall", dir: "out", required: ["turnId", "method", "candidates", "selected"], summary: "كيف اختيرت ذكريات الدور: semantic|cached|fallback|local، وكم مرشّحاً وكم مختاراً" },
  { kind: "models", dir: "out", required: ["groups"], summary: "كتالوج النماذج" },
  { kind: "model", dir: "out", required: ["name"], summary: "النموذج بُدّل" },
  { kind: "mode", dir: "out", required: ["mode"], summary: "النمط بُدّل" },
  { kind: "browse", dir: "out", required: ["url"], summary: "فتح رابط في لوحة القشرة" },
  { kind: "browser-shot", dir: "out", required: ["data"], summary: "لقطةُ PNG من صفحة متصفّح الوكيل إلى لوحة القشرة — للعرض لا للاستدلال" },
  { kind: "project", dir: "out", required: ["path"], summary: "المشروع بُدّل" },
  { kind: "trust-request", dir: "out", required: ["path"], summary: "طلب توثيق مشروع" },
  { kind: "settings", dir: "out", required: ["settings"], summary: "الإعدادات الحالية" },
  { kind: "usage-summary", dir: "out", required: ["summary"], summary: "خلاصة مجمعة لدفتر الاستهلاك السحابي المحلي" },
  { kind: "background-tasks", dir: "out", required: ["entries"], summary: "المهامُّ الخلفيّة: id/الأمر/الحالة/رمز الخروج/البداية/ذيلُ السجلّ، والخوادمُ المُدارة بمنفذها" },
  { kind: "meter-summary", dir: "out", required: ["summary"], summary: "خلاصة مجمعة للعدّاد المحلي (محلّيّ وسحابيّ) بلا أسماء مزوّدين أو نماذج" },
  { kind: "remote-control", dir: "out", required: ["status"], summary: "حالةُ عبدو ريموت كونترول: off | on مع المنفذ والعناوين ورمز الاقتران وعدد العملاء" },
  { kind: "bridge-pairing", dir: "out", required: ["status"], summary: "رمزُ اقتران إضافة المتصفّح ومنفذُها — للقشرة وحدها، يُلصق في نافذة الإضافة" },
  { kind: "extensions-bundled", dir: "out", required: ["entries"], summary: "الحزمُ المضمَّنة مع عبدو كود: معرّفٌ واسمٌ ووصفٌ ومسارٌ ومهارات — للمراجعة والتثبيت بالمسار المعتاد" },
  { kind: "connectors", dir: "out", required: ["entries"], summary: "الموصّلات وحالتُها: مربوطٌ/يحتاج معرّفَ تطبيق/موصول — بلا رموز" },
  { kind: "connector-open", dir: "out", required: ["id", "url"], summary: "رابطُ تسجيل الدخول يُفتح في متصفّح المستخدم الحقيقيّ (open_external)" },
  { kind: "connector-status", dir: "out", required: ["id", "state"], summary: "حالةُ ربطِ موصّل: authorizing/needs-client/linked/unlinked/error مع تفصيلٍ مقروء" },
  { kind: "servers", dir: "out", required: ["rows"], summary: "الخوادم المُدارة بحالةٍ مقيسة لحظةَ الطلب" },
  { kind: "plugins", dir: "out", required: ["turnId", "entries"], summary: "جرد الإضافات المقروءة في الدور بقيمها النافذة وأسبابها" },
  { kind: "vault-status", dir: "out", required: ["status"], summary: "حضور المفاتيح" },
  { kind: "external", dir: "out", required: ["id", "tools"], summary: "مزوّد خارجي موصول" },
  { kind: "external-gone", dir: "out", required: ["id"], summary: "مزوّد خارجي مفصول" },
  { kind: "resumed", dir: "out", required: ["from", "upTo"], summary: "مدى إعادة البث" },
  { kind: "running", dir: "out", required: ["turnId"], summary: "الدور ما زال جارياً" },
]

const inboundByKind = new Map(SHELL_FRAMES.filter((frame) => frame.dir === "in").map((frame) => [frame.kind, frame]))
export type ShellValidation = { readonly ok: true } | { readonly ok: false; readonly why: string }

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
const validMode = (value: unknown): boolean => value === "read-only" || value === "auto" || value === "full-access"
const invalidField = (kind: string, field: string): ShellValidation => ({
  ok: false,
  why: `الحقل «${field}» غير صالح في الإطار «${kind}»`,
})

/** Validate a decoded shell frame before any engine handler sees it. */
export const validateShellFrame = (value: unknown): ShellValidation => {
  if (!plainRecord(value)) return { ok: false, why: "الإطار ليس كائناً عادياً" }
  const kind = value.kind
  if (typeof kind !== "string") return { ok: false, why: "إطارٌ بلا kind" }
  const spec = inboundByKind.get(kind)
  if (spec === undefined) return { ok: false, why: `إطارٌ غير معروف «${kind}» — المعروف: ${[...inboundByKind.keys()].join("، ")}` }

  for (const field of spec.required ?? []) {
    if (value[field] === undefined) return { ok: false, why: `الإطار «${kind}» يحتاج الحقل «${field}»` }
  }
  const allowed = new Set(spec.allowed)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) return { ok: false, why: `الحقل «${field}» غير معروف في الإطار «${kind}»` }
  }

  if (kind === "submit") {
    if (!plainRecord(value.turn)) return invalidField(kind, "turn")
    if (Object.keys(value.turn).some((field) => field !== "id" && field !== "body")) return invalidField(kind, "turn")
    if (!boundedString(value.turn.id, 128) || typeof value.turn.body !== "string" || value.turn.body.length > 256 * 1024) return invalidField(kind, "turn")
    if (value.mode !== undefined && !validMode(value.mode)) return invalidField(kind, "mode")
    if(value.conversationMode!==undefined&&!['chat','code'].includes(value.conversationMode as string))return invalidField(kind,'conversationMode')
    if(value.attachments!==undefined&&(!Array.isArray(value.attachments)||value.attachments.length>4||new Set(value.attachments).size!==value.attachments.length||value.attachments.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id))))return invalidField(kind,'attachments')
  } else if(kind==='session-new') {
    if(value.conversationMode!==undefined&&!['chat','code'].includes(value.conversationMode as string))return invalidField(kind,'conversationMode')
  } else if (kind === "resume") {
    if (!Number.isSafeInteger(value.seen) || (value.seen as number) < 0) return invalidField(kind, "seen")
  } else if (kind === "mode-set") {
    if (!validMode(value.mode)) return invalidField(kind, "mode")
  } else if (kind === "settings-get" || kind === "usage-get" || kind === "meter-get" || kind === "background-list" || kind === "remote-control-get") {
    if (value.requestId !== undefined && (!boundedString(value.requestId, 80) || !/^[a-zA-Z0-9-]+$/.test(value.requestId))) return invalidField(kind, "requestId")
  } else if (kind === "settings-set") {
    if (!plainRecord(value.settings)) return invalidField(kind, "settings")
    // سياج مراجعة فضاء plugins: عددٌ صحيحٌ آمن غير سالب، وغيابه كتابةٌ غير مشروطة.
    if (value.expectedPluginsRevision !== undefined && (!Number.isSafeInteger(value.expectedPluginsRevision) || (value.expectedPluginsRevision as number) < 0)) {
      return invalidField(kind, "expectedPluginsRevision")
    }
  } else if (kind === "external-connect") {
    if (!boundedString(value.id, 32) || !/^[a-z0-9-]+$/.test(value.id)) return invalidField(kind, "id")
    if (!Array.isArray(value.command) || value.command.length < 1 || value.command.length > 32 || value.command.some((part) => !boundedString(part, 8192))) return invalidField(kind, "command")
    // السلك: لغتُنا أو MCP القياسيّ. **مغلقٌ بالاسم** كبقيّة الحقول — قيمةٌ
    // خارجهما تعني سلكاً يُبنى في العدم، والغيابُ = `native` فالموصولُ قبل
    // اليوم لا يتغيّر سلوكُه.
    if (value.protocol !== undefined && value.protocol !== "native" && value.protocol !== "mcp") return invalidField(kind, "protocol")
  } else if (kind === "external-disconnect") {
    if (!boundedString(value.id, 32) || !/^[a-z0-9-]+$/.test(value.id)) return invalidField(kind, "id")
  } else if (kind === "hello") {
    if (value.shell !== undefined && !boundedString(value.shell, 64)) return invalidField(kind, "shell")
    if (value.token !== undefined && !boundedString(value.token, 256)) return invalidField(kind, "token")
  } else if (kind === "project-set" || kind === "trust-grant") {
    if (!boundedString(value.path, 32_767)) return invalidField(kind, "path")
  } else if (kind === "model-set") {
    if (!boundedString(value.name, 512)) return invalidField(kind, "name")
  } else if (kind === "recall") {
    if (!boundedString(value.session, 128)) return invalidField(kind, "session")
  } else if (kind === "memory-note") {
    if (!boundedString(value.title, 120) || /[\u0000-\u001f\u007f]/u.test(value.title as string)) return invalidField(kind, "title")
    if (!boundedString(value.text, 8_000) || (value.text as string).includes("\0")) return invalidField(kind, "text")
    if (value.scope !== undefined && value.scope !== "project" && value.scope !== "session") return invalidField(kind, "scope")
    if (value.sensitive !== undefined && typeof value.sensitive !== "boolean") return invalidField(kind, "sensitive")
  } else if (kind === "memory-forget") {
    if (!boundedString(value.id, 128)) return invalidField(kind, "id")
  } else if (kind === "steer") {
    if (!boundedString(value.turnId, 128)) return invalidField(kind, "turnId")
    if (!boundedString(value.instruction, 16 * 1024)) return invalidField(kind, "instruction")
  } else if (kind === "grant-revoke" || kind === "denial-reset") {
    if (!boundedString(value.request, 32)) return invalidField(kind, "request")
    if (!boundedString(value.target, 128)) return invalidField(kind, "target")
  } else if (kind === "interrupt" || kind === "approve" || kind === "deny") {
    // نطاقُ الموافقة **مغلقٌ بالاسم**: «مرّة» أو «هذه الأداة» أو «هذا المزوّد».
    // قيمةٌ خارجها تعني إذناً يُبنى في العدم، فتُرفض هنا لا تُصحَّح صامتةً.
    if (kind === "approve" && value.scope !== undefined
      && value.scope !== "once" && value.scope !== "tool" && value.scope !== "namespace") {
      return invalidField(kind, "scope")
    }
    if (!boundedString(value.turnId, 128)) return invalidField(kind, "turnId")
  }
  return { ok: true }
}

/** Client reference generated from the exact catalogue consumed by the engine. */
export const shellSdkReference = (): string => {
  const line = (frame: FrameSpec) => `  ${frame.kind}${frame.required?.length ? ` { ${frame.required.join(", ")} }` : ""}${frame.idempotent ? "  [idempotent]" : ""} — ${frame.summary}`
  return [
    "# بروتوكول عبدو كود", "", "أُطر JSON ببادئة طول 32-bit وحد 1MiB على قناة الطفل المحلية؛ ووضع سطر JSON متاح للـCLI المباشر فقط.", "",
    "## الوارد (عميل ← محرّك)", ...SHELL_FRAMES.filter((frame) => frame.dir === "in").map(line), "",
    "## الصادر (محرّك ← عميل)", ...SHELL_FRAMES.filter((frame) => frame.dir === "out").map(line),
  ].join("\n")
}
