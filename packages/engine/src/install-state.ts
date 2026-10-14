/**
 * 10-12 — أين تُكتب حالةُ المحرّك (قواعدُه، دفاترُه، رمزُ جسر الإضافة، اللقطات).
 * الافتراضُ مجلّدُ الـexe نفسُه (المثبِّت يضعه في LOCALAPPDATA فيُكتب فيه). نسخةُ متجر مايكروسوفت (MSIX) تُثبَّت في WindowsApps
 * للقراءة فقط، فأوّلُ كتابةٍ تفشل — هناك تذهب الحالةُ إلى %LOCALAPPDATA%\AbdoCode\state ما لم يُعطَ مجلّدٌ صريح (القشرةُ تمرّره،
 * وهذا احتياطُ الأطفال الذين يُشغَّلون ببيئةٍ منزوعة: جسرُ الإضافة وخوادمُ MCP المشحونة).
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const STORE_INSTALL = /[\\/]windowsapps[\\/]/iu

export const isStoreInstall = (root: string): boolean => STORE_INSTALL.test(root)

export const stateRootFor = (root: string, env: Record<string, string | undefined>): string => {
  const supplied = env.ABDO_CODE_STATE_DIR?.trim()
  if (supplied !== undefined && supplied.length > 0) return resolve(supplied)
  if (!isStoreInstall(root)) return resolve(root)
  const local = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local")
  return resolve(local, "AbdoCode", "state")
}

/** مجلّدُ المتجر لا يوجد قبل أوّل تشغيل — يُنشأ؛ ومجلّدُ الـexe موجودٌ أصلاً. */
export const ensureStateRoot = (root: string, state: string): string => {
  if (isStoreInstall(root)) { try { mkdirSync(state, { recursive: true }) } catch { /* الكتابةُ التالية تقول السبب */ } }
  return state
}
