/**
 * drive-upload: a project file goes to Google Drive. The order is the safety: the path resolves inside the project,
 * the connector must be linked, the user approves, and only then are bytes read and sent.
 */
import { describe, expect, test } from "bun:test"
import { TOOLS } from "@abdo/tools"
import { familiesFor, familyOf } from "../src/tool-exposure"

const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const at = (s: string) => { const i = cli.indexOf(s); expect(i).toBeGreaterThan(0); return i }

describe("drive-upload", () => {
  test("one switch, read once at the call", () => {
    expect(cli.split('pluginOnNow("driveUpload")').length - 1).toBe(1)
  })
  test("project path, then linked connector, then approval, then upload — in that order", () => {
    const start = at('if (spec.name === "drive-upload") {')
    const path = at("const abs = resolveProjectPath(file)")
    const linked = at('return invalid("جوجل غيرُ مربوط')
    const approval = at('if (!await gate(turnId, "network", `رفعُ «${file}»')
    const upload = at("await new GoogleConnector(options).upload(basename(abs), new Uint8Array(readFileSync(abs))")
    expect(start).toBeLessThan(path)
    expect(path).toBeLessThan(linked)
    expect(linked).toBeLessThan(approval)
    expect(approval).toBeLessThan(upload)
    expect(cli).toContain('if (abs === undefined) return refused(`المسار خارج المشروع: ${file}`)')
  })
  test("the credential comes from the Google connector's vault grants, never from arguments", () => {
    expect(cli).toContain('for (const grant of connectorGrants("google", true)) { const r = await vaultGet(grant.handle, process.env); if ("value" in r) env[grant.env] = r.value }')
  })
  test("catalogued as a network effect in the documents family, opened by Drive words", () => {
    const spec = TOOLS.find((t) => t.name === "drive-upload")!
    expect(spec.effect).toBe("network")
    expect(spec.runner).toBe("document")
    expect(familyOf("drive-upload")).toBe("documents")
    for (const ask of ["ارفع العرض على درايف", "upload the deck to Google Drive", "اعمله مستند جوجل"]) expect(familiesFor(ask).has("documents")).toBe(true)
  })
})
