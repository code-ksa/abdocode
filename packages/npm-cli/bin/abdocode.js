#!/usr/bin/env node
// AbdoCode from the terminal. On first run this downloads the engine for this package's version from the GitHub
// release, checks its SHA-256 against release.json (shipped inside the package), unpacks it under the user's local
// app data, and then runs it here with the same arguments. Later runs start the engine directly.
"use strict"
const { spawn, spawnSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")

const release = require("../release.json")

function fail(message) {
  process.stderr.write(`abdocode: ${message}\n`)
  process.exit(1)
}

const target = `${process.platform}-${process.arch}`
const asset = release.assets[target]
if (!asset) fail(`no engine build for ${target} yet (available: ${Object.keys(release.assets).join(", ")}).`)

const root = process.env.ABDOCODE_CLI_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "abdocode-cli")
const dir = path.join(root, release.version)
const exe = path.join(dir, asset.entry)

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": `abdocode-npm/${release.version}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        resolve(download(new URL(res.headers.location, url).toString(), file, redirects + 1))
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`)); return }
      const total = Number(res.headers["content-length"] || asset.size || 0)
      let got = 0, shown = -1
      const out = fs.createWriteStream(file)
      res.on("data", (chunk) => {
        got += chunk.length
        const pct = total ? Math.floor((got / total) * 100) : -1
        if (pct !== shown && process.stderr.isTTY) { shown = pct; process.stderr.write(`\rabdocode: downloading the engine ${pct >= 0 ? pct + "%" : Math.round(got / 1048576) + " MB"}   `) }
      })
      res.pipe(out)
      out.on("finish", () => { if (process.stderr.isTTY) process.stderr.write("\n"); out.close(resolve) })
      out.on("error", reject)
    }).on("error", reject)
  })
}

function sha256(file) {
  const hash = createHash("sha256")
  hash.update(fs.readFileSync(file))
  return hash.digest("hex")
}

async function install() {
  fs.mkdirSync(root, { recursive: true })
  const zip = path.join(root, `${release.version}.download.zip`)
  await download(asset.url, zip)
  const actual = sha256(zip)
  if (actual !== asset.sha256) { fs.rmSync(zip, { force: true }); fail(`checksum mismatch for the engine download (expected ${asset.sha256}, got ${actual}) — nothing was installed.`) }
  const staging = `${dir}.partial`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  // tar on Windows 10+ (bsdtar) and on macOS/Linux reads zip archives.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar"
  const unpacked = spawnSync(tar, ["-xf", zip, "-C", staging], { stdio: "inherit" })
  fs.rmSync(zip, { force: true })
  if (unpacked.status !== 0) { fs.rmSync(staging, { recursive: true, force: true }); fail("could not unpack the engine archive.") }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(staging, dir)
}

async function main() {
  if (!fs.existsSync(exe)) await install()
  const child = spawn(exe, process.argv.slice(2), { stdio: "inherit", windowsHide: false })
  const forward = (signal) => { try { child.kill(signal) } catch { /* already gone */ } }
  process.on("SIGINT", () => forward("SIGINT"))
  process.on("SIGTERM", () => forward("SIGTERM"))
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0))
  child.on("error", (error) => fail(error.message))
}

main().catch((error) => fail(error.message))
