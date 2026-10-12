// عاملُ الخدمة لإضافة عبدو كود: مقبسٌ واحد إلى الجسر المحلّيّ (127.0.0.1) برمزٍ يلصقه المستخدم في النافذة
// المنبثقة. كلُّ رسالةٍ `{id, action, args}` تُنفَّذ على **التبويب الفعّال** ويُردّ `{id, ok, result|error}`.
// النقرُ والكتابةُ والمفاتيحُ عبر منقّح المتصفّح (أحداثُ إدخالٍ موثوقة، والمستخدم يرى شارةَ التنقيح) في كروم
// وإيدج؛ وفي سفاري — حيث لا منقّح للإضافات — تُبعث أحداثٌ اصطناعيةٌ داخل الصفحة ويُعلَن ذلك في الردّ
// (`mode: "synthetic"`) كي يعرف الوكيلُ والمستخدم. القراءةُ والتمريرُ بسكربتٍ في الصفحة. لا تخزينَ لمحتوى
// الصفحات، ولا إرسالَ إلا إلى الجسر المحلّيّ.
// 0.7.0: كروم وإيدج موصولان معاً (كلٌّ يعرّف نفسه ويعلن تركيزَ المستخدم)، المراجعُ تعبر
// Shadow DOM والإطاراتِ من الأصل نفسه، المنقّحُ يبقى ملتصقاً بالتبويب أثناء العمل، ونسخُ الصفحة (save) ولقطةُ الصفحة كاملةً والكونسولُ والشبكة.

const DEFAULT_PORT = 9367
const api = typeof chrome !== "undefined" ? chrome : browser
const TRUSTED_INPUT = !!(api.debugger && typeof api.debugger.attach === "function")
let socket = null
let retryTimer = null
let connecting = false
// أيُّ متصفّحٍ هذا — الجسرُ يوجّه الأفعالَ إلى آخر متصفّحٍ ركّز عليه المستخدم حين يكون كروم وإيدج موصولَين معاً.
const BROWSER = (() => {
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => String(b.brand))
  if (brands.some((b) => /Edge/.test(b))) return "edge"
  if (brands.some((b) => /Opera/.test(b))) return "opera"
  if (brands.some((b) => /Brave/.test(b))) return "brave"
  const ua = navigator.userAgent
  if (/Edg\//.test(ua)) return "edge"
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Safari\//.test(ua) && !/Chrom/.test(ua)) return "safari"
  return "chrome"
})()

const settings = async () => {
  const stored = await api.storage.local.get({ port: DEFAULT_PORT, token: "" })
  return { port: Number(stored.port) || DEFAULT_PORT, token: String(stored.token || "") }
}

// التبويبُ الفعّال بسلّم بدائل: النافذةُ المركَّزة أخيراً قد تعود فارغةً بعد إعادة تشغيل عامل الخدمة (MV3) أو حين تكون النافذةُ
// المركَّزة غيرَ عاديّة (مقيس 09-15: «no active tab» وكروم مفتوح) — فتُسأل النوافذُ العاديّة ثمّ أيُّ تبويبٍ فعّال، و`open` ينشئ تبويباً.
const activeTab = async ({ createIfNone = false } = {}) => {
  const pick = (tabs) => (tabs || []).find((t) => t && typeof t.id === "number")
  let tab = pick(await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))
  if (!tab) tab = pick(await api.tabs.query({ active: true, windowType: "normal" }).catch(() => []))
  if (!tab) tab = pick(await api.tabs.query({ active: true }).catch(() => []))
  if (!tab && createIfNone) tab = await api.tabs.create({ url: "about:blank", active: true })
  if (!tab || typeof tab.id !== "number") throw new Error("no active tab")
  return tab
}

// شجرةُ العناصر القابلة للقيادة — الشكلُ نفسُه الذي يقرؤه المحرّك من متصفّحه المملوك (دورٌ واسمٌ ومرجع).
const READ_TREE = () => {
  const out = []
  let n = 0
  const isSecret = (el) => el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password"
  const label = (el) => {
    // قيمةُ كلمة المرور لا تغادر الصفحة أبداً — حتى المعبّأةَ بحفظ كروم (0.6.2: كانت تُقرأ اسماً للحقل).
    const typed = isSecret(el) ? "" : (el.value || "").trim()
    if (typed) return typed.slice(0, 80)
    return ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"))) || (el.innerText || "").trim().slice(0, 80))
  }
  // حالةُ الحقل بلا قيمته: «معبّأ/فارغ» تكفي النموذجَ ليقرّر أنّ صفحةَ الدخول المعبّأة تُضغط لا تُترك للمستخدم.
  const state = (el) => {
    const t = el.tagName
    if (t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") return undefined
    const type = t === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : ""
    if (type === "submit" || type === "button" || type === "file" || type === "checkbox" || type === "radio" || type === "hidden") return undefined
    // 0.6.6: كروم يُظهر الحقلَ معبّأً بحفظه لكنّه يُخفي قيمتَه عن السكربت حتى أوّل لمسةٍ حقيقيّة —
    // فكان يُقرأ «فارغاً» فيُطلب من المستخدم الضغط (مقيس 09-19 على صفحة دخولٍ حقيقيّة). الحالةُ من :autofill لا من القيمة.
    const autofilled = (() => { for (const sel of [":autofill", ":-webkit-autofill"]) { try { if (el.matches(sel)) return true } catch { /* قديم */ } } return false })()
    if (autofilled) return "autofilled"
    return (el.value || "").trim().length > 0 ? "filled" : "empty"
  }
  const role = (el) => {
    const t = el.tagName.toLowerCase()
    if (t === "a") return "link"
    if (t === "button") return "button"
    if (t === "select") return "combobox"
    if (t === "textarea") return "textbox"
    if (t === "input") { const type = (el.getAttribute("type") || "text").toLowerCase(); return type === "password" ? "textbox:password" : type === "file" ? "textbox:file" : type === "checkbox" || type === "radio" ? type : type === "submit" || type === "button" ? "button" : "textbox" }
    if (/^h[1-6]$/.test(t)) return "heading"
    if (el.isContentEditable && !el.getAttribute("role")) return "textbox"
    return el.getAttribute("role") || t
  }
  // 0.7.0 — المراجعُ تعبر جذورَ Shadow DOM المفتوحة والإطاراتِ من الأصل نفسه (محرّراتٌ ومكوّناتُ ويب كانت لا تُرى)؛ والعنصرُ يُحفظ
  // في خريطةٍ داخل عالم الإضافة المعزول فيجده كلُّ فعلٍ لاحق حيث كان (querySelector لا يعبر الظلّ ولا الإطار).
  const SEL = "a,button,input,textarea,select,summary,h1,h2,h3,h4,h5,h6,[role],[contenteditable=''],[contenteditable='true']"
  const refs = new Map()
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (n >= 200) return
      if (el.matches(SEL)) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          n += 1
          const ref = "r" + n
          el.setAttribute("data-abdo-ref", ref)
          refs.set(ref, el)
          const s = state(el)
          out.push(s === undefined ? { ref, role: role(el), name: label(el) } : { ref, role: role(el), name: label(el), state: s })
        }
      }
      if (el.shadowRoot) visit(el.shadowRoot)
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") { let doc = null; try { doc = el.contentDocument } catch { doc = null } if (doc && doc.documentElement) visit(doc) }
    }
  }
  for (const old of document.querySelectorAll("[data-abdo-ref]")) old.removeAttribute("data-abdo-ref")
  visit(document)
  globalThis.__abdoRefs = refs
  globalThis.__abdoRef = (ref) => { const el = refs.get(ref); return el && el.isConnected ? el : document.querySelector('[data-abdo-ref="' + ref + '"]') }
  return out
}

