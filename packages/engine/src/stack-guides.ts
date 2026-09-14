/**
 * أدلّةُ الأكوام غيرِ المكتلَجة — أمر المالك 2026-09-13: «لو المستخدم طلب مشروع Next أو React أو Vite أو Flutter
 * أو React Native أو Swift». كتالوجُ القوالب (100 قالب) يغطّي next/vite/astro/express/fastify/hono بملفّاتٍ مقفلة الهاش؛
 * أكوامُ الموبايل تحتاج أدواتِها على الجهاز (flutter/xcode/expo) ولا تُشحن ملفّاتٍ — فدليلُها أوامرُ السقالة
 * والتحقّق والتشغيل بالضبط، يقرؤها النموذجُ من `templates <stack>` بدل أن يخمّنها، وتصير وصفةً محفوظة حين تنجح.
 */
export interface StackGuide {
  readonly stack: string
  readonly aliases: readonly string[]
  /** أمرُ فحص الأداة على الجهاز — يُنفَّذ أوّلاً؛ فشلُه يعني «ثبّت الأداة» لا «أعد المحاولة». */
  readonly doctor: string
  readonly scaffold: string
  readonly verify: readonly string[]
  readonly run: string
  readonly preview: string
  readonly notes: string
}

export const STACK_GUIDES: readonly StackGuide[] = Object.freeze([
  { stack: "flutter", aliases: ["flutter", "dart", "فلاتر"], doctor: "flutter --version", scaffold: "flutter create --org com.example --project-name <name> .", verify: ["flutter analyze", "flutter test"], run: "flutter run -d chrome", preview: "flutter run -d chrome يفتح المتصفّح على منفذٍ يطبعه؛ افتحه بـ open <url> ثمّ page/shot", notes: "بلا flutter على الجهاز لا سقالة — أخبر المستخدم بالتثبيت (flutter.dev) ولا تحاكِ الملفّات يدويّاً." },
  { stack: "react-native", aliases: ["react native", "react-native", "expo", "رياكت نيتيف", "ريأكت نيتف", "اكسبو", "إكسبو"], doctor: "node --version && npx --yes expo --version", scaffold: "npx --yes create-expo-app@latest . --template blank-typescript", verify: ["npx tsc --noEmit", "npx expo-doctor"], run: "npx expo start --web", preview: "expo start --web يخدم على http://localhost:8081 — open ثمّ page/shot؛ الهاتفُ عبر Expo Go بمسح الرمز", notes: "الأندرويد/iOS الأصليّان يحتاجان Android Studio/Xcode؛ ابدأ بالويب للتحقّق البصريّ." },
  { stack: "swift", aliases: ["swift", "swiftui", "ios", "xcode", "سويفت"], doctor: "swift --version", scaffold: "swift package init --type executable --name <name>", verify: ["swift build", "swift test"], run: "swift run", preview: "لا معاينةَ متصفّح — التحقّق بـ swift build/test؛ تطبيقُ iOS يحتاج ماك وXcode (xcodebuild -scheme <name> build)", notes: "على ويندوز يعمل Swift toolchain لسطر الأوامر فقط؛ SwiftUI/iOS على ماك وحده — قلها للمستخدم صراحةً." },
  { stack: "vite-react", aliases: ["vite", "react", "فيت", "رياكت"], doctor: "node --version", scaffold: "npm create vite@latest . -- --template react-ts", verify: ["npm install", "npx tsc --noEmit", "npm run build"], run: "npm run dev", preview: "vite يخدم على http://localhost:5173 — open ثمّ page/shot", notes: "القوالبُ المقفلة: templates vite — تعطي حزماً مثبَّتة الإصدارات؛ استعملها إن طابقت الطلب." },
  { stack: "next", aliases: ["next", "nextjs", "next.js", "نكست", "نيكست"], doctor: "node --version", scaffold: "npx --yes create-next-app@latest . --ts --app --eslint --no-tailwind --src-dir --import-alias '@/*'", verify: ["npm install", "npx tsc --noEmit", "npm run build"], run: "npm run dev", preview: "next يخدم على http://localhost:3000 — open ثمّ page/shot", notes: "القوالبُ المقفلة: templates next — ٥٠+ قالباً بقواعد بيانات وORM؛ فضّلها على السقالة العامّة." },
])

/** الدليلُ المطابق لاستعلامٍ (اسمُ الكومة أو مرادفُه بأيّ لغة) — أو لا شيء فيبقى الكتالوجُ وحده. */
export function stackGuideFor(query: string): StackGuide | undefined {
  const q = query.toLowerCase()
  if (q.trim().length === 0) return undefined
  return STACK_GUIDES.find((g) => g.aliases.some((a) => q.includes(a)))
}

export function describeStackGuide(g: StackGuide): string {
  return [
    `🧭 دليل ${g.stack}: نفّذ بالترتيب وتوقّف عند أوّل فشل (run لكلّ أمر، من مجلد المشروع بعد project-create):`,
    `1. فحص الأداة: ${g.doctor}`,
    `2. السقالة: ${g.scaffold}`,
    ...g.verify.map((v, i) => `${i + 3}. تحقّق: ${v}`),
    `${g.verify.length + 3}. التشغيل: run --bg ${g.run}`,
    `المعاينة: ${g.preview}`,
    `ملاحظة: ${g.notes}`,
  ].join("\n")
}
