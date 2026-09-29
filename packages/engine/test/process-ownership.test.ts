import { describe, expect, test } from "bun:test"
import { killByPidTargets, killRefusal, pidCommandLine, pidOwnedByProject } from "../src/process-ownership"

// 09-29 — «Stop-Process -Id 22472, 52448, 80340, 86024, 94596 -Force» قتل خمسَ عمليّات node على الجهاز كلِّه ومرّ من الحارس.
describe("kill by pid — ownership is measured, not assumed", () => {
  test("parses every by-pid kill shape the model used, and nothing else", () => {
    expect(killByPidTargets('powershell -Command "Stop-Process -Id 22472, 52448, 80340, 86024, 94596 -Force"')).toEqual([22472, 52448, 80340, 86024, 94596])
    expect(killByPidTargets("Stop-Process -Id 43072 -Force -ErrorAction SilentlyContinue")).toEqual([43072])
    expect(killByPidTargets("Stop-Process 57460 -Force")).toEqual([57460])
    expect(killByPidTargets("taskkill /PID 1234 /T /F")).toEqual([1234])
    expect(killByPidTargets("kill -9 4242")).toEqual([4242])
    expect(killByPidTargets("Get-Process node | Select-Object Id")).toEqual([])
    expect(killByPidTargets("npm run build")).toEqual([])
    expect(killByPidTargets("stop 48420")).toEqual([])
  })

  test("owned pids pass; foreign pids pass only when their command line lives in the project; a failed query is a refusal", () => {
    const owned = new Set([48420])
    const project = "C:\\Users\\x\\Desktop\\openrouter-clone"
    const lines: Record<number, string | undefined> = {
      1: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\Desktop\\openrouter-clone\\node_modules\\next\\dist\\bin\\next" dev',
      2: '"C:\\Program Files\\nodejs\\node.exe" C:/Users/x/Desktop/OPENROUTER-CLONE/scripts/seed.ts',
      3: '"C:\\Program Files\\nodejs\\node.exe" C:\\agent-admin\\scripts\\server.js',
      4: undefined,
    }
    const query = (pid: number) => lines[pid]
    expect(pidOwnedByProject(48420, project, owned, () => { throw new Error("must not query owned") })).toBe(true)
    expect(pidOwnedByProject(1, project, owned, query)).toBe(true)
    expect(pidOwnedByProject(2, project, owned, query)).toBe(true)
    expect(pidOwnedByProject(3, project, owned, query)).toBe(false)
    expect(pidOwnedByProject(4, project, owned, query)).toBe(false)
    expect(killRefusal([3, 4])).toContain("pid 3، 4")
    expect(killRefusal([3])).toContain("stop <pid>")
  })

  test("the PowerShell query is shaped for one pid and treats a failed or empty answer as absence", () => {
    const calls: string[][] = []
    expect(pidCommandLine(77, (argv) => { calls.push(argv); return { ok: true, stdout: "node dev\r\n" } })).toBe("node dev")
    expect(calls[0]![calls[0]!.length - 1]).toContain('ProcessId=77')
    expect(pidCommandLine(77, () => ({ ok: false, stdout: "" }))).toBeUndefined()
    expect(pidCommandLine(77, () => ({ ok: true, stdout: "  " }))).toBeUndefined()
    expect(pidCommandLine(-1, () => { throw new Error("must not spawn") })).toBeUndefined()
  })
})
