/**
 * دفترٌ تالفٌ لا يُسقط المحرّك — ولكلّ عزلٍ توأمُه: عطلٌ غيرُ معروفٍ يُرفع كما هو.
 *
 * مقيسٌ حيّاً على تثبيتٍ قائم: نافذةُ التطبيق مفتوحةٌ ولا محرّكَ خلفها،
 * لأنّ قراءةَ دفتر serve سقطت بـSQLITE_CORRUPT. ثمّ سقطت ثانيةً بفجوةِ تسلسلٍ بعد الإنقاذ.
 */
import { describe, expect, test } from "bun:test"
import { companionFiles, ledgerUnreadable, quarantineName, quarantineNotice } from "../src/ledger-quarantine"

describe("ما يعني «الدفترُ لا يُقرأ»", () => {
  test("الأشكالُ المقيسةُ حيّاً تُعرف", () => {
    expect(ledgerUnreadable(new Error("database disk image is malformed"))).toBeDefined()
    expect(ledgerUnreadable(new Error("serve_output_sequence_gap:3->8"))).toBeDefined()
    const sqlite = Object.assign(new Error("database disk image is malformed"), { name: "SQLiteError", code: "SQLITE_CORRUPT" })
    expect(ledgerUnreadable(sqlite)).toContain("malformed")
  })

  test("وأشكالٌ أخرى معروفةٌ للملفّ التالف", () => {
    for (const message of ["file is not a database", "no such table: events", "malformed database schema"]) {
      expect(ledgerUnreadable(new Error(message)), message).toBeDefined()
    }
  })

  test("🔴 والتوأمُ: عطلٌ غيرُ معروفٍ لا يُبتلع — حارسٌ يبتلع كلَّ خطأٍ يمحو تاريخاً بلا سبب", () => {
    expect(ledgerUnreadable(new Error("ENOSPC: no space left on device"))).toBeUndefined()
    expect(ledgerUnreadable(new Error("permission denied"))).toBeUndefined()
    expect(ledgerUnreadable(new TypeError("undefined is not a function"))).toBeUndefined()
    expect(ledgerUnreadable("something odd")).toBeUndefined()
  })

  test("والسببُ يُنقل إلى الإيصال مقصوصاً لا مطويّاً", () => {
    const why = ledgerUnreadable(new Error(`database disk image is malformed ${"x".repeat(400)}`))!
    expect(why.length).toBeLessThanOrEqual(200)
    expect(why).toContain("malformed")
  })
})

describe("العزلُ لا يحذف", () => {
  test("الاسمُ بجانب الدفتر ومؤرَّخٌ بالثانية", () => {
    const at = new Date(2026, 8, 24, 19, 30, 55)
    expect(quarantineName("/state/abdocode-events.sqlite", at)).toBe("/state/abdocode-events.sqlite.unreadable-20260924-193055")
  })

  test("🔴 وعزلانِ في دقيقتَين مختلفتَين لا يتدافعان", () => {
    const a = quarantineName("db.sqlite", new Date(2026, 8, 24, 19, 30, 55))
    const b = quarantineName("db.sqlite", new Date(2026, 8, 24, 19, 31, 2))
    expect(a).not.toBe(b)
  })

  test("🔴 والمصاحباتُ تُعزل معه — وإلّا أعاد WAL التلفَ إلى دفترٍ جديد", () => {
    expect(companionFiles("db.sqlite")).toEqual(["db.sqlite-wal", "db.sqlite-shm", "db.sqlite-journal"])
  })
})

describe("الإيصال يقول ما جرى وما لم يجرِ", () => {
  test("يسمّي الملفَّ المعزول والسبب، ويطمئن على ما لم يُمسّ", () => {
    const line = quarantineNotice("db.sqlite.unreadable-20260924-193055", "SQLiteError: malformed")
    expect(line).toContain("db.sqlite.unreadable-20260924-193055")
    expect(line).toContain("malformed")
    expect(line).toContain("لم يُحذف")
    expect(line).toContain("الخزنةُ")
  })
})
