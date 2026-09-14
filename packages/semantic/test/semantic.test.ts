import { describe, expect, test } from "bun:test"
import { detectDialect, detectLanguage, fold, parseFileIntent, semanticFrame, stems, describeFrame, type Dialect, type FileAction, type TargetKind } from "../src/index"

/**
 * المجموعةُ الذهبية — نقيّةٌ (لا قرص، لا نموذج، لا شبكة) فتعمل مع كلّ إيداع في ملّي ثوانٍ.
 *
 * كلُّ صفٍّ طلبٌ كما يقوله مستخدمٌ حقيقيّ بلهجته، ومعه ما يجب أن يفهمه المحرّك حتمياً.
 * الصفوفُ **محجوبةٌ عن التصميم**: كُتبت بعد القواميس بلغة الناس لا بلغة القواميس، فما
 * يفشل منها يكشف ثقباً في القاموس لا خطأً في الصفّ.
 */

// الصفُّ يحمل الأنواعَ الحقيقيّة لا `string`: لهجةٌ أو فعلٌ مكتوبٌ خطأً في المجموعة الذهبية يسقط في البوّابة لا في التشغيل.
type Row = { readonly text: string; readonly language: "ar" | "en" | "mixed"; readonly dialect: Dialect; readonly action: FileAction; readonly kind?: TargetKind; readonly target?: string }

