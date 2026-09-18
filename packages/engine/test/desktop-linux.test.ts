import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { desktopBackendFor, windowsBackend, type DesktopBound, type UiContext } from "../src/desktop-control"
import { LINUX_BUS, linuxBackend, linuxRunner, linuxScript } from "../src/desktop-linux"

// ب2 (09-16) — القناةُ اللينكسيّة: السكربتُ بايثون واحد يحمل الفعلَ base64، يُخرج JSON بشكل ويندوز نفسِه، ويُصرَّف (ast) بلا خطأ؛
// المشغّلُ محلّيّ أو عبر wsl.exe؛ والقشرةُ تمرّ بالعقد الواحد. القياسُ الحيّ على WSLg في `desk-linux-live.test.ts`.

const BOUND: DesktopBound = { hwnd: 77, title: "Abdo Desk Probe", left: 10, top: 20, right: 430, bottom: 180 }
const UI: UiContext = { depth: 4, elements: [{ ref: 3, type: "Edit", name: "Field", id: "", x: 1, y: 1, w: 10, h: 10, patterns: ["Value"], enabled: true, password: false }] }
const pythonArgv = (): string[] | undefined => {
  for (const exe of ["python", "python3"]) { try { if (Bun.spawnSync([exe, "--version"]).exitCode === 0) return [exe] } catch { /* غائب */ } }
  return undefined
}

describe("linuxScript — one python program per action, same JSON contract as Windows", () => {
  test("every action embeds its arguments (base64) and the program parses as Python", () => {
    const py = pythonArgv()
    const actions = [
      { kind: "windows" as const }, { kind: "shot" as const, scope: "auto" as const }, { kind: "open" as const, app: "xterm" }, { kind: "focus" as const, title: "Probe" },
      { kind: "click" as const, x: 5, y: 6, button: "left" as const }, { kind: "type" as const, text: "مرحباً" }, { kind: "key" as const, combo: "ctrl+s" },
      { kind: "scroll" as const, direction: "right" as const, count: 2 }, { kind: "drag" as const, x1: 1, y1: 2, x2: 30, y2: 40 }, { kind: "ui" as const, depth: 4 },
      { kind: "set" as const, ref: 3, text: "hello" }, { kind: "press" as const, ref: 3 },
    ]
    for (const action of actions) {
      const script = linuxScript(action, "C:\\shots\\x.png", BOUND, UI, [1])
      const b64 = /^ARGS = "([A-Za-z0-9+/=]+)"/u.exec(script)?.[1]
      expect(b64).toBeDefined()
      const args = JSON.parse(Buffer.from(b64!, "base64").toString("utf8"))
      expect(args.kind).toBe(action.kind)
      expect(args.bus).toBe(LINUX_BUS)
      if (action.kind === "set" || action.kind === "press") { expect(args.expType).toBe("Edit"); expect(args.expName).toBe("Field"); expect(args.ui).toEqual({ depth: 4 }) }
      if (py !== undefined) {
        const r = Bun.spawnSync([...py, "-c", "import ast,sys; ast.parse(sys.stdin.read())"], { stdin: Buffer.from(script) })
        expect(`${action.kind}: ${r.exitCode} ${r.stderr.toString().slice(0, 200)}`).toBe(`${action.kind}: 0 `)
      }
    }
    // النصُّ العربيّ يعبر base64 سليماً
    const typed = JSON.parse(Buffer.from(/^ARGS = "([^"]+)"/u.exec(linuxScript({ kind: "type", text: "مرحباً بالعالم" }, "", BOUND))![1]!, "base64").toString("utf8"))
    expect(typed.text).toBe("مرحباً بالعالم")
  })
  test("the program mirrors the Windows JSON contract keys the shared interpreter reads", () => {
    const s = linuxScript({ kind: "windows" }, "", BOUND)
    for (const key of ['"hwnd"', '"pid"', '"title"', '"left"', '"top"', '"right"', '"bottom"', '"foreground"', '"moved"', '"blocked"', '"elements"', '"how"', '"verified"', '"readback"', '"existing"', '"focused"', '"others"', '"scope"']) expect(s).toContain(key)
    expect(s).toContain('"error": "focus moved"')
    expect(s).toContain('"error": "no window matches"')
    expect(s).toContain("the UI changed since desk ui - run desk ui again")
    // مسارُ ويندوز يُترجم إلى /mnt/<حرف>/ حين يُقاس عبر WSL
    expect(s).toContain('return "/mnt/" + p[0].lower() + p[2:].replace("\\\\", "/")')
    // WSLg: X11 قسراً وحافلةُ جلسةٍ ثابتة
    expect(s).toContain('os.environ.setdefault("GDK_BACKEND", "x11")')
    expect(s).toContain("dbus-daemon")
  })
})

describe("runner and backend", () => {
  test("the runner feeds python3 through stdin — locally, or through wsl.exe with the named distro", async () => {
    const local = linuxRunner()
    const wsl = linuxRunner({ wslDistro: "Ubuntu-24.04" })
    expect(typeof local.run).toBe("function"); expect(typeof wsl.run).toBe("function")
    const b = linuxBackend({ wslDistro: "Ubuntu-24.04" })
    expect(b.id).toBe("linux-x11"); expect(b.platform).toBe("linux"); expect(b.label).toContain("WSLg (Ubuntu-24.04)")
    expect(linuxBackend().label).not.toContain("WSLg")
    // الحرّاسُ المشتركة قبل السكربت: بلا نافذةٍ مربوطة لا إدخال — ولا يُشغَّل python أصلاً
    let ran = false
    const r = await b.run({ kind: "type", text: "x" }, { shotsDir: "/tmp", runner: { run: async () => { ran = true; return { code: 0, stdout: '{"ok":true}', stderr: "" } } } })
    expect(r.ok).toBe(false); expect(ran).toBe(false)
    // والمفسِّرُ المشترك يقرأ JSON القناة اللينكسيّة كما يقرأ ويندوز
    const ok = await b.run({ kind: "windows" }, { shotsDir: "/tmp", runner: { run: async (script) => ({ code: 0, stdout: `noise\n${JSON.stringify({ ok: true, windows: [{ hwnd: 5, pid: 9, title: "Probe", left: 0, top: 0, right: 100, bottom: 50 }] })}`, stderr: "", ...(script.includes("ARGS = ") ? {} : { code: 1 }) }) } })
    expect(ok.ok).toBe(true); expect(ok.windows).toHaveLength(1); expect(ok.text).toContain("«Probe»")
  })
  test("the shell dispatches through the single contract and names the channel once", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("const backend = desktopBackendFor()")
    expect(cli).toContain('if ("error" in backend) return denied(')
    expect(cli).toContain("const runDesktop = backend.run")
    expect(cli).not.toContain('from "./desktop-backend"')
    expect(cli).toContain("(القناة: ${backend.label})")
    expect(desktopBackendFor("win32", {})).toBe(windowsBackend)
  })
})