const LOOK = (ref) => {
  const el = ref ? (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]')) : document.body
  if (!el) return ""
  const cs = getComputedStyle(el)
  const keys = ["display", "color", "background-color", "font-size", "font-family", "font-weight", "width", "height", "margin", "padding", "border", "text-align", "direction"]
  const styles = {}
  for (const k of keys) styles[k] = cs.getPropertyValue(k)
  // 0.6.5 — قيمةُ الحقل تُقرأ في `value` (innerText لـ<input> فارغٌ أبداً فكانت القيمةُ لا تُقرأ إلا باللقطة)؛
  // كلمةُ المرور «محجوب» دائماً ولا تغادر الصفحة؛ القائمةُ تُقرأ بنصّ خيارها المختار.
  const tag = el.tagName
  const field = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
  const value = !field ? undefined
    : tag === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password" ? "«محجوب»"
    : tag === "SELECT" ? (el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].text || "").trim() : String(el.value || ""))
    : String(el.value || "").slice(0, 2000)
  return JSON.stringify({ title: document.title, url: location.href, focused: document.activeElement === el, text: (el.innerText || "").trim().slice(0, ref ? 2000 : 6000), ...(value === undefined ? {} : { value }), styles })
}

const LOCATE = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  const r = el.getBoundingClientRect()
  let x = r.x + r.width / 2, y = r.y + r.height / 2
  // داخل إطارٍ من الأصل نفسه: الإحداثيّاتُ نسبةً إلى الإطار — تُضاف إزاحتُه (وإزاحةُ ما فوقه) لتصير إحداثيّاتِ الصفحة التي يضغط فيها المنقّح.
  let view = el.ownerDocument.defaultView
  while (view && view.frameElement) { const f = view.frameElement; const fr = f.getBoundingClientRect(); x += fr.left + f.clientLeft; y += fr.top + f.clientTop; view = view.parent }
  return { x: Math.round(x), y: Math.round(y) }
}

const SCROLL = (direction, count) => { window.scrollBy(0, (direction === "up" ? -1 : 1) * Math.round(innerHeight * 0.9) * count); return true }

// المسارُ الاصطناعيّ (سفاري): نقرةٌ وكتابةٌ ومفاتيحُ بأحداث DOM. الكتابةُ تمرّ بمُعيِّن القيمة الأصليّ كي تراها
// أُطرُ الواجهة (React وأخواتها) التي تتجاهل `el.value =` المباشر.
const SYNTH_TAP = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  if (typeof el.focus === "function") el.focus()
  el.click()
  return { mode: "synthetic" }
}

// 0.6.4 — قبل الكتابة الموثوقة يُحدَّد ما في الحقل كلُّه فتحلّ الكتابةُ محلَّه (مقيس 09-17: الكتابةُ كانت تُلحَق بالقديم فصار «ششش» «شششششش-قشششياس»).
const SELECT_FIELD = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  if (typeof el.focus === "function") el.focus()
  if (typeof el.select === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select(); return { length: String(el.value || "").length } }
  if (el.isContentEditable) { const doc = el.ownerDocument; const sel = doc.getSelection(); sel.removeAllRanges(); const range = doc.createRange(); range.selectNodeContents(el); sel.addRange(range); return { length: String(el.textContent || "").length } }
  return { length: 0 }
}

// What the field holds after a fill: its length only (never the value — it can be a password).
const READ_FIELD = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  const v = (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") ? String(el.value || "") : String(el.textContent || "")
  return { length: v.length }
}

const SYNTH_FILL = (ref, text) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  if (typeof el.focus === "function") el.focus()
  const view = el.ownerDocument.defaultView || window
  const proto = el.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : el.tagName === "INPUT" ? view.HTMLInputElement.prototype : null
  const setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set
  if (setter) setter.call(el, text)
  else if (el.isContentEditable) el.textContent = text
  else el.value = text
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { mode: "synthetic" }
}

const SYNTH_KEY = (key, mods) => {
  let el = document.activeElement || document.body
  for (let i = 0; i < 8 && el; i += 1) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue }
    if (el.tagName === "IFRAME") { let inner = null; try { inner = el.contentDocument && el.contentDocument.activeElement } catch { inner = null } if (inner) { el = inner; continue } }
    break
  }
  const m = Number(mods) || 0
  const init = { key, code: key, bubbles: true, cancelable: true, altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) }
  const down = el.dispatchEvent(new KeyboardEvent("keydown", init))
  el.dispatchEvent(new KeyboardEvent("keyup", init))
  if (down && key === "Enter" && el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit()
  if (down && key === "Escape" && typeof el.blur === "function") el.blur()
  if (down && key === "Tab") {
    const focusables = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[tabindex]:not([tabindex='-1'])")).filter((n) => !n.disabled && n.getBoundingClientRect().width > 0)
    const i = focusables.indexOf(el)
    const next = focusables[(i + 1) % Math.max(1, focusables.length)]
    if (next && typeof next.focus === "function") next.focus()
  }
  return { mode: "synthetic" }
}

// 0.7.0 — «page save» في متصفّح المستخدم: ما يعطيه DevTools «Inspect ⇦ <html> ⇦ Copy element» (outerHTML لعقدة <html> بعد تشغيل
// السكربتات) مع أوراق الأنماط والسكربتات. الملفّاتُ الخارجيّة يجلبها عاملُ الخدمة (fetchAsset) لا الصفحة: صلاحيّةُ المضيفين تتجاوز CORS.
// أوراقُ CSS-in-JS (insertRule بلا نصّ) تُقرأ من cssRules، والأوراقُ المتبنّاة (adoptedStyleSheets) كذلك.
const SAVE_DOC = () => {
  const clone = document.documentElement.cloneNode(true)
  const strip = (node) => { node.removeAttribute("data-abdo-ref"); node.removeAttribute("data-abdo-seq") }
  strip(clone)
  for (const node of clone.querySelectorAll("[data-abdo-ref],[data-abdo-seq]")) strip(node)
  const rulesText = (sheet) => { try { return Array.from(sheet.cssRules).map((r) => r.cssText).join("\n") } catch { return "" } }
  const styles = []
  for (const sheet of document.styleSheets) {
    const media = (sheet.media && sheet.media.mediaText) || ""
    if (sheet.href) { styles.push({ href: sheet.href, media }); continue }
    const text = (sheet.ownerNode && sheet.ownerNode.textContent) || rulesText(sheet)
    styles.push({ href: null, media, text })
  }
  for (const sheet of document.adoptedStyleSheets || []) styles.push({ href: null, media: "adopted", text: rulesText(sheet) })
  const scripts = Array.from(document.scripts).map((el) => el.src ? { src: el.src, type: el.type || "" } : { src: null, type: el.type || "", text: el.textContent || "" })
  const doctype = document.doctype ? "<!DOCTYPE " + document.doctype.name + ">" : "<!DOCTYPE html>"
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, html: doctype + "\n" + clone.outerHTML, styles, scripts }
}

