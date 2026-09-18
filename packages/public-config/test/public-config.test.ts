import { expect, test } from "bun:test"
import { loadPublicProjectConfig } from "../src"
test("does not parse project configuration before trust", () => {
  expect(() => loadPublicProjectConfig({ version: 1, projectDirectory: ".", network: "off" }, false, "C:\\work" )).toThrow("project_config_requires_trust")
  expect(loadPublicProjectConfig({ version: 1, projectDirectory: "project", network: "off" }, true, "C:\\work").network).toBe("off")
})
