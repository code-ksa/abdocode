/**
 * `read ملف.docx` — نصُّ مستند Word للوكيل. كانت القراءةُ تمرّ بالنواة فتعيد بايتاتِ ZIP لا تُقرأ.
 * لا اعتمادَ جديد: الدليلُ المركزيّ لـZIP يُقرأ هنا، و`word/document.xml` يُفكّ بـinflateRaw من node:zlib.
 * الفقرةُ سطر، والخليّةُ تُفصل بـ« | »، والصفُّ سطر؛ والعناوينُ (Heading/Title) تُسبق بـ# كي يراها النموذجُ أقساماً.
 *
 * الحدود: الملفُّ مسقوف (DOCX_MAX_BYTES) قبل القراءة، والجزءُ المفكوك مسقوف (DOCX_XML_MAX) — قنبلةُ ZIP تُرفض باسمها.
 */
import { inflateRawSync } from "node:zlib"

export const DOCX_MAX_BYTES = 40 * 1024 * 1024
export const DOCX_XML_MAX = 64 * 1024 * 1024

export type DocxResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }

interface ZipEntry { readonly name: string; readonly method: number; readonly compressed: number; readonly size: number; readonly offset: number }

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // نهايةُ الدليل المركزيّ: آخرُ توقيع 0x06054b50 ضمن آخر 64KB + 22.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("ليس ملفَّ ZIP (لا نهايةَ دليلٍ مركزيّ)")
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const out: ZipEntry[] = []
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("دليلٌ مركزيّ تالف")
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    out.push({ name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)), method, compressed, size, offset })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** جزءٌ واحد من الحزمة نصّاً، أو undefined إن غاب. */
export function zipPart(bytes: Uint8Array, name: string): string | undefined {
  const entry = zipEntries(bytes).find((e) => e.name === name)
  if (entry === undefined) return undefined
  if (entry.size > DOCX_XML_MAX) throw new Error(`${name} مفكوكاً ${entry.size} بايت — فوق السقف ${DOCX_XML_MAX}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(`رأسٌ محلّيّ تالف لـ${name}`)
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const raw = bytes.subarray(start, start + entry.compressed)
  let data: Uint8Array
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: DOCX_XML_MAX })
  else throw new Error(`ضغطٌ غير مدعوم (${entry.method}) في ${name}`)
  return new TextDecoder().decode(data)
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10))
    return ENTITIES[code.toLowerCase()] ?? whole
  })

/** نصُّ فقرةٍ واحدة: <w:t> متّصلة، و<w:tab/> مسافةُ جدولة، و<w:br/> سطر. */
function paragraphText(xml: string): string {
  let text = ""
  // خصائصُ الفقرة تحمل <w:tab> تعريفاتٍ لمواقف الجدولة لا جدولةً في النصّ.
  for (const m of xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/gu, "").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/gu)) {
    if (m[1] !== undefined) text += decodeEntities(m[1])
    else text += m[2] === "tab" ? "\t" : "\n"
  }
  return text
}

/** document.xml ⇦ نصّ: الفقرةُ سطر، والجدولُ صفوفٌ خلاياها بـ« | »، والعنوانُ بـ#. */
export function documentXmlText(xml: string): string {
  // تعقّبُ التغييرات: المحذوفُ (w:del) والمنقولُ من موضعه (w:moveFrom — نصُّه w:t عاديّ) ليسا في المستند؛ المنقولُ إليه (moveTo) يبقى.
  const body = xml.replace(/<w:(del|moveFrom)\b[\s\S]*?<\/w:\1>/gu, "")
  const lines: string[] = []
  for (const block of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/gu)) {
    const chunk = block[0]
    if (chunk.startsWith("<w:tbl")) {
      for (const row of chunk.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/gu)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gu)].map((c) =>
          [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)].map((p) => paragraphText(p[0]).trim()).filter(Boolean).join(" "))
        if (cells.some((c) => c.length > 0)) lines.push(cells.join(" | "))
      }
      continue
    }
    const text = paragraphText(chunk).replace(/[ \t]+$/u, "")
    const style = /<w:pStyle\s+w:val="([^"]+)"/u.exec(chunk)?.[1] ?? ""
    const heading = /^(?:Heading|Title|عنوان)\s*(\d)?/iu.exec(style)
    // الترقيمُ في الفقرة نفسِها أو في نمطها (Word يضع «List Bullet» ترقيمَه في تعريف النمط — مقيس على مستندٍ حفظه Word).
    const list = /<w:numPr\b/u.test(chunk) || /^List(?:Bullet|Number|Paragraph)/iu.test(style)
    if (heading !== null && text.trim().length > 0) lines.push(`${"#".repeat(Math.min(3, Number(heading[1] ?? "1")))} ${text.trim()}`)
    else if (list && text.trim().length > 0) lines.push(`- ${text.trim()}`)
    else lines.push(text)
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()
}

/** مستندُ Word كاملاً نصّاً، أو خطأٌ يسمّي سببه. */
export function docxText(bytes: Uint8Array): DocxResult {
  if (bytes.length > DOCX_MAX_BYTES) return { ok: false, error: `المستند ${bytes.length} بايت — فوق سقف القراءة ${DOCX_MAX_BYTES}` }
  try {
    const xml = zipPart(bytes, "word/document.xml")
    if (xml === undefined) return { ok: false, error: "ليس مستندَ Word (لا word/document.xml في الحزمة) — .doc القديم غيرُ مدعوم: احفظه .docx" }
    return { ok: true, text: documentXmlText(xml) }
  } catch (cause) {
    return { ok: false, error: `تعذّرت قراءةُ المستند: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}
