import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bridgeCallArgs, parseBrowserAction, uploadPathVerdict } from "../src/browser-actions-args"
import { BRIDGE_TOOLS } from "../src/mcp-servers/chrome-bridge"
import { argumentsFor } from "../src/mind/mcp"
import { readFileSync } from "node:fs"

// ن3 — select/upload/drag: التحليلُ يسمّي الصيغةَ عند النقص، مسارُ الرفع يُحكم قبل مغادرة الجهاز، ووسائطُ الجسر كائنٌ يجتاز مخطّطَ الأداة
// (fill كان يُرفض نصّاً حرّاً — مقيس 09-15).

test("parse: select needs ref + choice, upload needs ref + path, drag needs two different refs; quotes around the choice are stripped", () => {
  expect(parseBrowserAction("select", "r5 Saudi Arabia")).toEqual({ ok: true, verb: "select", ref: "r5", choice: "Saudi Arabia" })
  expect(parseBrowserAction("select", 'r5 "المملكة العربية السعودية"')).toEqual({ ok: true, verb: "select", ref: "r5", choice: "المملكة العربية السعودية" })
  expect(parseBrowserAction("select", "r5").ok).toBe(false)
  expect(parseBrowserAction("upload", "r7 renders/final.png")).toEqual({ ok: true, verb: "upload", ref: "r7", path: "renders/final.png" })
  expect(parseBrowserAction("upload", "renders/final.png").ok).toBe(false)
  expect(parseBrowserAction("drag", "r3 r9")).toEqual({ ok: true, verb: "drag", from: "r3", to: "r9" })
  expect(parseBrowserAction("drag", "r3 r3").ok).toBe(false)
  const bad = parseBrowserAction("drag", "r3")
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.why).toContain("الصيغة: drag")
})

test("upload path: inside the project only, must exist and be a file, never a credential-looking name", () => {
  const project = mkdtempSync(join(tmpdir(), "abdo-upload-"))
  try {
    mkdirSync(join(project, "renders"))
    writeFileSync(join(project, "renders", "final.png"), "png")
    writeFileSync(join(project, ".env"), "SECRET=1")
    writeFileSync(join(project, "server.key"), "k")
    const ok = uploadPathVerdict("renders/final.png", project)
    expect(ok.ok).toBe(true)
    if (ok.ok) { expect(ok.abs).toBe(resolve(project, "renders", "final.png")); expect(ok.name).toBe("final.png"); expect(ok.bytes).toBe(3) }
    // absolute path inside the project is fine too; outside is refused by name
    expect(uploadPathVerdict(resolve(project, "renders", "final.png"), project).ok).toBe(true)
    const outside = uploadPathVerdict(resolve(project, "..", "elsewhere.png"), project)
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.why).toContain("خارج مجلّد المشروع")
    expect(uploadPathVerdict("../elsewhere.png", project).ok).toBe(false)
    const secret = uploadPathVerdict(".env", project)
    expect(secret.ok).toBe(false)
    if (!secret.ok) expect(secret.why).toContain("ملفُّ اعتمادٍ")
    expect(uploadPathVerdict("server.key", project).ok).toBe(false)
    const missing = uploadPathVerdict("renders/nope.png", project)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.why).toContain("غير موجود")
    const dir = uploadPathVerdict("renders", project)
    expect(dir.ok).toBe(false)
    if (!dir.ok) expect(dir.why).toContain("مجلّدٌ")
  } finally { rmSync(project, { recursive: true, force: true }) }
})

