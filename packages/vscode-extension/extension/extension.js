// AbdoCode for VS Code — the editor binding. All logic lives in core.js; this file only talks to the VS Code API.
"use strict"

const vscode = require("vscode")
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const core = require("./core")

let output

function config() {
  const c = vscode.workspace.getConfiguration("abdocode")
  return { enginePath: c.get("enginePath"), mode: c.get("mode"), timeoutSeconds: c.get("timeoutSeconds"), profileDir: c.get("profileDir") }
}

async function run(task) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!folder) return void vscode.window.showErrorMessage("AbdoCode: open a folder first — the task runs in the workspace project.")
  const settings = config()
  const engine = core.findEngine(core.engineCandidates(process.env, settings.enginePath), (p) => fs.existsSync(p))
  if (!engine) return void vscode.window.showErrorMessage("AbdoCode: the engine was not found. Install the AbdoCode desktop app, or set abdocode.enginePath to abdocode.exe.")
  output.show(true)
  output.appendLine(`▶ ${task.split("\n")[0].slice(0, 200)}`)
  output.appendLine(`  project ${folder.uri.fsPath} · mode ${settings.mode}`)
  const controller = new AbortController()
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "AbdoCode", cancellable: true },
    (progress, token) => {
      token.onCancellationRequested(() => controller.abort())
      return core.runTask({
        command: [engine],
        args: core.execArgs(task, { project: folder.uri.fsPath, mode: settings.mode, timeoutSeconds: settings.timeoutSeconds }),
        env: core.engineEnv(process.env, settings.profileDir),
        cwd: folder.uri.fsPath,
        spawn,
        signal: controller.signal,
        onProgress: (line) => { output.appendLine(`  ${line}`); progress.report({ message: line.slice(0, 80) }) },
      })
    },
  )
  if (result.error) {
    output.appendLine(`✗ ${result.error}`)
    return void vscode.window.showErrorMessage(`AbdoCode: ${result.error}`)
  }
  const summary = result.summary
  output.appendLine("")
  output.appendLine(summary.answer || "(no answer)")
  for (const line of core.reportLines(summary)) output.appendLine(line)
  const note = `AbdoCode: ${summary.outcome}${summary.stop ? ` (${summary.stop})` : ""} — ${summary.tools.length} tools`
  if (summary.exitCode === 0) vscode.window.showInformationMessage(note)
  else vscode.window.showWarningMessage(note)
}

function activate(context) {
  output = vscode.window.createOutputChannel("AbdoCode")
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("abdocode.runTask", async () => {
      const task = await vscode.window.showInputBox({ prompt: "What should AbdoCode do in this project?", ignoreFocusOut: true })
      if (task && task.trim()) await run(task.trim())
    }),
    vscode.commands.registerCommand("abdocode.askSelection", async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) return void vscode.window.showWarningMessage("AbdoCode: select some code first.")
      const question = await vscode.window.showInputBox({ prompt: "What about the selected code?", ignoreFocusOut: true })
      if (!question || !question.trim()) return
      const doc = editor.document
      const selection = {
        file: vscode.workspace.asRelativePath(doc.uri),
        language: doc.languageId,
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: doc.getText(editor.selection),
      }
      await run(core.taskWithSelection(question.trim(), selection))
    }),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
