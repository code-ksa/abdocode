import { describe, expect, test } from "bun:test"

const shell = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
const fontDir = new URL("../../desktop/ui/fonts/", import.meta.url)

/**
 * برنامجُ القشرة — الموجةُ الأولى: خطٌّ محليّ، وشريطٌ لا يتراكب، وشرائحُ تنكمش.
 *
 * الأسبابُ الثلاثةُ للتراكب قِيست من لقطة المالك ومن المصدر، وكلٌّ يُصلَح عند
 * سببه لا بعلاجٍ عامّ. والقياسُ الحاكم أُخذ في متصفّحٍ حقيقيّ بمسحِ عرضٍ من
 * 980 إلى 400 بكسل: الأساسُ يتراكب عند أربعة عروض (640 · 580 · 520 · 460)،
 * وبعد الإصلاح **صفرُ تراكبٍ في التسعة كلّها**، وحقلُ الرابط ينكمش متّصلاً
 * إلى 90 بعد أن كان يقف عند 179 (وهو أثرُ `min-width: auto`).
 */
describe("قشرة المنتَج: الخطّ والشريط والشرائح", () => {
  // سوقُ الخوادم: بضغطةٍ بدل أمرٍ يُكتب بيد. والقياسُ هنا بنيويّ — أنّ القائمة
  // تأتي من الوحدة المُختبَرة لا من نسخةٍ في الصفحة، وأنّ رأسَ أمر المحرّك من
  // الرست لا من تخمين القشرة، وأنّ حقلَ السرّ مُخفى.
  test("سوقُ الخوادم من الوحدة المُختبَرة، وأمرُ المحرّك من الرست، والسرُّ مخفيّ", () => {
    expect(shell).toContain('import { McpCatalogue } from "./mcp-catalogue.js"')
    expect(shell).toContain("McpCatalogue.MCP_PRESETS")
    expect(shell).toContain("McpCatalogue.presetCommand(preset, engineArgv, value.value)")
    // رأسُ الأمر يأتي مع الهويّة — مصدرٌ واحدٌ مع ما يشغّله الرست فعلاً.
    expect(shell).toContain("engineArgv = Array.isArray(id.engine_argv)")
    // ولا مسارَ ثنائيٍّ مكتوبٌ في الصفحة: تخمينُه يبني أمراً لملفٍّ لا يُشغَّل.
    expect(shell).not.toContain("abdocode.exe")
    // وحقلُ السرّ مُخفى في الشاشة أيضاً.
    expect(shell).toContain('if (preset.input.kind === "secret") value.type = "password"')
  })

  // منحُ اعتمادٍ لخادم MCP: القيمةُ إلى الخزنة، والمقبضُ وحده إلى الإعدادات.
  // والقشرةُ تطبّق قاعدةَ «ما يُجرَّد لا يُمنَح» عندها أيضاً — لا لأنّها الحارس
  // (الحارسان في المحرّك وفي الجلسة) بل كي يُرفض الخطأُ حيث يقع لا بعد رحلة.
  test("منحُ الاعتماد: القيمةُ إلى الخزنة وحدها، والمقبضُ يُشتقّ، والمجرَّدُ لا يُمنَح", () => {
    expect(shell).toContain('await invoke("vault_set", { key: handle, value })')
    // المقبضُ مشتقٌّ من فضاء custom- فلا يخطئه المستخدم ولا يمسّ مفاتيحنا.
    expect(shell).toContain('const handle = "custom-" + server.id + "-"')
    // ولا قيمةَ تدخل رقعةَ الإعدادات: المرسَل `{ env, handle }` لا غير.
    expect(shell).toContain("{ env, handle }")
    expect(shell).not.toMatch(/secrets:.*value/u)
    // وحارسُ التهريب مكتوبٌ في القشرة كما في المحرّك.
    expect(shell).toContain('env === "ABDO_SHELL_TOKEN" || env.startsWith("ABDO_VAULT")')
    // ونزعُ المنح لا يمحو السرّ: المحوُ فعلٌ هدّامٌ يُطلب صراحةً.
    expect(shell).toContain("هنا يُنزع الإذنُ لا السرّ")
  })

  // قسمُ الاتصالات (MCP): البابُ الذي يجعل «أيَّ تطبيقٍ له MCP» مطروقاً من
  // المنتَج. والمقاييسُ هنا ثلاثةٌ لا شكلٌ: أنّ القسمَ موجود، وأنّ القسمةَ
  // تُستدعى من الوحدة المُختبَرة لا من نسخةٍ في الصفحة، وأنّ الحقيقةَ عند
  // المحرّك — فمسوّدةُ القشرة تُردّ عند كلّ رفضٍ وعند كلّ إطار إعدادات.
  test("قسمُ الاتصالات موجود، وقسمةُ الأمر من الوحدة المُختبَرة، والحقيقةُ عند المحرّك", () => {
    expect(shell).toContain('<button data-settings-panel="connections">الاتصالات</button>')
    expect(shell).toContain('data-panel="connections"')
    // القسمةُ تُستورد ولا تُكتب هنا: نسخةٌ ثانيةٌ في الصفحة تفترق عن المُختبَرة.
    expect(shell).toContain("Shell.splitCommandLine(String(text))")
    expect(shell).not.toMatch(/const splitCommand = \(text\) => \{/u)
    // الحقيقةُ عند المحرّك: المسوّدةُ تُردّ عند الرفض وعند وصول الإعدادات.
    expect(shell).toContain("const mcpResync = ()")
    // نداءان بالضبط: عند إطار الإعدادات (الحقيقة تصل) وعند الرفض (المسوّدة
    // تُردّ). ثالثٌ يعني مساراً لم يُقصد، وواحدٌ يعني نصفَ الحقيقة.
    expect((shell.match(/mcpResync\(\);/gu) ?? []).length).toBe(2)
    // Execute the live handler: a localized settings refusal must restore the
    // draft without incorrectly settling an unrelated running turn.
    const refusalHandler = shell.match(/if \(f.kind === "refused"\) \{[\s\S]*?\n {6}\}/u)?.[0]
    expect(refusalHandler).toBeDefined()
    for (const why of ["Settings could not be applied", "تعذّر تطبيق الإعدادات"]) {
      const effects: unknown[] = []
      new Function("f", "approvalFold", "delivFold", "settle", "notice", "mcpResync", refusalHandler!)(
        { kind: "refused", why },
        () => effects.push("approval"), () => effects.push("deliverables"), () => effects.push("settle"),
        (message: string) => effects.push(["notice", message]), () => effects.push("resync"),
      )
      expect(effects).toEqual([["notice", why], "resync"])
    }
    // والثوابتُ الثلاثة مكتوبةٌ للمستخدم لا مُضمَرة.
    expect(shell).toContain("كلُّ أداةِ MCP تقف على بوّابة الموافقة")
    expect(shell).toContain("التوصيلُ فعلٌ صريحٌ في كلّ جلسة")
    expect(shell).toContain("لا تضع مفتاحاً في الأمر")
    // ولا وصلَ تلقائيّ ضمنيّ: نداءُ التوصيل في مُعالج نقرةٍ، أو في autoConnectServers لخادمٍ أذن له المستخدم صراحةً مرّةً
    // (autoConnect === true — إضافةُ المتصفّح والموصّلات بعد ربطٍ يدويّ). نداءان بالضبط، والثاني محروسٌ بالعَلَم.
    expect(shell).toContain('sendFrame({ kind: "external-connect"')
    expect((shell.match(/kind: "external-connect"/gu) ?? []).length).toBe(2)
    expect(shell).toMatch(/const autoConnectServers = \(\) => \{[\s\S]*?server\.autoConnect !== true[\s\S]*?kind: "external-connect"/u)
  })

  // ⚠ قاعدةُ المالك: «الوحيدُ الثابت شاشةُ المحادثات». والمقيس (2026-09-04)
  // أنّ نقرةً واحدة على ⤢ في لوح المتصفّح كانت تضيف `body.paneexpanded`،
  // وقاعدةٌ في الورقة تُخفي عمودَ المحادثة — **ومعه ترويستُه التي تسكنها أزرارُ
  // الألواح كلُّها**، فلا يبقى طريقُ عودةٍ إلا الزرُّ نفسُه داخل لوحٍ ملءَ
  // الشاشة. قاعدةٌ حاكمةٌ تُحرَس في الورقة، لا في نيّة كاتبها.
  test("لا قاعدةَ في الورقة تُخفي عمودَ المحادثة — الثابتُ الوحيد", () => {
    // التعليقاتُ تُنزع أوّلاً: تعليقٌ يشرح القاعدةَ يذكر اسمَ العمود، ويقع في
    // الكتلة نفسِها بعد القسمة على `}` — فيتّهم الحارسُ التوثيقَ الذي يحرسه.
    // (وقع فعلاً عند كتابة هذا الفحص.)
    const style = shell.slice(shell.indexOf("<style>"), shell.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, " ")
    const rules = style.split("}")
    const hiding = rules.filter((rule) => /#chatcolumn(?![-\w])/.test(rule) && /display:\s*none/.test(rule))
    expect(hiding).toEqual([])
    // التوأمُ الإيجابيّ: الماسحُ يمسك `display: none` فعلاً حيث توجد — وإلّا
    // كانت القائمةُ الفارغةُ تعني «لم يُفحص شيء».
    expect(rules.filter((rule) => /display:\s*none/.test(rule)).length).toBeGreaterThan(3)
    expect(rules.some((rule) => /#chatcolumn(?![-\w])/.test(rule))).toBe(true)
  })

  // ⚠ اصطدامُ اسمٍ مقيسٌ حيّاً (2026-09-04): مقبضُ تغيير الارتفاع سُمّي
  // `class="dock-resize block"`، و`.block` هو صنفُ **فقاعة المحادثة** (حدٌّ
  // ونصفُ قطرٍ 14 وحشوةٌ 12/16 وmax-width 780). فورث المقبضُ الفقاعةَ وصار
  // 33×25 بدل شريطٍ بعرض اللوح وارتفاع 6 — والورقةُ لا تشكو، والمُحلِّلُ
  // النحويّ لا يرى. الأسماءُ العامّةُ تصطدم بصمت، فتُمنع في البنية الساكنة.
  test("لا عنصرَ ساكنٌ يستعير اسمَ صنفِ فقاعة المحادثة", () => {
    const used = [...shell.matchAll(/class="([^"]+)"/g)].map((match) => match[1]!)
    // التوأمُ الإيجابيّ: البنيةُ فيها أصنافٌ فعلاً — وإلّا مرّ الفحصُ فارغاً.
    expect(used.length).toBeGreaterThan(20)
    for (const value of used) expect(value.split(/\s+/)).not.toContain("block")
    // وفقاعةُ المحادثة نفسُها تُبنى في الجافاسكربت، فبقاؤها مضمون.
    expect(shell).toContain('className = "block')
  })

  test("كايرو محليٌّ بوزنيه، ولا رابطَ خطٍّ خارجيّ في الصفحة", () => {
    expect(shell).toContain('@font-face')
    expect(shell).toContain('url("fonts/Cairo-Regular.ttf")')
    expect(shell).toContain('url("fonts/Cairo-Bold.ttf")')
    expect(shell).toContain('font-display: swap')
    // الوجهُ العربيّ أوّلاً ثمّ اللاتينيّ — والرمزُ يبقى ثابتَ العرض.
    expect(shell).toContain('font-family: "Cairo", "Segoe UI", Tahoma, sans-serif')
    expect(shell).toContain("font-family: Consolas, monospace")
    // خطٌّ من شبكةٍ عامّة يحجبه CSP فيسقط النصُّ إلى بديلٍ صامت لا يُرى بالعين.
    expect(shell).not.toContain("fonts.googleapis")
    expect(shell).not.toContain("fonts.gstatic")
  })

  test("ملفّا الخطّ والترخيصُ مشحونةٌ فعلاً — والترخيصُ شرطُ شحنٍ لا زينة", async () => {
    for (const name of ["Cairo-Regular.ttf", "Cairo-Bold.ttf"]) {
      const file = Bun.file(new URL(name, fontDir))
      expect(await file.exists()).toBe(true)
      // التوأمُ الإيجابي: بايتاتُ خطٍّ حقيقيّ (0x00010000)، لا ملفٌّ فارغٌ باسمٍ صحيح.
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
      expect([...head]).toEqual([0x00, 0x01, 0x00, 0x00])
    }
    expect(await Bun.file(new URL("OFL.txt", fontDir)).exists()).toBe(true)
  })

  test("كلُّ شريحةٍ في صفّ المُنشئ تحمل أيقونةً ونصّاً واسماً كاملاً", () => {
    const row = shell.slice(shell.indexOf('<button class="chip" id="pluschip"'), shell.indexOf('<button id="send"'))
    const chips = [...row.matchAll(/<button[^>]*class="chip[^"]*"[^>]*id="(\w+)"[^>]*>(.*?)<\/button>/gsu)]
    expect(chips.length).toBe(5)
    for (const [whole, id, inner] of chips) {
      expect(`${id}:${inner.includes('class="ico"')}`).toBe(`${id}:true`)
      expect(`${id}:${inner.includes('class="lbl"')}`).toBe(`${id}:true`)
      // الانكماشُ بصريٌّ لا دلاليّ: النصُّ الكامل يبقى لقارئ الشاشة.
      expect(`${id}:${/title="[^"]+"/u.test(whole)}`).toBe(`${id}:true`)
      expect(`${id}:${/aria-label="[^"]+"/u.test(whole)}`).toBe(`${id}:true`)
    }
  })

  test("الانكماشُ بحاويةٍ معلَنة — ونسيانُ الإعلان يجعل القاعدةَ لا تشتعل أبداً", () => {
    // الخطرُ الذي سمّته المواصفة: قاعدةٌ تبدو سليمةً في المصدر ولا تعمل قطّ.
    expect(shell).toContain("#composer { container-type: inline-size; container-name: composer; }")
    expect(shell).toContain("@container composer (max-width: 34rem)")
    expect(shell).toContain("#composer .row .chip .lbl { display: none; }")
    // الإرسالُ ليس شريحةً، فلا يُطوى أبداً — يبقى للمستخدم طريقٌ ظاهر.
    expect(shell).toContain('<button id="send"')
    expect(shell).not.toMatch(/<button[^>]*id="send"[^>]*class="chip"/u)
  })

  test("الشريطُ العلويّ: التفافٌ وانكماش، ولا عائمَ فوقه أصلاً", () => {
    const tabs = shell.slice(shell.indexOf("#tabs {"), shell.indexOf("#tabs button.active"))
    expect(tabs).toContain("flex-wrap: wrap")
    // (٣) السببُ الثالث أُزيل لا حُوصر: لم يعد شيءٌ يطفو فوق الشريط، فلا
    // حاجةَ لحجزِ مكانٍ لعائم. `#panetoggle` صار زرَّ أيقونةٍ في الترويسة.
    expect(shell).not.toContain("--panetoggle-reserve")
    expect(shell).not.toMatch(/#panetoggle\s*\{[^}]*position:\s*absolute/u)
    const header = shell.slice(shell.indexOf('<header id="sessionhead">'), shell.indexOf("</header>"))
    expect(header).toContain('id="panetoggle"')
    expect(tabs).toContain("min-width: 0")
    // (١) و(٢): الالتفافُ في الشريطين، والحقلُ ينكمش أوّلاً لأنه الأمرن.
    const bar = shell.slice(shell.indexOf("#browserbar {"), shell.indexOf("#browserbar button:hover"))
    expect(bar).toContain("flex-wrap: wrap")
    expect(bar).toContain("min-width: 0")
    expect(bar).toContain("flex: 1 1 12rem")
  })

  test("الورقةُ منطقيّةٌ بالكامل — صفرُ خاصّيةٍ فيزيائيّة تنكسر بالإنجليزيّة", () => {
    const style = shell.slice(shell.indexOf("<style>"), shell.indexOf("</style>"))
    for (const physical of ["padding-left", "padding-right", "margin-left", "margin-right", "border-left:", "border-right:", "float:", "text-align: right"]) {
      expect(`${physical} count=${style.split(physical).length - 1}`).toBe(`${physical} count=0`)
    }
    // التوأمُ الإيجابي: البدائلُ المنطقيّة مستعمَلةٌ فعلاً، فالصفرُ أعلاه ليس
    // «ورقةٌ بلا اتجاهات» بل «اتجاهاتٌ كلُّها منطقيّة».
    expect(style).toContain("inset-inline")
    expect(style).toContain("padding-inline")
    expect(style).toContain("border-inline-end")
    // والأسهمُ تنعكس مع اللغة بقاعدةٍ واحدة لا برمزين يفترقان.
    expect(style).toContain('html[dir="ltr"] .dirflip')
    expect(shell).toContain('<span class="dirflip">')
  })

  test("نصُّ الشريحة يُكتب في .lbl وحدها — الفخُّ الذي يمحو الأيقونة مغلق", () => {
    expect(shell).toContain("const setChipLabel = (id, text)")
    expect(shell).toContain('const label = chip.querySelector(".lbl")')
    // التوأمُ الإيجابي: هناك مواضعُ كتابةٍ فعلاً وكلُّها عبر المالك الواحد.
    // العددُ ليس ثابتاً — الثابتُ أنّ **لا موضعَ** يكتب على الزرّ رأساً.
    expect((shell.match(/setChipLabel\(/gu) ?? []).length).toBeGreaterThanOrEqual(4)
    // الحارسُ يقيس الشرائحَ ذاتَ الأيقونة وحدها: `#headprojectchip` شريحةُ
    // سياقٍ نصّيّةٌ بلا `.ico`، فالكتابةُ عليها صحيحة. وتضييقُ الحارس هنا
    // بالأسماء لا بالشكل عمداً — قائمةٌ تُقرأ خيرٌ من نمطٍ يصيب البريء.
    const iconChips = ["pluschip", "projectchip", "modechip", "railchip", "modelchip"]
    for (const id of iconChips) {
      const direct = shell.match(new RegExp(`el\\("${id}"\\)\\.textContent\\s*=`, "gu")) ?? []
      expect(`${id} direct writes: ${direct.length}`).toBe(`${id} direct writes: 0`)
      // التوأمُ الإيجابي — وهو ما كان غائباً فمرّ الحارسُ على العدم: يُثبَت أنّ
      // النمط **يطابق فعلاً** حين يوجد ما يطابقه. بلا هذا السطر كان الهروبُ
      // الضائع يجعل التعبير `el("id").textContents*=` فلا يصيب شيئاً أبداً.
      const canary = `el("${id}").textContent = "x"`
      expect(canary.match(new RegExp(`el\\("${id}"\\)\\.textContent\\s*=`, "gu"))).not.toBeNull()
    }
    // ولا موضعَ يكتب على الزرّ رأساً فيمحو عقدةَ الأيقونة معه.
    expect(shell).not.toMatch(/el\("modechip"\)\.textContent\s*=/u)
    expect(shell).not.toMatch(/el\("modelchip"\)\.textContent\s*=/u)
    expect(shell).not.toMatch(/chip\.textContent = MODE_AR/u)
  })

  test("أزرارُ المتصفّح تفقد نصَّها لا وظيفتَها عند الضيق", () => {
    expect(shell).toContain("@container browserbar (max-width: 30rem)")
    expect(shell).toContain("#browserbar button .lbl { display: none; }")
    for (const id of ["browsergo", "browserread", "browserclose"]) {
      const button = shell.slice(shell.indexOf(`<button id="${id}"`), shell.indexOf("</button>", shell.indexOf(`<button id="${id}"`)))
      expect(`${id}:${button.includes('class="ico"')}`).toBe(`${id}:true`)
      expect(`${id}:${button.includes('class="lbl"')}`).toBe(`${id}:true`)
      expect(`${id}:${/aria-label="[^"]+"/u.test(button)}`).toBe(`${id}:true`)
    }
  })

  test("سُلَّمُ الخطّ في :root وحده — صفرُ حجمِ خطٍّ حرفيّ في الورقة", () => {
    const style = shell.slice(shell.indexOf("<style>"), shell.indexOf("</style>"))
    // صفرُ بكسلٍ حرفيّ: القاعدةُ التي تجعل الضبطَ في موضعٍ واحد.
    expect(style.match(/font-size:\s*[\d.]+px/gu)).toBeNull()
    // والتوأمُ الإيجابي، مصوغاً كثابتٍ لا كعدد: **كلُّ** إعلانِ حجمٍ في
    // الورقة يمرّ بالسُّلَّم. عددٌ حرفيٌّ هنا كان سيحمرّ مع أوّل قاعدةٍ جديدة
    // ويُعلّم القارئ أن يرفع الرقم بدل أن يسأل لماذا تغيّر.
    const all = style.match(/font-size:/gu) ?? []
    const uses = style.match(/font-size:\s*var\(--fs-[a-z0-9-]+\)/gu) ?? []
    expect(all.length).toBeGreaterThanOrEqual(62)
    expect(`through the scale: ${uses.length}/${all.length}`).toBe(`through the scale: ${all.length}/${all.length}`)
    // بالـrem لا بالبكسل: `uiScale` يُطبَّق كـroot font-size، فتوكنٌ بالبكسل
    // كان سيعيد إنتاج العطل نفسِه ويبدو مُصلَحاً في المصدر.
    const root = style.slice(style.indexOf(":root {"), style.indexOf("[data-theme=\"dark\"]"))
    const tokens = root.match(/--fs-[a-z0-9-]+:\s*[\d.]+rem;/gu) ?? []
    expect(tokens.length).toBe(14)
    expect(root).not.toMatch(/--fs-[a-z0-9-]+:\s*[\d.]+px/u)
    // وكلُّ توكنٍ يُستعمل: سُلَّمٌ فيه درجةٌ لا يقف عليها أحد ليس سُلَّماً.
    for (const token of tokens) {
      const name = token.slice(0, token.indexOf(":"))
      expect(`${name} used=${style.includes(`var(${name})`)}`).toBe(`${name} used=true`)
    }
  })

  test("وحدةُ القشرة تُحلَّل فعلاً — خطأُ صياغةٍ فيها يُعطّل المنتَج كلَّه بصمت", () => {
    // قيس 2026-09-03: هروبٌ ضاع في التحرير حوّل "\n" إلى سطرٍ حقيقيّ داخل
    // نصٍّ، فما عاد `<script type="module">` يُحلَّل. والوحدةُ التي لا تُحلَّل
    // **لا تعمل إطلاقاً** ولا تكتب خطأً يراه المستخدم: القشرةُ تُرسم ولا يستجيب
    // فيها زرّ. لا تُكتشف بمراجعةٍ تقرأ، فتُحلَّل هنا بمحلّلٍ حقيقيّ.
    const open = shell.indexOf('<script type="module">')
    expect(open).toBeGreaterThan(0)
    const body = shell.slice(open + '<script type="module">'.length, shell.indexOf("</script>", open))
    expect(body.length).toBeGreaterThan(10_000)
    const source = body.replace(/^\s*import .*$/gmu, "")
    // `scan` يحلّل الوحدة ويرمي على خطأ الصياغة — حكمٌ من محلّلٍ لا من نظرة.
    expect(() => new Bun.Transpiler({ loader: "js" }).scan(source)).not.toThrow()
  })

  test("المزوّدُ المخصّص يصل قوائمَ القشرة — والحزمةُ المولَّدة لا تحمله أبداً", () => {
    // `providers.js` مولَّدةٌ من الكتالوج وحده (أربعةَ عشرَ صفّاً مُجمَّداً)،
    // فمزوّدٌ يسجّله المالك لا يمكن أن يصلها. العطلُ كان صامتاً تماماً:
    // التسجيلُ ينجح، والصفُّ لا يظهر في منتقٍ ولا في بطاقةِ مفتاح.
    expect(shell).toContain("const shellProviders = () =>")
    expect(shell).toContain("runtimeSettings.customProviders || []")
    // وكلا القارئين يقرأ المدموج لا الحزمةَ رأساً — وإلا بقي أحدهما أعمى.
    expect(shell).toContain("for (const p of shellProviders()) {")
    expect(shell).toContain("for (const p of shellProviders().filter((x) => !x.local)) {")
    expect(shell.match(/for \(const p of Providers\.PROVIDERS/gu)).toBeNull()
    // ويُقال إنه مخصّص: صفٌّ لا يُميَّز يجعل المالك يتوقّع نماذجَ بذرةٍ لا يملكها.
    expect(shell).toContain("مزوّدٌ مخصّص · ")
  })
})
