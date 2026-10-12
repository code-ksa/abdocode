/** 10-10 — the reference-clone brief appears only when the request names a site to rebuild, and it names the tools in order. */
import { expect, test } from "bun:test"
import { asksReferenceClone, referenceCloneBrief } from "../src/reference-clone"

test("a site to rebuild after a live reference gets the ordered brief", () => {
  for (const ask of ["اعمل موقع مثل n8n بجميع خصائصه والداشبورد", "ابني نسخة من موقع stripe.com", "clone linear.app dashboard with auth", "خذ ريفرنس التصميم من الموقع"]) expect(asksReferenceClone(ask)).toBe(true)
  const brief = referenceCloneBrief("اعمل موقع مثل n8n.io بجميع خصائصه")
  for (const step of ["page save", "Copy element", "REFERENCE.md", "handoff", "ABDO-SPRINTS.md", "project-template", "Prisma", "design compare"]) expect(brief).toContain(step)
  expect(brief.indexOf("page save")).toBeLessThan(brief.indexOf("ABDO-SPRINTS.md"))
})

test("the twin: ordinary work does not carry it", () => {
  for (const ask of ["اجعل الزر مثل الآخر", "اكتب دالة sort", "أصلح خطأ البناء", "like this, but shorter"]) {
    expect(asksReferenceClone(ask)).toBe(false)
    expect(referenceCloneBrief(ask)).toBe("")
  }
})
