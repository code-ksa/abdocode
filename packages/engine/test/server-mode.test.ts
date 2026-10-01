/**
 * 10-01 — مقيس حيّاً: «run --bg npm run start» بعد بناءٍ وخادمُ «npm run dev» المُدار حيّ على :3000 ⇦ «خادمك يعمل فعلاً — لا حاجة لإعادة
 * تشغيله»، فقاس audit خادمَ التطوير الذي أفسد البناءُ أصولَه. الوضعُ يُقارن، والبناءُ تحت dev حيٍّ يُقال في إيصاله.
 */
import { describe, expect, test } from "bun:test"
import { devServerUnderBuildNote, modeMismatch, serverMode } from "../src/managed-server"

const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const managed = await Bun.file(new URL("../src/managed-server.ts", import.meta.url)).text()
const dev = { display: "npm run dev", port: 3000, pid: 82384, alive: true }

describe("server mode", () => {
  test("dev, production and other commands", () => {
    expect(serverMode("npm run dev")).toBe("dev")
    expect(serverMode("pnpm --filter web dev")).toBe("dev")
    expect(serverMode("npm run start:dev")).toBe("dev")
    expect(serverMode("npm run start")).toBe("prod")
    expect(serverMode("vite preview")).toBe("prod")
    expect(serverMode("python app.py")).toBe("other")
  })

  test("a production request on a running dev server is named with the stop and start commands — the measured case", () => {
    const line = modeMismatch(dev, "npm run start")!
    expect(line).toContain("«npm run dev» (pid 82384)")
    expect(line).toContain("خادمُ تطوير لا خادمُ الإنتاج الذي طلبتَه")
    expect(line).toContain("stop 82384 ثمّ run --bg npm run start")
    expect(modeMismatch({ ...dev, display: "npm run start" }, "npm run dev")).toContain("خادمُ إنتاج لا خادمُ التطوير")
  })

  test("the same mode, or a command of unknown mode, is not a mismatch", () => {
    expect(modeMismatch(dev, "npm run dev")).toBeUndefined()
    expect(modeMismatch({ ...dev, display: "npm run start" }, "npm run start")).toBeUndefined()
    expect(modeMismatch(dev, "python app.py")).toBeUndefined()
  })

  test("start() asks before its «already running» reply", () => {
    expect(managed.indexOf("const mismatch = modeMismatch(")).toBeGreaterThan(0)
    expect(managed.indexOf("const mismatch = modeMismatch(")).toBeLessThan(managed.indexOf("⚙ خادمك يعمل فعلاً تحت إدارة النواة"))
    expect(managed).toContain("if (mismatch !== undefined && ours.proc.exitCode === null) return mismatch")
  })
})

describe("a build while the managed dev server is alive", () => {
  test("the build receipt says so with the stop command", () => {
    const note = devServerUnderBuildNote([dev], "npm run build")
    expect(note).toContain("يكتبان .next معاً")
    expect(note).toContain("stop 82384")
  })
  test("no dev server, a dead one, or a command that is not a build adds nothing", () => {
    expect(devServerUnderBuildNote([{ ...dev, display: "npm run start" }], "npm run build")).toBe("")
    expect(devServerUnderBuildNote([{ ...dev, alive: false }], "npm run build")).toBe("")
    expect(devServerUnderBuildNote([dev], "npm test")).toBe("")
  })
  test("the run receipt carries it for the engine's own servers", () => {
    expect(cli).toContain("diagnosis += devServerUnderBuildNote([...turnServers.snapshot(), ...devServers.snapshot()], cmd)")
  })
})
