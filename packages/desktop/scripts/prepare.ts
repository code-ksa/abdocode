#!/usr/bin/env bun

import { $ } from "bun"
import { cp, readdir, rm } from "node:fs/promises"
import path from "node:path"

/**
 * 🔴 **حمولةُ سطح المكتب حزمةُ ويندوز، و`prepare` يعمل مع كلّ `bun install`.**
 *
 * مقيس 2026-09-26 على أوّل تشغيلٍ لـCI (أوبونتو): السكربتُ بنى النواةَ بنجاح ثمّ سقط
 * بـ`ENOENT` على `abdo-kernel.exe` — فكارجو على لينكس لا يضع لاحقةَ `.exe`. والحمولةُ
 * كلُّها لمُنصِّب NSIS على ويندوز: لا شيءَ يُرحَّل منها على لينكس.
 *
 * فيُتخطّى **بالسبب منطوقاً** لا صامتاً، ولا يُخفى العطلُ على ويندوز: هناك يبقى
 * السقوطُ سقوطاً. وتخطٍّ صامتٌ هنا كان سيجعل بناءَ سطح المكتب على لينكس «ينجح» بلا حمولة.
 */
if (process.platform !== "win32") {
  console.error(`⏭ prepare: حمولةُ سطح المكتب حزمةُ ويندوز (مُنصِّب NSIS) — لا شيءَ يُرحَّل على ${process.platform}. تُخطّى بالسبب.`)
  process.exit(0)
}

const desktop = path.resolve(import.meta.dir, "..")
const root = path.resolve(desktop, "../..")
const payload = path.join(desktop, "src-tauri", "payload")
const engine = path.join(root, "packages", "engine", "dist", "abdocode.exe")
const kernel = path.join(root, "packages", "kernel", "target", "release", "abdo-kernel.exe")
const toolWorker = path.join(root, "packages", "kernel", "target", "release", "abdo-tool-worker.exe")
// الفجوة #4 (2026-09-27) — خطّافُ AppContainer يُشحن مع بيان بنائه: المحرّكُ لا يثق بثنائيٍّ لا تطابق بصمتُه البيان.
const winisoPackage = path.join(root, "packages", "windows-isolation-helper")
const winiso = path.join(winisoPackage, "target", "release", "abdo-winiso.exe")
const winisoManifest = path.join(winisoPackage, "helper-manifest.json")

// The xterm renderer and CSS are bundled locally; no runtime CDN or remote code.
await $`bun build ${path.join(desktop, "src", "native-terminal.js")} --target=browser --format=esm --outdir=${path.join(desktop, "ui")}`
await Bun.write(path.join(desktop, "ui", "xterm-LICENSE.txt"), Bun.file(path.join(desktop, "node_modules", "@xterm", "xterm", "LICENSE")))

// The executable shell must never carry stale hand-copied contracts. These
// browser modules are rebuilt from the same owned sources tested by the engine.
await $`bun build ${path.join(root, "packages", "providers", "src", "catalog.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "providers.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "shell.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "shell.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "turns.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "turns.js")}`
// IDEA 6 — the slot registry is the MECHANISM, not a feature: it carries no
// toggle and is imported statically, so there is exactly one way to mount and
// one way to tear down. The pure registry (shells/slots.ts) is bundled in.
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "slot-host.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "slot-host.js")}`
// الحالةُ التي لا يملكها السجلّ (مِرساةُ اللوح وتوسيعُه ونقطةُ «جديدٌ لم تره»).
// آليّةٌ كالسجلّ: بلا مفتاح، وتُستورد ثابتاً — لا فرعَ ثانياً لميزةٍ ثانية.
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "panels.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "panels.js")}`
// Lazily imported by the shell only when its plugin toggle is on: an OFF
// toggle must mean the file is never fetched, not fetched and ignored. Each
// bundle carries its feature's PURE reducer plus that feature's slot
// contribution — one fetch per feature, and nothing at all when it is off.
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "approval-mount.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "approval-mount.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "trajectory-mount.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "trajectory-mount.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "deliverables-mount.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "deliverables-mount.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "terminal-panel.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "terminal-panel.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "servers-panel.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "servers-panel.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "tasks-panel.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "tasks-panel.js")}`
await $`bun build ${path.join(root, "packages", "engine", "src", "shells", "mcp-catalogue.ts")} --target=browser --format=esm --outfile=${path.join(desktop, "ui", "mcp-catalogue.js")}`

