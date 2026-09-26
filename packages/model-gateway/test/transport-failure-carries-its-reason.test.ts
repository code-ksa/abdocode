import { describe, expect, test } from "bun:test"
import { classifyModelFailure } from "../src/index"

/**
 * 🔴 **مِصنَفٌ يبتلع السببَ يحوّل كلَّ الأعطال إلى عطلٍ واحدٍ لا يُشخَّص.**
 *
 * كان كلُّ خطأٍ بلا حالةِ HTTP يعود بعبارةٍ واحدة — انقطاعُ اسمٍ، أو تفاوضُ TLS،
 * أو مهلةٌ، أو خروجُ العامل: كلُّها «transport failed before response».
 *
 * وقِيس على ليلتَي مسحٍ كاملتَين: ستُّ إلى تسعِ سقطاتٍ في الجولة الواحدة أبطلت خمسَ
 * جولات. **وفي الوقت نفسِه** نجحت عشرةُ نداءاتٍ متوازيةٍ بـ`fetch` إلى المزوّد
 * نفسِه (10/10، ~1.5ث لكلٍّ) — فالعطلُ في طريقنا لا في الشبكة، ولم يكن في السجلّ
 * ما يدلّ عليه. وهو الدرسُ نفسُه الذي دفعناه في حلقة الوصل بالمتصفّح.
 */
describe("a transport failure says why", () => {
  test("the underlying message is carried, and the classification does not change", () => {
    const failure = classifyModelFailure({ error: new Error("ECONNRESET: socket hang up") })
    expect(failure.kind).toBe("transport")
    expect(failure.retry).toBe("bounded-backoff")
    expect(failure.reason).toContain("ECONNRESET")
    expect(failure.reason).toContain("transport failed before response")
  })

  test("a long or ragged message is trimmed to one line, never dropped", () => {
    const noisy = new Error(`  fetch failed\n\n  caused by:  ${"x".repeat(400)}  `)
    const failure = classifyModelFailure({ error: noisy })
    expect(failure.reason).toContain("fetch failed caused by:")
    expect(failure.reason.includes("\n")).toBe(false)
    expect(failure.reason.length).toBeLessThan(230)
  })

  test("AN EMPTY ERROR KEEPS THE OLD WORDING (the negative twin): no dangling colon", () => {
    for (const empty of [undefined, null, "", new Error("")]) {
      const failure = classifyModelFailure({ error: empty })
      expect(failure.reason).toBe("transport failed before response")
      expect(failure.kind).toBe("transport")
    }
  })

  test("the other verdicts are untouched: a cancel, a credential and a status still classify as before", () => {
    const cancelled = classifyModelFailure({ error: new DOMException("aborted", "AbortError") })
    expect(cancelled.kind).toBe("cancelled")
    const credential = classifyModelFailure({ error: new Error("provider credential unavailable") })
    expect(credential.kind).toBe("credential")
    expect(classifyModelFailure({ error: new Error("x"), status: 401 }).kind).toBe("credential")
    expect(classifyModelFailure({ error: new Error("x"), status: 413 }).kind).toBe("context-limit")
    // وردٌّ بدأ لا يُعاد تلقائيّاً مهما كان سببُه.
    expect(classifyModelFailure({ error: new Error("x"), responseStarted: true }).retry).toBe("never")
  })
})
