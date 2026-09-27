import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * بوّابةُ الأسماء غير المعلنة في واجهة سطح المكتب.
 *
 * العطلُ المقيس (2026-09-27، بلاغُ المالك على 4.0.68): «حفظ وتطبيق» في الإعدادات كان يسقط بـ
 * `ReferenceError: meter is not defined` — متغيّرٌ يُسنَد ويُقرأ في `native-usage-settings.js`
 * ولم يُعلَن قطّ. ملفّاتُ الواجهة JavaScript بلا بناء، فلا مترجمَ يمرّ عليها، ولا اختبارَ
 * يشغّل ذلك المسار. هذه البوّابة تمرّر مدقّقَ الأنواع على كلّ ملفّاتها وعلى وحدة
 * `index.html` المضمّنة، وتفشل على «لا اسمَ بهذا» (TS2304/TS2552) وحدَه.
 *
 * والتوأمُ الإيجابيّ في النداء نفسه: ملفٌّ مزروعٌ باسمٍ غير معلن يجب أن يُبلَّغ عنه —
 * وإلّا فالأخضرُ قد يعني أنّ المدقّق لم يقرأ شيئاً.
 */

const REPO = resolve(import.meta.dir, "..")
const UI = join(REPO, "packages", "desktop", "ui")
const PLANTED = "abdoUiGatePlantedUndeclaredName"

const tsgoEntry = (): string => {
  const manifest = Bun.resolveSync("@typescript/native-preview/package.json", join(REPO, "packages", "engine"))
  const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin: Record<string, string> }).bin.tsgo!
  return join(dirname(manifest), bin)
}

test("desktop UI scripts reference no undeclared names, and the checker bites on a planted one", async () => {
  const work = mkdtempSync(join(tmpdir(), "abdo-ui-names-"))
  try {
    const html = readFileSync(join(UI, "index.html"), "utf8")
    const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/gu)].map((m) => m[1]!)
    expect(inline.length).toBeGreaterThan(0)
    const uiImport = UI.replaceAll("\\", "/") + "/"
    inline.forEach((body, index) => {
      writeFileSync(join(work, `index-inline-${index}.js`), body.replace(/from (["'])\.\//gu, `from $1${uiImport}`))
    })
    writeFileSync(join(work, "planted.js"), `export const planted = () => ${PLANTED} + 1\n`)
    const scripts = readdirSync(UI).filter((name) => name.endsWith(".js")).map((name) => join(UI, name))
    expect(scripts.length).toBeGreaterThan(20)
    writeFileSync(join(work, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowJs: true, checkJs: true, noEmit: true, strict: false, skipLibCheck: true,
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2023", "DOM", "DOM.Iterable"],
      },
      files: [...scripts, ...inline.map((_, index) => join(work, `index-inline-${index}.js`)), join(work, "planted.js")],
    }))
    const run = Bun.spawn([process.execPath, tsgoEntry(), "-p", join(work, "tsconfig.json")], { cwd: work, stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    const missingNames = `${out}\n${err}`.split(/\r?\n/u).filter((line) => /error TS2(?:304|552):/u.test(line))
    // التوأمُ الإيجابيّ: المزروعُ وحده يُبلَّغ — فالمدقّقُ قرأ الملفّات.
    expect(missingNames.some((line) => line.includes("planted.js") && line.includes(PLANTED))).toBe(true)
    expect(missingNames.filter((line) => !line.includes("planted.js"))).toEqual([])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}, 180_000)
