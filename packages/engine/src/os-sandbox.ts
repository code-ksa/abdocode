/**
 * العزلُ على مستوى نظام التشغيل — الفجوة #4 في جدول 2026-09-27 (Codex وClaude Code يشغّلان الأوامرَ في صندوق).
 *
 * `run --sandbox <أمر>` يشغّل الأمرَ داخل **AppContainer بلا أيّ قدرة**: لا شبكة، ولا وصولَ إلى ملفّات المستخدم (الخزنة
 * وSSH وكلُّ ما تحت ملفّه الشخصيّ) — ومجلّدُ المشروع وحده مفتوحٌ للكتابة. الآليّةُ مقيسةٌ في حزمة windows-isolation-helper
 * (CL-16A2: الشبكةُ تُعزل صحيحاً لـcmd/powershell/python/node/git/curl) ومشحونةٌ بخطّافها الموثَّق (بصمةُ الثنائيّ في البيان).
 * وهذا الملفّ لا يصنع آليّةً ثانية: يبني **منحَ التنفيذ** الذي يسلّمه موضعُ الإنفاذ إلى `launchControlledProcess`،
 * فيبقى المُطلِقُ مالكَ السجلّ والتحقّقِ قبل الإطلاق والرفض — ولا عودةَ إلى تشغيلٍ غيرِ معزولٍ عند الرفض أبداً.
 */
import { existsSync } from "node:fs"
import { MemoryEventStore } from "@abdo/event-store"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "@abdo/tools/isolation"
import type { ControlledExecutionGrant } from "@abdo/tools/launcher"
import { APPCONTAINER_MECHANISM, createAppContainerBackend, verifyHelperTrust } from "@abdo/windows-isolation-helper/backend"

export interface SandboxPaths { readonly helper: string; readonly manifest: string }

// دفترُ دورة حياة الحاوية (عقودُ الإيجار ومنحُ الصلاحيّات) في الذاكرة: جلسةُ المحرّك وحدها. منحُ ACL لحاويةٍ حُذف ملفُّها
// الشخصيّ بعد انهيارٍ خاملٌ لا يفتح شيئاً — والاسترجاعُ الدائم بندٌ مفتوحٌ مسمّى لا مدّعى.
const store = new MemoryEventStore()

/** منحُ `deny_all` بآليّة AppContainer — أو سببُ الرفض مسمّى. الثقةُ تُقاس الآن (ويُعاد قياسُها قبل كلّ تشغيل في الخلفيّة). */
export function sandboxGrant(paths: SandboxPaths, projectDir: string, platform: NodeJS.Platform = process.platform): { readonly grant: ControlledExecutionGrant } | { readonly refusal: string } {
  if (platform !== "win32") return { refusal: "العزلُ بـAppContainer لويندوز وحده — لا صندوقَ مقيساً على هذه المنصّة، ولا يُشغَّل الأمرُ بلا عزل" }
  if (!existsSync(paths.helper) || !existsSync(paths.manifest)) return { refusal: `خطّافُ العزل غيرُ موجود (${paths.helper}) — لا يُشغَّل الأمرُ بلا عزل` }
  const trust = verifyHelperTrust(paths.helper, paths.manifest)
  if (!trust.trusted) return { refusal: `خطّافُ العزل غيرُ موثوق: ${trust.reasonCode ?? "?"} — ${trust.detail ?? ""}`.trim() }
  const capability: IsolationCapabilityReport = {
    platform: "win32",
    mechanism: APPCONTAINER_MECHANISM,
    denyAll: "supported",
    processTree: "supported",
    childInheritance: "supported",
    loopbackInsideDenyAll: "unknown",
    requiresElevation: false,
    mutatesGlobalState: false,
    reasonCodes: [],
    evidenceHash: `appcontainer:${trust.binaryHash}:${trust.protocolVersion}:true`,
    isolationVersion: ISOLATION_VERSION,
  }
  return {
    grant: {
      profile: DENY_ALL_PROFILE,
      capability,
      approvalGranted: false,
      // المنحُ الوحيد: مجلّدُ المشروع للكتابة — يختاره المحرّكُ لا النموذج (مقيس: بلاه يُرفض حتى مجلّدُ العمل نفسُه).
      backend: createAppContainerBackend({ store, helperPath: paths.helper, manifestPath: paths.manifest, grants: [{ path: projectDir, rights: "modify" }] }),
    },
  }
}

/**
 * أمرُ الصندوق بلا صَدَفة (مقيس 2026-09-27 على هذا الجهاز):
 * · PowerShell لا يدخل مجلّدَ العمل داخل الحاوية — مزوّدُ المسارات يطلب قراءةَ آبائه (Set-Location: Access is denied).
 * · والبحثُ في PATH من داخل الحاوية يفشل — مجلّداتٌ مثل «C:\Program Files\nodejs» لا تمنح الحاوياتِ حقَّ السرد —
 *   بينما البرنامجُ نفسُه بمساره الكامل يعمل ويكتب في المشروع.
 * فالبرنامجُ يُحلّ **على المضيف** إلى مساره الكامل ويُشغَّل بوسائطَ منفصلة (بلا cmd /c ولا دمج نصّ)، وأوامرُ cmd المدمجة
 * البسيطة وحدها تمرّ عبر cmd.exe. ومحارفُ الصَّدَفة (| & > < ; ` $() تُرفض باسمها: الصندوقُ لا يفسّر سلاسلَ أوامر.
 */
const CMD_BUILTINS = new Set(["type", "echo", "dir", "set", "ver", "vol", "cd", "where", "copy", "move", "del", "erase", "mkdir", "md", "rmdir", "rd", "ren", "rename"])

export function sandboxTokens(command: string): string[] | undefined {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/gu
  for (const m of command.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!)
  return out.length === 0 ? undefined : out
}

export function sandboxInvocation(command: string, which: (name: string) => string | null, systemRoot = "C:\\Windows"): { readonly executable: string; readonly argv: readonly string[] } | { readonly refusal: string } {
  if (/[|&<>;`]|\$\(/u.test(command.replace(/"[^"]*"|'[^']*'/gu, ""))) return { refusal: "الصندوقُ لا يفسّر سلاسلَ الصَّدَفة (| & > < ; ` $()) — شغّل برنامجاً واحداً بوسائطه، أو ضع السلسلةَ في سكربتٍ داخل المشروع وشغّله" }
  const tokens = sandboxTokens(command)
  if (tokens === undefined) return { refusal: "run --sandbox يحتاج أمراً" }
  const [program, ...args] = tokens as [string, ...string[]]
  const cmdExe = `${systemRoot}\\System32\\cmd.exe`
  if (CMD_BUILTINS.has(program.toLowerCase())) return { executable: cmdExe, argv: ["/d", "/c", program, ...args] }
  const resolved = /^[A-Za-z]:[\\/]/u.test(program) ? program : which(program)
  if (resolved === null) return { refusal: `لا يُعثر على «${program.slice(0, 60)}» في PATH على المضيف — أعطِ مسارَه الكامل` }
  // ‏.cmd/.bat يفسّرها cmd.exe، بمسارها الكامل وسيطاً منفصلاً.
  if (/\.(?:cmd|bat)$/iu.test(resolved)) return { executable: cmdExe, argv: ["/d", "/c", resolved, ...args] }
  return { executable: resolved, argv: args }
}

export const SANDBOX_LINE = "🛡 معزول: AppContainer بلا شبكة وبلا وصولٍ إلى ملفّات المستخدم — مجلّدُ المشروع وحده مفتوح، والبرنامجُ بمساره الكامل بلا صَدَفة."
