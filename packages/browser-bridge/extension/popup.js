const el = (id) => document.getElementById(id)
const api = typeof chrome !== "undefined" ? chrome : browser
const INSTALL_URL = "https://github.com/code-ksa/abdocode/releases/latest"
const render = (s) => {
  const connected = !!(s && s.connected)
  el("status").textContent = connected ? "متّصلٌ بعبدو كود ✓" : "غير متّصل — اضغط «ابحث عن عبدو كود واقترن» أو الصق الرمز يدويّاً"
  // نصُّ الشفافية يتبع المتصفّح: منقّحٌ موثوق (كروم/إيدج) أو أحداثٌ اصطناعية (سفاري).
  el("mode").textContent = s && s.trusted === false
    ? "في هذا المتصفّح تُنفَّذ النقرات والكتابة بأحداثٍ داخل الصفحة (لا منقّح)، وقد لا تستجيب بعضُ المواقع لها."
    : "عند كل نقرة أو كتابة يُعلمك المتصفّح أن هذا التبويب يُدار بأداة تنقيح، فتعرف أن الوكيل يعمل."
}
const refresh = () => api.runtime.sendMessage({ kind: "status" }).then(render).catch(() => render(null))
api.storage.local.get({ port: 9367, token: "" }).then((stored) => { el("port").value = stored.port; el("token").value = stored.token })
refresh()
el("save").onclick = async () => {
  await api.storage.local.set({ port: Number(el("port").value) || 9367, token: el("token").value.trim() })
  await api.runtime.sendMessage({ kind: "reconnect" }).catch(() => {})
  setTimeout(refresh, 800)
}
// ب8 — الاقترانُ الآليّ: يسأل عبدو كود على المنفذ المحفوظ؛ الردُّ يسمّي ما حدث ولا يدّعي.
el("pair").onclick = async () => {
  el("status").textContent = "يبحث عن عبدو كود على هذا الجهاز…"
  await api.storage.local.set({ port: Number(el("port").value) || 9367 })
  const r = await api.runtime.sendMessage({ kind: "pair" }).catch(() => null)
  if (r && r.paired) { el("token").value = "••••••••"; el("status").textContent = "اقترن ✓ — يتّصل الآن…"; setTimeout(refresh, 1200); return }
  const reason = r ? r.reason : "unreachable"
  if (reason === "closed") el("status").textContent = "عبدو كود يعمل لكن نافذة الاقتران مغلقة: في عبدو كود اكتب «browser extension» (أو الإعدادات ▸ الاتّصالات ▸ إضافة المتصفّح) ثم اضغط هذا الزرّ خلال دقيقتين — أو الصق الرمز يدويّاً."
  else if (reason === "unreachable") el("status").innerHTML = `لا يوجد عبدو كود يعمل على 127.0.0.1:${(r && r.port) || el("port").value}. افتحه إن كان مثبّتاً، أو <a href="${INSTALL_URL}" target="_blank" rel="noopener">ثبّته من هنا</a> ثم أعد المحاولة.`
  else el("status").textContent = "تعذّر الاقتران: " + reason
}
