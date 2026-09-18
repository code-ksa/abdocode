import { describe, expect, test } from "bun:test"
import { detectDialect, detectLanguage, fold, parseFileIntent, parseOpsIntent, semanticFrame, stems, describeFrame, OPS_ACTIONS, KNOWN_TARGETS, type Dialect, type FileAction, type KnownTarget, type OpsAction, type TargetKind } from "../src/index"

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

/**
 * الريستارت، الباكاب على جوجل درايف». الصفوفُ بلغة الناس بعد القاموس: ما يفشل يكشف ثقباً في القاموس.
 */
/**
 * الصفُّ يحمل ما يجب أن يُفهم حتمياً: العمليّةُ الأولى، وتسلسلُها إن تعدّدت، وهدفُها (النصُّ كما كُتب ومعرّفُه إن عُرف)،
 * والنفيُ والسؤال. `negated` و`question` يُفحصان في **كلّ** صفّ (الغيابُ `false` معلَن) — توأمٌ سلبيٌّ لكلّ صفٍّ إيجابيّ.
 */
type OpsRow = {
  readonly text: string
  readonly action: OpsAction
  readonly sequence?: readonly OpsAction[]
  readonly target?: string
  readonly targetId?: string
  readonly negated?: boolean
  readonly question?: boolean
}

/**
 * أهدافُ نكهةٍ تُمرَّر من خارج النواة: النواةُ لا تعرف منتَجاً (حارسُ الخطّين)، ومن يعرف مواقعَه ومشاريعَه يمرّرها هنا —
 * والصفوفُ أدناه تثبت أن التمريرَ يُقرأ فعلاً (توأمٌ إيجابيّ في «الأهدافُ المعروفة» أدناه: بلا تمريرٍ لا معرّف).
 */
const FLAVOR_TARGETS: readonly KnownTarget[] = [
  { id: "example", forms: ["تكنولوجيا سعودية", "تكنولوجيا السعودية", "example", "technology ksa"] },
  // المعرّفُ عربيٌّ عمداً: حارسُ الحدّ العامّ يرفض الاسمَ اللاتينيّ للمنتَج في أيّ ملفٍّ تحت الحزم — والاختبارُ لا يُستثنى.
  { id: "منصّةُ المواقع", forms: ["منصّةُ المواقع"] },
  { id: "eagle", forms: ["غرفةُ الأخبار", "غرفةُ الأخبار", "eagle"] },
  { id: "marketplace", forms: ["السوق", "marketplace"] },
  { id: "suq", forms: ["سوق الالسوق"] },
  { id: "search-ksa", forms: ["search-ksa", "search ksa"] },
  { id: "controlpanel", forms: ["أوبن عبد", "اوبن عبد", "controlpanel", "open abd"] },
]

