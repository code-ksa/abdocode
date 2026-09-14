/**
 * S13.5 — إصلاح عيب: التحرير يطابق موضعاً واحداً، أو نيّةً معلَنة بكلّ المواضع.
 *
 * البرهانُ الحاسم هو `SILENT FIRST-MATCH`: يعيد بناء السلوك القديم حرفياً
 * (`includes` ثمّ `String.replace`) ويثبت أنه يكتب ملفّاً مختلفاً عمّا يكتبه
 * الحاليّ — فلو رُدّ الكود القديم سقط هذا الاختبار.
 */
import { describe, expect, test } from "bun:test"
import { EDIT_ALL_FLAG, applyEdit, countOccurrences, parseEditCommand } from "../src/edit-match"
import { writeTargetOf } from "../src/turn-memory"

const FILE = ["const a = value", "const b = value", "const c = value"].join("\n")

describe("edit — التطابق الفريد شرط", () => {
  test("SILENT FIRST-MATCH: the old behaviour edited occurrence #1 and said nothing", () => {
    // السلوك القديم بنصّه — هو نفسه ما كان في `runWriteToolV`:
    const legacy = FILE.includes("value") ? FILE.replace("value", "NEW") : FILE
    expect(legacy).toBe(["const a = NEW", "const b = value", "const c = value"].join("\n"))
    // والسلوك الحاليّ يرفض بدل أن يكتب هذا الملفّ.
    const now = applyEdit(FILE, { oldText: "value", newText: "NEW", all: false })
    expect(now.ok).toBe(false)
    if (now.ok) throw new Error("unreachable")
    expect(now.occurrences).toBe(3)
    expect(now.why).toContain("3 مواضع")
    expect(now.why).toContain(EDIT_ALL_FLAG)
  })

  test("a UNIQUE old text still edits, exactly once", () => {
    const applied = applyEdit(FILE, { oldText: "const b = value", newText: "const b = NEW", all: false })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error("unreachable")
    expect(applied.replaced).toBe(1)
    expect(applied.after).toBe(["const a = value", "const b = NEW", "const c = value"].join("\n"))
  })

  test("--all is the ONLY way to mean every occurrence, and it replaces them all", () => {
    const applied = applyEdit(FILE, { oldText: "value", newText: "NEW", all: true })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error("unreachable")
    expect(applied.replaced).toBe(3)
    expect(countOccurrences(applied.after, "NEW")).toBe(3)
    expect(countOccurrences(applied.after, "value")).toBe(0)
  })

  test("absent and empty old text are refused by their own names", () => {
    expect(applyEdit(FILE, { oldText: "missing", newText: "x", all: false })).toMatchObject({ ok: false, occurrences: 0 })
    expect(applyEdit(FILE, { oldText: "", newText: "x", all: false })).toMatchObject({ ok: false, occurrences: 0 })
    // و«كل المواضع» لا تخترع موضعاً غير موجود.
    expect(applyEdit(FILE, { oldText: "missing", newText: "x", all: true }).ok).toBe(false)
  })

  test("the replacement is LITERAL: `$&` and `$1` are text, not back-references", () => {
    // السلوك القديم كان يفسّرها (String.replace بسلسلة) فيكتب غير ما طُلب.
    const legacy = "a-TOKEN-b".replace("TOKEN", "[$&]")
    expect(legacy).toBe("a-[TOKEN]-b")
    const applied = applyEdit("a-TOKEN-b", { oldText: "TOKEN", newText: "[$&]", all: false })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error("unreachable")
    expect(applied.after).toBe("a-[$&]-b")
  })
})

