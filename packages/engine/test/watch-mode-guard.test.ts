import { describe, expect, test } from "bun:test"
import { watchModeViolation } from "../src/shell-command-guard"

describe("watch-mode guard — commands that never return (catalog 1.13)", () => {
  test("vitest without run is refused; vitest run passes", () => {
    expect(watchModeViolation("npx vitest")).toContain("vitest run")
    expect(watchModeViolation("npx vitest run")).toBeUndefined()
  })
  test("--watch flags and nodemon are refused", () => {
    expect(watchModeViolation("npx jest --watchAll")).toContain("--watch")
    expect(watchModeViolation("npx tsc --watch")).toContain("--watch")
    expect(watchModeViolation("npx nodemon server.js")).toContain("nodemon")
  })
  test("live log tails are refused with the batch alternative", () => {
    expect(watchModeViolation("tail -f app.log")).toContain("-Tail")
    expect(watchModeViolation("Get-Content app.log -Wait")).toContain("-Tail")
  })
  test("ad-hoc static servers are refused toward the managed path", () => {
    expect(watchModeViolation("npx serve dist")).toContain("المُدار")
    expect(watchModeViolation("python -m http.server 8080")).toContain("المُدار")
  })
  test("ordinary batch commands pass untouched", () => {
    expect(watchModeViolation("npm run build")).toBeUndefined()
    expect(watchModeViolation("npm test")).toBeUndefined()
    expect(watchModeViolation("dotnet test")).toBeUndefined()
    expect(watchModeViolation("tail -n 20 app.log")).toBeUndefined()
  })
})
