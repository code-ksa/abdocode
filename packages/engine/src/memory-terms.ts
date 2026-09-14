// Small local concept vocabulary: no embeddings, downloads or external calls.
const concepts = [
  ["database", "databases", "sql", "قاعدة", "بيانات", "قواعد"],
  ["postgres", "postgresql", "بوستجري", "بوستجرس", "بوستجريس"],
  ["sqlite", "سيكوال", "اسكيوالايت"],
  ["invoice", "invoices", "billing", "فاتورة", "فواتير", "فوترة"],
  ["authentication", "auth", "login", "signin", "مصادقة", "دخول"],
  ["permissions", "permission", "authorization", "صلاحيات", "صلاحية"],
  ["test", "tests", "testing", "verification", "اختبار", "اختبارات", "تحقق"],
  ["style", "styles", "styling", "css", "design", "تصميم", "تنسيق", "استايل"],
  ["deploy", "deployment", "release", "نشر", "اصدار"],
  ["memory", "recall", "remember", "ذاكرة", "تذكر", "استرجاع"],
  ["resume", "continuation", "handoff", "استكمال", "متابعة", "تسليم"],
  ["dependency", "dependencies", "packages", "حزم", "اعتماديات", "باكيدجات"],
]
const stop = new Set(["the","and","this","with","please","project","مشروع","اكمل","continue"])
export function memoryTerms(text: string) {
  const words = (text.slice(0,8000).toLowerCase().normalize("NFKC").replace(/[\u064b-\u065f\u0640]/gu,"").replace(/[أإآ]/gu,"ا").match(/[\p{L}\p{N}_]{3,}/gu)??[])
    .map(word=>/^[\u0621-\u064a]+$/u.test(word)&&word.startsWith("ال")&&word.length>4?word.slice(2):word).filter(word=>!stop.has(word)).slice(0,120)
  const tokens = new Set(words)
  return { tokens, concepts: new Set(concepts.flatMap((aliases,index)=>aliases.some(alias=>tokens.has(alias))?[index]:[])) }
}