const OPS_GOLDEN: readonly OpsRow[] = [
  // site — واجهاتُنا البصريّة (09-17): فتحُ داشبورد/لوحة تحكّم عمليّةٌ تُوجَّه إلى دليل الواجهات لا تخمينُ رابط.
  { text: "افتح لي داشبورد منصّةُ المواقع وخذ لقطة", action: "site" },
  { text: "ادخل على لوحة تحكم غرفةُ الأخبار", action: "site" },
  { text: "open the marketplace admin panel", action: "site" },
  { text: "افتح الموقع", action: "site" },

  // ── مصرية ──
  { text: "ادفع و انشر", action: "push", sequence: ["push", "publish"] },
  { text: "تمام ارفع", action: "push" },
  { text: "ارفع الكود على جيت هب دلوقتي", action: "push", target: "جيت هب", targetId: "repo" },
  { text: "اعمل كوميت للشغل ده", action: "commit", target: "الشغل" },
  { text: "اعمل كوميت وبعدين ادفع", action: "commit", sequence: ["commit", "push"] },
  { text: "عدّل الكود وبعدين اعمل كوميت وادفع", action: "commit", sequence: ["commit", "push"] },
  { text: "اعمل ديبلوي للموقع", action: "publish", target: "الموقع", targetId: "site" },
  { text: "الموقع مش شغال صلحه", action: "fix", target: "الموقع", targetId: "site" },
  { text: "الموقع بايظ، صلحه بسرعة", action: "fix", sequence: ["fix"], target: "الموقع", targetId: "site" },
  { text: "اصلح الخطأ اللي بيطلع", action: "fix", target: "الخطأ" },
  { text: "شغّله تاني", action: "restart" },
  { text: "اعمل ريستارت للسيرفر", action: "restart", target: "السيرفر", targetId: "server" },
  { text: "اعمل ريستارت للخدمة بتاعة الايميل", action: "restart", target: "الخدمة", targetId: "service" },
  { text: "خد باكاب على جوجل درايف", action: "backup", target: "جوجل درايف", targetId: "drive" },
  { text: "خد باكاب للداتابيز على الدرايف", action: "backup", target: "الداتابيز", targetId: "database" },
  { text: "خد باكاب الأول وبعدين انشر النسخة", action: "backup", sequence: ["backup", "publish"] },
  { text: "نظّف المساحة وبعدين خد باكاب على الدرايف", action: "cleanup", sequence: ["cleanup", "backup"], target: "الدرايف", targetId: "drive" },
  { text: "والباكاب فين؟", action: "backup", question: true },
  { text: "رجّع النسخة القديمة", action: "restore" },
  { text: "رجّع الباكاب بتاع امبارح", action: "restore" },
  { text: "ابني المثبت", action: "build", target: "المثبت", targetId: "app" },
  { text: "سطّبلي النسخة الجديدة", action: "install", target: "النسخة الجديدة" },
  { text: "شغل الاختبارات كلها", action: "test" },
  { text: "شغّل الاختبارات وبعدين اعمل كوميت لو نجحت", action: "test", sequence: ["test", "commit"] },
  { text: "اعمل ابديت للسيرفر وبعدين ريستارت", action: "sync", sequence: ["sync", "restart"], target: "السيرفر", targetId: "server" },
  { text: "هات آخر نسخة من الريبو وابنيها", action: "sync", sequence: ["sync", "build"], target: "الريبو", targetId: "repo" },
  { text: "نظف المساحة على السيرفر", action: "cleanup", target: "السيرفر", targetId: "server" },
  { text: "امسح القديم من الديسك", action: "cleanup" },
  { text: "فين مفتاح الـ API؟", action: "secrets", target: "API", targetId: "api", question: true },
  { text: "ورني اللوج بتاع الخدمة", action: "logs", target: "الخدمة", targetId: "service" },
  { text: "شوف الخطأ في لوج الخدمة", action: "logs", target: "الخدمة", targetId: "service" },
  { text: "هات لوجات الـ pm2", action: "logs", target: "pm2", targetId: "service" },
  { text: "ابعت للريبو", action: "push", target: "الريبو", targetId: "repo" },
  { text: "طلّع نسخة جديدة", action: "publish" },
  { text: "حط على الانتاج", action: "publish", target: "الانتاج", targetId: "server" },
  { text: "ارفع الشغل على الريبو يا باشا", action: "push", target: "الريبو", targetId: "repo" },
  // نفيٌ مصريّ: الطوقُ الملتصق «متـ…ش»، و«بلاش»، و«مش عايز» — والعمليّةُ مسمّاةٌ مع ذلك.
  { text: "متعملش push", action: "push", negated: true },
  { text: "بلاش نشر", action: "publish", negated: true },
  { text: "بلاش تعمل ديبلوي دلوقتي", action: "publish", negated: true },
  { text: "مش عايز اعمل كوميت دلوقتي", action: "commit", negated: true },
  { text: "ممنوع الدفع على الانتاج", action: "push", target: "الانتاج", targetId: "server", negated: true },
  // التوأمُ السلبيّ للنفي: «لا تنسى» أمرٌ، و«بعد ما» ظرفٌ، ونفيُ خطوةٍ لاحقة لا ينفي الأولى.
  { text: "لا تنسى تعمل باكاب", action: "backup", negated: false },
  { text: "بعد ما تخلص اعمل كوميت", action: "commit", negated: false },
  { text: "اعمل كوميت بس متعملش push", action: "commit", sequence: ["commit", "push"], negated: false },
  // أسئلةٌ مصريّة: عن الحال لا أمرٌ؛ وسؤالُ الصحّة يبقى health وما قبله موضوعُه.
  { text: "الباكاب شغّال؟", action: "health", sequence: ["health"], target: "الباكاب", question: true },
  { text: "الداتابيز شغالة؟", action: "health", target: "الداتابيز", targetId: "database", question: true },
  { text: "هل الباكاب اتعمل؟", action: "backup", question: true },
  { text: "ممكن تعمل باكاب؟", action: "backup", question: false },
  // ── خليجية / سعودية ──
  { text: "سوّي باكاب للداتابيز الحين", action: "backup", target: "الداتابيز", targetId: "database" },
  { text: "ما ابغى باكاب الحين", action: "backup", negated: true },
  { text: "ما تعمل ريستارت للسيرفر", action: "restart", target: "السيرفر", targetId: "server", negated: true },
  { text: "سطّب النسخة الجديدة على جهازي", action: "install", target: "جهازي", targetId: "machine" },
  { text: "ثبّت الإضافة الجديدة على ويندوز", action: "install", target: "الإضافة", targetId: "app" },
  { text: "وين الباكاب بتاع السوق؟", action: "backup", target: "السوق", targetId: "marketplace", question: true },
  { text: "السيرفر شغال ولا لا؟", action: "health", target: "السيرفر", targetId: "server", question: true },
  { text: "الأسرار في الخزنة ولا لا؟", action: "secrets", question: true },
  { text: "الموقع واقع؟", action: "health", target: "الموقع", targetId: "site", question: true },
  { text: "افحص سوق الالسوق", action: "health", target: "سوق الالسوق", targetId: "suq" },
  { text: "افحص السيرفر ثم ورني اللوج", action: "health", sequence: ["health", "logs"], target: "السيرفر", targetId: "server" },
  { text: "ادفع تغييرات السوق", action: "push", target: "السوق", targetId: "marketplace" },
  // ── فصحى ──
  { text: "أودِع التغييرات محلياً", action: "commit", target: "التغييرات" },
  { text: "انشر النسخة الجديدة على السيرفر", action: "publish", target: "السيرفر", targetId: "server" },
  { text: "ارفع على السيرفر", action: "publish", target: "السيرفر", targetId: "server" },
  { text: "اعد تشغيل الخدمة", action: "restart", target: "الخدمة", targetId: "service" },
  { text: "أعد تشغيل خدمة nginx", action: "restart", target: "خدمة", targetId: "service" },
  { text: "يرجى إعادة تشغيل الخادم", action: "restart", target: "الخادم", targetId: "server" },
  { text: "نسخة احتياطية للداتابيز", action: "backup", target: "الداتابيز", targetId: "database" },
  { text: "قم بعمل نسخة احتياطية للموقع الآن", action: "backup", target: "الموقع", targetId: "site" },
  { text: "خذ نسخة احتياطية من قاعدة البيانات على جوجل درايف", action: "backup", sequence: ["backup"], target: "قاعدة البيانات", targetId: "database" },
  { text: "افحص حالة الموقع", action: "health", target: "الموقع", targetId: "site" },
  { text: "قيس الأداء", action: "test", target: "الأداء" },
  { text: "قِس الأداء على الانتاج", action: "test", target: "الانتاج", targetId: "server" },
  { text: "اسحب آخر نسخة من الريبو", action: "sync", target: "الريبو", targetId: "repo" },
  { text: "حدّث الريبو ثم أعد التشغيل", action: "sync", sequence: ["sync", "restart"], target: "الريبو", targetId: "repo" },
  { text: "ارجو نشر التحديث على الموقع", action: "publish", sequence: ["publish"], target: "الموقع", targetId: "site" },
  // التسلسلُ بروابطَ فصيحة: «ثم» — والخطواتُ التي لا عمليّةَ فيها (بحثٌ، كتابة) لا تدخله؛ العمليّةُ الأولى هي الأولى منه.
  { text: "ابحث عن الموضوع ثم اكتب المقال ثم انشره", action: "publish", sequence: ["publish"] },
  { text: "اعمل كوميت ثم ارفع ثم انشر على السيرفر", action: "commit", sequence: ["commit", "push", "publish"], target: "السيرفر", targetId: "server" },
  { text: "اسحب آخر نسخة، ابني، وبعدها شغّل الاختبارات", action: "sync", sequence: ["sync", "build", "test"] },
  { text: "ابني «الإضافة» ثم ثبّتها", action: "build", sequence: ["build", "install"], target: "الإضافة", targetId: "app" },
  { text: "انشر تكنولوجيا سعودية", action: "publish", target: "تكنولوجيا سعودية", targetId: "example" },
  { text: "انشر السوق على الانتاج", action: "publish", target: "السوق", targetId: "marketplace" },
  { text: "انشر المقال على غرفةُ الأخبار", action: "publish", target: "غرفةُ الأخبار", targetId: "eagle" },
  { text: "ثبّت أوبن عبد على السيرفر", action: "install", target: "أوبن عبد", targetId: "controlpanel" },
  { text: "ابني أوبن عبد", action: "build", target: "أوبن عبد", targetId: "controlpanel" },
  { text: "ما يشتغل التطبيق على لينكس", action: "fix", target: "التطبيق", targetId: "app" },
  // نفيٌ فصيح.
  { text: "لا تدفع", action: "push", negated: true },
  { text: "لا داعي للنشر الآن", action: "publish", negated: true },
  { text: "لا تنشر على الانتاج قبل ما تختبر", action: "publish", target: "الانتاج", targetId: "server", negated: true },
  // أسئلةٌ فصيحة: «هل» في الأوّل.
  { text: "هل اندفع؟", action: "push", question: true },
  { text: "هل تم النشر على الانتاج؟", action: "publish", target: "الانتاج", targetId: "server", question: true },
  { text: "هل الموقع شغال على الانتاج؟", action: "health", target: "الموقع", targetId: "site", question: true },
  // ── إنجليزية ──
  { text: "pull the latest and restart pm2", action: "sync", sequence: ["sync", "restart"], target: "pm2", targetId: "service" },
  { text: "backup the database to drive", action: "backup", target: "database", targetId: "database" },
  { text: "restart the server", action: "restart", target: "server", targetId: "server" },
  { text: "commit, then push, then deploy to the server", action: "commit", sequence: ["commit", "push", "publish"], target: "server", targetId: "server" },
  { text: "commit, push, deploy", action: "commit", sequence: ["commit", "push", "publish"] },
  { text: "build the installer and then publish it", action: "build", sequence: ["build", "publish"], target: "installer", targetId: "app" },
  { text: "run the tests then commit", action: "test", sequence: ["test", "commit"] },
  { text: "deploy eagle to production", action: "publish", target: "eagle", targetId: "eagle" },
  { text: "go live on the site", action: "publish", target: "site", targetId: "site" },
  { text: "install the extension on windows", action: "install", target: "extension", targetId: "app" },
  { text: "cleanup old releases on the server", action: "cleanup", target: "server", targetId: "server" },
  { text: "restore the last backup from drive", action: "restore", sequence: ["restore"], target: "drive", targetId: "drive" },
  { text: "don't deploy", action: "publish", negated: true },
  { text: "do not restart the server", action: "restart", target: "server", targetId: "server", negated: true },
  { text: "never push to main", action: "push", target: "main", negated: true },
  { text: "is the server up?", action: "health", target: "server", targetId: "server", question: true },
  { text: "is it running?", action: "health", question: true },
  { text: "did the backup run?", action: "backup", question: true },
  { text: "where are the secrets for the mail server?", action: "secrets", target: "mail server", targetId: "mail", question: true },
  { text: "can you push the code?", action: "push", target: "code", question: false },
  // ── مختلطة (عربيّة بمعرّفات لاتينية) ──
  { text: "اعمل commit وبعدين push على الـ repo", action: "commit", sequence: ["commit", "push"], target: "repo", targetId: "repo" },
  { text: "اعمل sync للريبو", action: "sync", target: "الريبو", targetId: "repo" },
  { text: "اعمل build للمثبت ثم ارفعه على الدرايف", action: "build", sequence: ["build", "push"], target: "المثبت", targetId: "app" },
  { text: "ورني لوجات nginx", action: "logs", target: "nginx", targetId: "service" },
  { text: "انشر على search-ksa", action: "publish", target: "search-ksa", targetId: "search-ksa" },
  { text: "اعمل ريستارت لغرفةُ الأخبار", action: "restart", target: "غرفةُ الأخبار", targetId: "eagle" },
  { text: "اعمل ديبلوي لمنصّةُ المواقع", action: "publish", target: "منصّةُ المواقع", targetId: "منصّةُ المواقع" },
  { text: "اعمل كوميت لمنصّةُ المواقع", action: "commit", target: "منصّةُ المواقع", targetId: "منصّةُ المواقع" },
  { text: "شغل الاختبارات على منصّةُ المواقع", action: "test", target: "منصّةُ المواقع", targetId: "منصّةُ المواقع" },
  { text: "ادفع التعديلات على جيت هب", action: "push", target: "جيت هب", targetId: "repo" },
  // ── عربيّةٌ بحروفٍ لاتينية (عربيزي) ──
  { text: "e3mel commit w ba3den push", action: "commit", sequence: ["commit", "push"] },
  { text: "5od backup lel database", action: "backup", target: "database", targetId: "database" },
  { text: "e3mel restart lel server", action: "restart", target: "server", targetId: "server" },
  { text: "mat3melsh deploy", action: "publish", negated: true },
  { text: "matdf3sh 3ala main", action: "push", target: "main", negated: true },
  { text: "el server sha8al?", action: "health", target: "server", targetId: "server", question: true },
  // ── لا عمليّةَ فيها — سؤالُ ملفّاتٍ يبقى سؤالاً بلا عمليّة ──
  { text: "فين مجلد الفواتير؟", action: "none", question: true },
  { text: "عايز اعمل فولدر جديد اسمه تقارير", action: "none" },
  { text: "افتحلي ملف الاعدادات ده", action: "none" },
]
describe("عمليّاتُ التشغيل — المجموعة الذهبية", () => {
  test("المجموعةُ مئةُ صفٍّ فأكثر", () => { expect(OPS_GOLDEN.length).toBeGreaterThanOrEqual(100) })
  for (const row of OPS_GOLDEN) {
    test(`«${row.text}» ⇦ ${row.action}${row.sequence !== undefined && row.sequence.length > 1 ? ` [${row.sequence.join(" ⇦ ")}]` : ""}${row.negated === true ? " (نفي)" : ""}${row.question === true ? " (سؤال)" : ""}`, () => {
      const o = parseOpsIntent(row.text, { knownTargets: FLAVOR_TARGETS })
      const why = `evidence ${JSON.stringify(o.evidence)}`
      expect(o.action, why).toBe(row.action)
      if (row.action === "none") { expect(o.sequence).toEqual([]); expect(o.confidence).toBe(0) }
      else { expect(o.confidence).toBeGreaterThan(0); expect(o.sequence[0], why).toBe(row.action) }
      if (row.sequence !== undefined) expect(o.sequence, why).toEqual(row.sequence)
      if (row.target !== undefined) { expect(o.target, why).toBe(row.target); expect(o.targetStems.length).toBeGreaterThan(0) }
      if (row.targetId !== undefined) expect(o.targetId, why).toBe(row.targetId)
      expect(o.negated, `negated — ${why}`).toBe(row.negated ?? false)
      expect(o.question, `question — ${why}`).toBe(row.question ?? false)
    })
  }
  test("الإطارُ يحمل العمليّة ويذكرها في السطر حين تُوجد فقط", () => {
    expect(describeFrame(semanticFrame("خد باكاب على الدرايف"))).toContain("عمليّة: backup")
    expect(describeFrame(semanticFrame("فين مجلد الفواتير؟"))).not.toContain("عمليّة:")
    expect(OPS_ACTIONS).toContain("backup")
    expect(OPS_ACTIONS).not.toContain("none")
  })
  test("السطرُ يذكر التسلسلَ والهدفَ والنفيَ والسؤالَ حين تُوجد فقط", () => {
    const seq = describeFrame(semanticFrame("اعمل كوميت ثم ارفع ثم انشر على السيرفر"))
    expect(seq).toContain("عمليّة: commit ⇦ push ⇦ publish")
    expect(seq).toContain("هدفُ العمليّة: «السيرفر»")
    expect(seq).not.toContain("نفي")
    expect(seq).not.toContain("سؤال")
    expect(describeFrame(semanticFrame("لا تدفع"))).toContain("عمليّة: push · نفي")
    expect(describeFrame(semanticFrame("الباكاب شغّال؟"))).toContain("عمليّة: health · هدفُ العمليّة: «الباكاب» · سؤال")
    expect(describeFrame(semanticFrame("انشر تكنولوجيا سعودية", { knownTargets: FLAVOR_TARGETS }))).toContain("هدفُ العمليّة: «تكنولوجيا سعودية»")
    // التوأمُ السلبيّ: عمليّةٌ واحدةٌ بلا هدفٍ تُطبع كما كانت — لا سهمَ ولا هدفَ ولا نفيَ ولا سؤال.
    expect(describeFrame(semanticFrame("تمام ارفع"))).toContain("عمليّة: push · استنتاج")
  })
  test("الأهدافُ المعروفة: جدولُ النواة عامّ، وأهدافُ النكهة تُقرأ من التمرير وحده", () => {
    // توأمٌ إيجابيّ: بلا تمريرٍ لا يعرف المحرّكُ اسمَ المنتَج، ومع التمرير يعرفه — فالتمريرُ يُقرأ فعلاً.
    expect(parseOpsIntent("انشر السوق على الانتاج").targetId).toBe("server")
    expect(parseOpsIntent("انشر السوق على الانتاج", { knownTargets: FLAVOR_TARGETS }).targetId).toBe("marketplace")
    expect(KNOWN_TARGETS.map((k) => k.id)).toEqual(expect.arrayContaining(["server", "repo", "database", "site", "drive", "service"]))
    // جذوعُ الهدف تطوي الأدوات كي تطابق اسمَ الموقع أو المشروع عبر «لل/بال».
    expect(parseOpsIntent("اعمل ريستارت للسيرفر").targetStems).toContain("سيرفر")
  })
  test("حتميّةٌ: النصُّ نفسُه يعطي الإطارَ نفسَه، ولا حالةَ تتسرّب بين النداءات", () => {
    const a = parseOpsIntent("اعمل كوميت بس متعملش push", { knownTargets: FLAVOR_TARGETS })
    parseOpsIntent("لا تدفع")
    const b = parseOpsIntent("اعمل كوميت بس متعملش push", { knownTargets: FLAVOR_TARGETS })
    expect(b).toEqual(a)
    expect(a.evidence.some((e) => e.includes("نفي في خطوةٍ لاحقة (push)"))).toBe(true)
  })
})
