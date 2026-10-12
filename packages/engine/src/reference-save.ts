/**
 * 10-10 — «page save» (DevTools Inspect ⇦ <html> ⇦ Copy element + أوراقُ الأنماط والسكربتات) له بابان: المتصفّحُ المملوك (cli.ts)
 * وإضافةُ المتصفّح الحقيقيّ (chrome-bridge.ts). الملفّاتُ وأسماؤها ومجلّدُها من هنا وحدها كي لا يتباعد البابان.
 *
 * مقيس 10-10 في مهمّة n8n: `page save n8n.io/home` كتب في جذر المشروع لا تحت .abdo/reference، و`data-abdo-seq` بقي في HTML المنسوخ.
 * الآن: كلُّ مجلّدٍ يُسمّى يوضع تحت .abdo/reference/ (إلّا إن بدأ بها)، والمسارُ المطلق و`..` مرفوضان، وسماتُ عبدو كود تُنزع.
 */

export interface ReferenceCopy {
  readonly url: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly html: string
  readonly styles: readonly { readonly href: string | null; readonly media?: string; readonly text?: string; readonly error?: string; readonly truncated?: boolean }[]
  readonly scripts: readonly { readonly src: string | null; readonly type?: string; readonly text?: string; readonly error?: string; readonly truncated?: boolean }[]
}

export const REFERENCE_ROOT = ".abdo/reference"

/** Pure. The folder a capture goes to, relative to the project — or a refusal naming why. */
export function referenceDir(dirArg: string, pageUrl: string): { ok: true; dir: string } | { ok: false; why: string } {
  let url: URL
  try { url = new URL(pageUrl) } catch { return { ok: false, why: "تعذّر قراءةُ رابط الصفحة المفتوحة" } }
  const slug = (url.pathname.replace(/\/+$/u, "") || "/home").replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 60) || "home"
  const asked = dirArg.trim().replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "")
  if (asked.length === 0) return { ok: true, dir: `${REFERENCE_ROOT}/${url.hostname}/${slug}` }
  if (/^(?:[A-Za-z]:|\/)/u.test(asked) || asked.split("/").some((part) => part === ".." || part === "")) return { ok: false, why: `مجلّدٌ غيرُ مقبول «${asked.slice(0, 80)}» — اكتب مساراً نسبيّاً بلا «..» (يوضع تحت ${REFERENCE_ROOT}/)` }
  return { ok: true, dir: asked === REFERENCE_ROOT || asked.startsWith(`${REFERENCE_ROOT}/`) ? asked : `${REFERENCE_ROOT}/${asked}` }
}

/** Pure. The copied <html> without the attributes AbdoCode itself stamped on the page (refs, ref counter). */
export function cleanCopiedHtml(html: string): string {
  const body = html.replace(/\sdata-abdo-(?:ref|seq)="[^"]*"/gu, "")
  return /^\s*<!doctype/iu.test(body) ? body : `<!DOCTYPE html>\n${body}`
}

const nameOf = (u: string | null, index: number, ext: string): string => {
  const base = u === null ? `inline-${index + 1}` : (u.split(/[?#]/u)[0]!.split("/").pop() || `file-${index + 1}`).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60)
  return `${String(index + 1).padStart(2, "0")}-${base.replace(new RegExp(`\\.${ext}$`, "iu"), "")}.${ext}`
}

/** Pure. Every file of one capture (page.html, styles/, scripts/, meta.json), paths under `dir`. */
export function referenceFiles(copy: ReferenceCopy, dir: string, how: string): { path: string; content: string }[] {
  const has = (t: string | undefined): t is string => typeof t === "string" && t.length > 0
  const files: { path: string; content: string }[] = [{ path: `${dir}/page.html`, content: cleanCopiedHtml(copy.html) }]
  copy.styles.forEach((s, i) => { if (has(s.text)) files.push({ path: `${dir}/styles/${nameOf(s.href, i, "css")}`, content: s.text }) })
  copy.scripts.forEach((s, i) => { if (has(s.text)) files.push({ path: `${dir}/scripts/${nameOf(s.src, i, "js")}`, content: s.text }) })
  const meta = { url: copy.url, title: copy.title, viewport: copy.viewport, capturedAt: new Date().toISOString(), how,
    styles: copy.styles.map((s, i) => ({ source: s.href ?? "inline <style>", ...(s.media ? { media: s.media } : {}), file: has(s.text) ? nameOf(s.href, i, "css") : undefined, chars: s.text?.length ?? 0, ...(s.error ? { error: s.error } : {}), ...(s.truncated ? { truncated: true } : {}) })),
    scripts: copy.scripts.map((s, i) => ({ source: s.src ?? "inline <script>", type: s.type, file: has(s.text) ? nameOf(s.src, i, "js") : undefined, chars: s.text?.length ?? 0, ...(s.error ? { error: s.error } : {}), ...(s.truncated ? { truncated: true } : {}) })) }
  files.push({ path: `${dir}/meta.json`, content: JSON.stringify(meta, null, 2) })
  return files
}

/** Pure. The receipt the model reads: what was written where, never the content. */
export function referenceReceipt(copy: ReferenceCopy, dir: string, written: readonly string[], refused: readonly string[], where = ""): string {
  const skipped = [...copy.styles.filter((s) => s.error), ...copy.scripts.filter((s) => s.error)].length
  let host = ""
  try { host = new URL(copy.url).hostname } catch { /* الرابطُ فُحص قبلها */ }
  return [
    `نسختُ الصفحة كما يفعل DevTools «Copy element» على <html>${where}: ${copy.title || host} — ${copy.url}`,
    `كُتب ${written.length} ملفّاً في ${dir}/ (HTML ${copy.html.length} حرفاً، أنماط ${copy.styles.length}، سكربتات ${copy.scripts.length}${skipped > 0 ? `، تعذّر ${skipped} — الأسبابُ في meta.json` : ""}):`,
    ...written.slice(0, 14).map((w) => `  ✓ ${w}`),
    ...(written.length > 14 ? [`  … و${written.length - 14} ملفّاً آخر (القائمةُ في meta.json)`] : []),
    ...refused.map((r) => `  ✕ ${r}`),
    "اقرأها بالقطعة: read <ملف> (لا تلصقها كاملةً في الردّ). ثمّ shot full للشكل وpage styles للأرقام، وكرّر لكلّ صفحةٍ في القوائم.",
  ].join("\n")
}
