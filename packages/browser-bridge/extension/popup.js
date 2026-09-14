const el = (id) => document.getElementById(id)
const api = typeof chrome !== "undefined" ? chrome : browser
const render = (s) => {
  const connected = !!(s && s.connected)
  el("status").textContent = connected ? "متّصلٌ بعبدو كود ✓" : "غير متّصل — تأكّد أن عبدو كود يعمل وأن الرمز صحيح"
  // نصُّ الشفافية يتبع المتصفّح: منقّحٌ موثوق (كروم/إيدج) أو أحداثٌ اصطناعية (سفاري).
  el("mode").textContent = s && s.trusted === false
    ? "في هذا المتصفّح تُنفَّذ النقرات والكتابة بأحداثٍ داخل الصفحة (لا منقّح)، وقد لا تستجيب بعضُ المواقع لها."
    : "عند كل نقرة أو كتابة يُعلمك المتصفّح أن هذا التبويب يُدار بأداة تنقيح، فتعرف أن الوكيل يعمل."
}
api.storage.local.get({ port: 9367, token: "" }).then((stored) => { el("port").value = stored.port; el("token").value = stored.token })
api.runtime.sendMessage({ kind: "status" }).then(render).catch(() => render(null))
el("save").onclick = async () => {
  await api.storage.local.set({ port: Number(el("port").value) || 9367, token: el("token").value.trim() })
  await api.runtime.sendMessage({ kind: "reconnect" }).catch(() => {})
  setTimeout(() => api.runtime.sendMessage({ kind: "status" }).then(render).catch(() => render(null)), 800)
}
