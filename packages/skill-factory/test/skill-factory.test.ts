import { expect, test } from "bun:test"
import { generateSkill } from "../src"
test("builds skills only from verified secret-free traces", () => {
  expect(generateSkill("format-project", [{ tool: "format", arguments: { path: "." }, verified: true }]).steps).toHaveLength(1)
  expect(() => generateSkill("bad", [{ tool: "fetch", arguments: { apiKey: "x" }, verified: true }])).toThrow("secret_bearing_skill_step")
})