const GOLDEN: readonly Row[] = [
  // ── مصرية ──
  { text: "فين مجلد الفواتير؟", language: "ar", dialect: "egyptian", action: "find", kind: "folder", target: "الفواتير" },
  { text: "عايز اعمل فولدر جديد اسمه تقارير", language: "ar", dialect: "egyptian", action: "create", kind: "folder", target: "تقارير" },
  { text: "افتحلي ملف الاعدادات ده", language: "ar", dialect: "egyptian", action: "open", kind: "file", target: "الاعدادات" },
  { text: "امسح الفايل بتاع التجربة خالص", language: "ar", dialect: "egyptian", action: "delete", kind: "file", target: "بتاع التجربة" },
  { text: "ازاي الاقي مجلد الصور؟", language: "ar", dialect: "egyptian", action: "find", kind: "folder", target: "الصور" },
  { text: "هات لي الملفات اللي في مجلد المشروع دلوقتي", language: "ar", dialect: "egyptian", action: "list", kind: "file" },
  { text: "عاوز افتح المشروع بتاع المطعم", language: "ar", dialect: "egyptian", action: "open", kind: "project", target: "بتاع المطعم" },
  { text: "اعمللي ملف اسمه notes.md", language: "ar", dialect: "egyptian", action: "create", kind: "file", target: "notes.md" },
  { text: "وريني ايه اللي جوه فولدر الداتا", language: "ar", dialect: "egyptian", action: "list", kind: "folder", target: "الداتا" },
  { text: "غيرلي اسم الملف ده لـ index.html", language: "ar", dialect: "egyptian", action: "edit", kind: "file", target: "index.html" },
  { text: "لسه مش لاقي مجلد الباك اند", language: "ar", dialect: "egyptian", action: "find", kind: "folder", target: "الباك اند" },
  { text: "شيل المجلد القديم بتاع الاختبارات", language: "ar", dialect: "egyptian", action: "delete", kind: "folder", target: "القديم بتاع الاختبارات" },
  // ── خليجية / سعودية ──
  { text: "وين مجلد الفواتير؟", language: "ar", dialect: "gulf", action: "find", kind: "folder", target: "الفواتير" },
  { text: "ابغى اسوي فولدر جديد اسمه تقارير", language: "ar", dialect: "gulf", action: "create", kind: "folder", target: "تقارير" },
  { text: "افتح لي ملف الاعدادات الحين", language: "ar", dialect: "gulf", action: "open", kind: "file", target: "الاعدادات" },
  { text: "وش فيه داخل مجلد المشروع؟", language: "ar", dialect: "gulf", action: "list", kind: "folder", target: "المشروع" },
  { text: "سويلي ملف اسمه config.json", language: "ar", dialect: "gulf", action: "create", kind: "file", target: "config.json" },
  { text: "ودي اشوف وين ملف الباكج", language: "ar", dialect: "gulf", action: "find", kind: "file", target: "الباكج" },
  { text: "امسح هالمجلد زين", language: "ar", dialect: "gulf", action: "delete", kind: "folder" },
  { text: "ياخي وين راح ملف السكربت؟", language: "ar", dialect: "gulf", action: "find", kind: "file", target: "السكربت" },
  { text: "ايش الملفات اللي في الريبو؟", language: "ar", dialect: "gulf", action: "list", kind: "file" },
  { text: "ابي افتح مشروع المتجر", language: "ar", dialect: "gulf", action: "open", kind: "project", target: "المتجر" },
  { text: "عدل لي ملف الـ package.json", language: "ar", dialect: "msa", action: "edit", kind: "file", target: "package.json" },
  { text: "روح لمجلد السورس على طول", language: "ar", dialect: "gulf", action: "open", kind: "folder", target: "السورس" },
  // ── شامية ──
  { text: "وين مجلد الفواتير؟ بدي افتحه", language: "ar", dialect: "levantine", action: "find", kind: "folder", target: "الفواتير" },
  { text: "بدي اعمل فولدر جديد اسمه تقارير", language: "ar", dialect: "levantine", action: "create", kind: "folder", target: "تقارير" },
  { text: "شو في جوا مجلد المشروع؟", language: "ar", dialect: "levantine", action: "list", kind: "folder", target: "المشروع" },
  { text: "افتحلي ملف الاعدادات هلق", language: "ar", dialect: "levantine", action: "open", kind: "file", target: "الاعدادات" },
  { text: "بدك تمسح هالملف؟ لا، بدي اعدله", language: "ar", dialect: "levantine", action: "delete", kind: "file" },
  { text: "كتير ملفات هون، وريني بس ملفات الـ css", language: "ar", dialect: "levantine", action: "list", kind: "file" },
  { text: "ليش ما عم لاقي مجلد الصور؟", language: "ar", dialect: "levantine", action: "find", kind: "folder", target: "الصور" },
  { text: "تعا افتح مشروع المدرسة", language: "ar", dialect: "levantine", action: "open", kind: "project", target: "المدرسة" },
  // ── مغاربية ──
  { text: "فين كاين مجلد الفواتير؟", language: "ar", dialect: "maghrebi", action: "find", kind: "folder" },
  { text: "بغيت نصاوب فولدر جديد سميتو تقارير", language: "ar", dialect: "maghrebi", action: "create", kind: "folder" },
  { text: "واش كاين شي ملف ديال الاعدادات؟", language: "ar", dialect: "maghrebi", action: "find", kind: "file" },
  { text: "دابا حل لي ملف config.json", language: "ar", dialect: "maghrebi", action: "open", kind: "file", target: "config.json" },
  { text: "كيفاش نلقى مجلد الصور؟", language: "ar", dialect: "maghrebi", action: "find", kind: "folder", target: "الصور" },
  { text: "بزاف ديال الملفات هنا، شحال كاينين؟", language: "ar", dialect: "maghrebi", action: "none", kind: "file" },
  // ── عراقية ──
  { text: "وين مجلد الفواتير؟ شكو بيه؟", language: "ar", dialect: "iraqi", action: "find", kind: "folder", target: "الفواتير" },
  { text: "سوي لي فولدر جديد اسمه تقارير هسه", language: "ar", dialect: "iraqi", action: "create", kind: "folder", target: "تقارير" },
  { text: "شنو الملفات اللي بمجلد المشروع؟", language: "ar", dialect: "iraqi", action: "list", kind: "file" },
  { text: "اكو ملف اسمه readme؟ افتحه", language: "ar", dialect: "iraqi", action: "open", kind: "file", target: "readme" },
  { text: "خوش، امسح هذا الملف هوايه كبير", language: "ar", dialect: "iraqi", action: "delete", kind: "file" },
  // ── فصحى ──
  { text: "أين يقع مجلد الفواتير؟", language: "ar", dialect: "msa", action: "find", kind: "folder", target: "الفواتير" },
  { text: "أريد إنشاء مجلد جديد باسم تقارير", language: "ar", dialect: "msa", action: "create", kind: "folder", target: "تقارير" },
  { text: "افتح ملف الإعدادات من فضلك", language: "ar", dialect: "msa", action: "open", kind: "file", target: "الإعدادات" },
  { text: "ما هي الملفات الموجودة في المجلد الحالي؟", language: "ar", dialect: "msa", action: "list", kind: "file" },
  { text: "احذف الملف المؤقت الآن", language: "ar", dialect: "msa", action: "delete", kind: "file", target: "المؤقت" },
  { text: "قم بتعديل ملف package.json", language: "ar", dialect: "msa", action: "edit", kind: "file", target: "package.json" },
  { text: "اعرض محتويات مجلد src", language: "ar", dialect: "msa", action: "list", kind: "folder", target: "src" },
  { text: "أنشئ مجلداً باسم «الفواتير القديمة»", language: "ar", dialect: "msa", action: "create", kind: "folder", target: "الفواتير القديمة" },
  // ── تبديلُ خطّ ومعرّفات ──
  { text: "افتح ملف app/page.tsx", language: "ar", dialect: "msa", action: "open", kind: "file", target: "app/page.tsx" },
  { text: "فين الـ .env بتاع المشروع؟", language: "ar", dialect: "egyptian", action: "find", kind: "file", target: ".env" },
  { text: "سوي folder اسمه assets داخل public", language: "ar", dialect: "gulf", action: "create", kind: "folder", target: "assets" },
  { text: "وين راح مجلد node_modules؟", language: "ar", dialect: "gulf", action: "find", kind: "folder", target: "node_modules" },
  // ── إنجليزية ──
  { text: "where is the invoices folder?", language: "en", dialect: "unknown", action: "find", kind: "folder", target: "invoices" },
  { text: "create a new file named notes.md", language: "en", dialect: "unknown", action: "create", kind: "file", target: "notes.md" },
  { text: "open src/index.ts", language: "en", dialect: "unknown", action: "open", kind: "file", target: "src/index.ts" },
  { text: "delete the temp directory", language: "en", dialect: "unknown", action: "delete", kind: "folder", target: "temp" },
  // ── متابعةٌ (استئناف) — ثقبٌ قيس 2026-09-06: كانت كلُّها action none ──
  { text: "كمّل لي مشروع المتجر الحين", language: "ar", dialect: "gulf", action: "resume", kind: "project", target: "المتجر" },
  { text: "استكمل مشروع المدرسة من حيث توقفت", language: "ar", dialect: "msa", action: "resume", kind: "project", target: "المدرسة" },
  { text: "تابع مشروع المطعم بقى", language: "ar", dialect: "egyptian", action: "resume", kind: "project", target: "المطعم" },
  { text: "واصل على مشروع الفواتير هلق", language: "ar", dialect: "levantine", action: "resume", kind: "project", target: "الفواتير" },
  { text: "ارجع لمشروع الحديقة", language: "ar", dialect: "msa", action: "resume", kind: "project", target: "الحديقة" },
  { text: "continue project rodud", language: "en", dialect: "unknown", action: "resume", kind: "project", target: "rodud" },
  { text: "pick up the invoices project", language: "en", dialect: "unknown", action: "resume", kind: "project", target: "invoices" },
  // التوأمُ السلبيّ: «التابع» صفةٌ هنا لا فعل — أوّلُ فعلٍ حقيقيّ («فين») يحكم، فلا تنقلب المتابعةُ على العثور.
  { text: "فين الملف التابع للمشروع", language: "ar", dialect: "egyptian", action: "find", kind: "file" },
  { text: "list files in the project", language: "en", dialect: "unknown", action: "list", kind: "file" },
]

