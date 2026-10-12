import type { SqliteFactStore } from "@abdo/memory"
import { classifyInboundSecret } from "./secret-intake"

export type MemoryCommand = { action: "save"; title: string; text: string; session: boolean } | { action: "forget"; title: string; session: boolean } | { action: "list" }

/** Only an explicit top-level command can persist a user preference. */
export function parseMemoryCommand(body: string): MemoryCommand | undefined {
  const text = body.trim()
  if (/^(?:\/memory|اعرض الذاكرة)$/iu.test(text)) return { action: "list" }
  const save = text.match(/^(?:\/?remember|تذكر|تذكّر)(\s+--session)?\s+([^:\n]{1,120}):\s*([^\0]+)$/iu)
  if (save) return { action: "save", title: save[2]!.trim(), text: save[3]!.trim(), session: !!save[1] }
  const forget = text.match(/^(?:\/?forget|انس)(\s+--session)?\s+([^\n]{1,120})$/iu)
  if (forget) return { action: "forget", title: forget[2]!.trim(), session: !!forget[1] }
  return undefined
}

/**
 * نطاقُ «كلّ المشاريع»: ملاحظاتُ المالك التي تخصّه هو لا مشروعاً بعينه (تخصيصاتُه المستوردة من ChatGPT وClaude
 * وGemini ووكلاء مشاريعه، أو ملاحظةٌ يختار لها هذا النطاق). **المالكُ نفسُه لا مخزنٌ ثانٍ**: المخزنُ نفسُه
 * (SqliteFactStore) والمفتاحُ نفسُه (`owner-note:`) والحارسُ نفسُه (`saveOwnerMemory`) — بمعرّف مشروعٍ محجوز
 * لا يكون مساراً مطلقاً أبداً، فلا يصطدم بمشروعٍ حقيقيّ ولا يعبر حارسَ «المشروع الآخر» في فهرس الوعي.
 */
export const USER_MEMORY_PROJECT = "abdo:user"

/**
 * ملاحظاتُ المالك بنطاق «كلّ المشاريع» — تُقدَّم **قبل** حقائق المشروع في المسار نفسِه
 * (factsForAutomaticRecall ⇦ SemanticMemory.recall ⇦ [PROJECT_MEMORY])، فملاحظةُ مشروعٍ بالعنوان نفسِه تغلبها
 * (الأحدثُ موضعاً يفوز في recallBrief). بلا جلسة: التخصيصُ لا يخصّ محادثة.
 */
export function userOwnerNotes(store: SqliteFactStore, now = Date.now()) {
  return store.query({ projectId: USER_MEMORY_PROJECT, now }).facts.filter((f) => f.kind === "project_fact" && f.sessionId === undefined && f.key.startsWith("owner-note:"))
}

/** أصلُ ملاحظةٍ مستوردة: أيُّ وكيلٍ ومن أيّ ملفٍّ/حقلٍ ومتى — يُحفظ مع الملاحظة فيراه المالكُ في صفحة الذاكرة. */
export interface ImportedOrigin { readonly agent: string; readonly from: string; readonly importedAt: string }

export function saveOwnerMemory(store: SqliteFactStore, input: {
  projectId: string; sessionId?: string; title: string; text: string; sensitive?: boolean; allowSensitive: boolean; source: string; category?: "profile" | "topic" | "area" | "person"; importedFrom?: ImportedOrigin;
}) {
  const title = input.title.trim(), text = input.text.trim()
  if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/u.test(title) || !text || text.length > 8000 || text.includes("\0")) throw Error("Memory needs a valid title and text. الذاكرة تحتاج عنوانًا ونصًا صالحين.")
  if (input.sensitive && !input.allowSensitive) throw Error("Sensitive memory is disabled. حفظ الذاكرة الحساسة معطّل.")
  if (classifyInboundSecret(title + "\n" + text).carriesSecret) throw Error("Store credentials in the vault, not memory. احفظ الاعتمادات في الخزنة.")
  const key = `owner-note:${title}`
  const previous = store.query({projectId:input.projectId,sessionId:input.sessionId,now:Date.now()}).facts.filter(f=>f.key===key&&f.kind==='project_fact'&&f.sessionId===input.sessionId).at(-1)
  const sources = [...new Set([input.source,...(previous?.sourceEventIds??[])])].slice(0,8)
  return store.replaceVerified({ projectId: input.projectId, sessionId: input.sessionId, kind: "project_fact", key, value: { note: text, sensitive: !!input.sensitive, ...(input.category === undefined ? {} : { category: input.category }), ...(input.importedFrom === undefined ? {} : { importedFrom: { ...input.importedFrom } }) }, sourceEventIds: sources })
}
