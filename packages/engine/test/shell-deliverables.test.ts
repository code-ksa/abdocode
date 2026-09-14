import { describe, expect, test } from "bun:test"
import { Deliverables } from "../src/shells/deliverables"
import { locationsFromReceipt } from "../src/tool-locations"

const receipt = (turnId: string, cmd: string, output: string, verdict: unknown) => ({
  kind: "tool-result", turnId, cmd, output, epoch: 1,
  ...(verdict === undefined ? {} : { verdict }),
  ...(verdict === undefined ? {} : { locations: locationsFromReceipt(cmd, output, verdict as never) }),
})

const SERVED = "⚙ الخادم يعمل تحت إدارة النواة: «npm run dev» على http://127.0.0.1:4310 (pid 8123)."

describe("shell deliverables reducer — rows come from the verdict, and a server row dies with its turn", () => {
  test("an ok write becomes a row; the same path written twice stays ONE row — and a skip never erases the write", () => {
    let state = Deliverables.empty()
    state = Deliverables.fold(state, receipt("t1", "write a.ts", "✎ كُتب", { ok: true }))
    expect(Deliverables.render(state)).toEqual([{ glyph: "✎", label: "a.ts", badge: "" }])
    state = Deliverables.fold(state, receipt("t1", "edit a.ts", "✎ عُدّل", { ok: true }))
    expect(Deliverables.render(state)).toEqual([{ glyph: "✎", label: "a.ts", badge: "" }])
    // «آخرُ حالةٍ تفوز» إلا حين يكون الوافد **نفياً للتغيير**: كان هذا السطر
    // يثبّت العطل نفسه — ملفٌّ كتبه الدورُ للتوّ يُعرض «بلا تغيير» لأن
    // النموذج أعاد إصدار الكتابة نفسها، وهو بالضبط ما وُجد إيصالُ التخطّي له.
    state = Deliverables.fold(state, receipt("t1", "write a.ts", "⏭ a.ts: نفس المحتوى (بصمة x) — تُخطّى، لا كتابةٌ ثانية.", { ok: true }))
    expect(Deliverables.render(state)).toEqual([{ glyph: "✎", label: "a.ts", badge: "" }])
    expect(state.rows).toHaveLength(1)
  })

  test("NO VERDICT, NO ROW — even when the frame carries locations anyway", () => {
    // إطارٌ ملفَّق: مواضعُ حاضرة بلا حكم. الصفّ **لا** يُبنى — فالحقل يشهد
    // له الحكم لا العكس (وإلا صارت اللوحة تدّعي كتابةً لم تُحكم).
    const forged = { kind: "tool-result", turnId: "t1", cmd: "write a.ts", output: "✎", epoch: 1, locations: [{ kind: "file", path: "a.ts", op: "write" }] }
    expect(Deliverables.fold(Deliverables.empty(), forged).rows).toEqual([])
    // وحكمٌ يقول لا: لا صفّ.
    const refused = { ...forged, verdict: { ok: false, reason: "guard_refused", denied: true } }
    expect(Deliverables.fold(Deliverables.empty(), refused).rows).toEqual([])
    // وحكمٌ ok بلا مواضع (toolVerdict مفعَّل، deliverables مطفأ في المحرّك): لا صفّ.
    expect(Deliverables.fold(Deliverables.empty(), { kind: "tool-result", turnId: "t1", cmd: "write a.ts", output: "✎", verdict: { ok: true } }).rows).toEqual([])
  })

  test("a managed server row is live, then flips to «أُوقف» when its own turn ends", () => {
    let state = Deliverables.fold(Deliverables.empty(), receipt("t1", "run npm run dev", SERVED, { ok: true }))
    expect(Deliverables.render(state)).toEqual([{ glyph: "⚙", label: "http://127.0.0.1:4310", badge: "حيّ" }])
    // انتهاءُ دورٍ آخر لا يلمسه.
    expect(Deliverables.fold(state, { kind: "done", turnId: "t2" })).toBe(state)
    for (const ending of ["done", "interrupted", "unresolved"]) {
      const ended = Deliverables.fold(state, { kind: ending, turnId: "t1" })
      expect(Deliverables.render(ended)).toEqual([{ glyph: "⚙", label: "http://127.0.0.1:4310", badge: "أُوقف" }])
      // ولا يُقلب مرتين: الطيّ ثابتٌ بعد أوّل قلب.
      expect(Deliverables.fold(ended, { kind: ending, turnId: "t1" })).toBe(ended)
    }
  })

  test("a browse frame is a url row, deduped by url", () => {
    let state = Deliverables.fold(Deliverables.empty(), { kind: "browse", turnId: "t1", url: "http://localhost:3000/" })
    state = Deliverables.fold(state, { kind: "browse", turnId: "t1", url: "http://localhost:3000/" })
    expect(Deliverables.render(state)).toEqual([{ glyph: "🌐", label: "http://localhost:3000/", badge: "" }])
    expect(Deliverables.fold(state, { kind: "browse", turnId: "t1" })).toBe(state)
  })

  test("a receipt that both wrote and served yields two rows in receipt order", () => {
    const state = Deliverables.fold(Deliverables.empty(), receipt("t1", "write dev.log", `✎ كُتب\n${SERVED}`, { ok: true }))
    expect(Deliverables.render(state)).toEqual([
      { glyph: "✎", label: "dev.log", badge: "" },
      { glyph: "⚙", label: "http://127.0.0.1:4310", badge: "حيّ" },
    ])
  })

  test("malformed location entries are skipped, never rendered as half-rows", () => {
    const frame = {
      kind: "tool-result", turnId: "t1", cmd: "write a.ts", output: "✎", verdict: { ok: true },
      locations: [null, 42, { kind: "file" }, { kind: "file", path: "a.ts", op: "wat" }, { kind: "server" }, { kind: "file", path: "b.ts", op: "edit" }],
    }
    expect(Deliverables.render(Deliverables.fold(Deliverables.empty(), frame)))
      .toEqual([{ glyph: "✎", label: "b.ts", badge: "" }])
  })

  // إيصال «⏭ نفس المحتوى» يقول «لم أكتب ثانيةً» لا «لم يُكتب شيء». وحين
  // يعيد النموذج كتابةً وقعت في هذا الدور نفسه — وهو بالضبط ما وُجد الإيصال
  // له — كان الصفُّ ينقلب «بلا تغيير»، فتقول اللوحة عن ملفٍ أنشأه الدورُ
  // للتوّ إنه لم يتغيّر. نفيُ التغيير لا يمحو تغييراً مشهوداً.
  test("a skipped re-write NEVER downgrades a file this turn already wrote", () => {
    let state = Deliverables.fold(Deliverables.empty(), receipt("t1", "write a.ts", "✎ كُتب a.ts", { ok: true }))
    state = Deliverables.fold(state, receipt("t1", "write a.ts", "⏭ a.ts: نفس المحتوى (بصمة abc) — تُخطّى، لا كتابةٌ ثانية.", { ok: true }))
    expect(Deliverables.render(state)).toEqual([{ glyph: "✎", label: "a.ts", badge: "" }])
    // والاتّجاه الآخر يمرّ كما كان: تخطٍّ أوّلاً ثم كتابةٌ حقيقية = كتابة.
    let other = Deliverables.fold(Deliverables.empty(), receipt("t2", "write b.ts", "⏭ b.ts: نفس المحتوى (بصمة abc) — تُخطّى، لا كتابةٌ ثانية.", { ok: true }))
    expect(Deliverables.render(other)).toEqual([{ glyph: "⏭", label: "b.ts", badge: "بلا تغيير" }])
    other = Deliverables.fold(other, receipt("t2", "write b.ts", "✎ كُتب b.ts", { ok: true }))
    expect(Deliverables.render(other)).toEqual([{ glyph: "✎", label: "b.ts", badge: "" }])
  })

  // مسارُ سقوط الدور ينتهي بـ`refused` لا بـ`done`. بدونه بقي صفُّ الخادم
  // «حيّاً» أبداً — ثم صار ادّعاءً كاذباً صريحاً حين يقتل أوّلُ دورٍ تالٍ
  // كلَّ الخوادم بـ`stopAll()` العامّة وهو ما يزال يعِد برابطٍ ميت.
  test("a turn that DIES flips its server row to «أُوقف» — refused is the fourth terminal frame", () => {
    const live = Deliverables.fold(Deliverables.empty(), receipt("A", "run npm run dev", SERVED, { ok: true }))
    expect(Deliverables.render(live)).toEqual([{ glyph: "⚙", label: "http://127.0.0.1:4310", badge: "حيّ" }])
    const dead = Deliverables.fold(live, { kind: "refused", turnId: "A", why: "فشل الدور A: boom" })
    expect(Deliverables.render(dead)).toEqual([{ glyph: "⚙", label: "http://127.0.0.1:4310", badge: "أُوقف" }])
    // ورفضٌ عامّ بلا دور («نمطٌ غير معروف» وأخواته) لا يقلب شيئاً ولا يكذب.
    expect(Deliverables.fold(live, { kind: "refused", why: "نمطٌ غير معروف" })).toBe(live)
    expect(Deliverables.fold(live, { kind: "refused", turnId: "B", why: "فشل الدور B" })).toBe(live)
  })

  test("unrelated frames leave the state identical", () => {
    const state = Deliverables.fold(Deliverables.empty(), receipt("t1", "write a.ts", "✎", { ok: true }))
    for (const frame of [{ kind: "tool", turnId: "t1", cmd: "write a.ts" }, { kind: "event", turnId: "t1", payload: "📐" }]) {
      expect(Deliverables.fold(state, frame)).toBe(state)
    }
  })
})
