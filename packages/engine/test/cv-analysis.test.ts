/**
 * 10-01 — `cv` وقراءةُ DOCX. لكلّ فحصٍ توأمان: سيرةٌ تفشل فيه وسيرةٌ تنجح؛ والتقريرُ لا يطبع قيمةَ تواصل.
 */
import { describe, expect, test } from "bun:test"
import { analyzeCv, dateSpans, cvNorm, jobKeywords, matchJob, mergedMonths, parseCvCommand, renderCvReport, sectionOf } from "../src/cv-analysis"
import { docxText, documentXmlText } from "../src/docx-read"
import { zip } from "../src/slides"

const NOW = new Date(Date.UTC(2026, 9, 1))

const EN = `Sara Example
sara.example@mail.test | +966 55 123 4567 | linkedin.com/in/sara-example | github.com/saraex

PROFESSIONAL SUMMARY
Backend engineer focused on payments.

WORK EXPERIENCE
Senior Backend Engineer — Example Pay (Jan 2022 – Present)
- Led the migration of 14 services to Kubernetes, cutting deploy time by 60%
- Built a TypeScript and Node.js ledger handling 2M transactions a day
- Responsible for code reviews
Backend Engineer — Example Shop (Mar 2019 – Dec 2021)
- Designed REST APIs in Node.js and PostgreSQL
- Reduced p95 latency from 900ms to 120ms
Freelance (2020 - 2021)
- Developed small sites

EDUCATION
B.Sc. Computer Science, Example University (2014 - 2018)

SKILLS
TypeScript, Node.js, PostgreSQL, Kubernetes, Docker, AWS, Redis

CERTIFICATIONS
AWS Certified Developer
`

const AR = `أحمد مثال
البريد: ahmad@mail.test — الجوال: ٠٥٥٥١٢٣٤٥٦

الخبرات العملية
مهندس واجهات — شركة مثال (يناير 2021 - حتى الآن)
- طوّرت لوحة تحكم بـReact خفّضت زمن التحميل 40٪
- مسؤول عن صيانة الموقع
- قدت فريقاً من 4 مطوّرين

المؤهلات العلمية
بكالوريوس نظم معلومات (2016 - 2020)

المهارات
React، TypeScript، Next.js، Figma

تاريخ الميلاد: 1998
الحالة الاجتماعية: أعزب
`

describe("sections and contact", () => {
  test("headings in English and Arabic, with qualifiers; a sentence that contains a heading word is not a heading", () => {
    expect(sectionOf("WORK EXPERIENCE")).toBe("experience")
    expect(sectionOf("## Professional Summary:")).toBe("summary")
    expect(sectionOf("الخبرات العملية")).toBe("experience")
    expect(sectionOf("المؤهلات العلمية")).toBe("education")
    expect(sectionOf("المهارات")).toBe("skills")
    expect(sectionOf("Customer Service Training")).toBeUndefined()
    expect(sectionOf("Led the migration of services")).toBeUndefined()
    expect(sectionOf("Experience 2019 - 2021")).toBeUndefined()
  })

  test("contact is reported as presence only — the report never prints an address or a number", () => {
    const cv = analyzeCv("sara.pdf", EN, NOW)
    expect(cv.contact).toEqual({ email: true, phone: true, linkedin: true, github: true, website: false })
    const report = renderCvReport([cv])
    expect(report).not.toContain("sara.example@mail.test")
    expect(report).not.toContain("123 4567")
    expect(report).not.toContain("Sara Example")
    expect(report).toContain("email ✓")
    // التوأم: سيرةٌ بلا بريد تُسمّى خطأً.
    const noMail = analyzeCv("x.txt", EN.replace("sara.example@mail.test", ""), NOW)
    expect(noMail.findings.map((f) => `${f.severity}:${f.check}`)).toContain("error:contact:email")
  })

  test("Arabic: Indic digits are a phone, sections fold their spelling, and personal data is named", () => {
    const cv = analyzeCv("ahmad.docx", AR, NOW)
    expect(cv.contact.phone).toBe(true)
    expect(cv.sections.experience && cv.sections.education && cv.sections.skills).toBe(true)
    expect(cv.findings.find((f) => f.check === "personal-data")?.detail).toContain("تاريخ الميلاد")
    expect(cv.findings.find((f) => f.check === "personal-data")?.detail).toContain("الحالة الاجتماعيّة")
    expect(analyzeCv("en", EN, NOW).findings.some((f) => f.check === "personal-data")).toBe(false)
  })
})

