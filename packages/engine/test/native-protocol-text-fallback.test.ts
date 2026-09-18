import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { usesNativeToolProtocol } from "../src/native-model-protocol"

// مقيس 09-17 على المثبَّت 4.0.46 (ollama/empero-qwen3.8-9b-gpu، بروتوكول أصليّ): النموذجُ كتب «نفّذ: project-locate alzooz» نصّاً
// فرُفض «استخدم استدعاء الأداة المنظّم» ثلاثَ مرّاتٍ في كلّ حقبة — أربعُ حقبٍ وثلاثُ أدواتٍ فقط ثمّ «duplicate». الحلقةُ تستهلك النصَّ
// تحت البروتوكولين (النداءُ الأصليّ نفسُه يُحوَّل إلى سطر «نفّذ:»)، فسطرُ «نفّذ:» الصريح طريقٌ مثبَت يُقبل؛ ويُرفض فقط ما يحاكي النداء نصّاً بلا سطر.
test("a verified native-tool local model that answers with an explicit «نفّذ:» line is accepted, not refused three times", () => {
  expect(usesNativeToolProtocol("ollama", "empero-qwen3.8-9b-gpu:latest", undefined)).toBe(true)
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain('if (nativeTools && /(?:```|<tool_call>)/u.test(answer) && !/نفّ?ذ\\s*:/u.test(answer)) return')
  expect(cli).not.toContain('if (nativeTools && /(?:نفّ?ذ\\s*:|```|<tool_call>)/u.test(answer)) return')
  // الرفضُ الباقي يسمّي الطريقين المقبولين
  expect(cli).toContain("استخدم استدعاء الأداة المنظم أو سطر «نفّذ:» واحداً لا كتلة كود")
})