describe("edit — تحليل الأمر", () => {
  test("the classic and unspaced forms both parse", () => {
    expect(parseEditCommand("app/page.tsx :: old => new")).toEqual({ target: "app/page.tsx", oldText: "old", newText: "new", all: false })
    expect(parseEditCommand("app/page.tsx::old => new")).toEqual({ target: "app/page.tsx", oldText: "old", newText: "new", all: false })
  })

  test("--all is parsed off the head, before and without disturbing the path", () => {
    expect(parseEditCommand("app/page.tsx --all :: old => new")).toEqual({ target: "app/page.tsx", oldText: "old", newText: "new", all: true })
    expect(parseEditCommand("--all app/page.tsx :: old => new")).toMatchObject({ target: "app/page.tsx", all: true })
  })

  // ب10 — المسمارُ يُرفع لا يُحذف: كان «أوّلُ سهمٍ يفصل» يحفظ البديلَ كاملاً (وهو صحيح)، لكنّه يقسم **النصّ
  // القديم** على سهمِ نفسِه حين يحمل دالّةً سهميّة — فيُكتب مشوّهاً ويُروى نجاحاً. فالالتباسُ صار رفضاً،
  // والفاصلُ الصريح (سطرٌ فيه «=>» وحدها، كما في medit) يقبل الطرفين مهما حملا من أسهم.
  test("an ambiguous arrow is refused, and the line-only separator carries arrows on both sides", () => {
    const ambiguous = parseEditCommand("a.ts :: x => (y) => y + 1")
    expect(typeof ambiguous).toBe("string")
    expect(ambiguous as string).toContain("medit")
    // الشكلُ الصريح: سطرٌ لا يحمل إلا «=>» — الطرفان يصلان كاملين وفيهما أسهم.
    const explicit = parseEditCommand("a.ts :: const ids = rows.map(r => r.id)\n=>\nconst ids = rows.map((r) => r.id ?? 0)")
    expect(explicit).toMatchObject({ target: "a.ts", oldText: "const ids = rows.map(r => r.id)", newText: "const ids = rows.map((r) => r.id ?? 0)" })
    // وسهمٌ واحدٌ في السطر لا يلتبس فيبقى مقبولاً كما كان.
    expect(parseEditCommand("a.ts :: old => new")).toMatchObject({ oldText: "old", newText: "new" })
    // والسلوكُ القديم كان يبتر ما بعد السهم الثاني بصمت — يبقى مذكوراً لأنّه سببُ القاعدة.
    const legacy = "x => (y) => y + 1".split("=>")
    expect(legacy[1]!.trim()).toBe("(y)")
  })

  test("malformed commands are refused with the usage line", () => {
    for (const bad of ["", "a.ts", "a.ts :: old", ":: old => new", `${EDIT_ALL_FLAG} :: old => new`]) {
      const parsed = parseEditCommand(bad)
      expect(typeof parsed).toBe("string")
    }
    // رايةٌ غيرُ معروفة تبقى رفضاً بالاسم — على طرفَي الرأس كليهما.
    expect(parseEditCommand("a.ts --every :: old => new")).toContain("رايةٌ غير معروفة")
    expect(parseEditCommand("--every a.ts :: old => new")).toContain("رايةٌ غير معروفة")
  })

  test("REGRESSION: a path WITH SPACES parses — the shape `patch` builds from `*** Update File:`", () => {
    // الكود القديم (قبل هذه الوحدة) كان يأخذ كلَّ ما قبل `::` مساراً، فمسارٌ
    // ذو فراغاتٍ يُحرَّر. أوّلُ نسخةٍ من الوحدة قصّت الرأس على الفراغ فرفضته،
    // بينما المسارُ المنظَّم (`args.path` في cli.ts) يقبله — مفردتان لمسارٍ واحد.
    expect(parseEditCommand("docs/my notes.md :: old => new")).toEqual({ target: "docs/my notes.md", oldText: "old", newText: "new", all: false })
    expect(parseEditCommand(`docs/my notes.md ${EDIT_ALL_FLAG} :: old => new`)).toEqual({ target: "docs/my notes.md", oldText: "old", newText: "new", all: true })
  })

  test("ONE READER: parseEditCommand and writeTargetOf name the SAME file, flag first or last", () => {
    // العطلُ المقيس: `writeTargetOf` كان يأخذ أوّل كلمةٍ فيسمّي `--all` ملفّاً،
    // فتُخزَّن «wrote:--all» حقيقةً دائمةً عن ملفٍّ لا وجود له، وتُحقن لاحقاً.
    for (const command of [
      "edit f.ts :: a => b",
      `edit ${EDIT_ALL_FLAG} f.ts :: a => b`,
      `edit f.ts ${EDIT_ALL_FLAG} :: a => b`,
      "edit docs/my notes.md :: a => b",
      `edit docs/my notes.md ${EDIT_ALL_FLAG} :: a => b`,
    ]) {
      const parsed = parseEditCommand(command.replace(/^edit\s+/u, ""))
      if (typeof parsed === "string") throw new Error(`refused: ${parsed}`)
      expect(writeTargetOf(command)).toBe(parsed.target)
      expect(writeTargetOf(command)).not.toBe(EDIT_ALL_FLAG)
    }
  })
})
