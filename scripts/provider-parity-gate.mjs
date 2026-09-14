#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { DEFAULT_MODEL, PROVIDER_DEFINITIONS } from "../packages/providers/src/catalog.ts"

const root = path.resolve(import.meta.dir, "..")
const workerPath = path.join(root, "packages/kernel/bins/abdo-tool-worker/src/provider.rs")
const browserPath = path.join(root, "packages/desktop/ui/providers.js")
const worker = await readFile(workerPath, "utf8")

const rust = new Map()
for (const block of worker.matchAll(/ProviderBinding\s*\{([\s\S]*?)\n\s*\},/g)) {
  const id = block[1].match(/id:\s*"([^"]+)"/)?.[1]
  const url = block[1].match(/url:\s*"([^"]+)"/)?.[1]
  const vaultKey = block[1].match(/vault_key:\s*"([^"]+)"/)?.[1]
  if (id && url && vaultKey) rust.set(id, { url, vaultKey })
}

const remote = PROVIDER_DEFINITIONS.filter((item) => !item.local)
const errors = []
for (const item of remote) {
  const binding = rust.get(item.id)
  if (!binding) errors.push(`${item.id}: missing Rust worker binding`)
  else {
    if (binding.url !== item.workerUrl) errors.push(`${item.id}: endpoint drift`)
    if (binding.vaultKey !== item.vaultKey) errors.push(`${item.id}: vault handle drift`)
  }
}
for (const id of rust.keys()) if (!remote.some((item) => item.id === id)) errors.push(`${id}: worker-only provider`)

// The checked-in desktop asset is the exact offline payload shipped by Tauri.
// Import it as data and reject a stale build before packaging.
const browser = await import(`${pathToFileURL(browserPath).href}?gate=${Date.now()}`)
const browserProviders = browser.Providers?.PROVIDERS ?? []
if (JSON.stringify(browserProviders) !== JSON.stringify(PROVIDER_DEFINITIONS)) {
  errors.push("desktop provider bundle is stale; run packages/desktop/scripts/prepare.ts")
}

// مقبضا بحث جوجل خارج اللائحة: لا `ProviderBinding` لهما ولا مدخلَ كتالوج، بل
// حرفان يُكتبان بيدٍ في مكانين لا يعرف أحدهما الآخر — الرست يقرأ، والغلاف
// يكتب. البوّابةُ أعلاه لا تعدّهما أصلاً، فتغييرُ بادئةٍ نصفَ منجزٍ على سكّة
// البحث كان يمرّ صامتاً ويُعيد «الخزنة غير مهيّأة» بلا سببٍ مسمّى. تُقارن
// الحروفُ هنا، حيث تُقارن أصلاً بقيّةُ عقد الأسرار.
const shell = await readFile(path.join(root, "packages/desktop/ui/index.html"), "utf8")
const workerSearch = [...new Set([...worker.matchAll(/read_secret\("([a-z0-9-]*pse[a-z0-9-]*)"\)/g)].map((match) => match[1]))].sort()
const shellSearch = [...new Set([...shell.matchAll(/key:\s*"([a-z0-9-]*pse[a-z0-9-]*)"/g)].map((match) => match[1]))].sort()
if (workerSearch.length !== 2) errors.push(`google pse handle drift: worker declares ${workerSearch.length} handles, expected 2`)
if (workerSearch.join("|") !== shellSearch.join("|")) {
  errors.push(`google pse handle drift: worker [${workerSearch.join(", ")}] vs shell [${shellSearch.join(", ")}]`)
}
// وبادئتُهما ليست حرّة: هي بادئةُ مفاتيح المزوّدين نفسها، وإلا رفضها سياجُ
// `vault_set` في المضيف ورفضها نمطُ vault.ps1 قبل أن يُكتب شيء.
const vaultPrefixes = new Set(remote.map((item) => `${item.vaultKey.split("-")[0]}-`))
if (vaultPrefixes.size !== 1) errors.push(`provider vault handles do not share one prefix: ${[...vaultPrefixes].join(", ")}`)
else {
  const [prefix] = [...vaultPrefixes]
  for (const handle of workerSearch) {
    if (!handle.startsWith(prefix)) errors.push(`google pse handle drift: ${handle} does not carry the ${prefix} prefix`)
  }
}

// الافتراضيُّ له نسختان بالضرورة (TypeScript للمحرّك والقشرة، Rust لعامل الأتمتة) — فتُقاس المطابقةُ هنا لا تُفترض.
const desktopSetup = await readFile(path.join(root, "packages/desktop/src-tauri/src/provider_setup.rs"), "utf8")
const rustDefault = desktopSetup.match(/const DEFAULT_MODEL: &str = "([^"]+)"/)?.[1]
if (rustDefault !== DEFAULT_MODEL) errors.push(`default model drift: catalog ${DEFAULT_MODEL} vs desktop rust ${rustDefault ?? "(missing)"}`)
const [defaultProvider, defaultModel] = DEFAULT_MODEL.split("/")
if (!PROVIDER_DEFINITIONS.some((item) => item.id === defaultProvider && item.models.includes(defaultModel))) errors.push(`default model ${DEFAULT_MODEL} is not a catalogued model`)

if (errors.length > 0) {
  console.error(`PROVIDER_PARITY_FAILED\n${errors.map((error) => `- ${error}`).join("\n")}`)
  process.exit(1)
}
console.log(
  `PROVIDER_PARITY_OK catalogue=${PROVIDER_DEFINITIONS.length} remote=${remote.length} rust=${rust.size} search=${workerSearch.length}`,
)
