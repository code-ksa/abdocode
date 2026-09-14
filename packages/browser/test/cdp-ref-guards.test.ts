import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpBrowser } from "../src/cdp"
import { stripChildEnv } from "@abdo/tools/env-strip"

// ب9 — **لوحٌ حيّ على إيدج حقيقيّ** لما كان مفحوصاً بفكستشر ثابت (فيتّفق القارئُ والفاعلُ بالبناء لا بالواقع):
//   (١) المرجعُ **ثابتٌ** بين قراءتين — كان كلُّ قراءةٍ تُعيد الترقيم، فيصير الرقمُ الذي وافق عليه المستخدم لعنصرٍ آخر.
//   (٢) قيمةُ حقل كلمة المرور **لا تُقرأ**: لا في الشجرة، ولا في `locate`، ولا في قراءة ما استقرّ بعد الكتابة.
//   (٣) عنصرٌ انطوى ⇦ مقاسٌ صفر (كان يعطي (0,0) فتقع النقرةُ في زاوية الصفحة)، وعنصرٌ يغطّيه آخر ⇦ `hit=false`.
//   (٤) عنصرٌ خارج العرض يُحضَر ثمّ يُقاس — لا يُنقر على إحداثيّةٍ خارج النافذة.
//   (٥) الكتابةُ تُحدِّد الحقلَ أوّلاً فتُبدِل لا تُذيَّل، وما استقرّ يُقرأ فيُقارَن.

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>refs</title>
<style>body{margin:0;font:14px sans-serif} #cover{position:fixed;inset:0;background:#000;display:none;z-index:9} .far{margin-top:2400px}</style></head>
<body>
<input id="user" name="اسم المستخدم" value="">
<input id="pass" type="password" name="كلمة المرور" value="ســـرّي-٩٩">
<input id="otp" autocomplete="one-time-code" name="رمز التحقق" value="123456">
<button id="save">احفظ</button>
<button id="ghost">مؤقّت</button>
<button id="far" class="far">زرٌّ بعيد</button>
<div id="cover"></div>
</body></html>`

test.skipIf(!edge)("real Edge: refs stay stable, credential values never leave the page, and a collapsed, covered or off-screen element is never treated as clickable", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-cdp-refs-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }) })
  const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
  const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", "--window-size=900,700", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "profile")}`, `http://127.0.0.1:${server.port}/`], { env: stripChildEnv(process.env) as unknown as Record<string, string | undefined>, stdout: "ignore", stderr: "ignore" })
  const browser = new CdpBrowser(port!)
  try {
    for (let i = 0; ; i++) { try { await browser.attach(); break } catch (error) { if (i > 40) throw error; await Bun.sleep(100) } }
    const tree = await browser.readPage()
    const byId = async (id: string): Promise<string> => browser.evalForTest(`(document.getElementById(${JSON.stringify(id)}).getAttribute('data-abdo-ref') || '')`)
    const save = await byId("save"), pass = await byId("pass"), otp = await byId("otp"), ghost = await byId("ghost"), far = await byId("far"), user = await byId("user")
    expect(`${save}|${pass}|${far}`).toMatch(/^r\d+\|r\d+\|r\d+$/u)

    // (٢) السرُّ لا يُقرأ: لا قيمةَ كلمة المرور ولا الرمز في الشجرة، والعقدةُ موسومةٌ سرّيّةً بنوعها لا باسمها.
    const flat = JSON.stringify(tree)
    expect(flat).not.toContain("ســـرّي-٩٩")
    expect(flat).not.toContain("123456")
    expect(tree.find((n) => n.ref === pass)?.sensitive).toBe(true)
    expect(tree.find((n) => n.ref === otp)?.sensitive).toBe(true)
    expect(tree.find((n) => n.ref === pass)?.name).toContain("(مملوء)")
    expect(tree.find((n) => n.ref === save)?.name).toBe("احفظ")

    // (١) المرجعُ ثابتٌ بين قراءتين، وعنصرٌ جديد يأخذ رقماً جديداً — لا يرث رقمَ غيره.
    await browser.evalForTest("(() => { const b = document.createElement('button'); b.id='fresh'; b.textContent='طارئ'; document.body.insertBefore(b, document.body.firstChild); return 'ok' })()")
    const again = await browser.readPage()
    expect(await byId("save")).toBe(save)
    expect(await byId("pass")).toBe(pass)
    const fresh = await byId("fresh")
    expect(fresh).not.toBe(save)
    expect(again.find((n) => n.ref === fresh)?.name).toBe("طارئ")

    // (٣أ) العنصرُ الظاهر: موضعٌ داخل العرض، وإصابةٌ صحيحة، وهويّةٌ تطابق الشجرة.
    const onSave = await browser.locate(save)
    expect(onSave).toBeDefined()
    expect(`${onSave!.hit} ${onSave!.inView} ${onSave!.width > 0} ${onSave!.role} ${onSave!.name}`).toBe("true true true button احفظ")

    // (٣ب) عنصرٌ انطوى: مقاسُه صفر — ولا يُعطى (0,0) لتقع نقرةٌ في زاوية الصفحة.
    await browser.evalForTest("(document.getElementById('ghost').style.display='none','ok')")
    const onGhost = await browser.locate(ghost)
    expect(onGhost === undefined || (onGhost.width === 0 && onGhost.height === 0)).toBe(true)

    // (٣ج) عنصرٌ يغطّيه آخر: الموضعُ صحيحٌ والإصابةُ كاذبة — `elementFromPoint` يقول من تحت النقطة حقّاً.
    await browser.evalForTest("(document.getElementById('cover').style.display='block','ok')")
    const covered = await browser.locate(save)
    expect(covered!.hit).toBe(false)
    await browser.evalForTest("(document.getElementById('cover').style.display='none','ok')")
    expect((await browser.locate(save))!.hit).toBe(true)

    // (٤) عنصرٌ خارج العرض: يُحضَر ثمّ يُقاس، فيصير داخل النافذة ومصاباً.
    const onFar = await browser.locate(far)
    expect(`${onFar!.inView} ${onFar!.hit} ${onFar!.name}`).toBe("true true زرٌّ بعيد")

    // (٥) الكتابةُ تُبدِل ولا تُذيَّل، وما استقرّ يُقرأ.
    await browser.evalForTest("(document.getElementById('user').value='قديم','ok')")
    expect(await browser.selectRef(user)).toBe(true)
    await browser.typeKeys("جديد")
    const landed = await browser.readValue(user)
    expect(landed).toEqual({ value: "جديد", length: 4, sensitive: false })

    // والسرُّ لا يُقرأ حتى في التحقّق: طولٌ فقط، بلا قيمة.
    const secret = await browser.readValue(pass)
    expect(secret).toEqual({ length: "ســـرّي-٩٩".length, sensitive: true })
    expect(JSON.stringify(secret)).not.toContain("ســـرّي")
  } finally {
    browser.close()
    try { child.kill() } catch { /* انتهى */ }
    await child.exited
    server.stop(true)
    for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 180_000)
