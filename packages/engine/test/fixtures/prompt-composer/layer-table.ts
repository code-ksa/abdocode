/**
 * جدولُ الطبقات بأحجامها لكلّ مثبّت ذهبيّ — للإيصال والمراجعة، لا للاختبار.
 * التشغيل (من جذر المستودع): `bun packages/engine/test/fixtures/prompt-composer/layer-table.ts`
 */
import { composeSystem, humanBytes, legacyBaseSystem, systemReceiptLine, type ComposeInput } from "../../../src/prompt-composer"

interface Golden { readonly fixtures: readonly { readonly name: string; readonly input: ComposeInput; readonly golden: string }[] }
const golden: Golden = await Bun.file(new URL("./legacy-golden.json", import.meta.url)).json()
const environment = { os: "Windows", shell: "Windows PowerShell 5.1", projectName: "demo-site", language: "ar", dialect: "gulf" }
for (const fixture of golden.fixtures) {
  const legacy = Buffer.byteLength(legacyBaseSystem(fixture.input), "utf8")
  const composed = composeSystem({ ...fixture.input, environment, semanticFrame: "لغة: ar · لهجة: gulf 80% · فعل: create · نوع: page · هدف: «من نحن»" })
  const total = composed.layers.reduce((sum, layer) => sum + layer.bytes, 0)
  console.log(`\n== ${fixture.name}: legacy ${legacy}b → layered ${total}b (بيئة+إطار جديدان)`)
  for (const layer of composed.layers) console.log(`  ${layer.name.padEnd(15)} ${String(layer.bytes).padStart(6)}b / ${layer.budget}${layer.truncated ? "  ⚠" : ""}`)
  console.log(`  🧾 ${systemReceiptLine(composed.layers, 3_100)}`)
  void humanBytes
}
