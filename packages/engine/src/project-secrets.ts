/**
 * 10-08 — أسرارُ المشروع من الخزنة إلى النشر، بلا أن تظهر قيمةٌ واحدة.
 *
 * كانت الحلقةُ مقطوعةً من طرفيها: لا أداةَ للوكيل تضع مفاتيحَ المشروع في الخزنة (الخزنةُ للمزوّدات والموصّلات والخوادم وحدها)،
 * و`deploy` يستبعد `.env` عمداً — فمشروعٌ يحتاج مفاتيحَه يُنشر بلا مفاتيح. هنا:
 *   - `secrets import <ملفّ>` يقرأ KEY=VALUE من ملفٍّ داخل المشروع ويحفظ كلَّ قيمةٍ في الخزنة باسمٍ خاصٍّ بالمشروع، ويكتب **الأسماءَ وحدها**
 *     في `.abdo/secrets.json`؛ الإيصالُ يذكر الأسماءَ والعدد ولا يذكر قيمة.
 *   - `secrets list` الأسماءُ وحضورُها في الخزنة.
 *   - `deploy <خادم> --env` يكتب `.env` في الإصدار على الخادم من الخزنة عبر stdin (umask 077) — لا في سطر أوامر ولا في سجلّ.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

export interface SecretVault {
  readonly get: (handle: string) => Promise<string | undefined>
  readonly set: (handle: string, value: string) => Promise<boolean>
}

export const SECRETS_FILE = join(".abdo", "secrets.json")
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u

/** KEY=VALUE كما يكتبه dotenv: تعليقات، export، اقتباسٌ مفرد/مزدوج. المفاتيحُ غيرُ الصالحة تُسمّى ولا تُخمَّن. */
export function parseDotenv(text: string): { readonly entries: readonly { readonly key: string; readonly value: string }[]; readonly skipped: readonly string[] } {
  const entries: { key: string; value: string }[] = []
  const skipped: string[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/u.exec(line)
    if (m === null || !KEY.test(m[1]!)) { skipped.push(line.split("=", 1)[0]!.slice(0, 40)); continue }
    let value = m[2]!
    const q = value[0]
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/u, "")
    if (value.length === 0) { skipped.push(m[1]!); continue }
    entries.push({ key: m[1]!, value })
  }
  return { entries, skipped }
}

/** اسمٌ ثابتٌ للمشروع في الخزنة: اسمُ المجلّد + بصمةُ مساره (مشروعان باسمٍ واحد لا يتشاركان مفاتيح). */
export function projectSlug(projectDir: string): string {
  const name = basename(resolve(projectDir)).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "project"
  const hash = createHash("sha256").update(resolve(projectDir).toLowerCase()).digest("hex").slice(0, 8)
  return `${name}-${hash}`
}

export const secretHandle = (slug: string, key: string): string => `project-${slug}-${key.toLowerCase().replace(/_/gu, "-")}`.slice(0, 120)

interface SecretsManifest { readonly slug: string; readonly keys: readonly string[] }

export function readManifest(projectDir: string): SecretsManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(projectDir, SECRETS_FILE), "utf8")) as SecretsManifest
    return Array.isArray(m.keys) && typeof m.slug === "string" ? m : undefined
  } catch { return undefined }
}

/** يحفظ المفاتيحَ في الخزنة ويكتب أسماءها وحدها. يعيد إيصالاً بلا قيم. الملفُّ المصدر لا يُمسّ (قرارُ حذفه للمستخدم). */
export async function importSecrets(projectDir: string, relFile: string, vault: SecretVault): Promise<{ readonly ok: boolean; readonly text: string }> {
  const root = resolve(projectDir)
  const file = resolve(root, relFile)
  if (!file.toLowerCase().startsWith(root.toLowerCase())) return { ok: false, text: `«${relFile}» خارجَ المشروع — الاستيرادُ من ملفٍّ داخل المشروع وحده.` }
  if (!existsSync(file)) return { ok: false, text: `لا ملفَّ «${relFile}» في المشروع.` }
  const { entries, skipped } = parseDotenv(readFileSync(file, "utf8"))
  if (entries.length === 0) return { ok: false, text: `لا مفاتيحَ KEY=VALUE في «${relFile}»${skipped.length > 0 ? ` (تُجوهل: ${skipped.join("، ")})` : ""}.` }
  const slug = projectSlug(root)
  const stored: string[] = [], failed: string[] = []
  for (const { key, value } of entries) (await vault.set(secretHandle(slug, key), value) ? stored : failed).push(key)
  const previous = readManifest(root)?.keys ?? []
  const keys = [...new Set([...previous, ...stored])].sort()
  mkdirSync(join(root, ".abdo"), { recursive: true })
  writeFileSync(join(root, SECRETS_FILE), `${JSON.stringify({ slug, keys }, null, 2)}\n`)
  const ignored = (() => { try { return /^\.env\b|^\.env\*|^\*\.env/mu.test(readFileSync(join(root, ".gitignore"), "utf8")) } catch { return false } })()
  return {
    ok: failed.length === 0,
    text: `🔐 حُفظ ${stored.length} مفتاحاً في الخزنة (القيمُ لم تُعرض): ${stored.join("، ")}${failed.length > 0 ? `\n✕ تعذّر حفظ: ${failed.join("، ")}` : ""}${skipped.length > 0 ? `\nℹ تُجوهل: ${skipped.join("، ")}` : ""}` +
      `\nالأسماءُ في ${SECRETS_FILE.replace(/\\/gu, "/")}؛ والنشرُ يكتبها على الخادم بـ deploy <خادم> --env.` +
      (ignored ? "" : `\n⚠ .gitignore لا يستبعد ${relFile} — أضِف «.env*» إليه كي لا يدخل git.`),
  }
}

export async function listSecrets(projectDir: string, has: (handle: string) => Promise<boolean>): Promise<string> {
  const m = readManifest(projectDir)
  if (m === undefined || m.keys.length === 0) return `لا أسرارَ محفوظةً لهذا المشروع — secrets import .env يحفظها في الخزنة.`
  const rows = await Promise.all(m.keys.map(async (k) => `${await has(secretHandle(m.slug, k)) ? "✓" : "✕ غائبٌ عن الخزنة"} ${k}`))
  return `أسرارُ المشروع (${m.keys.length} — أسماءٌ لا قيم):\n${rows.join("\n")}`
}

/** نصُّ `.env` للنشر من الخزنة — لا يُطبع ولا يُسجَّل؛ يُمرَّر إلى deploy وحده. */
export async function envFromVault(projectDir: string, vault: SecretVault): Promise<{ readonly text: string; readonly keys: readonly string[]; readonly missing: readonly string[] } | { readonly error: string }> {
  const m = readManifest(projectDir)
  if (m === undefined || m.keys.length === 0) return { error: "لا أسرارَ محفوظةً لهذا المشروع — secrets import .env أوّلاً." }
  const lines: string[] = [], keys: string[] = [], missing: string[] = []
  for (const key of m.keys) {
    const value = await vault.get(secretHandle(m.slug, key))
    if (value === undefined) { missing.push(key); continue }
    lines.push(`${key}=${JSON.stringify(value)}`)
    keys.push(key)
  }
  return { text: `${lines.join("\n")}\n`, keys, missing }
}
