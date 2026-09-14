/**
 * Production capability assembly.
 *
 * These checks are deliberately pure: importing a package must not start a
 * process, open a network connection or mutate a project. The live shell calls
 * this assembly in its status path, which makes the packages part of the
 * shipped engine graph while their effectful entry points remain behind policy.
 */
import { RUNG_ORDER } from "@abdo/browser"
import { registerBuiltins } from "@abdo/builtin-tools"
import { scheduleLevels } from "@abdo/controlplane"
import { OPERATION_HASH_VERSION } from "@abdo/grants"
import { fingerprint } from "@abdo/healing"
import { SERVERS } from "@abdo/lsp"
import { RecoveryReconciler } from "@abdo/recovery"
import { DEFAULT_SEARCH_LIMITS } from "@abdo/reliability"
import { SECRET_BROKER_CONTRACT_VERSION } from "@abdo/secret-broker"
import { DEFAULT_VISUAL_LIMIT } from "@abdo/verification"
import { JOURNAL_VERSION as WINDOWS_ISOLATION_JOURNAL_VERSION } from "@abdo/windows-isolation-helper"

const capabilities = Object.freeze([
  ["browser", () => RUNG_ORDER[0] === "dom"],
  ["builtin-tools", () => typeof registerBuiltins === "function"],
  ["controlplane", () => typeof scheduleLevels === "function"],
  ["grants", () => OPERATION_HASH_VERSION > 0],
  ["healing", () => fingerprint({ failureClass: "probe", message: "probe", site: "assembly" }).id.length > 0],
  ["lsp", () => SERVERS.length > 0],
  ["recovery", () => typeof RecoveryReconciler === "function"],
  ["reliability", () => DEFAULT_SEARCH_LIMITS.maxHits > 0],
  ["secret-broker", () => SECRET_BROKER_CONTRACT_VERSION > 0],
  ["verification", () => DEFAULT_VISUAL_LIMIT > 0],
  ["windows-isolation", () => WINDOWS_ISOLATION_JOURNAL_VERSION > 0],
] as const)

export interface ProductCapabilityStatus {
  readonly connected: number
  readonly total: number
  readonly refused: readonly string[]
}

export function productCapabilityStatus(): ProductCapabilityStatus {
  const refused = capabilities.filter(([, probe]) => !probe()).map(([name]) => name)
  return Object.freeze({
    connected: capabilities.length - refused.length,
    total: capabilities.length,
    refused: Object.freeze(refused),
  })
}