// S9 (0.6.5) — ماشي المواصفة: شجرةُ العناصر الظاهرة المسطّحة بصناديقها وأنماطها المحسوبة — النصُّ نفسُه في
// packages/browser/src/spec-walker.ts (المتصفّح المملوك)؛ اختبارٌ يثبّت تطابقَ النسختين. مستقلّةٌ لأنّ executeScript يحقن الدالّةَ بلا إغلاقها.
const SPEC = (limit, rootRef) => {
  const root = rootRef ? document.querySelector('[data-abdo-ref="' + rootRef + '"]') : document.body
  if (!root) return null
  const cap = Math.max(50, Math.min(2000, Number(limit) || 600))
  const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, BR: 1, WBR: 1 }
  const keys = ["display", "position", "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap", "gridTemplateColumns", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom", "color", "backgroundColor", "backgroundImage", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "borderRadius", "borderTopWidth", "borderTopColor", "boxShadow", "opacity", "overflow", "objectFit"]
  const drop = { none: 1, normal: 1, auto: 1, "0px": 1, "rgba(0, 0, 0, 0)": 1, visible: 1, static: 1, "1": 1, nowrap: 1, start: 1, "0px 0px": 1 }
  const nodes = []
  const queue = [{ el: root, parent: -1, depth: 0 }]
  while (queue.length > 0 && nodes.length < cap) {
    const item = queue.shift()
    const el = item.el
    if (skip[el.tagName]) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue
    const s = {}
    for (const k of keys) { const v = cs[k]; if (v && !drop[v]) s[k] = String(v).slice(0, 160) }
    let own = ""
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue + " "
    own = own.replace(/\s+/g, " ").trim().slice(0, 120)
    const node = { i: nodes.length, p: item.parent, d: item.depth, t: el.tagName.toLowerCase(), x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height), n: el.children.length, s }
    if (own) node.tx = own
    const cls = Array.from(el.classList).slice(0, 4).join(" ")
    if (cls) node.c = cls
    const role = el.getAttribute("role")
    if (role) node.r = role
    const ref = el.getAttribute("data-abdo-ref")
    if (ref) node.ref = ref
    if (el.tagName === "IMG") node.img = { src: String(el.currentSrc || el.src || "").slice(0, 300), nw: el.naturalWidth, nh: el.naturalHeight, alt: String(el.alt || "").slice(0, 80) }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") node.f = { type: String(el.type || "").slice(0, 20), placeholder: String(el.placeholder || "").slice(0, 60) }
    if (el.tagName === "A") { const href = el.getAttribute("href"); if (href) node.href = String(href).slice(0, 200) }
    nodes.push(node)
    const tag = el.tagName.toLowerCase()
    if (tag === "svg" || tag === "canvas" || tag === "video" || tag === "iframe") continue
    for (const child of el.children) queue.push({ el: child, parent: node.i, depth: item.depth + 1 })
  }
  const fonts = []
  try { for (const f of document.fonts) { if (fonts.length >= 20) break; if (f.status === "loaded") fonts.push(f.family.replace(/["']/g, "") + " " + f.weight + " " + f.style) } } catch (e) {}
  const bodyCs = getComputedStyle(document.body)
  return { url: location.href, title: document.title.slice(0, 120), dir: document.documentElement.dir || bodyCs.direction, lang: document.documentElement.lang || "", viewport: { w: innerWidth, h: innerHeight, docW: Math.round(document.documentElement.scrollWidth), docH: Math.round(document.documentElement.scrollHeight) }, body: { background: bodyCs.backgroundColor, color: bodyCs.color, font: bodyCs.fontFamily.slice(0, 120), fontSize: bodyCs.fontSize }, fonts, capped: queue.length > 0, nodes }
}

// أدواتُ الفحص (2026-09-14، تكافؤٌ مع المتصفّح المملوك): styles = تصميمُ الصفحة بالأرقام (متغيّرات الجذر، الألوان
// بمساحتها، التدرّجات، الخطوط، العناوين، الأزرار)؛ dom <ref> = HTML الخارجيّ المقصوص وأنماطُه المحسوبة وصندوقه؛
// css <selector> = قواعدُ الأوراق المطابقة (+ @font-face)؛ assets = الصور والأيقونات والأوراق والخطوط. قراءةٌ بلا أثر.
const INSPECT = (mode, target) => {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
  if (mode === "dom") {
    const el = (globalThis.__abdoRef ? globalThis.__abdoRef(target) : document.querySelector('[data-abdo-ref="' + target + '"]'))
    if (!el) return ""
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    const keys = ["display", "position", "width", "height", "padding", "margin", "gap", "color", "backgroundColor", "backgroundImage", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "borderRadius", "border", "boxShadow", "opacity", "flexDirection", "justifyContent", "alignItems", "gridTemplateColumns"]
    const styles = {}
    for (const k of keys) { const v = cs[k]; if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "rgba(0, 0, 0, 0)") styles[k] = String(v).slice(0, 120) }
    const clone = el.cloneNode(true)
    for (const s of clone.querySelectorAll("script,style,svg path")) s.remove()
    for (const n of clone.querySelectorAll("*")) n.removeAttribute("data-abdo-ref")
    clone.removeAttribute && clone.removeAttribute("data-abdo-ref")
    return JSON.stringify({ tag: el.tagName.toLowerCase(), id: el.id || undefined, classes: [...el.classList].slice(0, 12), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, children: el.children.length, styles, html: clone.outerHTML.slice(0, 3000) })
  }
  if (mode === "css") {
    const needle = String(target || "").replace(/[\\"`]/g, "").slice(0, 120).toLowerCase()
    const rules = []; const fonts = []; let foreign = 0
    // (#25ج) القواعدُ داخل @media/@layer/@supports/@container تُمشى بعمقٍ ويُسبق المحدِّدُ بسياقه — كما في المتصفّح المملوك.
    const walk = (list, ctx) => {
      for (const r of list) {
        if (rules.length >= 40) return
        if (r.type === 5 && fonts.length < 12) { fonts.push(String(r.cssText).slice(0, 240)); continue }
        if (r.cssRules && r.cssRules.length > 0 && !r.selectorText) {
          const name = r.constructor && r.constructor.name
          const head = r.type === 4 ? "@media " + r.media.mediaText : r.type === 12 ? "@supports " + r.conditionText : name === "CSSLayerBlockRule" ? "@layer " + r.name : name === "CSSContainerRule" ? "@container " + r.conditionText : ""
          if (head) { walk(r.cssRules, ctx + head + " { "); continue }
        }
        if (!r.selectorText) continue
        if (needle.length > 0 && !r.selectorText.toLowerCase().includes(needle)) continue
        rules.push((ctx ? ctx : "") + String(r.cssText).slice(0, 400))
      }
    }
    for (const sheet of document.styleSheets) {
      let list; try { list = sheet.cssRules } catch { foreign += 1; continue }
      walk(list, "")
    }
    return JSON.stringify({ needle, matched: rules.length, foreignSheets: foreign, rules, fontFaces: fonts })
  }
  if (mode === "assets") {
    const images = [...document.images].filter((i) => i.naturalWidth > 24).slice(0, 24).map((i) => ({ src: abs(i.currentSrc || i.src).slice(0, 200), alt: (i.alt || "").slice(0, 60), natural: i.naturalWidth + "x" + i.naturalHeight }))
    const icons = [...document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon]")].map((l) => abs(l.href).slice(0, 200)).slice(0, 6)
    const sheets = [...document.styleSheets].map((s) => s.href ? abs(s.href).slice(0, 200) : "inline(" + (s.ownerNode && s.ownerNode.textContent ? s.ownerNode.textContent.length : 0) + ")").slice(0, 12)
    const fonts = []; try { for (const f of document.fonts) { if (fonts.length >= 20) break; fonts.push(f.family + " " + f.weight + " " + f.style + " " + f.status) } } catch {}
    const bg = []; for (const el of document.querySelectorAll("body *")) { if (bg.length >= 10) break; const v = getComputedStyle(el).backgroundImage; if (v && v.startsWith("url(")) bg.push(v.slice(0, 200)) }
    return JSON.stringify({ url: location.href, title: document.title.slice(0, 120), images, backgroundImages: bg, icons, stylesheets: sheets, fonts, svgInline: document.querySelectorAll("svg").length })
  }
  // styles (الافتراض)
  const out = { url: location.href, dir: document.documentElement.dir || getComputedStyle(document.body).direction, rootVars: {}, colors: [], gradients: [], fonts: [], headings: [], buttons: [], body: {} }
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (!r.style || !/^(:root|html|body)\b/.test(r.selectorText || "")) continue
      for (const p of r.style) { if (p.startsWith("--") && Object.keys(out.rootVars).length < 40) out.rootVars[p] = r.style.getPropertyValue(p).trim().slice(0, 80) }
    }
  }
  const tally = new Map(), grads = new Map(), fonts = new Map()
  const add = (m, k, w) => { if (!k || k === "rgba(0, 0, 0, 0)" || k === "transparent") return; m.set(k, (m.get(k) || 0) + w) }
  let seen = 0
  for (const el of document.querySelectorAll("body *")) {
    if (seen >= 1500) break
    const r = el.getBoundingClientRect(); const area = r.width * r.height
    if (area < 400 || r.width === 0) continue
    seen += 1
    const cs = getComputedStyle(el)
    add(tally, "text " + cs.color, area); add(tally, "bg " + cs.backgroundColor, area)
    if (cs.borderTopWidth !== "0px") add(tally, "border " + cs.borderTopColor, area)
    if (cs.backgroundImage && cs.backgroundImage.includes("gradient")) add(grads, cs.backgroundImage.slice(0, 160), area)
    add(fonts, cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(), area)
  }
  out.colors = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k + " · " + Math.round(v / 1000) + "k px²")
  out.gradients = [...grads].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  out.fonts = [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  const pick = (sel, n) => [...document.querySelectorAll(sel)].slice(0, n).map((el) => { const cs = getComputedStyle(el); return { text: (el.innerText || "").trim().slice(0, 60), fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, background: cs.backgroundColor, radius: cs.borderRadius, padding: cs.padding } })
  out.headings = pick("h1, h2", 6); out.buttons = pick("button, a.btn, [class*=btn], [role=button]", 6)
  const bs = getComputedStyle(document.body); const c = document.querySelector("main, .container, [class*=container], [class*=wrapper]")
  out.body = { font: bs.fontFamily.slice(0, 80), fontSize: bs.fontSize, color: bs.color, background: bs.backgroundColor, lineHeight: bs.lineHeight, containerWidth: c ? Math.round(c.getBoundingClientRect().width) + "px" : undefined }
  return JSON.stringify(out)
}

// ن3 — قائمةٌ منسدلة أصليّة: مطابقةُ الخيار بالنصّ/القيمة (تامّةً ثمّ بادئةً ثمّ احتواءً) ثمّ input/change كما يفعل المتصفّح.
const SELECT_OPTION = (ref, want) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return null
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ")
  if (el.tagName !== "SELECT") return { ok: false, why: "not-select", role: el.tagName.toLowerCase(), options: [] }
  const opts = Array.from(el.options)
  const w = norm(want)
  let idx = opts.findIndex((o) => norm(o.text) === w || norm(o.value) === w || norm(o.label) === w)
  if (idx < 0) idx = opts.findIndex((o) => norm(o.text).startsWith(w))
  if (idx < 0) idx = opts.findIndex((o) => norm(o.text).includes(w))
  if (idx < 0) return { ok: false, why: "no-option", role: "combobox", options: opts.map((o) => o.text.trim()).slice(0, 40) }
  el.selectedIndex = idx
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  const picked = el.options[el.selectedIndex]
  return { ok: true, picked: picked ? picked.text.trim() : "", value: picked ? String(picked.value) : "", index: el.selectedIndex, total: opts.length }
}

const FILE_INPUT_KIND = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el) return "missing"
  return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file" ? "file" : "other"
}

