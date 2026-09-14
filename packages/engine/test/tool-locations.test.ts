import { describe, expect, test } from "bun:test"
import type { ToolVerdict } from "@abdo/engine-host"
import { SKIPPED_WRITE_PREFIX, locationsFromReceipt } from "../src/tool-locations"
import * as ToolLocations from "../src/tool-locations"
import { SERVED_URL_RE, distillFact, writeTargetOf } from "../src/turn-memory"

const OK: ToolVerdict = { ok: true }
const REFUSED: ToolVerdict = { ok: false, reason: "guard_refused", denied: true }
const FAILED: ToolVerdict = { ok: false, reason: "nonzero_exit", denied: false }

// نصُّ الخادم المُدار منقولٌ من `managed-server.ts` بشكله الحقيقيّ.
const SERVED = "⚙ الخادم يعمل تحت إدارة النواة: «npm run dev» على http://127.0.0.1:4310 (pid 8123).\nافحصه مباشرة."

describe("tool locations — deliverables come from the verdict, never from prose", () => {
  test("an ok write/edit yields its target with the verb as the op", () => {
    expect(locationsFromReceipt("write app/page.tsx :: <html/>", "✎ كُتب app/page.tsx", OK))
      .toEqual([{ kind: "file", path: "app/page.tsx", op: "write" }])
    expect(locationsFromReceipt("edit app/page.tsx", "✎ عُدّل", OK))
      .toEqual([{ kind: "file", path: "app/page.tsx", op: "edit" }])
  })

  test("the skip receipt is its own op — a file that did not change is not a new deliverable", () => {
    const output = `${SKIPPED_WRITE_PREFIX}app/page.tsx: نفس المحتوى (بصمة ab12) — تُخطّى، لا كتابةٌ ثانية.`
    expect(locationsFromReceipt("write app/page.tsx", output, OK))
      .toEqual([{ kind: "file", path: "app/page.tsx", op: "skipped" }])
    expect(SKIPPED_WRITE_PREFIX).toBe("⏭ ")
  })

  test("ABSENCE IS REFUSAL: no verdict, a refusal, or a failure yields nothing at all", () => {
    const looksSuccessful = "✎ كُتب app/page.tsx بنجاح"
    // إيصالٌ يبدو ناجحاً تماماً — ومع ذلك لا مُسلَّم بلا حكم. هذا هو الفرق
    // كلّه عن لوحة النشاط التي تستنتج من النصّ.
    expect(locationsFromReceipt("write app/page.tsx", looksSuccessful, undefined)).toEqual([])
    expect(locationsFromReceipt("write app/page.tsx", looksSuccessful, REFUSED)).toEqual([])
    expect(locationsFromReceipt("write app/page.tsx", looksSuccessful, FAILED)).toEqual([])
    // وحتى سطر الخادم الصريح لا يمرّ بلا حكم.
    expect(locationsFromReceipt("run npm run dev", SERVED, undefined)).toEqual([])
    expect(locationsFromReceipt("run npm run dev", SERVED, REFUSED)).toEqual([])
  })

  test("a managed server URL is a location for ANY command whose verdict is ok", () => {
    expect(locationsFromReceipt("run npm run dev", SERVED, OK))
      .toEqual([{ kind: "server", url: "http://127.0.0.1:4310" }])
    // كتابةٌ رفعت خادماً تعطي الاثنين معاً.
    expect(locationsFromReceipt("write dev.log", `✎ كُتب\n${SERVED}`, OK)).toEqual([
      { kind: "file", path: "dev.log", op: "write" },
      { kind: "server", url: "http://127.0.0.1:4310" },
    ])
  })

  test("ONE VOCABULARY: the very same regex and the very same parse as turn-memory (identity, not likeness)", async () => {
    // لا نظير: المصدر نفسه. تعبيرٌ ثانٍ مكتوبٌ بيدٍ كان سيفترق أوّلَ مرّةٍ
    // يتغيّر نصّ `managed-server.ts` — ويظلّ الاختباران أخضرَين وهما يفترقان.
    const moduleSource = await Bun.file(new URL("../src/tool-locations.ts", import.meta.url)).text()
    expect(moduleSource).toContain('import { SERVED_URL_RE, writeTargetOf } from "./turn-memory"')
    expect(moduleSource).not.toContain("تحت إدارة النواة")
    expect(moduleSource).not.toContain("127\\.0\\.0\\.1")
    expect(moduleSource).not.toContain('replace(/^(?:write|edit)')
    expect(Object.keys(ToolLocations)).toContain("locationsFromReceipt")
    expect(SERVED_URL_RE.exec(SERVED)?.[1]).toBe("http://127.0.0.1:4310")
    expect(writeTargetOf("write app/page.tsx :: x")).toBe("app/page.tsx")
    // والدليل السلوكيّ على الهويّة: ما يقطّره turn-memory هو ما يسمّيه الموضع.
    const fact = distillFact("write app/page.tsx :: x", "✎ كُتب", OK)
    expect(fact).toMatchObject({ key: "wrote:app/page.tsx" })
    const [located] = locationsFromReceipt("write app/page.tsx :: x", "✎ كُتب", OK)
    expect(`wrote:${(located as { path: string }).path}`).toBe(fact!.key)
    const served = distillFact("run npm run dev", SERVED, OK)
    expect(served).toMatchObject({ key: "server:url", value: "الخادم المُدار يعمل على http://127.0.0.1:4310" })
  })

  // الصيغةُ المقبولة بلا فراغٍ قبل الفاصل: مُحلّل `edit` في cli.ts يقطع على
  // `"::"` عارياً، فالهدف الحقيقيّ `app/page.tsx`. وكان الفاصلُ هنا
  // `/\s+::/` فيُسمّى الصفُّ `app/page.tsx::old` — مساراً لم يُكتب ولا وجود
  // له، ويُشوَّه معه مفتاحُ الذاكرة `wrote:<ملف>` الذي يشترك في المُشتقّ نفسه.
  test("the UNSPACED edit form names the file that was really written, not «file::old»", () => {
    expect(writeTargetOf("edit app/page.tsx::old => new")).toBe("app/page.tsx")
    expect(locationsFromReceipt("edit app/page.tsx::old => new", "✍ ok", OK))
      .toEqual([{ kind: "file", path: "app/page.tsx", op: "edit" }])
    // والمفتاحُ الدائم يتبعه — مفردةٌ واحدة لا اثنتان.
    expect(distillFact("edit app/page.tsx::old => new", "✍ app/page.tsx — كتابة ذرّية", OK))
      .toMatchObject({ key: "wrote:app/page.tsx" })
    // والصيغةُ المتباعدة كما كانت، بلا انحدار.
    expect(writeTargetOf("edit app/page.tsx :: old => new")).toBe("app/page.tsx")
  })

  test("a command that touches nothing, and a write with no target, yield nothing", () => {
    expect(locationsFromReceipt("read app/page.tsx", "…محتوى…", OK)).toEqual([])
    expect(locationsFromReceipt("run npm test", "12 pass", OK)).toEqual([])
    expect(locationsFromReceipt("write", "✎", OK)).toEqual([])
    expect(locationsFromReceipt("", "", OK)).toEqual([])
  })

  test("the regex is stateless: repeated calls on the same output do not drift", () => {
    for (let i = 0; i < 3; i++) {
      expect(locationsFromReceipt("run npm run dev", SERVED, OK))
        .toEqual([{ kind: "server", url: "http://127.0.0.1:4310" }])
    }
  })
})
