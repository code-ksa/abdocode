import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const roots = ["packages", "architecture", "docs"]
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".mdx", ".html", ".astro", ".rs", ".toml", ".yml", ".yaml"])
const forbidden = [
  ["abdo-code-", "latest"].join(""),
  ["abdo", "3"].join(""),
  ["agent", "-admin"].join(""),
  ["agent", "admin"].join(""),
  ["Abdo", "Code3"].join(""),
  ["C:", "\\agent", "-admin"].join(""),
  ["Mopar", "Meg"].join(""),
  ["Edu", "Global"].join(""),
  ["Mubar", "mij"].join(""),
]
const findings = []
let scanned = 0
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "target", "dist", ".git"].includes(name)) continue
    const path = join(directory, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (extensions.has(extname(path))) {
      scanned++
      const text = readFileSync(path, "utf8")
      for (const token of forbidden) if (text.toLowerCase().includes(token.toLowerCase())) findings.push(`${relative(".", path)}: forbidden private-product marker`)
    }
  }
}
for (const root of roots) walk(root)
if (findings.length) { console.error(`PUBLIC_BOUNDARY_FAILED (${findings.length})\n${findings.join("\n")}`); process.exit(1) }
console.log(`PUBLIC_BOUNDARY_OK files=${scanned} forbidden=0`)