const READ_FILES = (ref) => {
  const el = (globalThis.__abdoRef ? globalThis.__abdoRef(ref) : document.querySelector('[data-abdo-ref="' + ref + '"]'))
  if (!el || !el.files) return []
  return Array.from(el.files).map((f) => f.name + " (" + f.size + " بايت)")
}

// ن3 — سحبُ HTML5 بأحداث DragEvent وDataTransfer مشترَك (تكملةٌ للماوس الموثوق أو بديلُه في المسار الاصطناعيّ).
const SYNTH_DRAG = (fromRef, toRef) => {
  const a = (globalThis.__abdoRef ? globalThis.__abdoRef(fromRef) : document.querySelector('[data-abdo-ref="' + fromRef + '"]')), b = (globalThis.__abdoRef ? globalThis.__abdoRef(toRef) : document.querySelector('[data-abdo-ref="' + toRef + '"]'))
  if (!a || !b) return null
  const dt = new DataTransfer()
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
  const pt = (r) => ({ clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), bubbles: true, cancelable: true, buttons: 1 })
  a.dispatchEvent(new PointerEvent("pointerdown", pt(ra))); a.dispatchEvent(new MouseEvent("mousedown", pt(ra)))
  fire(a, "dragstart"); fire(b, "dragenter"); fire(b, "dragover"); fire(b, "drop"); fire(a, "dragend")
  b.dispatchEvent(new PointerEvent("pointerup", pt(rb))); b.dispatchEvent(new MouseEvent("mouseup", pt(rb)))
  return { mode: "synthetic" }
}

