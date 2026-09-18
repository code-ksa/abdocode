import { expect, test } from "bun:test"
import { NativeDock } from "../../desktop/ui/native-dock.js"

// يقسم الجذرَ فيأخذ اللوحُ طولَ الصفحة، والطرفيّةُ تبقى تحت المحادثة وحدها؛ السحبُ إلى منطقة إفلات ورقةٍ يبقى نسبيّاً إلى الورقة.
// شجرةُ الرصيف نقيّة — تُختبر بلا DOM بتعطيل الرسم.

const dock = (): any => {
  const d: any = Object.create(NativeDock.prototype)
  d.nodes = new Map([["conversation", { node: {} }], ["terminal", { node: {} }], ["tasks", { node: {} }], ["files", { node: {} }]])
  d.tree = { id: "conversation", tabs: ["conversation"], active: "conversation" }
  d.floating = []; d.floatBounds = {}; d.history = []; d.serial = 0; d.maximized = null
  d.bridge = { park() {}, sync() {}, relocate() {} }
  d.render = () => {}; d.checkpoint = () => {}; d.save = () => {}
  return d
}
const tabsOf = (node: any): string[] => node.tabs ? node.tabs : [...tabsOf(node.first), ...tabsOf(node.second)]

test("a side panel opened after the terminal spans the full height: root row split, terminal stays under the conversation", () => {
  const d = dock()
  d.move("terminal", "conversation", "bottom", false)
  expect(d.tree.axis).toBe("column")
  d.open("tasks", "right")
  expect(d.tree.axis).toBe("row")
  expect(d.tree.ratio).toBe(.72)
  expect(d.tree.second.tabs).toEqual(["tasks"])
  expect(d.tree.first.axis).toBe("column")
  expect(tabsOf(d.tree.first)).toEqual(["conversation", "terminal"])
})

test("a drag into a leaf's drop zone keeps splitting that leaf (scope=leaf), and a left panel takes the first column", () => {
  const d = dock()
  d.move("terminal", "conversation", "bottom", false)
  const conversationLeaf = d.leaves().find((l: any) => l.tabs.includes("conversation"))
  d.move("files", conversationLeaf.id, "right")
  expect(d.tree.axis).toBe("column")
  expect(tabsOf(d.tree.first)).toEqual(["conversation", "files"])
  d.open("tasks", "left")
  expect(d.tree.axis).toBe("row"); expect(d.tree.ratio).toBe(.28); expect(d.tree.first.tabs).toEqual(["tasks"])
})

test("register(): the terminal lands under the conversation only, and a panel registered afterwards still takes a full-height right column", () => {
  const d = dock()
  d.nodes.set("conversation", { node: {} })
  d.register("terminal", {})
  expect(d.tree.axis).toBe("column"); expect(tabsOf(d.tree)).toEqual(["conversation", "terminal"])
  d.register("tasks", {})
  expect(d.tree.axis).toBe("row"); expect(d.tree.second.tabs).toEqual(["tasks"]); expect(tabsOf(d.tree.first)).toEqual(["conversation", "terminal"])
})
