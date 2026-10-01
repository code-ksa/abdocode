import { expect, test } from "bun:test"
import { syncCustomProviders } from "../src/index"

const nim = "https://integrate.api.nvidia.com/v1"
const nvidia2 = { id: "nvidia2", label: "NVIDIA (vision key)", baseUrl: nim, vaultKey: "custom-nvidia2-api-key", local: false, models: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"] }

// 09-29 (مقيس على تطبيق المالك): مدخلٌ قديم بعنوان NIM نفسِه أسقط القائمةَ كلَّها بصمت — الرفضُ يسمّي المدخلَ وما يكرّره.
test("the same endpoint with the same handle refuses the whole list and names the entry and the clash", () => {
  const refusals = syncCustomProviders([nvidia2, { ...nvidia2, id: "ddd", label: "ddd", models: ["x"] }] as never, { dryRun: true })
  expect(refusals).toHaveLength(1)
  expect(refusals[0]).toContain("«ddd» يكرّر عنوانَ nvidia2 بالمقبض نفسِه")
  expect(refusals[0]).toContain("القائمةُ كلُّها مرفوضة")
  const dupId = syncCustomProviders([nvidia2, { ...nvidia2, baseUrl: "https://other.example.com/v1" }] as never, { dryRun: true })
  expect(dupId[0]).toContain("«nvidia2» يكرّر المعرّف")
  expect(syncCustomProviders([nvidia2] as never, { dryRun: true })).toEqual([])
})

// 10-01 (مقيس في دور compare): مفتاحٌ ثانٍ ثمّ ثالثٌ احتياطيٌّ للمزوّد نفسِه — حسابان على العنوان نفسِه
// بمقبضين مختلفين. الرفضُ القديم أسقط القائمةَ فلم يُحلّ نموذجُ الرؤية nvidia2/nano-omni، وحُفظت لقطتا compare بلا مقارنة.
test("two accounts on one endpoint, each with its own handle, both register", () => {
  const nvidia3 = { id: "nvidia3", label: "NVIDIA (third key — fallback)", baseUrl: nim, vaultKey: "custom-nvidia3-api-key", local: false, models: ["nvidia/nemotron-3-ultra-550b-a55b"] }
  expect(syncCustomProviders([nvidia3, nvidia2] as never, { dryRun: true })).toEqual([])
  expect(syncCustomProviders([nvidia3, nvidia2] as never)).toEqual([])
})