describe("experience years", () => {
  test("ranges inside the experience section only, overlap merged, «Present» is now", () => {
    const cv = analyzeCv("sara.pdf", EN, NOW)
    expect(cv.experienceScope).toBe("section")
    // Mar 2019 → Oct 2026 continuous (the freelance 2020–2021 overlaps); education 2014–2018 is not counted.
    expect(cv.experienceYears).toBe(7.5)
  })
  test("Arabic months and «حتى الآن»", () => {
    expect(analyzeCv("a", AR, NOW).experienceYears).toBe(6)
  })
  test("spans and merging", () => {
    const spans = dateSpans(cvNorm("Jan 2020 – Dec 2020, 2020 - 2021, 03/2023 - present"), NOW)
    expect(spans).toHaveLength(3)
    expect(mergedMonths(spans)).toBe(24 + 44)
    expect(dateSpans(cvNorm("2030 - 2031"), NOW)).toEqual([])
    expect(mergedMonths([])).toBe(0)
  })
  test("no experience section: the whole text is used and the report says so", () => {
    const cv = analyzeCv("x", "Engineer at A (2018 - 2020)\nUniversity (2012 - 2016)", NOW)
    expect(cv.experienceScope).toBe("whole-text")
    expect(renderCvReport([cv])).toContain("من النصّ كلّه")
  })
})

describe("bullets and ATS checks", () => {
  test("quantified, action-led and weak phrasing are counted", () => {
    const cv = analyzeCv("sara.pdf", EN, NOW)
    expect(cv.bullets).toBe(6)
    expect(cv.quantified).toBe(3)
    expect(cv.actionLed).toBe(5)
    expect(cv.findings.find((f) => f.check === "weak-phrases")?.detail).toStartWith("1 ")
    const ar = analyzeCv("a", AR, NOW)
    expect(ar.actionLed).toBe(2)
    // الأفعالُ بهمزةٍ وشدّةٍ وضمّة كما تُكتب.
    expect(analyzeCv("h", "- أنشأتُ نظامَ فوترة\n- أشرفتُ على 6 مهندسين\n- أسّستُ قسمَ الجودة\n- تابعت المهام", NOW).actionLed).toBe(3)
    expect(ar.quantified).toBe(2)
  })
  test("unquantified bullets are a warning; the measured CV passes it", () => {
    const flat = analyzeCv("flat", EN.replace(/\d+%|\d+ms|\d+M|\d+ services/gu, "many"), NOW)
    expect(flat.findings.map((f) => f.check)).toContain("quantified")
    expect(analyzeCv("sara", EN, NOW).findings.map((f) => f.check)).not.toContain("quantified")
  })
  test("a scanned CV (no extractable text) is an error that names the cause", () => {
    const cv = analyzeCv("scan.pdf", "  \n\f\n Page 1 ", NOW)
    expect(cv.findings[0]).toMatchObject({ severity: "error", check: "no-text" })
    expect(cv.score).toBeLessThan(60)
  })
  test("missing core sections are warnings; the complete CV has none", () => {
    const bare = analyzeCv("bare", "Name\nme@x.test\n" + "word ".repeat(300), NOW)
    expect(bare.findings.filter((f) => f.check.startsWith("section:")).map((f) => f.check)).toEqual(["section:experience", "section:education", "section:skills"])
    expect(analyzeCv("sara", EN, NOW).findings.filter((f) => f.check.startsWith("section:"))).toEqual([])
  })
})

describe("job match", () => {
  const JOB = `Senior Backend Engineer
We are looking for an engineer with strong experience in Node.js, TypeScript and PostgreSQL.
Experience with Kubernetes, Kafka and GraphQL is required. Knowledge of AWS and CI/CD pipelines.
Machine learning experience is a plus. Kafka streaming at scale.`

  test("keywords: phrases first, then by frequency; stopwords dropped", () => {
    const k = jobKeywords(JOB)
    expect(k.slice(0, 3)).toEqual(["machine learning", "ci/cd", "node.js"])
    expect(k).toContain("kafka")
    expect(k.indexOf("kafka")).toBeLessThan(k.indexOf("graphql"))
    for (const stop of ["experience", "with", "strong", "required"]) expect(k).not.toContain(stop)
  })
  test("matched and missing, with a percentage; a stronger CV ranks first", () => {
    const k = jobKeywords(JOB)
    const sara = analyzeCv("sara.pdf", EN, NOW)
    const m = matchJob(sara, k)
    for (const has of ["node.js", "typescript", "postgresql", "kubernete", "aws"]) expect(m.matched).toContain(has)
    for (const miss of ["kafka", "graphql", "machine learning", "ci/cd"]) expect(m.missing).toContain(miss)
    expect(m.percent).toBe(Math.round((100 * m.matched.length) / k.length))
    const ahmad = analyzeCv("ahmad.docx", AR, NOW)
    const report = renderCvReport([ahmad, sara], k)
    expect(report.indexOf("| 1 | sara.pdf")).toBeGreaterThan(0)
    expect(report.indexOf("| 2 | ahmad.docx")).toBeGreaterThan(report.indexOf("| 1 | sara.pdf"))
  })
  test("Arabic job text is normalized before matching", () => {
    const k = jobKeywords("مطلوب مطوّر واجهات يجيد React وتصميم Figma مع خبرة في إدارة المشاريع")
    expect(k).toContain("react")
    expect(k).toContain("figma")
    expect(k).toContain(cvNorm("ادارة المشاريع"))
    expect(matchJob(analyzeCv("a", AR, NOW), k).matched).toEqual(expect.arrayContaining(["react", "figma"]))
  })
})

