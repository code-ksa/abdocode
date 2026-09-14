import { expect, test } from "bun:test"
import { admitComputerAction, bindTarget } from "../src"
test("rejects stale generation-bound targets", () => {
  const ref = bindTarget({ generation: 4, targetIds: ["save"] }, "save", "accessibility")
  expect(() => admitComputerAction({ generation: 5, targetIds: ["save"] }, ref)).toThrow("stale_computer_target")
})
