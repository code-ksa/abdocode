// عاملُ الخدمة لإضافة عبدو كود: مقبسٌ واحد إلى الجسر المحلّيّ (127.0.0.1) برمزٍ يلصقه المستخدم في النافذة
// المنبثقة. كلُّ رسالةٍ `{id, action, args}` تُنفَّذ على **التبويب الفعّال** ويُردّ `{id, ok, result|error}`.
// النقرُ والكتابةُ والمفاتيحُ عبر منقّح المتصفّح (أحداثُ إدخالٍ موثوقة، والمستخدم يرى شارةَ التنقيح) في كروم
// وإيدج؛ وفي سفاري — حيث لا منقّح للإضافات — تُبعث أحداثٌ اصطناعيةٌ داخل الصفحة ويُعلَن ذلك في الردّ
// (`mode: "synthetic"`) كي يعرف الوكيلُ والمستخدم. القراءةُ والتمريرُ بسكربتٍ في الصفحة. لا تخزينَ لمحتوى
// الصفحات، ولا إرسالَ إلا إلى الجسر المحلّيّ.

const DEFAULT_PORT = 9367
const api = typeof chrome !== "undefined" ? chrome : browser
const TRUSTED_INPUT = !!(api.debugger && typeof api.debugger.attach === "function")
let socket = null
let retryTimer = null

const settings = async () => {
  const stored = await api.storage.local.get({ port: DEFAULT_PORT, token: "" })
  return { port: Number(stored.port) || DEFAULT_PORT, token: String(stored.token || "") }
}

const activeTab = async () => {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || typeof tab.id !== "number") throw new Error("no active tab")
  return tab
}

// شجرةُ العناصر القابلة للقيادة — الشكلُ نفسُه الذي يقرؤه المحرّك من متصفّحه المملوك (دورٌ واسمٌ ومرجع).
const READ_TREE = () => {
  const out = []
  let n = 0
  const label = (el) => {
    const typed = (el.value || "").trim()
    if (typed) return typed.slice(0, 80)
    return ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"))) || (el.innerText || "").trim().slice(0, 80))
  }
  const role = (el) => {
    const t = el.tagName.toLowerCase()
    if (t === "a") return "link"
    if (t === "button") return "button"
    if (t === "select") return "combobox"
    if (t === "textarea") return "textbox"
    if (t === "input") { const type = (el.getAttribute("type") || "text").toLowerCase(); return type === "password" ? "textbox:password" : type === "checkbox" || type === "radio" ? type : type === "submit" || type === "button" ? "button" : "textbox" }
    if (/^h[1-6]$/.test(t)) return "heading"
    return el.getAttribute("role") || t
  }
  for (const el of document.querySelectorAll("a,button,input,textarea,select,h1,h2,h3,h4,h5,h6,[role]")) {
    if (n >= 200) break
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    n += 1
    const ref = "r" + n
    el.setAttribute("data-abdo-ref", ref)
    out.push({ ref, role: role(el), name: label(el) })
  }
  return out
}

const LOOK = (ref) => {
  const el = ref ? document.querySelector('[data-abdo-ref="' + ref + '"]') : document.body
  if (!el) return ""
  const cs = getComputedStyle(el)
  const keys = ["display", "color", "background-color", "font-size", "font-family", "font-weight", "width", "height", "margin", "padding", "border", "text-align", "direction"]
  const styles = {}
  for (const k of keys) styles[k] = cs.getPropertyValue(k)
  return JSON.stringify({ title: document.title, url: location.href, focused: document.activeElement === el, text: (el.innerText || "").trim().slice(0, ref ? 2000 : 6000), styles })
}

const LOCATE = (ref) => {
  const el = document.querySelector('[data-abdo-ref="' + ref + '"]')
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}

const SCROLL = (direction, count) => { window.scrollBy(0, (direction === "up" ? -1 : 1) * Math.round(innerHeight * 0.9) * count); return true }

// المسارُ الاصطناعيّ (سفاري): نقرةٌ وكتابةٌ ومفاتيحُ بأحداث DOM. الكتابةُ تمرّ بمُعيِّن القيمة الأصليّ كي تراها
// أُطرُ الواجهة (React وأخواتها) التي تتجاهل `el.value =` المباشر.
const SYNTH_TAP = (ref) => {
  const el = document.querySelector('[data-abdo-ref="' + ref + '"]')
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  if (typeof el.focus === "function") el.focus()
  el.click()
  return { mode: "synthetic" }
}

const SYNTH_FILL = (ref, text) => {
  const el = document.querySelector('[data-abdo-ref="' + ref + '"]')
  if (!el) return null
  el.scrollIntoView({ block: "center", inline: "center" })
  if (typeof el.focus === "function") el.focus()
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null
  const setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set
  if (setter) setter.call(el, text)
  else if (el.isContentEditable) el.textContent = text
  else el.value = text
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { mode: "synthetic" }
}