test("bridge args: fill/select/upload/drag become JSON that the bridge schema accepts; other verbs pass through as text", () => {
  const project = mkdtempSync(join(tmpdir(), "abdo-bridge-args-"))
  try {
    writeFileSync(join(project, "cv.pdf"), "pdf")
    const schema = (name: string) => BRIDGE_TOOLS.find((t) => t.name === name)!.inputSchema
    const fill = bridgeCallArgs("fill", "r5 hello world", project)
    expect(fill).toEqual({ ok: true, args: JSON.stringify({ ref: "r5", text: "hello world" }) })
    if (fill.ok) expect(argumentsFor(fill.args, schema("fill"))).toEqual({ ok: true, value: { ref: "r5", text: "hello world" } })
    // the measured defect: the free text itself is refused by the schema mapper
    expect(argumentsFor("r5 hello world", schema("fill")).ok).toBe(false)
    const select = bridgeCallArgs("select", "r2 Riyadh", project)
    if (select.ok) expect(argumentsFor(select.args, schema("select"))).toEqual({ ok: true, value: { ref: "r2", text: "Riyadh" } })
    else throw new Error(select.why)
    const upload = bridgeCallArgs("upload", "r7 cv.pdf", project)
    if (upload.ok) expect(argumentsFor(upload.args, schema("upload"))).toEqual({ ok: true, value: { ref: "r7", path: resolve(project, "cv.pdf") } })
    else throw new Error(upload.why)
    expect(bridgeCallArgs("upload", "r7 ../cv.pdf", project).ok).toBe(false)
    const drag = bridgeCallArgs("drag", "r3 r9", project)
    if (drag.ok) expect(argumentsFor(drag.args, schema("drag"))).toEqual({ ok: true, value: { from: "r3", to: "r9" } })
    else throw new Error(drag.why)
    expect(bridgeCallArgs("tap", "r3", project)).toEqual({ ok: true, args: "r3" })
    expect(bridgeCallArgs("fill", "r5", project).ok).toBe(false)
  } finally { rmSync(project, { recursive: true, force: true }) }
})

test("wiring: both backends know the three verbs, the catalogue describes them, and the extension implements them", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain('import { bridgeCallArgs, parseBrowserAction, uploadPathVerdict } from "./browser-actions-args"')
  for (const verb of ["select", "upload", "drag"]) expect(cli).toContain(`if (name === "${verb}") {`)
  expect(cli).toContain('select: "select", upload: "upload", drag: "drag", tabs: "tabs", back: "back", forward: "forward" }')
  expect(cli).toContain("bridgeCallArgs(target ?? name, rest, PROJECT_DIR)")
  // the owned route reads the effect back rather than claiming it
  expect(cli).toContain("const picked = await surface.selectOption(ref, p.choice)")
  expect(cli).toContain("const landed = await surface.setFiles(ref, [fileVerdict.abs])")
  expect(cli).toContain("await surface.dragTo({ x: again.at.x, y: again.at.y }, { x: dest.x, y: dest.y })")
  // the upload path verdict precedes the approval question
  const verdictAt = cli.indexOf("const fileVerdict = uploadPathVerdict(p.path, PROJECT_DIR)")
  const gateAt = cli.indexOf("رفعُ الملفّ «${fileVerdict.name}»")
  expect(verdictAt).toBeGreaterThan(0)
  expect(verdictAt).toBeLessThan(gateAt)
  const catalogue = readFileSync(join(import.meta.dir, "..", "..", "tools", "src", "catalogue.ts"), "utf8")
  for (const verb of ["select", "upload", "drag"]) expect(catalogue).toContain(`{ name: "${verb}", effect: "outside-workspace"`)
  const exposure = readFileSync(join(import.meta.dir, "..", "src", "tool-exposure.ts"), "utf8")
  expect(exposure).toContain('"select", "upload", "drag", "tabs", "back", "forward", "design"]') // S9: design في عائلة المتصفّح
  for (const verb of ["select", "upload", "drag"]) expect(BRIDGE_TOOLS.some((t) => t.name === verb)).toBe(true)
  const background = readFileSync(join(import.meta.dir, "..", "..", "browser-bridge", "extension", "background.js"), "utf8")
  expect(background).toContain('case "select": {')
  expect(background).toContain('await send("DOM.setFileInputFiles", { files: [String(args.path)], objectId })')
  expect(background).toContain('case "drag": {')
  expect(background).toContain("const SYNTH_DRAG = (fromRef, toRef) => {")
  const surface = readFileSync(join(import.meta.dir, "..", "src", "mind", "surface.ts"), "utf8")
  expect(surface).toContain('| { readonly kind: "select"; readonly ref: string; readonly generation: number; readonly choice: string }')
  expect(surface).toContain('case "select":\r\n    case "upload":\r\n    case "drag":\r\n')
})
