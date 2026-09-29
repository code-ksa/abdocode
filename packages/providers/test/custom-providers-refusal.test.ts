import { expect, test } from "bun:test"
import { syncCustomProviders } from "../src/index"

// 09-29 (مقيس على تطبيق المالك): مدخلٌ قديم بعنوان NIM نفسِه أسقط القائمةَ كلَّها بصمت — الرفضُ يسمّي المدخلَ وما يكرّره.
test("a duplicate endpoint refuses the whole list and names the entry and the clash", () => {
  const nim = "https://integrate.api.nvidia.com/v1"
  const list = [
    { id: "nvidia2", label: "NVIDIA (vision key)", baseUrl: nim, vaultKey: "custom-nvidia2-api-key", local: false, models: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"] },
    { id: "ddd", label: "ddd", baseUrl: nim, vaultKey: "custom-ddd-api-key", local: false, models: ["x"] },
  ]
  const refusals = syncCustomProviders(list as never, { dryRun: true })
  expect(refusals).toHaveLength(1)
  expect(refusals[0]).toContain("«ddd» يكرّر عنوان nvidia2")
  expect(refusals[0]).toContain("القائمةُ كلُّها مرفوضة")
  const dupId = syncCustomProviders([list[0], { ...list[0], baseUrl: "https://other.example.com/v1" }] as never, { dryRun: true })
  expect(dupId[0]).toContain("«nvidia2» يكرّر المعرّف")
  expect(syncCustomProviders([list[0]] as never, { dryRun: true })).toEqual([])
})