const inPage = async (tabId, func, args = []) => {
  const [frame] = await api.scripting.executeScript({ target: { tabId }, func, args })
  return frame && frame.result
}

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Insert: 45 }
for (let i = 1; i <= 12; i += 1) KEY_CODES["F" + i] = 111 + i

// 0.7.0 — «Control+a» و«Shift+Tab» و«a»: المُعدِّلاتُ بأرقام CDP (Alt=1 Ctrl=2 Meta=4 Shift=8)، والحرفُ يُكتب نصّاً إلا مع Ctrl/Meta (اختصار).
const parseKey = (spec) => {
  const parts = String(spec).split("+")
  const name = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const k = part.toLowerCase()
    if (k === "alt") modifiers |= 1
    else if (k === "control" || k === "ctrl") modifiers |= 2
    else if (k === "meta" || k === "cmd") modifiers |= 4
    else if (k === "shift") modifiers |= 8
    else return null
  }
  if (KEY_CODES[name] !== undefined) {
    const text = modifiers & 6 ? undefined : name === "Enter" ? "\r" : name === "Space" ? " " : undefined
    return { key: name === "Space" ? " " : name, code: name, vk: KEY_CODES[name], modifiers, text }
  }
  if (/^[A-Za-z0-9]$/.test(name)) {
    const upper = name.toUpperCase()
    const ch = /[A-Za-z]/.test(name) ? (modifiers & 8 ? upper : name.toLowerCase()) : name
    return { key: ch, code: /[0-9]/.test(name) ? "Digit" + name : "Key" + upper, vk: upper.charCodeAt(0), modifiers, text: modifiers & 6 ? undefined : ch }
  }
  return null
}

// 0.7.0 — جلسةُ منقّحٍ لكلّ تبويب تبقى ملتصقةً أثناء العمل وتنفكّ بعد ٣٠ ث خمول (كانت تُلصق وتُفكّ مع كلّ نقرة: شارةُ «يجري التنقيح»
// تومض، وكلُّ فعلٍ يدفع ثمنَ الإلصاق). أثناءَ تسجيل الكونسول/الشبكة تبقى حتى تنتهي مدّةُ التسجيل. إن ألغى المستخدمُ التنقيحَ من شريط
// المتصفّح فذلك قراره: لا يُعاد الإلصاقُ دقيقةً كاملة، ويُقال السببُ للوكيل.
const DEBUG_IDLE_MS = 30000
const CAPTURE_MS = 10 * 60 * 1000
const sessions = new Map()
let userCanceledAt = 0
const detachTab = async (tabId) => {
  const session = sessions.get(tabId)
  if (session) { clearTimeout(session.idle); clearTimeout(session.stop) }
  sessions.delete(tabId)
  try { await api.debugger.detach({ tabId }) } catch {}
}
const attachTab = async (tabId) => {
  if (Date.now() - userCanceledAt < 60000) throw new Error("the user cancelled debugging from the browser bar less than a minute ago — ask them before acting again")
  let session = sessions.get(tabId)
  if (!session) {
    try { await api.debugger.attach({ tabId }, "1.3") }
    catch (error) { if (!/already attached/i.test(String((error && error.message) || error))) throw error }
    session = { idle: null, stop: null, capture: null }
    sessions.set(tabId, session)
  }
  clearTimeout(session.idle)
  if (!session.capture) session.idle = setTimeout(() => detachTab(tabId), DEBUG_IDLE_MS)
  return session
}
const withDebugger = async (tabId, work) => {
  await attachTab(tabId)
  const send = (method, params) => api.debugger.sendCommand({ tabId }, method, params)
  try { return await work(send) }
  catch (error) {
    // مقبسُ المنقّح انفكّ من تحتنا (أُغلق التبويب في مكانه، أو أُعيد تشغيلُ عامل الخدمة): إلصاقٌ جديد ومحاولةٌ واحدة.
    if (!/not attached|detached/i.test(String((error && error.message) || error))) throw error
    sessions.delete(tabId)
    await attachTab(tabId)
    return work(send)
  }
}

// الكونسول والشبكة: أحداثُ المنقّح تُخزَّن لكلّ تبويبٍ يسجّل (سقفُ ٣٠٠ لكلٍّ منهما، والأقدمُ يسقط ويُعدّ).
const MAX_CAPTURE = 300
const captureEvent = (capture, method, p) => {
  const pushConsole = (entry) => { capture.console.push(entry); if (capture.console.length > MAX_CAPTURE) { capture.console.shift(); capture.dropped += 1 } }
  const at = (frames) => { const f = frames && frames.callFrames && frames.callFrames[0]; return f ? (f.url || "") + ":" + (f.lineNumber + 1) : "" }
  if (method === "Runtime.consoleAPICalled") pushConsole({ level: p.type, text: (p.args || []).map((a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description || a.type)).join(" ").slice(0, 600), at: at(p.stackTrace) })
  else if (method === "Runtime.exceptionThrown") { const d = p.exceptionDetails || {}; pushConsole({ level: "error", text: String((d.exception && d.exception.description) || d.text || "exception").slice(0, 600), at: d.url ? d.url + ":" + ((d.lineNumber || 0) + 1) : at(d.stackTrace) }) }
  else if (method === "Log.entryAdded") { const e = p.entry || {}; pushConsole({ level: e.level, text: String(e.text || "").slice(0, 600), at: e.url ? e.url + (typeof e.lineNumber === "number" ? ":" + (e.lineNumber + 1) : "") : "" }) }
  else if (method === "Network.requestWillBeSent") {
    if (!p.request || /^data:/i.test(p.request.url)) return
    capture.network.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type || "", start: p.timestamp })
    if (capture.network.size > MAX_CAPTURE) { capture.network.delete(capture.network.keys().next().value); capture.dropped += 1 }
  }
  else if (method === "Network.responseReceived") { const e = capture.network.get(p.requestId); if (e) { e.status = p.response.status; e.type = p.type || e.type } }
  else if (method === "Network.loadingFinished") { const e = capture.network.get(p.requestId); if (e) { e.ms = (p.timestamp - e.start) * 1000; e.bytes = p.encodedDataLength } }
  else if (method === "Network.loadingFailed") { const e = capture.network.get(p.requestId); if (e) { e.failed = p.errorText || (p.canceled ? "canceled" : "failed"); e.ms = (p.timestamp - e.start) * 1000 } }
}
if (TRUSTED_INPUT) {
  api.debugger.onEvent.addListener((source, method, params) => { const session = sessions.get(source.tabId); if (session && session.capture) captureEvent(session.capture, method, params || {}) })
  api.debugger.onDetach.addListener((source, reason) => {
    const session = sessions.get(source.tabId)
    if (session) { clearTimeout(session.idle); clearTimeout(session.stop) }
    sessions.delete(source.tabId)
    if (reason === "canceled_by_user") userCanceledAt = Date.now()
  })
}
api.tabs.onRemoved.addListener((tabId) => { const session = sessions.get(tabId); if (session) { clearTimeout(session.idle); clearTimeout(session.stop) } sessions.delete(tabId) })

