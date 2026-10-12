/**
 * 10-12 — سكربتا الصفحة المشتركان بين إضافة المتصفّح (background.js) ومتصفّح عبدو كود المملوك: روابطُ الصفحة لزاحف الموقع (crawl)،
 * وأحدثُ صورةٍ كبيرة لحفظها (page image). نهاياتُ الأسطر تُوحَّد (autocrlf قد يجعل الملفّ CRLF في نسخةٍ أخرى). نسخةٌ حرفيّة من الإضافة — user-browser-image.test.ts يقارن البايتات، فتعديلُ أحدهما وحده يحمرّ.
 */
export const LINKS_SOURCE = String.raw`() => {
  const text = (el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()
  const links = []
  const seen = new Set()
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href
    if (!/^https?:/i.test(href) || seen.has(href)) continue
    seen.add(href)
    links.push({ href, text: text(a).slice(0, 80) })
    if (links.length >= 400) break
  }
  const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 24).map((h) => h.tagName.toLowerCase() + " " + text(h).slice(0, 140))
  return { url: location.href, title: String(document.title || "").slice(0, 200), headings, links }
}`.replace(/\r\n/gu, "\n")

export const IMAGE_FIND_SOURCE = String.raw`async (ref, exclude, minSide) => {
  const keyOf = (src) => String(src).slice(0, 300)
  const skip = new Set(exclude || [])
  const srcOf = (img) => img.currentSrc || img.src || ""
  const describe = (img) => ({ src: srcOf(img), key: keyOf(srcOf(img)), width: img.naturalWidth, height: img.naturalHeight, alt: String(img.alt || "").slice(0, 120) })
  let img = null
  if (ref) {
    const el = globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]')
    img = el && el.tagName === "IMG" ? el : el && el.querySelector ? el.querySelector("img") : null
    if (!img || !srcOf(img)) return null
  } else {
    const all = [...document.images].filter((i) => i.complete && i.naturalWidth >= minSide && i.naturalHeight >= minSide && srcOf(i) && !/^data:image\/svg/i.test(srcOf(i)) && !skip.has(keyOf(srcOf(i))))
    const shown = all.filter((i) => { const r = i.getBoundingClientRect(); return r.width >= 64 && r.height >= 64 })
    img = (shown.length > 0 ? shown : all).pop() || null
    if (!img) return null
  }
  const found = describe(img)
  if (/^(blob|data):/i.test(found.src)) {
    const blob = await (await fetch(found.src)).blob()
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ""
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    found.mime = blob.type
    found.data = btoa(bin)
    found.src = found.src.slice(0, 60)
  }
  return found
}`.replace(/\r\n/gu, "\n")
