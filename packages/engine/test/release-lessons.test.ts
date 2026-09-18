import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applyReleaseLessons, parseReleaseLessons, releaseLessonsLine, type ReleaseLessonsIo } from "../src/release-lessons"
import { parseGeneralStore } from "../src/general-awareness"

// ت1 — دروسُ الإصدار المراجَعة تُرقّى مرّةً لكلّ إصدار بقاعدة الترقية نفسِها: الصنفُ المغلق، الحجبُ، لا هويّةَ مشروع؛ مخزنٌ لا يُقرأ لا يُدهس.

const io = (over: Partial<ReleaseLessonsIo> & { shipped?: string; applied?: string; store?: string }) => {
  const writes: { applied?: string; store?: string } = {}
  const base: ReleaseLessonsIo = {
    readShipped: () => over.shipped,
    readApplied: () => over.applied,
    writeApplied: (t) => { writes.applied = t },
    readStore: () => over.store,
    writeStore: (t) => { writes.store = t },
    now: () => 1_789_400_000_000,
  }
  return { io: { ...base, ...over }, writes }
}
const doc = (lessons: object[], version = "4.0.32") => JSON.stringify({ version, lessons })

describe("release lessons", () => {
  test("الملفُّ المشحون مع المستودع صالحٌ وكلُّ درسٍ من صنفٍ مغلق", () => {
    const shipped = readFileSync(join(import.meta.dir, "..", "release-lessons.json"), "utf8")
    const parsed = parseReleaseLessons(shipped)
    expect("why" in parsed).toBe(false)
    if ("why" in parsed) return
    expect(parsed.lessons.length).toBeGreaterThanOrEqual(4)
    for (const l of parsed.lessons) expect(["playbook", "package_pattern", "env_trap"]).toContain(l.cls)
    const { io: i, writes } = io({ shipped })
    const r = applyReleaseLessons(i)
    expect(r.status).toBe("applied")
    if (r.status !== "applied") return
    expect(r.promoted).toBe(parsed.lessons.length)
    expect(r.refused).toEqual([])
    expect(parseGeneralStore(writes.store!).lessons.length).toBe(parsed.lessons.length)
  })
  test("غيابُ الملفّ = absent بلا كتابة؛ الإصدارُ المطبَّق لا يُعاد", () => {
    const a = io({})
    expect(applyReleaseLessons(a.io).status).toBe("absent")
    expect(a.writes).toEqual({})
    const b = io({ shipped: doc([{ cls: "env_trap", text: "درسٌ مقيسٌ من الإصدار الجديد" }]), applied: JSON.stringify({ version: "4.0.32" }) })
    expect(applyReleaseLessons(b.io)).toEqual({ status: "already-applied", version: "4.0.32" })
    expect(b.writes).toEqual({})
  })
  test("صنفٌ حرّ أو هويّةُ مشروع أو سرٌّ يُرفض باسمه — والباقي يُرقّى", () => {
    const { io: i, writes } = io({ shipped: doc([
      { cls: "opinion", text: "رأيٌ بلا صنفٍ مغلق" },
      { cls: "env_trap", text: "درسٌ صالحٌ عن سطح المكتب: لا تخمّن عنوانَ النافذة، اقرأ desk windows أوّلاً" },
    ]) })
    const r = applyReleaseLessons(i)
    expect(r.status).toBe("applied")
    if (r.status !== "applied") return
    expect(r.promoted).toBe(1)
    expect(r.refused.length).toBe(1)
    expect(r.refused[0]).toContain("رُفضت الترقية")
    expect(JSON.parse(writes.applied!).version).toBe("4.0.32")
  })
  test("مخزنٌ لا يُقرأ لا يُدهس", () => {
    const { io: i, writes } = io({ shipped: doc([{ cls: "env_trap", text: "درسٌ صالحٌ طويلٌ بما يكفي" }]), store: "{not json" })
    const r = applyReleaseLessons(i)
    expect(r.status).toBe("store-unreadable")
    expect(writes).toEqual({})
  })
  test("الشكلُ المشوَّه يُسمّى", () => {
    expect(applyReleaseLessons(io({ shipped: "{}" }).io)).toEqual({ status: "invalid", why: "version غائبٌ أو مشوَّه" })
    expect(releaseLessonsLine({ status: "applied", version: "4.0.32", promoted: 3, refused: [], changed: true })).toContain("رُقّي 3")
    expect(releaseLessonsLine({ status: "absent" })).toBeUndefined()
  })
})
