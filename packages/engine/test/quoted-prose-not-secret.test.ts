/**
 * 10-08 — مهمّة الموقع: مُوجِّهُ صفحة الهبوط فيه «احصل على مفتاح API» وثانويّ «اكتشف النماذج …» فعُدّ ٢٠٨٩ حرفاً من النثر مفتاحاً،
 * وفتح كلُّ دورٍ محرّراً على سطح المكتب (ستّة أدوار). المقتبسُ بعد اسمٍ سرّيّ يُقبل بهيئة اعتماد وحدها.
 */
import { expect, test } from "bun:test"
import { classifyInboundSecret } from "../src/secret-intake"

const prose = "اكتشف النماذج وقارن الأسعار واختر الأنسب لمشروعك من بين مئات النماذج من عشرات المزوّدين، بواجهة واحدة متوافقة وبأسعار بالريال، مع لوحة استخدام وسجلّات وتحكّم في الإنفاق لكل فريق ومشروع وبيئة."

test("the measured shape: a long quoted Arabic sentence after «مفتاح API» is not a secret", () => {
  const body = `البطولة: زرّان (أساسيّ «احصل على مفتاح API» وثانويّ «${prose}»)، ثمّ صف أرقام.`
  const scan = classifyInboundSecret(body)
  expect(scan.carriesSecret).toBe(false)
})

test("positive twins: a quoted key, an unquoted key, and a quoted passphrase are still caught", () => {
  expect(classifyInboundSecret("مفتاح API «sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z»").carriesSecret).toBe(true)
  expect(classifyInboundSecret("هذا مفتاح الـ API: sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z").carriesSecret).toBe(true)
  expect(classifyInboundSecret('my password is "correct horse battery staple"').carriesSecret).toBe(true)
})