// ملفّاتُ «save» الخارجيّة: سقفُ ٣MB للملفّ و٢٠MB للنسخة كلّها (كالمتصفّح المملوك)، ستّةٌ في وقتٍ واحد.
const ASSET_CAP = 3 * 1024 * 1024
const COPY_CAP = 20 * 1024 * 1024
const fetchAssets = async (items, key) => {
  let used = 0
  const queue = items.filter((item) => item[key])
  const work = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      if (!/^https?:/i.test(item[key])) { item.error = "not http(s)"; continue }
      if (used >= COPY_CAP) { item.error = "copy budget (20MB) reached"; continue }
      try {
        const response = await fetch(item[key], { credentials: "include" })
        if (!response.ok) { item.error = "HTTP " + response.status; continue }
        let text = await response.text()
        if (text.length > ASSET_CAP) { text = text.slice(0, ASSET_CAP); item.truncated = true }
        used += text.length
        item.text = text
      } catch (error) { item.error = String((error && error.message) || error).slice(0, 120) }
    }
  }
  await Promise.all([work(), work(), work(), work(), work(), work()])
}

// ن5 — انتظارُ اكتمال تحميل تبويبٍ بعد فعلٍ عليه (open/back/forward/new)، بمهلةٍ لا تعلّق.
const settled = (tabId, ms = 15000) => new Promise((resolve) => {
  const done = (id, info) => { if (id === tabId && info.status === "complete") { api.tabs.onUpdated.removeListener(done); resolve() } }
  api.tabs.onUpdated.addListener(done)
  setTimeout(() => { api.tabs.onUpdated.removeListener(done); resolve() }, ms)
})