describe("command", () => {
  test("files, --job and --job-text to the end of the line", () => {
    expect(parseCvCommand("a.pdf b.docx --job jd.md")).toEqual({ files: ["a.pdf", "b.docx"], jobFile: "jd.md" })
    expect(parseCvCommand("a.pdf --job-text Senior engineer, Node.js and AWS")).toEqual({ files: ["a.pdf"], jobText: "Senior engineer, Node.js and AWS" })
    expect(parseCvCommand("cvs/one.txt")).toEqual({ files: ["cvs/one.txt"] })
    // مقيس حيّاً: النموذجُ أحاط الوصفَ بعلامتي تنصيص.
    expect(parseCvCommand('a.pdf --job-text "Senior Data Engineer — Python, CI/CD"').jobText).toBe("Senior Data Engineer — Python, CI/CD")
    expect(parseCvCommand("a.pdf --job-text «مطوّر واجهات»").jobText).toBe("مطوّر واجهات")
  })
  test("refusals name the cause", () => {
    expect(() => parseCvCommand("")).toThrow("الصيغة")
    expect(() => parseCvCommand("a.doc")).toThrow(".doc القديم")
    expect(() => parseCvCommand("a.pdf --job")).toThrow("--job بلا ملفّ")
    expect(() => parseCvCommand("a.pdf --job-text")).toThrow("--job-text بلا نصّ")
    expect(() => parseCvCommand("a.pdf --jobs x.md")).toThrow("خيارٌ غير معروف")
    expect(() => parseCvCommand("a.pdf --job j.md --job-text x")).toThrow("لا الاثنان")
  })
})

describe("docx", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Work Experience</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Led </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>14 &amp; more</w:t></w:r></w:p>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr><w:r><w:t>Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Value</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>next</w:t></w:r></w:p>
<w:p/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Skill</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Level</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Node.js</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>&#x627;&#1604;</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:moveFrom><w:r><w:t>moved away</w:t></w:r></w:moveFrom><w:r><w:t>kept</w:t></w:r><w:moveTo><w:r><w:t> here</w:t></w:r></w:moveTo></w:p>
</w:body></w:document>`

  test("paragraphs, headings, list items, tabs, breaks, entities, tables, and deleted text", () => {
    expect(documentXmlText(xml)).toBe("# Work Experience\n- Led 14 & more\nName\tValue\nnext\n\nSkill | Level\nNode.js | ال\nkept here")
  })
  test("read from a real ZIP package (deflated), and the refusals name the cause", () => {
    const enc = new TextEncoder()
    const pkg = zip([{ name: "[Content_Types].xml", data: enc.encode("<Types/>") }, { name: "word/document.xml", data: enc.encode(xml + " ".repeat(2000)) }])
    const r = docxText(pkg)
    expect(r.ok && r.text.startsWith("# Work Experience")).toBe(true)
    const notWord = docxText(zip([{ name: "a.txt", data: enc.encode("x") }]))
    expect(!notWord.ok && notWord.error).toContain("ليس مستندَ Word")
    const notZip = docxText(enc.encode("plain text, not a package"))
    expect(!notZip.ok && notZip.error).toContain("ليس ملفَّ ZIP")
  })
})

describe("wiring", () => {
  const cli = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../src/cli.ts"), "utf8") as string
  test("cv is one switch read once at the call, and reads pdf, docx and text through the project path resolver", () => {
    expect(cli.split('pluginOnNow("cvAnalysis")').length - 1).toBe(1)
    expect(cli).toContain("const abs = resolveProjectPath(file)")
    expect(cli).toContain("else analyses.push(analyzeCv(file, doc.text))")
    expect(cli.indexOf('if (spec.name === "cv")')).toBeLessThan(cli.indexOf('if (spec.name === "slides")'))
  })
  test("read turns a .docx into text, line-ranged and clipped like any text file", () => {
    expect(cli).toContain("doc = docxText(new Uint8Array(readFileSync(target)))")
    expect(cli).toContain("const shown = clipReadBody(whole.slice, readBudgetChars(), whole.from, whole.to, file)")
  })
})

// 10-01 — مقيس على سيرةٍ حفظها Word نفسُه (DOCX وPDF): ثلاثةُ عيوبٍ لم تكشفها النصوصُ المصنوعة.
describe("measured on files Word saved", () => {
  test("a «List Bullet» paragraph is a list item even without numPr in the paragraph", () => {
    const xml = '<w:body><w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Built Kafka pipelines</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>plain</w:t></w:r></w:p></w:body>'
    expect(documentXmlText(xml)).toBe("- Built Kafka pipelines\nplain")
  })
  test("pdftotext -layout puts a heading and the next column on one line; the first column is still a heading", () => {
    expect(sectionOf("Skills                                              Kafka, Spark")).toBe("skills")
    expect(sectionOf("Built Kafka pipelines        3TB a day")).toBeUndefined()
  })
  test("seniority words are not keywords", () => {
    const k = jobKeywords("Senior Data Engineer. Requirements: Python, SQL, Kafka.")
    expect(k).not.toContain("senior")
    expect(k).toEqual(expect.arrayContaining(["python", "sql", "kafka"]))
  })
})
