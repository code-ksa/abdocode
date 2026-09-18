import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SHELL_FRAMES } from "@abdo/transport-contracts"
import { SITE_HOST, sitePolicyCommand, sitePolicyRequest } from "../src/browser-site-policy"

// ن9 (09-16) — بابُ IPC لسياسة المواقع: المحرّكُ لا يكتب workspace-v1.json (مالكُه القشرة `workspace.rs`)؛ «browser allow|block <نطاق>»
// من المشغّل يبثّ إطارَ `site-policy` مُعلَناً في البروتوكول، والقشرةُ تحفظه بالطريق الأصيل نفسِه (savePreference ⇦ workspace_store_set).

describe("sitePolicyRequest — the shape is judged in the engine, the policy is written by the shell", () => {
  test("allow/block with a bare host, a quoted host, or a URL whose host is derived; anything else is refused by name", () => {
    expect(sitePolicyRequest("allow", "Example.com")).toEqual({ ok: true, op: "allow", site: "example.com" })
    expect(sitePolicyRequest("block", "«ads.tracker.net»")).toEqual({ ok: true, op: "block", site: "ads.tracker.net" })
    expect(sitePolicyRequest("allow", "https://Docs.Example.org/path?q=1")).toEqual({ ok: true, op: "allow", site: "docs.example.org" })
    expect(sitePolicyRequest("allow", "example.com.")).toEqual({ ok: true, op: "allow", site: "example.com" })
    for (const bad of ["", "not a host", "-bad.com", "exa mple.com", "http://", "a".repeat(70) + ".com"]) expect(sitePolicyRequest("allow", bad).ok).toBe(false)
    expect(sitePolicyRequest("zap", "example.com")).toEqual({ ok: false, why: "الصيغة: browser allow <نطاق> | browser block <نطاق>" })
    expect(SITE_HOST.test("sub.example.co.uk")).toBe(true)
    expect(SITE_HOST.test("example.com/path")).toBe(false)
  })
  // مقيس حيّاً 09-16 على المثبَّت 4.0.42: «browser block example.com» أعاد سطرَ الصيغة لأنّ الفعلَ قُورن بالسطر كلِّه —
  // والمسمارُ النصّيّ القديم مرّ فوق العيب. الحكمُ هنا على الدالّة التي يستدعيها المعالجُ بالسطر كما يصل من المشغّل.
  test("the operator line is parsed by its first word: «block example.com» is the door, «owned» and «status» are not", () => {
    expect(sitePolicyCommand("block example.com")).toEqual({ ok: true, op: "block", site: "example.com" })
    expect(sitePolicyCommand("  Allow   https://Docs.Example.org/x ")).toEqual({ ok: true, op: "allow", site: "docs.example.org" })
    expect(sitePolicyCommand("block")).toEqual({ ok: false, why: "نطاقٌ غيرُ صالح «» — اكتب اسمَ النطاق بلا بروتوكول ولا مسار (مثل example.com)" })
    for (const other of ["owned", "status", "", "extension", "pair", "blocked example.com"]) expect(sitePolicyCommand(other)).toBeUndefined()
  })
})

describe("wiring — protocol, engine emit, shell handler, and the refusal that names the door", () => {
  test("the frame is declared outbound with op+site, the engine emits it only with a shell attached, the shell saves through the same preference path", () => {
    const spec = SHELL_FRAMES.find((f) => f.kind === "site-policy")
    expect(spec).toBeDefined(); expect(spec!.dir).toBe("out"); expect(spec!.required).toEqual(["op", "site"])
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("const sitePolicy = sitePolicyCommand(rest)")
    expect(cli).not.toContain('if (verb === "allow" || verb === "block") {')
    expect(cli).toContain('emit({ kind: "site-policy", op: request.op, site: request.site, turnId })')
    expect(cli.indexOf("if (shellKind === undefined) return `لا قشرةَ موصولة تحفظ سياسةَ المواقع")).toBeLessThan(cli.indexOf('emit({ kind: "site-policy"'))
    // المحرّكُ لا يكتب ملفَّ سياسة المواقع أبداً
    expect(cli).not.toMatch(/writeFileSync\([^\n]*workspace-v1\.json/u)
    const ui = readFileSync(join(import.meta.dir, "..", "..", "desktop", "ui", "native-workspace-settings.js"), "utf8")
    expect(ui).toContain("if(frame?.kind==='site-policy'){")
    expect(ui).toContain("void savePreference('blockedSites',values)")
    expect(ui).toContain("current.filter(value=>value!==site&&!site.endsWith('.'+value))")
    expect(ui).toContain("const covering=op==='allow'?current.filter(value=>value!==site&&site.endsWith('.'+value)):[]")
    // الرفضُ يسمّي البابَ للمشغّل
    expect(cli).toContain("Navigation blocked by saved site permissions — المشغّل: browser allow <نطاق>")
    expect(cli).toContain("أو اكتب للمشغّل: browser allow <نطاق>")
  })
})