const perform = async (action, args) => {
  const tab = await activeTab({ createIfNone: action === "open" || action === "tabs" })
  switch (action) {
    // 0.6.3 — إعادةُ تحميل الإضافة من قرصها بأمر عبدو كود (عبدو كود يعيد التحميل لا المستخدم): الردُّ أوّلاً ثمّ التحميل، والمقبسُ يعود بالرمز المحفوظ.
    case "reload": setTimeout(() => api.runtime.reload(), 300); return { ok: true, version: api.runtime.getManifest().version }
    case "hello": return { trusted: TRUSTED_INPUT, ua: navigator.userAgent.slice(0, 120), version: api.runtime.getManifest().version }
    case "page": return inPage(tab.id, READ_TREE)
    case "look": return inPage(tab.id, LOOK, [args.ref || ""])
    // 0.6.5 (S9) — spec: ماشي المواصفة (SPEC) دالّةٌ مستقلّة لأنّ executeScript يحقن الدالّةَ وحدها بلا إغلاقها.
    case "inspect": return String(args.mode) === "spec" ? inPage(tab.id, SPEC, [600, String(args.target || "")]) : inPage(tab.id, INSPECT, [String(args.mode || "styles"), String(args.target || "")])
    case "scroll": return inPage(tab.id, SCROLL, [args.direction, args.count || 1])
    case "open": {
      if (!/^https?:\/\//i.test(String(args.url))) throw new Error("http/https only")
      await api.tabs.update(tab.id, { url: String(args.url) })
      await settled(tab.id, 25000)
      return true
    }
    case "tap": {
      if (!TRUSTED_INPUT) { const r = await inPage(tab.id, SYNTH_TAP, [args.ref]); if (!r) throw new Error("element not found"); return r }
      const at = await inPage(tab.id, LOCATE, [args.ref])
      if (!at) throw new Error("element not found")
      return withDebugger(tab.id, async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 })
        return { mode: "trusted" }
      })
    }
    case "fill": {
      if (!TRUSTED_INPUT) { const r = await inPage(tab.id, SYNTH_FILL, [args.ref, String(args.text)]); if (!r) throw new Error("element not found"); const back = await inPage(tab.id, READ_FIELD, [args.ref]); return { ...r, length: back ? back.length : null, expected: String(args.text).length } }
      const at = await inPage(tab.id, LOCATE, [args.ref])
      if (!at) throw new Error("element not found")
      return withDebugger(tab.id, async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 })
        // الكتابةُ تحلّ محلَّ القديم لا تُلحَق به: تحديدُ الحقل كلِّه، ثمّ الحروفُ تستبدل التحديد؛ والنصُّ الفارغ يمسح بـDelete.
        const selected = await inPage(tab.id, SELECT_FIELD, [args.ref])
        const text = String(args.text)
        if (text.length === 0 && selected && selected.length > 0) {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 })
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 })
        }
        // 0.6.7: one Input.insertText, not a keyDown per character. Per-character keyDown{text} left React-controlled
        // fields (a CMS article editor) empty and took minutes for a long article (measured 2026-09-19: two fills
        // read back "" after a "successful" fill). insertText is the browser's own typing path: beforeinput + input fire.
        if (text.length > 0) await send("Input.insertText", { text })
        const after = await inPage(tab.id, READ_FIELD, [args.ref])
        // The framework may still have discarded it: set the value through the native setter and report which path held.
        if (text.length > 0 && after && after.length === 0) {
          await inPage(tab.id, SYNTH_FILL, [args.ref, text])
          const again = await inPage(tab.id, READ_FIELD, [args.ref])
          return { mode: "trusted+native", replaced: selected ? selected.length : 0, length: again ? again.length : null, expected: text.length }
        }
        return { mode: "trusted", replaced: selected ? selected.length : 0, length: after ? after.length : null, expected: text.length }
      })
    }
    case "key": {
      const k = parseKey(args.key)
      if (!k) throw new Error("unsupported key")
      if (!TRUSTED_INPUT) return inPage(tab.id, SYNTH_KEY, [k.key, k.modifiers])
      return withDebugger(tab.id, async (send) => {
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: k.modifiers }
        await send("Input.dispatchKeyEvent", k.text ? { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text } : { type: "rawKeyDown", ...base })
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
        return { mode: "trusted" }
      })
    }
    case "select": {
      const r = await inPage(tab.id, SELECT_OPTION, [args.ref, String(args.text)])
      if (!r) throw new Error("element not found")
      return r
    }
    case "upload": {
      // رفعٌ بلا حوار نظام: DOM.setFileInputFiles عبر المنقّح على كائن الحقل — يحتاج صلاحيّةَ debugger (كروم/إيدج)؛ سفاري بلا منقّح يُقال له.
      const kind = await inPage(tab.id, FILE_INPUT_KIND, [args.ref])
      if (kind === "missing") return null
      if (kind !== "file") return { ok: false, why: "not-file" }
      if (!TRUSTED_INPUT) return { ok: false, why: "upload needs the debugger permission (Chrome/Edge)" }
      return withDebugger(tab.id, async (send) => {
        const want = "[data-abdo-ref=\"" + String(args.ref).replace(/[^A-Za-z0-9]/g, "") + "\"]"
        const expression = "(() => { const want = '" + want + "'; const walk = (root) => { const hit = root.querySelector(want); if (hit) return hit; for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const h = walk(el.shadowRoot); if (h) return h } if (el.tagName === 'IFRAME') { let d = null; try { d = el.contentDocument } catch { d = null } if (d) { const h = walk(d); if (h) return h } } } return null }; return walk(document) })()"
        const handle = await send("Runtime.evaluate", { expression, returnByValue: false })
        const objectId = handle && handle.result && handle.result.objectId
        if (!objectId) return null
        await send("DOM.enable", {})
        await send("DOM.setFileInputFiles", { files: [String(args.path)], objectId })
        const files = await inPage(tab.id, READ_FILES, [args.ref])
        return { ok: true, files: Array.isArray(files) ? files : [] }
      })
    }
    case "drag": {
      const from = await inPage(tab.id, LOCATE, [args.from]); const to = await inPage(tab.id, LOCATE, [args.to])
      if (!from || !to) throw new Error("element not found")
      if (!TRUSTED_INPUT) { const r = await inPage(tab.id, SYNTH_DRAG, [args.from, args.to]); if (!r) throw new Error("element not found"); return r }
      await withDebugger(tab.id, async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y })
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 })
        for (let i = 1; i <= 8; i += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 8), y: Math.round(from.y + ((to.y - from.y) * i) / 8), button: "left", buttons: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 })
      })
      await inPage(tab.id, SYNTH_DRAG, [args.from, args.to])
      return { mode: "trusted" }
    }
    // 0.6.1 (مقيس 09-16 على لوحة القياس): captureVisibleTab يردّ «image readback failed» حين تكون نافذةُ المتصفّح خلف نافذةٍ أخرى؛
    // اللقطةُ لا تحقن شيئاً، فتُرفع النافذةُ مرّةً ويُعاد الالتقاط — وإن فشل ثانيةً يصل الخطأُ باسمه.
    case "shot": {
      // 0.7.0 — الصفحةُ كاملةً بطولها (سقفُ 16384px) عبر المنقّح: captureVisibleTab لا يرى إلا الشاشة.
      const viaDebugger = (full) => withDebugger(tab.id, async (send) => {
        const params = { format: "png", captureBeyondViewport: !!full }
        if (full) {
          const metrics = await send("Page.getLayoutMetrics", {})
          const size = metrics.cssContentSize || metrics.contentSize
          params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16384), scale: 1 }
        }
        const shot = await send("Page.captureScreenshot", params)
        return "data:image/png;base64," + shot.data
      })
      if (args.full) { if (!TRUSTED_INPUT) throw new Error("a full-page shot needs the debugger permission (Chrome/Edge)"); return viaDebugger(true) }
      try { return await api.tabs.captureVisibleTab(tab.windowId, { format: "png" }) }
      catch (first) {
        try { await api.windows.update(tab.windowId, { focused: true }) } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300))
        try { return await api.tabs.captureVisibleTab(tab.windowId, { format: "png" }) }
        catch (second) {
          if (TRUSTED_INPUT) { try { return await viaDebugger(false) } catch {} }
          throw new Error(String(second && second.message || second) + " (after raising the window; first: " + String(first && first.message || first) + ")")
        }
      }
    }
    case "save": {
      const copy = await inPage(tab.id, SAVE_DOC)
      if (!copy || typeof copy.html !== "string") throw new Error("could not read the page")
      await fetchAssets(copy.styles, "href")
      await fetchAssets(copy.scripts, "src")
      return copy
    }
    // 0.7.0 — الكونسول والشبكة: أوّلُ نداءٍ يبدأ التسجيلَ لعشر دقائق (يمتدّ مع كلّ نداء)؛ الكونسولُ يُعاد كاملاً (المتصفّحُ يعيد ما سبق عند
    // Runtime.enable)، والشبكةُ من لحظة البدء — reload يعيد تحميلَ الصفحة ليلتقط كلَّ طلباتها.
    case "devtools": {
      if (!TRUSTED_INPUT) throw new Error("devtools needs the debugger permission (Chrome/Edge)")
      const session = await attachTab(tab.id)
      let started = false
      if (!session.capture) {
        session.capture = { console: [], network: new Map(), dropped: 0 }
        clearTimeout(session.idle)
        started = true
        for (const domain of ["Runtime.enable", "Log.enable", "Network.enable"]) await api.debugger.sendCommand({ tabId: tab.id }, domain, {})
      }
      clearTimeout(session.stop)
      session.stop = setTimeout(() => { session.capture = null; detachTab(tab.id) }, CAPTURE_MS)
      if (args.clear) { session.capture.console = []; session.capture.network.clear(); session.capture.dropped = 0 }
      if (args.reload) {
        session.capture.network.clear()
        await api.tabs.reload(tab.id)
        await settled(tab.id, 25000)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      const entries = args.what === "network" ? Array.from(session.capture.network.values()).map(({ start, ...rest }) => rest) : session.capture.console.slice()
      const now = await api.tabs.get(tab.id).catch(() => tab)
      return { started, url: now.url, entries: entries.slice(-200), dropped: session.capture.dropped }
    }
    // ن5 (09-16) — التبويبات: قائمةٌ مرقّمة بالفعّال، تبديلٌ/إغلاقٌ برقمٍ من القائمة (لا بمعرّفٍ خفيّ)، وتبويبٌ جديد على رابط http/https.
    case "tabs": {
      const tabs = await api.tabs.query({ windowId: tab.windowId })
      const op = String(args.op || "list")
      if (op === "list") return tabs.map((t, i) => ({ index: i + 1, id: t.id, title: String(t.title || "").slice(0, 80), url: String(t.url || "").slice(0, 200), active: !!t.active }))
      if (op === "new") {
        if (!/^https?:\/\//i.test(String(args.url))) throw new Error("http/https only")
        const created = await api.tabs.create({ windowId: tab.windowId, url: String(args.url), active: true })
        await settled(created.id)
        return { id: created.id, url: String(args.url) }
      }
      const n = Number(args.target)
      const picked = Number.isInteger(n) && n >= 1 && n <= tabs.length ? tabs[n - 1] : tabs.find((t) => String(t.id) === String(args.target))
      if (!picked) return null
      if (op === "switch") { await api.tabs.update(picked.id, { active: true }); return { id: picked.id, title: picked.title, url: picked.url } }
      if (op === "close") { if (tabs.length <= 1) return { last: true }; await api.tabs.remove(picked.id); return { id: picked.id, title: picked.title, url: picked.url } }
      throw new Error("unknown tabs op")
    }
    case "back":
    case "forward": {
      const before = String(tab.url || "")
      try { await (action === "back" ? api.tabs.goBack(tab.id) : api.tabs.goForward(tab.id)) } catch { return { moved: false, url: before } }
      await settled(tab.id)
      const after = await api.tabs.get(tab.id)
      return { moved: String(after.url || "") !== before, url: after.url, title: after.title }
    }
    default: throw new Error("unknown action")
  }
}

