import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFileIntent } from "@abdo/semantic"

// قائمتان لفعلٍ واحد تتباعدان بصمت (أغلى صنف عيب عندنا): مسارُ الوكيل يعرف «استكمل مشروع X» في
// `@abdo/providers` (`PROJECT_INTENT`)، والإطارُ الدلاليّ يعرفه في `@abdo/semantic` (`resume`/`open`).
// هذا الفحصُ يقرأ التعبيرَ من مصدره — لا من نسخةٍ محفوظة — ويمرّر كلَّ فعلٍ فيه من المحرّك الدلاليّ:
// فعلُ متابعةٍ أو فتحٍ يتبعه «مشروع رودود» يجب أن يخرج فعلاً معروفاً ونوعَ مشروعٍ وهدفَ «رودود».

const ROUTING = resolve(import.meta.dir, "../../providers/src/routing.ts")

function projectIntentVerbs(): string[] {
  const src = readFileSync(ROUTING, "utf8")
  const m = /const PROJECT_INTENT = \/\(\?<!\\p\{L\}\)\(\?:([^)]+)\)/u.exec(src)
  if (m === null) throw new Error("PROJECT_INTENT alternation not found in routing.ts — the twin moved; realign this test")
  return m[1]!.split("|").map((v) => v.replace(/\\s\+/gu, " ").trim())
}

test("every verb in providers' PROJECT_INTENT is understood by the semantic frame as resume/open on a project", () => {
  const verbs = projectIntentVerbs()
  // توأمٌ إيجابيّ: الاستخراجُ أمسك بقائمةٍ حقيقية لا بفراغ.
  expect(verbs.length).toBeGreaterThanOrEqual(10)
  expect(verbs).toContain("استكمل")
  const misses: string[] = []
  for (const verb of verbs) {
    // «ارجع ل» يلتصق بالاسم: «ارجع لمشروع رودود»؛ الباقي يفصله فراغ.
    const text = verb.endsWith(" ل") ? `${verb}مشروع رودود` : `${verb} مشروع رودود`
    const i = parseFileIntent(text)
    if (!(["resume", "open"].includes(i.action) && i.kind === "project" && i.target === "رودود")) misses.push(`${verb} ⇦ ${i.action}/${i.kind}/${i.target ?? "—"}`)
  }
  expect(misses, "verbs the semantic frame does not understand:\n" + misses.join("\n")).toEqual([])
})
