/**
 * المنحُ الدائمُ المُقيَّد — مُخفِّضٌ نقيٌّ يُقاس وحده.
 *
 * الخطرُ الذي يحرسه هذا الملفّ: منحٌ يتّسع أكثرَ ممّا قاله المشغّل. فأكثرُ
 * الفحوص هنا **سلبيّة بقصد**: منحُ `read` لا يفتح `command`، ومنحُ `drive.`
 * لا يفتح `drive2.`، والنقطةُ وحدها لا تُقبل نطاقاً.
 */
import { describe, expect, test } from "bun:test"
import { covers, describeTarget, empty, grant, list, MAX_GRANTS, revoke, usedLine } from "../src/standing-grants"

const tool = (name: string) => ({ kind: "tool" as const, name })
const ns = (prefix: string) => ({ kind: "namespace" as const, prefix })

describe("المنحُ المُقيَّد — ما يغطّيه وما لا يغطّيه", () => {
  test("المنحُ يغطّي هدفَه وصنفَه معاً، ولا يعبر إلى صنفٍ آخر", () => {
    const state = grant(empty(), { target: tool("drive.list"), request: "read" }).state
    expect(covers(state, "drive.list", "read")).toBeDefined()
    // ⚠ الصنفُ جزءُ الإذن: منحُ القراءة لا يمنح التنفيذ ولو على الأداة نفسِها.
    expect(covers(state, "drive.list", "command")).toBeUndefined()
    expect(covers(state, "drive.list", "edit")).toBeUndefined()
    // ولا يعبر إلى أداةٍ أخرى ولو تشابه الاسم.
    expect(covers(state, "drive.listAll", "read")).toBeUndefined()
    expect(covers(state, "drive.delete", "read")).toBeUndefined()
  })

  test("نطاقُ المزوّد يغطّي أدواتِه وحدها — ولا يتسرّب إلى جارٍ يشبه اسمُه", () => {
    const state = grant(empty(), { target: ns("drive."), request: "command" }).state
    expect(covers(state, "drive.list", "command")).toBeDefined()
    expect(covers(state, "drive.upload", "command")).toBeDefined()
    // ⚠ الفخُّ: `drive2.` تبدأ بـ`drive` لكنّها ليست `drive.` — والبادئةُ
    // بنقطتها هي ما يمنع التسرّب.
    expect(covers(state, "drive2.list", "command")).toBeUndefined()
    expect(covers(state, "drivex.list", "command")).toBeUndefined()
    expect(covers(state, "mail.list", "command")).toBeUndefined()
  })

  test("لا منحَ عامّ: النقطةُ وحدها والبادئةُ بلا نقطةٍ تُرفضان مسمّاتين", () => {
    for (const bad of [".", "", "*", "drive", "drive.*"]) {
      const outcome = grant(empty(), { target: ns(bad), request: "command" })
      expect(`${JSON.stringify(bad)}: ${outcome.refused !== undefined}`).toBe(`${JSON.stringify(bad)}: true`)
      // والحالةُ لم تُمسّ: لا أثرَ جزئيّ في سجلّ أذونات.
      expect(outcome.state.grants).toEqual([])
    }
    expect(grant(empty(), { target: tool("has space"), request: "read" }).refused).toBeDefined()
  })

  test("التكرارُ يُبتلع بلا رفض، والسقفُ يُرفض مسمّى", () => {
    const once = grant(empty(), { target: tool("a.b"), request: "read" }).state
    const twice = grant(once, { target: tool("a.b"), request: "read" })
    expect(twice.refused).toBeUndefined()
    expect(twice.state.grants).toHaveLength(1)

    let full = empty()
    for (let i = 0; i < MAX_GRANTS; i += 1) full = grant(full, { target: tool(`t${i}`), request: "read" }).state
    expect(full.grants).toHaveLength(MAX_GRANTS)
    const over = grant(full, { target: tool("one-more"), request: "read" })
    expect(over.refused).toContain(String(MAX_GRANTS))
    expect(over.state.grants).toHaveLength(MAX_GRANTS)
  })

  test("النقضُ يزيل المنحَ المسمّى وحده، والغائبُ لا يُخترع", () => {
    let state = grant(empty(), { target: tool("a.b"), request: "read" }).state
    state = grant(state, { target: ns("drive."), request: "command" }).state
    expect(state.grants).toHaveLength(2)
    state = revoke(state, "read", "a.b")
    expect(covers(state, "a.b", "read")).toBeUndefined()
    expect(covers(state, "drive.x", "command")).toBeDefined()
    // نقضُ ما ليس موجوداً لا يغيّر شيئاً ولا يرمي.
    expect(revoke(state, "read", "لا-شيء").grants).toHaveLength(1)
    // ونقضٌ بصنفٍ مختلفٍ لا يصيب المنحَ القائم.
    expect(revoke(state, "read", "drive.*").grants).toHaveLength(1)
  })

  test("العرضُ ثابتُ الترتيب، والإعلانُ يسمّي الإذنَ الذي مرّ به النداء", () => {
    let state = grant(empty(), { target: ns("mail."), request: "network" }).state
    state = grant(state, { target: tool("a.b"), request: "read" }).state
    expect(list(state)).toEqual([
      { request: "network", target: "mail.*" },
      { request: "read", target: "a.b" },
    ])
    expect(describeTarget(ns("drive."))).toBe("drive.*")
    const line = usedLine("drive.upload", { target: ns("drive."), request: "command" })
    expect(line).toContain("drive.upload")
    expect(line).toContain("drive.*")
    expect(line).toContain("command")
  })
})
