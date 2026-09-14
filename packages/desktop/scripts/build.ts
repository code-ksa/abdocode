#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"

const desktop = path.resolve(import.meta.dir, "..")
await $`bun ${path.join(import.meta.dir, "prepare.ts")}`
await $`bunx @tauri-apps/cli build`.cwd(path.join(desktop, "src-tauri"))
