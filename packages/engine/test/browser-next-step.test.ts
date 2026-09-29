import { describe, expect, test } from "bun:test"
import { buildNextStepPrompt, candidatesFrom, commandFor, parseNextStep, renderNextStep } from "../src/browser-next-step"

// 09-29 — فكرةُ OpenJev على المتصفّح: قرارٌ من قائمةٍ مسمّاة، بصرامةٍ في القراءة، وبلا تخمين.
const tree = [
  { ref: "r1", role: "heading", name: "تسجيل الدخول" },
  { ref: "r2", role: "textbox", name: "البريد" },
  { ref: "r3", role: "textbox", name: "كلمة المرور", sensitive: true },
  { ref: "r4", role: "button", name: "دخول", children: [{ ref: "r5", role: "generic", name: "" }] },
  { ref: "r6", role: "link", name: "نسيت كلمة المرور؟" },
]

describe("browser next step — candidates and prompt", () => {
  test("only actionable, non-sensitive elements become numbered candidates, in tree order", () => {
    const c = candidatesFrom(tree)
    expect(c.map((x) => `${x.n}:${x.ref}:${x.role}:${x.fillable}`)).toEqual(["1:r2:textbox:true", "2:r4:button:false", "3:r6:link:false"])
    expect(candidatesFrom(tree, 2)).toHaveLength(2)
  })
  test("the prompt names the goal, the page and every candidate with its verb and ref, and demands one line", () => {
    const p = buildNextStepPrompt("سجّل الدخول بحساب التجربة", { url: "http://localhost:3000/login", title: "Login", text: "  مرحباً  بك " }, candidatesFrom(tree))
    expect(p).toContain("الهدف: سجّل الدخول بحساب التجربة")
    expect(p).toContain("الصفحة: Login — http://localhost:3000/login")
    expect(p).toContain("نصُّ الصفحة (مقتطف): مرحباً بك")
    expect(p).toContain("1) fill — textbox «البريد» [r2]")
    expect(p).toContain("2) tap — button «دخول» [r4]")
    expect(p).toContain("fill <رقم المرشّح> :: <النصّ الذي يُكتب>")
  })
})

describe("browser next step — strict parsing and the executable command", () => {
  const c = candidatesFrom(tree)
  test("accepts exactly the five shapes, tolerates fences and spaces, and maps to the right ref", () => {
    expect(parseNextStep("tap 2", c)).toEqual({ kind: "tap", candidate: c[1]! })
    expect(commandFor(parseNextStep("tap 2", c)!)).toBe("tap r4")
    expect(parseNextStep("```\nfill 1 :: demo@example.com\n```", c)).toEqual({ kind: "fill", candidate: c[0]!, text: "demo@example.com" })
    expect(commandFor(parseNextStep("fill 1 :: demo@example.com", c)!)).toBe("fill r2 demo@example.com")
    expect(parseNextStep("SCROLL", c)).toEqual({ kind: "scroll" })
    expect(parseNextStep("done :: الحساب ظاهر في الزاوية", c)).toEqual({ kind: "done", why: "الحساب ظاهر في الزاوية" })
    expect(parseNextStep("blocked :: صفحة 500", c)).toEqual({ kind: "blocked", why: "صفحة 500" })
    expect(commandFor({ kind: "done", why: "x" })).toBeUndefined()
  })
  test("refuses out-of-range numbers, fill on a non-fillable or sensitive element, empty text, and prose (no guessing)", () => {
    expect(parseNextStep("tap 9", c)).toBeUndefined()
    expect(parseNextStep("fill 2 :: x", c)).toBeUndefined()
    expect(parseNextStep("fill 1 ::   ", c)).toBeUndefined()
    expect(parseNextStep("أعتقد أن الزر الثاني مناسب", c)).toBeUndefined()
    expect(parseNextStep("tap 2 لأنّه زر الدخول", c)).toBeUndefined()
    // r3 (كلمة المرور) ليس مرشّحاً أصلاً
    expect(c.some((x) => x.ref === "r3")).toBe(false)
  })
  test("the receipt names the judge and the chosen action, or lists the candidates when unjudged", () => {
    expect(renderNextStep(parseNextStep("tap 2", c), c, "fx/judge", "tap 2")).toBe("🧠 الخطوةُ التالية (نموذج القرار fx/judge): tap r4 — button «دخول»")
    const unjudged = renderNextStep(undefined, c, "fx/judge", "ربّما الزرّ")
    expect(unjudged).toContain("غيرُ محكّم")
    expect(unjudged).toContain("1) fill textbox «البريد» [r2]")
  })
})