const SYNTH_KEY = (key) => {
  const el = document.activeElement || document.body
  const init = { key, code: key, bubbles: true, cancelable: true }
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

// أدواتُ الفحص (2026-09-14، تكافؤٌ مع المتصفّح المملوك): styles = تصميمُ الصفحة بالأرقام (متغيّرات الجذر، الألوان
// بمساحتها، التدرّجات، الخطوط، العناوين، الأزرار)؛ dom <ref> = HTML الخارجيّ المقصوص وأنماطُه المحسوبة وصندوقه؛
// css <selector> = قواعدُ الأوراق المطابقة (+ @font-face)؛ assets = الصور والأيقونات والأوراق والخطوط. قراءةٌ بلا أثر.
const INSPECT = (mode, target) => {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
  if (mode === "dom") {
    const el = document.querySelector('[data-abdo-ref="' + target + '"]')
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

const inPage = async (tabId, func, args = []) => {
  const [frame] = await api.scripting.executeScript({ target: { tabId }, func, args })
  return frame && frame.result
}

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }

const withDebugger = async (tabId, work) => {
  const target = { tabId }
  await api.debugger.attach(target, "1.3")
  try { return await work((method, params) => api.debugger.sendCommand(target, method, params)) }
  finally { try { await api.debugger.detach(target) } catch {} }
}

const perform = async (action, args) => {
  const tab = await activeTab()
  switch (action) {
    case "hello": return { trusted: TRUSTED_INPUT, ua: navigator.userAgent.slice(0, 120), version: api.runtime.getManifest().version }
    case "page": return inPage(tab.id, READ_TREE)
    case "look": return inPage(tab.id, LOOK, [args.ref || ""])
    case "inspect": return inPage(tab.id, INSPECT, [String(args.mode || "styles"), String(args.target || "")])
    case "scroll": return inPage(tab.id, SCROLL, [args.direction, args.count || 1])
    case "open": {
      if (!/^https?:\/\//i.test(String(args.url))) throw new Error("http/https only")
      await api.tabs.update(tab.id, { url: String(args.url) })
      await new Promise((resolve) => {
        const done = (id, info) => { if (id === tab.id && info.status === "complete") { api.tabs.onUpdated.removeListener(done); resolve() } }
        api.tabs.onUpdated.addListener(done)
        setTimeout(() => { api.tabs.onUpdated.removeListener(done); resolve() }, 15000)
      })
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
      if (!TRUSTED_INPUT) { const r = await inPage(tab.id, SYNTH_FILL, [args.ref, String(args.text)]); if (!r) throw new Error("element not found"); return r }
      const at = await inPage(tab.id, LOCATE, [args.ref])
      if (!at) throw new Error("element not found")
      return withDebugger(tab.id, async (send) => {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 })
        for (const ch of String(args.text)) { await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", text: ch }) }
        return { mode: "trusted" }
      })
    }
    case "key": {
      const vk = KEY_CODES[args.key]
      if (vk === undefined) throw new Error("unsupported key")
      if (!TRUSTED_INPUT) return inPage(tab.id, SYNTH_KEY, [args.key])
      return withDebugger(tab.id, async (send) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: args.key, windowsVirtualKeyCode: vk })
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: args.key, windowsVirtualKeyCode: vk })
        return { mode: "trusted" }
      })
    }
    case "shot": return api.tabs.captureVisibleTab(tab.windowId, { format: "png" })
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

// ب8ب (مقيس 09-14 على جهاز المالك): بعد إعادة تشغيل عبدو كود لم تعد الإضافةُ تتّصل — مؤقّتُ إعادة المحاولة يموت مع إيقاف عامل
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

const connect = async () => {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  const stored = await settings()
  const port = stored.port
  if (!stored.token) { setBadge("?"); pairLoop(); return }
  clearTimeout(pairTimer)
  const token = await refreshToken(port, stored.token)
  socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
  socket.onopen = () => setBadge("on")
  socket.onclose = () => { setBadge(""); socket = null; clearTimeout(retryTimer); retryTimer = setTimeout(connect, 3000) }
  socket.onerror = () => {}
  socket.onmessage = async (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (typeof message.id !== "number") return
    try { socket.send(JSON.stringify({ id: message.id, ok: true, result: await perform(message.action, message.args || {}) })) }
    catch (error) { socket.send(JSON.stringify({ id: message.id, ok: false, error: String(error && error.message || error).slice(0, 300) })) }
  }
}

api.runtime.onInstalled.addListener(connect)
api.runtime.onStartup.addListener(connect)
api.storage.onChanged.addListener(() => { if (socket) socket.close(); else connect() })
api.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message && message.kind === "status") { reply({ connected: !!socket && socket.readyState === WebSocket.OPEN, trusted: TRUSTED_INPUT }); return true }
  if (message && message.kind === "reconnect") { if (socket) socket.close(); connect(); reply({ ok: true }); return true }
  if (message && message.kind === "pair") { tryPair().then((result) => { if (result.paired) connect(); reply(result) }); return true }
  return false
})
connect()
