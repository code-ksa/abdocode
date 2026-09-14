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

export function saveOwnerMemory(store: SqliteFactStore, input: {
  projectId: string; sessionId?: string; title: string; text: string; sensitive?: boolean; allowSensitive: boolean; source: string; category?: "profile" | "topic" | "area" | "person";
}) {
  const title = input.title.trim(), text = input.text.trim()
  if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/u.test(title) || !text || text.length > 8000 || text.includes("\0")) throw Error("Memory needs a valid title and text. الذاكرة تحتاج عنوانًا ونصًا صالحين.")
  if (input.sensitive && !input.allowSensitive) throw Error("Sensitive memory is disabled. حفظ الذاكرة الحساسة معطّل.")
  if (classifyInboundSecret(title + "\n" + text).carriesSecret) throw Error("Store credentials in the vault, not memory. احفظ الاعتمادات في الخزنة.")
  const key = `owner-note:${title}`
  const previous = store.query({projectId:input.projectId,sessionId:input.sessionId,now:Date.now()}).facts.filter(f=>f.key===key&&f.kind==='project_fact'&&f.sessionId===input.sessionId).at(-1)
  const sources = [...new Set([input.source,...(previous?.sourceEventIds??[])])].slice(0,8)
  return store.replaceVerified({ projectId: input.projectId, sessionId: input.sessionId, kind: "project_fact", key, value: { note: text, sensitive: !!input.sensitive, ...(input.category === undefined ? {} : { category: input.category }) }, sourceEventIds: sources })
}
