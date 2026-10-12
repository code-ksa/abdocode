/**
 * 10-08 (مقيس في بروفات النشر): `glob .env*` عاد «لا مطابقة» في أربع بروفات و.env موجود، و`glob C:\…\hello-deploy\.env*` مثله —
 * Bun.Glob يُخفي الملفّاتِ النقطيّة ما لم يُطلب `dot`، ولا يفهم المسارَ المطلق ولا الشرطةَ العكسيّة. فظنّ النموذجُ أن لا .env وكتب
 * واحداً جديداً فوق مفاتيح المستخدم. النمطُ يُطبَّع هنا: المطلقُ داخل المشروع يصير نسبيّاً، وخارجَه يُسمّى صراحةً لا «لا مطابقة»،
 * والملفّاتُ النقطيّة تُرى متى ذكرها النمطُ نفسُه (كما يفعل Glob عند كلود).
 */
export function globPatternInProject(raw: string, projectDir: string): { readonly pattern: string; readonly dot: boolean } | { readonly error: string } {
  const given = raw.trim().replace(/^(["'])(.*)\1$/u, "$2")
  if (given.length === 0) return { error: "glob يحتاج نمطاً" }
  let pattern = given.replaceAll("\\", "/")
  const root = projectDir.replaceAll("\\", "/").replace(/\/+$/u, "")
  if (/^(?:[A-Za-z]:\/|\/)/u.test(pattern)) {
    const lower = pattern.toLowerCase(), rootLower = root.toLowerCase()
    if (lower === rootLower) pattern = "*"
    else if (lower.startsWith(`${rootLower}/`)) pattern = pattern.slice(root.length + 1)
    else return { error: `«${given}» خارجَ المشروع — glob يبحث داخل المشروع وحده (${projectDir})؛ لما خارجه استعمل run (Get-ChildItem/ls).` }
  }
  pattern = pattern.replace(/^(?:\.\/)+/u, "")
  if (pattern === "" || pattern === ".") pattern = "*"
  return { pattern, dot: /(?:^|\/)\.[^./]/u.test(pattern) }
}
