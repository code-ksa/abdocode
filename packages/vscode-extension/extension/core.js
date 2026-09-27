// AbdoCode for VS Code — the logic, kept free of the VS Code API so it is tested without an editor.
//
// Gap #7 in the 2026-09-27 table (Codex and Claude Code live inside the editor). There is no second way to drive the
// agent here: every task runs through `abdocode exec` — the same gates, kernel and ledger as the desktop app — and
// the extension only chooses the project, the mode and the timeout, then reads the JSON summary.
"use strict"

// These are the desktop app's Windows locations (LOCALAPPDATA, APPDATA): built with path.win32 on every OS, so the
// result is the same wherever it is computed (measured: CI on Linux joined them with "/").
const path = require("node:path").win32

/** Where the engine may be, in order: the user's setting, then the desktop app's per-user and machine installs. */
function engineCandidates(env, configured) {
  const out = []
  if (typeof configured === "string" && configured.trim().length > 0) out.push(configured.trim())
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "AbdoCode", "payload", "abdocode.exe"))
  if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, "AbdoCode", "payload", "abdocode.exe"))
  return out
}

function findEngine(candidates, exists) {
  return candidates.find((candidate) => exists(candidate))
}

/**
 * The desktop app's profile holds the user's models and vault. The extension reads the same settings and vault, but
 * keeps its OWN engine state: two engines on one ledger break its sequencing (measured in the A/B lab).
 */
function engineEnv(env, profileDir) {
  const profile = profileDir || (env.APPDATA ? path.join(env.APPDATA, "io.abdocode.desktop") : undefined)
  if (profile === undefined) return { ...env }
  const vaultHome = path.join(profile, "vault-home")
  return {
    ...env,
    ABDO_CODE_SETTINGS: env.ABDO_CODE_SETTINGS || path.join(profile, "engine-settings.json"),
    ABDO_CODE_STATE_DIR: env.ABDO_CODE_STATE_DIR || path.join(profile, "engine-state-vscode"),
    ABDO_VAULT_HOME: env.ABDO_VAULT_HOME || vaultHome,
    ABDO_VAULT_DIR: env.ABDO_VAULT_DIR || path.join(vaultHome, "vault"),
  }
}

const MODES = ["read-only", "auto", "full-access"]

function execArgs(task, options) {
  const mode = MODES.includes(options.mode) ? options.mode : "auto"
  const timeout = Math.min(86400, Math.max(10, Math.round(Number(options.timeoutSeconds) || 1800)))
  return ["exec", task, "--project", options.project, "--mode", mode, "--timeout", String(timeout), "--json"]
}

/** The selection travels as context the model can quote — file, language and the exact text. */
function taskWithSelection(question, selection) {
  if (!selection || !selection.text || selection.text.trim().length === 0) return question
  const fence = selection.text.includes("```") ? "~~~~" : "```"
  return `${question}\n\nFile: ${selection.file}${selection.startLine ? ` (lines ${selection.startLine}-${selection.endLine})` : ""}\n${fence}${selection.language || ""}\n${selection.text}\n${fence}`
}

function parseSummary(stdout) {
  const start = stdout.indexOf("{")
  if (start < 0) return { error: "the engine returned no JSON summary" }
  try {
    const summary = JSON.parse(stdout.slice(start))
    if (typeof summary !== "object" || summary === null || typeof summary.outcome !== "string") return { error: "the summary has no outcome" }
    return { summary }
  } catch (cause) {
    return { error: `the summary is not valid JSON: ${String(cause && cause.message ? cause.message : cause).slice(0, 120)}` }
  }
}

function reportLines(summary) {
  const lines = [`— ${summary.outcome}${summary.stop ? ` (${summary.stop})` : ""} · ${summary.tools.length} tools · ${Math.round(summary.durationMs / 1000)} s`]
  for (const tool of summary.tools) lines.push(`  ${tool.ok === true ? "✓" : tool.ok === false ? "✗" : "·"} ${tool.cmd}`)
  if (summary.approvalsDenied.length > 0) lines.push(`  ${summary.approvalsDenied.length} approval(s) refused — widen abdocode.mode to allow them: ${summary.approvalsDenied.join(" | ").slice(0, 300)}`)
  if (summary.gates) lines.push(`  ${summary.gates}`)
  if (summary.reason) lines.push(`  reason: ${summary.reason}`)
  return lines
}

/**
 * Runs one task. `command` is the engine invocation (`[abdocode.exe]`, or `[bun, cli.ts]` from source); progress
 * lines arrive on stderr and the summary on stdout. Resolves with the summary, or with an error that names why.
 */
function runTask({ command, args, env, cwd, spawn, onProgress, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, windowsHide: true })
    let stdout = "", stderr = "", pending = ""
    const onAbort = () => { try { child.kill() } catch { /* already gone */ } }
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8") })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      stderr += text
      pending += text
      let cut
      while ((cut = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, cut).replace(/\r$/, "")
        pending = pending.slice(cut + 1)
        if (line.trim().length > 0 && onProgress) onProgress(line)
      }
    })
    child.on("error", (error) => resolve({ error: `could not start the engine: ${error.message}` }))
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort)
      if (signal && signal.aborted) return resolve({ error: "cancelled" })
      const parsed = parseSummary(stdout)
      if (parsed.summary) return resolve({ summary: parsed.summary, exitCode: code })
      resolve({ error: `${parsed.error} (exit ${code}): ${stderr.trim().split("\n").slice(-2).join(" / ").slice(0, 300)}` })
    })
  })
}

module.exports = { engineCandidates, findEngine, engineEnv, execArgs, taskWithSelection, parseSummary, reportLines, runTask, MODES }
