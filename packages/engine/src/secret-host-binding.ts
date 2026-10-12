/**
 * البند 27 من جرد هيرمس/أوبن‑كلاو — ربطُ السرّ بمضيفه (plugins.secretHostBinding، مطفأٌ افتراضاً لأنّه يغيّر سلوكاً).
 * مفتاحُ المزوّد في الخزنة يُربط بمضيف أوّلِ طلبٍ يحمله (ثقةُ أوّلِ استعمال)، وطلبٌ بالمفتاح نفسِه إلى مضيفٍ آخر يُرفض قبل أن
 * يخرج — فتعديلُ عنوان مزوّدٍ مخصّص (يدوياً أو بملفٍّ مسموم) لا يرسل المفتاحَ إلى خادمٍ لم يُرسَل إليه قطّ.
 * لا سرَّ هنا: المقبضُ (اسمُ الخزنة) والمضيفُ وحدهما. وإعادةُ الربط بيد المستخدم وحده: إطفاءُ المفتاح يمحو الروابط، وتشغيلُه
 * يربط من جديد عند أوّل طلب — النموذجُ لا يملك أداةً تفعل ذلك.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type SecretHostVerdict =
  | { readonly ok: true; readonly host: string; readonly bound: "existing" | "new" }
  | { readonly ok: false; readonly boundHost: string; readonly requestedHost: string; readonly message: string }

const hostOf = (url: string): string | undefined => { try { return new URL(url).host.toLowerCase() } catch { return undefined } }

function readBindings(file: string): Record<string, { host: string; boundAt: string }> {
  try { const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, { host: string; boundAt: string }> : {} } catch { return {} }
}

export function secretHostVerdict(file: string, handle: string, url: string, now: Date = new Date()): SecretHostVerdict {
  const host = hostOf(url)
  if (host === undefined) return { ok: false, boundHost: "", requestedHost: url.slice(0, 80), message: `رُفض الطلب: عنوانٌ غيرُ صالح للمفتاح ${handle}` }
  const bindings = readBindings(file)
  const existing = bindings[handle]
  if (existing !== undefined && typeof existing.host === "string") {
    if (existing.host === host) return { ok: true, host, bound: "existing" }
    return {
      ok: false, boundHost: existing.host, requestedHost: host,
      message: `رُفض الطلب قبل خروجه: المفتاح ${handle} مربوطٌ بالمضيف ${existing.host} والطلبُ إلى ${host} (plugins.secretHostBinding). إن كان تغييرُ العنوان مقصوداً فأطفئ «ربط السرّ بمضيفه» من الإعدادات ← الإضافات ثمّ أعد تشغيله — يُربط المفتاحُ بالمضيف الجديد عند أوّل طلب.`,
    }
  }
  bindings[handle] = { host, boundAt: now.toISOString() }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(bindings, null, 2))
  return { ok: true, host, bound: "new" }
}

/** المفتاحُ مطفأ ⇦ لا روابط: إطفاؤه هو طريقُ المستخدم لإعادة الربط. */
export function clearSecretHostBindings(file: string): void {
  if (existsSync(file)) rmSync(file, { force: true })
}
