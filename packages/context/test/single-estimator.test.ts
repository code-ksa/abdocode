import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CHARS_PER_TOKEN, estimateTokens } from "../src/budget"

/**
 * ONE TOKEN ESTIMATOR IN THE WHOLE TREE.
 *
 * On 2026-08-20 a survey found FOUR separate `estimateTokens` implementations
 * shipping in one binary — three dividing by 4 and one by 3. A full-suite run
 * then exposed a fifth implementation hidden as `Token.estimate` in a generic
 * utility module. The context
 * compiler sized a text at N tokens while the window manager sized the same
 * text at 1.33N. Context was packed to a budget computed one way and then
 * measured another: premature spilling, or a window left under-filled.
 *
 * The divergence had widened that same morning, by a change that was correct in
 * its own file: a divisor moved from 4 to 3 to fix a spill threshold, with no
 * way to know three other copies existed. That is what duplication does — it
 * turns a correct local fix into a system-wide defect.
 *
 * So this test does not check behaviour. It checks that there is only one
 * implementation to have behaviour.
 *
 * IT WALKS THE FILESYSTEM RATHER THAN SHELLING OUT. The first version ran
 * `git grep` through a computed working directory; on Windows it returned
 * nothing, and a guard that finds nothing reports a clean tree forever. Reading
 * the files directly removes the shell, the glob quoting and git itself from
 * the things that can silently break it.
 */
describe("a single token estimator", () => {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..")
  const packagesDir = path.join(repoRoot, "packages")

  const namedDefinition = /(?:const|let|var|function)\s+estimateTokens\s*[=(]/
  const constantDefinition = /\bconst\s+CHARS_PER_TOKEN\b/
  const tokenFile = /(?:^|\/)(?:token|tokens)(?:\.[^/]*)?\.tsx?$/i
  const localHeuristic =
    /(?:Math\.(?:ceil|round)\s*\([^)]*\.length\s*\/|\.length\s*\/\s*(?:CHARS_PER_TOKEN|\d+(?:\.\d+)?))/
  const definesEstimator = (file: string, source: string) =>
    namedDefinition.test(source) ||
    constantDefinition.test(source) ||
    (tokenFile.test(file.replaceAll("\\", "/")) && localHeuristic.test(source))

  const sourceFiles = (): string[] => {
    const found: string[] = []
    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full)
      }
    }
    // Only `src` trees: a test may legitimately define a local stub.
    for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      walk(path.join(packagesDir, pkg.name, "src"))
    }
    return found
  }

  test("only one file defines estimateTokens", () => {
    const files = sourceFiles()

    // THE GUARD MUST PROVE IT LOOKED. Zero scanned files means the walk broke —
    // wrong root, renamed layout — and a guard that silently checks nothing is
    // exactly the failure this whole exercise exists to prevent. It happened on
    // the first run of this very test.
    expect(files.length).toBeGreaterThan(100)

    const definers = files
      .filter((file) => definesEstimator(file, fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file).replaceAll("\\", "/"))

    // Names the offenders: "there are 2" is not actionable.
    expect(definers).toEqual(["packages/schema/src/tokens.ts"])
  })

  test("the canonical estimator over-counts rather than under-counts", () => {
    // 3.3 chars/token was the measured figure on JSON-escaped tool output. The
    // safe direction is to assume MORE tokens than reality: an under-count
    // hands the truncation decision to the provider, which makes it silently
    // and mid-prompt.
    expect(CHARS_PER_TOKEN).toBeLessThanOrEqual(3.3)
    expect(estimateTokens("x".repeat(3300))).toBeGreaterThanOrEqual(1000)
  })

  test("it is deterministic", () => {
    const text = "const x = 1\n".repeat(50)
    expect(estimateTokens(text)).toBe(estimateTokens(text))
  })

  test("the guard catches a token estimator hidden behind a generic name and neutral filename", () => {
    expect(
      definesEstimator(
        "packages/fake/src/window-budget.ts",
        "const CHARS_PER_TOKEN = 4\nexport const estimate = (text: string) => Math.round(text.length / CHARS_PER_TOKEN)\n",
      ),
    ).toBe(true)

    expect(
      definesEstimator(
        "packages/fake/src/window-budget.ts",
        'import { CHARS_PER_TOKEN } from "@abdo/schema"\nexport const charsForTokens = (tokens: number) => tokens * CHARS_PER_TOKEN\n',
      ),
    ).toBe(false)
  })
})