await $`bun run --cwd ${path.join(root, "packages", "engine")} build`
// Production uses the kernel's guarded dispatch path. The default Rust build
// deliberately keeps it compiled out for fail-closed library/test consumers.
await $`cargo build --release --manifest-path ${path.join(root, "packages", "kernel", "Cargo.toml")} --bin abdo-kernel --features effectful-dispatch`
await $`cargo build --release --manifest-path ${path.join(root, "packages", "kernel", "Cargo.toml")} --bin abdo-tool-worker`
// build.ps1 يبني ويكتب بيانه بمساراتٍ نسبيّة إلى حزمته — فيُشغَّل منها (مقيس: من الجذر بحث عن target\release في الجذر وسقط).
await $`powershell -NoProfile -ExecutionPolicy Bypass -File ${path.join(winisoPackage, "build.ps1")}`.cwd(winisoPackage)
await $`mkdir -p ${path.join(payload, "bin")}`
// The payload is a staging directory, not an application data directory, and
// tauri.conf.json bundles it whole (`"resources": ["payload/**/*"]`) — so
// whatever survives here ships. Pruning by file type could only see the file
// type it named: it removed a local smoke's journal (which would bind a fresh
// installation to another run's state) but was blind to a binary staged under
// a name this run no longer writes. The 2026-09-03 rename produced exactly
// that — a 99 MB pre-rename engine sitting beside the new one, still reading
// the retired vault prefix. So the rule is stated positively instead: this run
// declares the files it stages, and every other file is removed.
const WRITES = [
  { file: path.join(payload, "abdocode.exe"), source: engine, staged: "abdocode.exe" },
  { file: path.join(payload, "bin", "abdo-kernel.exe"), source: kernel, staged: "bin/abdo-kernel.exe" },
  { file: path.join(payload, "bin", "abdo-tool-worker.exe"), source: toolWorker, staged: "bin/abdo-tool-worker.exe" },
  { file: path.join(payload, "bin", "abdo-winiso.exe"), source: winiso, staged: "bin/abdo-winiso.exe" },
  { file: path.join(payload, "bin", "helper-manifest.json"), source: winisoManifest, staged: "bin/helper-manifest.json" },
]
const keep = new Set([...WRITES.map((entry) => entry.staged), "release-lessons.json"])
// The three declared files are overwritten in place rather than deleted first:
// on Windows a payload binary left running by a live smoke holds its own file,
// and deleting the whole directory would make `prepare` unrunnable whenever
// one is up — a worse failure than the one being fixed.
for (const [dir, prefix] of [
  [payload, ""],
  [path.join(payload, "bin"), "bin/"],
] as const) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && !keep.has(`${prefix}${entry.name}`)) {
      await rm(path.join(dir, entry.name), { force: true })
    }
  }
}
for (const entry of WRITES) await Bun.write(entry.file, Bun.file(entry.source))
// الحزمُ المضمَّنة مع عبدو كود (extensions/bundled — خطُّ المنتج): تُنسخ كاملةً فتظهر في الإعدادات ← الامتدادات ← «المضمَّنة»
// وتُثبَّت بالمسار نفسِه الذي يثبّت به المستخدم حزمةً من مجلّد (مراجعة ⇦ تثبيت ⇦ تفعيل). المجلّد يُمسح ثمّ يُنسخ فلا بقايا.
// ت1 — دروسُ الإصدار المراجَعة (packages/engine/release-lessons.json) تُشحن مع الحمولة فيرقّيها المحرّكُ إلى الوعي العامّ مرّةً لكلّ إصدار.
await cp(path.join(root, "packages", "engine", "release-lessons.json"), path.join(payload, "release-lessons.json"))
const bundledSource = path.join(root, "extensions", "bundled")
const bundledStaged = path.join(payload, "extensions", "bundled")
await rm(bundledStaged, { recursive: true, force: true })
await cp(bundledSource, bundledStaged, { recursive: true, filter: (source) => !/(^|[\\/])(PORT-REPORT\.md|\.DS_Store)$/.test(source) })

// ...and the result is asserted, not trusted, so the next rename cannot leave
// a second engine behind silently the way this one did.
const stagedNow = (
  await Promise.all(
    (
      [
        [payload, ""],
        [path.join(payload, "bin"), "bin/"],
      ] as const
    ).map(async ([dir, prefix]) =>
      (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => `${prefix}${entry.name}`),
    ),
  )
).flat()
const unexpected = stagedNow.filter((name) => !keep.has(name))
const missing = [...keep].filter((name) => !stagedNow.includes(name))
if (unexpected.length > 0 || missing.length > 0) {
  throw new Error(
    `payload staging does not match this build — unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
  )
}

console.log("Prepared AbdoCode payload from rust-main")