describe("التطبيع", () => {
  test("يطوي التشكيل والهمزات والتاء المربوطة والألف المقصورة والأرقام الهندية", () => {
    expect(fold("أَنْشِئْ مُجَلَّدًا")).toBe("انشي مجلدا")
    expect(fold("الفَواتيرُ ٢٠٢٦")).toBe("الفواتير 2026")
    expect(fold("مَكْتَبَة   ")).toBe("مكتبه")
    expect(fold("إلى الأعلى")).toBe("الي الاعلي")
  })
  test("الجذعُ بلا أداة: «وللفواتير» تعطي «فواتير»، و«هات» لا تصير «ات»", () => {
    expect(stems("وللفواتير")).toContain("فواتير")
    expect(stems("بالملفات")).toContain("ملفات")
    // أداةٌ فوق أداةٍ غيرِ مُدرَجةٍ مركّبةً: «وكالمجلد» = و + كال + مجلد — تحتاج مرورين.
    expect(stems("وكالمجلد")).toContain("مجلد")
    expect(stems("هات")).toEqual(["هات"])
    expect(stems("ملفه")).toContain("ملف")
  })
})

describe("اللغة", () => {
  test("عربية، إنجليزية، ومختلطة بتبديل", () => {
    expect(detectLanguage("افتح مجلد الفواتير").language).toBe("ar")
    expect(detectLanguage("open the invoices folder").language).toBe("en")
    const mixed = detectLanguage("افتح ملف config.json")
    expect(mixed.language).toBe("ar")
    expect(mixed.codeSwitch).toBe(true)
    expect(detectLanguage("12345 ???").language).toBe("unknown")
  })
})

