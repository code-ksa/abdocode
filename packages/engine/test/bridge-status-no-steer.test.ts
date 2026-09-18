import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// مقيس حيّاً 09-16 على المثبَّت 4.0.40 (nemotron): «bridge status» كان يختم بـ«نفّذ: bridge pair» والخلفيّةُ المملوكة هي الفعّالة،
// فاتّبعه النموذجُ (25 ث انتظار)، ثمّ فتح رابطَ التثبيت الوارد في إيصال الاقتران بدل هدف المستخدم، ثمّ أوقفه حارسُ التكرار.
// القاعدة: إيصالٌ لا يوجّه إلى فعلٍ لا تحتاجه الخلفيّةُ الفعّالة — الاقترانُ يُطلب فقط حين تكون الإضافةُ هي الخلفيّة.

test("bridge status asks for pairing only when the extension is the chosen backend; with the owned backend it points back to open/page", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const start = cli.indexOf('if (name === "bridge") {'), end = cli.indexOf('if (name === "browser") {', start)
  const block = cli.slice(start, end)
  expect(block).toContain('? backend === "extension" ? " نفّذ: bridge pair" : " الخلفيّةُ الفعّالة لا تحتاج الإضافة — واصل بـopen/page مباشرةً')
  expect(block).not.toContain('${live !== undefined && !live.connected ? " نفّذ: bridge pair" : ""}')
  // the owned-backend line names no URL and no pairing verb the model could copy
  const owned = /الخلفيّةُ الفعّالة لا تحتاج الإضافة[^"]*/u.exec(block)?.[0] ?? ""
  expect(owned).not.toContain("http")
  expect(owned).not.toMatch(/نفّذ: bridge/u)
})