const setBadge = (text) => { try { api.action.setBadgeText({ text }) } catch {} }

// ب8 — الاقترانُ الآليّ: بلا رمزٍ محفوظ تسأل الإضافةُ الجسرَ المحلّيّ `GET /pair` كلَّ ثوانٍ؛ حين تكون نافذةُ الاقتران
// مفتوحةً في عبدو كود (عند إقلاعه أو بأمر «browser extension») يُسلَّم الرمزُ فيُحفظ ويتّصل المقبس — بلا لصقٍ يدويّ.
// الردُّ يسمّي السببَ حين لا يقترن: مغلق (423) أو لا عبدو كود على المنفذ (تعذّر الوصول).
let pairTimer = null
const tryPair = async () => {
  const { port, token } = await settings()
  if (token) return { paired: true, port }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, { cache: "no-store" })
    if (response.status === 200) {
      const body = await response.json()
      if (body && typeof body.token === "string" && body.token.length >= 24) { await api.storage.local.set({ port: Number(body.port) || port, token: body.token }); return { paired: true, fresh: true, port: Number(body.port) || port } }
      return { paired: false, reason: "bad-reply", port }
    }
    return { paired: false, reason: response.status === 423 ? "closed" : "http-" + response.status, port }
  } catch { return { paired: false, reason: "unreachable", port } }
}
const pairLoop = async () => {
  clearTimeout(pairTimer)
  const result = await tryPair()
  if (!result.paired) pairTimer = setTimeout(pairLoop, 5000)
}

// ب8ب (مقيس 09-14): بعد إعادة تشغيل عبدو كود لم تعد الإضافةُ تتّصل — مؤقّتُ إعادة المحاولة يموت مع إيقاف عامل
// الخدمة (MV3)، والرمزُ قد يتبدّل. فالمنبّهُ يوقظ العاملَ كلَّ دقيقة ليعيد الاتّصال، وقبل كلّ اتّصالٍ برمزٍ محفوظ يُسأل /pair:
// إن كانت نافذةُ الاقتران مفتوحةً وأعطت رمزاً مختلفاً حلّ محلَّ القديم (الرمزُ تبدّل) — وإلّا يُستعمل المحفوظ كما هو.
const refreshToken = async (port, token) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, { cache: "no-store" })
    if (response.status !== 200) return token
    const body = await response.json()
    if (body && typeof body.token === "string" && body.token.length >= 24 && body.token !== token) { await api.storage.local.set({ token: body.token }); return body.token }
  } catch {}
  return token
}
try { api.alarms.create("abdo-reconnect", { periodInMinutes: 1 }); api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "abdo-reconnect") connect() }) } catch {}

const tell = (frame) => { try { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)) } catch {} }
// المستخدمُ ركّز على هذا المتصفّح ⇦ الجسرُ يوجّه الأفعالَ إليه (حين يكون كروم وإيدج موصولَين معاً).
const notifyFocus = () => tell({ kind: "focus", at: Date.now() })
try { api.windows.onFocusChanged.addListener((windowId) => { if (windowId !== api.windows.WINDOW_ID_NONE) notifyFocus() }) } catch {}
try { api.tabs.onActivated.addListener(() => notifyFocus()) } catch {}

const connect = async () => {
  // 0.7.0 — قفلٌ واحد: المنبّهُ وبدءُ التشغيل وتغيّرُ التخزين كانت تستدعي connect معاً فيُفتح مقبسان، ويمحو إغلاقُ القديم المتغيّرَ الجديد.
  if (connecting) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  connecting = true
  try {
    const stored = await settings()
    const port = stored.port
    if (!stored.token) { setBadge("?"); pairLoop(); return }
    clearTimeout(pairTimer)
    const token = await refreshToken(port, stored.token)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
    socket = ws
    // ب8د — النبضُ كلَّ ٢٠ ث: يُبقي عاملَ الخدمة حيّاً (كروم ≥116 يمدّد عمرَه مع نشاط المقبس) ويجعل «متّصل» في الجسر قياساً لا حالةً.
    let pingTimer = null
    ws.onopen = () => {
      if (socket !== ws) { try { ws.close() } catch {} return }
      setBadge("on")
      tell({ kind: "hello", browser: BROWSER, version: api.runtime.getManifest().version, trusted: TRUSTED_INPUT })
      api.windows.getLastFocused().then((w) => { if (w && w.focused) notifyFocus() }).catch(() => {})
      clearInterval(pingTimer)
      pingTimer = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "ping", at: Date.now() })) } catch {} }, 20000)
    }
    ws.onclose = () => {
      clearInterval(pingTimer)
      if (socket !== ws) return
      setBadge(""); socket = null; clearTimeout(retryTimer); retryTimer = setTimeout(connect, 3000)
    }
    ws.onerror = () => {}
    ws.onmessage = async (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (typeof message.id !== "number") return
      try { ws.send(JSON.stringify({ id: message.id, ok: true, result: await perform(message.action, message.args || {}) })) }
      catch (error) { try { ws.send(JSON.stringify({ id: message.id, ok: false, error: String(error && error.message || error).slice(0, 300) })) } catch {} }
    }
  } finally { connecting = false }
}

api.runtime.onInstalled.addListener(connect)
api.runtime.onStartup.addListener(connect)
// يُعاد الاتّصالُ حين يتغيّر المنفذُ أو الرمز وحدهما — لا مع كلّ كتابةٍ في التخزين.
api.storage.onChanged.addListener((changes, area) => { if (area !== "local" || !(("token" in changes) || ("port" in changes))) return; if (socket) socket.close(); else connect() })
api.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message && message.kind === "status") { reply({ connected: !!socket && socket.readyState === WebSocket.OPEN, trusted: TRUSTED_INPUT, browser: BROWSER, version: api.runtime.getManifest().version }); return true }
  if (message && message.kind === "reconnect") { if (socket) socket.close(); connect(); reply({ ok: true }); return true }
  if (message && message.kind === "pair") { tryPair().then((result) => { if (result.paired) connect(); reply(result) }); return true }
  return false
})
connect()
