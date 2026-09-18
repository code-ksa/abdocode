/**
 * S9 (2026-09-18) — ماشي المواصفة داخل الصفحة: دالّةٌ واحدة تُحقن في الصفحة الحيّة (المتصفّحُ المملوك عبر CDP هنا،
 * وإضافةُ المتصفّح في `background.js` بالنصّ نفسِه — اختبارٌ يثبّت تطابقَ النسختين بايتاً بايتاً كي لا تفترقا).
 *
 * تمشي العناصرَ الظاهرة عرضاً (BFS: البنيةُ العليا قبل الأوراق حين يُبلَغ السقف) وتعيد شجرةً مسطّحة: صندوقُ كلّ عنصر
 * (getBoundingClientRect + التمرير)، وأنماطٌ محسوبة من مجموعةٍ محدودة، ونصُّه الخاصّ، وصورُه وحقولُه. السقفُ ٦٠٠ عقدة
 * افتراضاً (≤ ٢٠٠٠). لا تكتب في الصفحة شيئاً — قراءةٌ بلا أثر.
 *
 * نصٌّ لا دالّة: `Function.prototype.toString` بعد الترجمة قد يختلف عن المصدر، والإضافةُ ملفُّ JS خامٌ يُقرأ كما هو —
 * فالمصدرُ الواحد نصٌّ ASCII بلا علاماتِ اقتباسٍ خلفيّة (String.raw يحفظ الشرطات المائلة في التعبيرات النمطيّة).
 */
export const SPEC_WALKER_LIMIT = 600

export const SPEC_WALKER: string = String.raw`(limit, rootRef) => {
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
}`.replace(/\r\n/gu, "\n") // نهاياتُ الأسطر من الاستخراج لا من نوع السحب (autocrlf يجعل الحرفيَّ CRLF على ويندوز)

/** تعبيرُ التقييم للمتصفّح المملوك: الماشي يُستدعى بسقفه وجذره ويُعاد JSON نصّاً (كما تعيد `readDesign` أخواتُها). */
export const specWalkerExpression = (limit: number = SPEC_WALKER_LIMIT, rootRef = ""): string =>
  "JSON.stringify((" + SPEC_WALKER + ")(" + Math.max(50, Math.min(2000, Math.floor(limit) || SPEC_WALKER_LIMIT)) + ", " + JSON.stringify(/^r\d{1,6}$/u.test(rootRef) ? rootRef : "") + "))"