describe("اللهجة", () => {
  test("كلُّ لهجةٍ تُعرف بعلاماتها، والدليلُ يخرج مع الحكم", () => {
    const eg = detectDialect("عايز افتح الملف ده دلوقتي")
    expect(eg.dialect).toBe("egyptian")
    expect(eg.evidence.map((e) => e.token)).toContain("عايز")
    expect(detectDialect("وش فيه بالمجلد الحين").dialect).toBe("gulf")
    expect(detectDialect("شو بدك تعمل هلق").dialect).toBe("levantine")
    expect(detectDialect("واش بغيت دابا").dialect).toBe("maghrebi")
    expect(detectDialect("شكو ماكو هسه").dialect).toBe("iraqi")
    expect(detectDialect("ماذا تريد الآن؟").dialect).toBe("msa")
  })
  test("عربيةٌ بلا علامةٍ عاميّة: فصحى بثقةٍ منخفضة — لا مجهول", () => {
    const r = detectDialect("افتح مجلد الفواتير")
    expect(r.dialect).toBe("msa")
    expect(r.confidence).toBe(0.3)
  })
  test("غيرُ العربية مجهولٌ — لا نحزر لهجةَ ما ليس عربياً", () => {
    expect(detectDialect("open the folder", false).dialect).toBe("unknown")
  })
  test("التعادلُ التامّ يُحسم باللهجة الأمّ ويُعلَن، لا يُحزر", () => {
    // «وين» مشتركة بوزنٍ واحد بين ثلاث — لا تحسم وحدها، فتحسمها الأمّ (خليجية افتراضاً).
    const r = detectDialect("وين المجلد")
    expect(r.dialect).toBe("gulf")
    expect(r.tieBreak).toBe(true)
    expect(r.confidence).toBe(0.3)
    expect(detectDialect("وين المجلد", true, { home: "levantine" }).dialect).toBe("levantine")
    // أمٌّ خارج المتعادلين ⇦ فصحى بثقةٍ منخفضة.
    expect(detectDialect("وين المجلد", true, { home: "egyptian" }).dialect).toBe("msa")
  })
})

describe("الفعل والهدف", () => {
  test("الفعلُ الأول في الجملة يحكم والباقي دليل", () => {
    const i = parseFileIntent("افتح المجلد وبعدين سوي فيه ملف")
    expect(i.action).toBe("open")
    expect(i.evidence.some((e) => e.includes("create"))).toBe(true)
  })
  test("الهدفُ يُقتطع بالترتيب: اقتباس ⇦ اسمه ⇦ معرّف ⇦ بعد النوع", () => {
    expect(parseFileIntent("انشئ مجلد «تقارير 2026»").target).toBe("تقارير 2026")
    expect(parseFileIntent("انشئ ملف اسمه readme.md").target).toBe("readme.md")
    expect(parseFileIntent("افتح app/layout.tsx").target).toBe("app/layout.tsx")
    expect(parseFileIntent("افتح مجلد الفواتير في المشروع").target).toBe("الفواتير")
  })
  test("جذوعُ الهدف تطوي الأدوات كي تطابق اسمَ المجلّد الحقيقيّ", () => {
    expect(parseFileIntent("فين مجلد الفواتير").targetStems).toContain("فواتير")
  })
  test("النوعُ من شكل الهدف حين غاب اسمُه", () => {
    expect(parseFileIntent("افتح src/lib").kind).toBe("folder")
    expect(parseFileIntent("افتح .env").kind).toBe("file")
  })
  test("جملةٌ بلا فعلٍ معروف تُعلن none لا تحزر", () => {
    const i = parseFileIntent("الفواتير القديمة")
    expect(i.action).toBe("none")
    expect(i.confidence).toBe(0)
  })
})

describe("المجموعة الذهبية", () => {
  for (const row of GOLDEN) {
    test(`«${row.text}»`, () => {
      const f = semanticFrame(row.text)
      expect(f.language.language, "language").toBe(row.language)
      expect(f.dialect.dialect, `dialect — evidence ${JSON.stringify(f.dialect.evidence.map((e) => e.token))}`).toBe(row.dialect)
      expect(f.intent.action, `action — evidence ${JSON.stringify(f.intent.evidence)}`).toBe(row.action)
      if (row.kind !== undefined) expect(f.intent.kind, "kind").toBe(row.kind)
      if (row.target !== undefined) expect(f.intent.target, `target — evidence ${JSON.stringify(f.intent.evidence)}`).toBe(row.target)
    })
  }
  test("الإطارُ يُعلن غيابَ الاستنتاج ولا يدّعيه", () => {
    const f = semanticFrame("فين مجلد الفواتير؟")
    expect(f.inferred).toBeUndefined()
    expect(describeFrame(f)).toContain("استنتاج: لم يُشغَّل")
  })
})
