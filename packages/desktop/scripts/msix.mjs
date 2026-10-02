// Microsoft Store package (MSIX) from the release build: abdocode-desktop.exe + payload/ in a full-trust desktop package.
// The Store signs the package on publication, so no code-signing certificate is needed here.
//
//   node packages/desktop/scripts/msix.mjs --name <Package/Identity/Name> --publisher "<CN=…>" --publisher-name "<display>" [--out dir]
//
// The three identity values come from Partner Center (Product identity) after the app name is reserved. Without them the
// script builds a local test package with placeholder identity that the Store would reject.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const here = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const conf = JSON.parse(readFileSync(join(here, "src-tauri", "tauri.conf.json"), "utf8"))
const version = `${conf.version.split("-")[0]}.0` // the Store wants four parts with revision 0
const identity = arg("--name", "AbdoCode.LocalTest")
const publisher = arg("--publisher", "CN=AbdoCode Local Test")
const publisherName = arg("--publisher-name", "AbdoCode")
const out = resolve(arg("--out", join(here, "src-tauri", "target", "msix")))
const exe = join(here, "src-tauri", "target", "release", "abdocode-desktop.exe")
const payload = join(here, "src-tauri", "payload")
const icon = join(here, "src-tauri", "icons", "icon.png")
for (const [what, path] of [["release build", exe], ["payload", join(payload, "abdocode.exe")], ["icon", icon]]) {
  if (!existsSync(path)) { console.error(`msix: ${what} missing at ${path} — build the desktop app first`); process.exit(2) }
}
if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity)) { console.error(`msix: bad --name ${identity}`); process.exit(2) }
if (!/^CN=/.test(publisher)) { console.error("msix: --publisher must start with CN="); process.exit(2) }

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const layout = join(out, "layout")
rmSync(layout, { recursive: true, force: true })
mkdirSync(join(layout, "assets"), { recursive: true })
cpSync(exe, join(layout, "abdocode-desktop.exe"))
cpSync(payload, join(layout, "payload"), { recursive: true })

// Store tile assets from the app icon (System.Drawing through PowerShell — no image library in the repo).
const sizes = { "Square44x44Logo.png": 44, "Square150x150Logo.png": 150, "StoreLogo.png": 50, "Square44x44Logo.targetsize-256_altform-unplated.png": 256 }
const ps = Object.entries(sizes).map(([file, n]) =>
  `$b=New-Object System.Drawing.Bitmap ${n},${n};$g=[System.Drawing.Graphics]::FromImage($b);$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($src,0,0,${n},${n});$b.Save('${join(layout, "assets", file).replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$b.Dispose()`).join(";")
const drawn = spawnSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Drawing;$src=[System.Drawing.Image]::FromFile('${icon.replace(/'/g, "''")}');${ps};$src.Dispose()`], { stdio: "inherit" })
if (drawn.status !== 0) process.exit(drawn.status ?? 1)

writeFileSync(join(layout, "AppxManifest.xml"), `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identity)}" Publisher="${xml(publisher)}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>AbdoCode</DisplayName>
    <PublisherDisplayName>${xml(publisherName)}</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="ar" />
  </Resources>
  <Applications>
    <Application Id="AbdoCode" Executable="abdocode-desktop.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="AbdoCode" Description="A coding agent that runs on your own machine."
        BackgroundColor="transparent" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`)

const sdk = "C:\\Program Files (x86)\\Windows Kits\\10\\bin"
const versions = existsSync(sdk) ? spawnSync("cmd", ["/c", "dir", "/b", "/ad", sdk], { encoding: "utf8" }).stdout.split(/\r?\n/).filter((d) => /^10\./.test(d)).sort() : []
const makeappx = versions.map((v) => join(sdk, v, "x64", "makeappx.exe")).reverse().find((p) => existsSync(p))
if (!makeappx) { console.error("msix: makeappx.exe not found (Windows SDK)"); process.exit(2) }
const file = join(out, `AbdoCode-${version}-x64.msix`)
const packed = spawnSync(makeappx, ["pack", "/d", layout, "/p", file, "/o"], { stdio: "inherit" })
if (packed.status !== 0) process.exit(packed.status ?? 1)
console.log(`msix: ${file}  (identity ${identity}, ${publisher}, ${version})`)
