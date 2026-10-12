/**
 * 10-08 (مقيس على nemotron-ultra في موقع Next.js): النموذجُ يختم حمولةَ write بسطرٍ وحده «»» (إغلاقُ اقتباسه العربيّ للأمر)،
 * فرفض حارسُ الصياغة الملفَّ «Unexpected »» نحو عشرين مرّةً في دورٍ واحد. السطرُ يُنزع من ملفّات الشيفرة وحدها؛
 * والتوأمُ: في Markdown يبقى بايتاً، و«»» داخل الشيفرة لا يُمسّ.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

async function dispatched(reply: string): Promise<string[]> {
  const seen: string[] = []
  const answers = [reply, "تمّ."]
  await runTextAgentLoop({
    input: "اكتب الملفّ",
    history: [],
    ask: async () => (answers.length > 1 ? answers.shift()! : answers[0]!),
    dispatch: async (command: string) => { seen.push(command); return "✍ كُتب" },
    isCallable: () => true,
    maxRounds: 3,
  })
  return seen
}

const TSX = "\"use client\";\nexport function A() {\n  return <div>«مرحبا»</div>\n}"

test("a lone closing «»» after a code payload is dropped before the write", async () => {
  const seen = await dispatched(`نفّذ: write src/a.tsx <<<\n${TSX}\n»`)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toBe(`write src/a.tsx <<<\n${TSX}\n`)
  const css = await dispatched("نفّذ: write src/a.css <<<\n.a { color: red }\n» ")
  expect(css[0]).toBe("write src/a.css <<<\n.a { color: red }\n")
})

test("a lone trailing >> / >>> / EOF line after code is a closing marker too (measured on a 666-line page)", async () => {
  for (const marker of [">>", ">>>", "EOF"]) {
    const seen = await dispatched(`نفّذ: write src/page.tsx <<<\n${TSX}\n${marker}`)
    expect(seen[0]).toBe(`write src/page.tsx <<<\n${TSX}\n`)
  }
  // التوأم: سطرٌ فيه شيفرةٌ تنتهي بـ>> (إزاحةٌ أو نوعٌ عامّ) لا يُمسّ.
  const shift = await dispatched("نفّذ: write src/bits.ts <<<\nexport const x = 8 >> 1\nexport type A = Map<string, Set<number>>")
  expect(shift[0]).toBe("write src/bits.ts <<<\nexport const x = 8 >> 1\nexport type A = Map<string, Set<number>>")
})

test("the twins: Markdown keeps it, and «»» inside code is untouched", async () => {
  const md = await dispatched("نفّذ: write NOTES.md <<<\n# اقتباس\n«قولٌ مأثور\n»")
  expect(md[0]).toBe("write NOTES.md <<<\n# اقتباس\n«قولٌ مأثور\n»")
  const inner = await dispatched(`نفّذ: write src/a.tsx <<<\n${TSX}`)
  expect(inner[0]).toBe(`write src/a.tsx <<<\n${TSX}`)
})
