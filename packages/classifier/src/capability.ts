/**
 * CL-05 — semantic capability classification.
 *
 * Replaces the CL-01 placeholder that mapped TOOL NAMES to capabilities. What
 * matters is what the command does: `shell` running `rm -rf build` is a
 * `filesystem.delete`, not a generic `code.execute`.
 *
 * DETERMINISTIC by construction: a lookup over the resolved program and its
 * first non-flag argument. No heuristics, no scoring, no ordering surprises —
 * the same command always classifies the same way, which is what makes a
 * decision comparable and a policy testable.
 *
 * `unknown` is a real answer, not a shrug: an unrecognised program means we
 * cannot say what it does, and the risk model treats that as a reason to
 * escalate, never as evidence of harmlessness.
 *
 * Docker/SSH/Kubernetes/cloud families are classified so those commands are not
 * silently `unknown`. That is not support: there is no adapter, no target
 * contract and no execution path for them (CL-12/CL-13).
 */
import type { Capability, NormalizedCommand } from "@abdo/control-contracts"

/** A subcommand-driven family: program -> subcommand -> capability. */
type SubTable = Readonly<Record<string, Capability>>

const GIT: SubTable = {
  status: "git.read", log: "git.read", diff: "git.read", show: "git.read", branch: "git.read",
  remote: "git.read", fetch: "git.read", ls: "git.read", blame: "git.read", describe: "git.read",
  add: "git.commit", commit: "git.commit", tag: "git.commit", stash: "git.commit", merge: "git.commit",
  rebase: "git.commit", cherry: "git.commit", checkout: "git.commit", switch: "git.commit", clone: "network.request",
  pull: "network.request", push: "git.push", reset: "git.reset", clean: "git.reset", revert: "git.reset",
}
const DOCKER: SubTable = {
  ps: "docker.inspect", inspect: "docker.inspect", logs: "docker.inspect", images: "docker.inspect",
  version: "docker.inspect", build: "docker.build", run: "docker.run", compose: "docker.run",
  start: "docker.run", exec: "docker.exec", rm: "docker.remove", rmi: "docker.remove",
  stop: "docker.remove", kill: "docker.remove", prune: "docker.prune", push: "artifact.publish",
}
const KUBECTL: SubTable = {
  get: "kubernetes.read", describe: "kubernetes.read", logs: "kubernetes.read", explain: "kubernetes.read",
  apply: "kubernetes.apply", create: "kubernetes.apply", patch: "kubernetes.apply", rollout: "kubernetes.apply",
  scale: "kubernetes.apply", delete: "kubernetes.delete", exec: "kubernetes.exec", "port-forward": "kubernetes.exec",
}
const SYSTEMCTL: SubTable = {
  status: "system.read", show: "system.read", list: "system.read", "list-units": "system.read",
  start: "system.service", restart: "system.restart", reload: "system.restart",
  stop: "system.disable", disable: "system.disable", mask: "system.disable", enable: "system.service",
}
/** Package managers: subcommand decides install vs remove vs script. */
const PACKAGE: SubTable = {
  install: "package.install", i: "package.install", ci: "package.install", add: "package.install",
  update: "package.update", upgrade: "package.update", up: "package.update",
  uninstall: "package.remove", remove: "package.remove", rm: "package.remove", prune: "package.remove",
  run: "package.script", exec: "package.script", test: "package.script", start: "package.script",
  shell: "package.script", sync: "package.install", lock: "package.update",
  build: "package.script", publish: "artifact.publish",
}
const CLOUD: SubTable = {
  describe: "cloud.read", list: "cloud.read", get: "cloud.read", ls: "cloud.read",
  deploy: "cloud.deploy", create: "cloud.deploy", update: "cloud.deploy", sync: "cloud.deploy",
  delete: "cloud.delete", destroy: "cloud.delete", rm: "cloud.delete",
  iam: "cloud.iam", "add-user": "cloud.iam",
}

const SUBCOMMAND_FAMILIES: Readonly<Record<string, SubTable>> = {
  git: GIT,
  docker: DOCKER,
  "docker-compose": DOCKER,
  podman: DOCKER,
  kubectl: KUBECTL,
  helm: KUBECTL,
  systemctl: SYSTEMCTL,
  service: SYSTEMCTL,
  npm: PACKAGE,
  pnpm: PACKAGE,
  yarn: PACKAGE,
  bun: PACKAGE,
  pip: PACKAGE,
  pip3: PACKAGE,
  poetry: PACKAGE,
  // Pipenv was absent here until CL-16A. It still reached `ask`, but only
  // because an unclassified program falls to `unknown` capability and the
  // conservative risk floor. Relying on a fallback as if it were a policy hides
  // the real verb — `pipenv install` and `pipenv run` are very different acts —
  // so it is named explicitly. `sync` is an install; `shell`/`run` are scripts.
  pipenv: PACKAGE,
  cargo: PACKAGE,
  composer: PACKAGE,
  gem: PACKAGE,
  go: PACKAGE,
  aws: CLOUD,
  gcloud: CLOUD,
  az: CLOUD,
  terraform: CLOUD,
}

/** Programs whose capability does not depend on a subcommand. */
const DIRECT: Readonly<Record<string, Capability>> = {
  // read
  cat: "filesystem.read", less: "filesystem.read", more: "filesystem.read", head: "filesystem.read",
  tail: "filesystem.read", ls: "filesystem.read", dir: "filesystem.read", find: "filesystem.read",
  grep: "filesystem.read", rg: "filesystem.read", stat: "filesystem.read", file: "filesystem.read",
  wc: "filesystem.read", diff: "filesystem.read", pwd: "filesystem.read", tree: "filesystem.read",
  "get-content": "filesystem.read", "get-childitem": "filesystem.read", "select-string": "filesystem.read",
  type: "filesystem.read",
  // write
  touch: "filesystem.write", tee: "filesystem.write", cp: "filesystem.write", copy: "filesystem.write",
  mv: "filesystem.write", move: "filesystem.write", mkdir: "filesystem.write", md: "filesystem.write",
  ln: "filesystem.write", "set-content": "filesystem.write", "add-content": "filesystem.write",
  "new-item": "filesystem.write", "copy-item": "filesystem.write", "move-item": "filesystem.write",
  sed: "filesystem.write", patch: "filesystem.write", tar: "filesystem.write", unzip: "filesystem.write",
  // delete
  rm: "filesystem.delete", rmdir: "filesystem.delete", del: "filesystem.delete", erase: "filesystem.delete",
  "remove-item": "filesystem.delete", shred: "filesystem.delete",
  // permission
  chmod: "filesystem.permission", chown: "filesystem.permission", chgrp: "filesystem.permission",
  icacls: "filesystem.permission", attrib: "filesystem.permission",
  // process
  kill: "process.kill", killall: "process.kill", pkill: "process.kill", taskkill: "process.kill",
  "stop-process": "process.kill", nohup: "process.start", "start-process": "process.start",
  // network
  curl: "network.request", wget: "network.request", "invoke-webrequest": "network.request",
  "invoke-restmethod": "network.request", nc: "network.listen", netcat: "network.listen",
  ping: "network.request", ssh: "ssh.exec", scp: "ssh.copy", sftp: "ssh.copy", rsync: "ssh.copy",
  // database
  psql: "database.read", mysql: "database.read", sqlite3: "database.read", mongo: "database.read",
  redis: "database.read",
  // system
  reboot: "system.restart", shutdown: "system.restart", halt: "system.restart", poweroff: "system.restart",
  uname: "system.read", whoami: "system.read", ps: "system.read", df: "system.read", du: "system.read",
  env: "system.read", printenv: "system.read", date: "system.read", hostname: "system.read",
  useradd: "system.service", userdel: "system.disable", usermod: "system.service",
  iptables: "system.disable", ufw: "system.disable", mkfs: "filesystem.delete", dd: "filesystem.write",
  // benign output
  echo: "system.read", "write-output": "system.read", printf: "system.read", true: "system.read",
  // interpreters run arbitrary code
  node: "code.execute", python: "code.execute", python3: "code.execute", ruby: "code.execute",
  perl: "code.execute", make: "code.execute", tsc: "code.execute", tsgo: "code.execute",
  jest: "code.execute", vitest: "code.execute", mocha: "code.execute", eslint: "code.execute",
  prettier: "code.execute", npx: "code.execute", bunx: "code.execute", pnpx: "code.execute",
}

export interface CapabilityMatch {
  readonly capability: Capability
  /** `known` = a table entry matched. `unknown` = we could not say. */
  readonly confidence: "known" | "unknown"
}

/** First argument that is not a flag (`-x`, `--long`, or a cmd-style `/x`). */
export function firstArgument(argv: readonly string[]): string | undefined {
  return argv.find((a) => !a.startsWith("-") && !/^\/[A-Za-z?]/.test(a))
}

/**
 * Classify ONE resolved command. Deterministic: program -> optional subcommand
 * -> capability. An unrecognised program is `unknown`, which the risk model
 * escalates rather than excuses.
 */
export function classifyCapability(command: NormalizedCommand): CapabilityMatch {
  const program = command.program.toLowerCase()
  // `python -m pip <verb>` IS a package operation, not generic code execution —
  // classify it by the pip verb so an install is `package.install` (bounded),
  // not `code.execute` (which the conservative floor escalates). A `python -m X`
  // for anything else stays code.execute.
  const base = program.replace(/\.exe$/i, "").replace(/^.*[/\\]/, "")
  if (/^python[0-9.]*$/i.test(base) || base === "py") {
    const mi = command.argv.indexOf("-m")
    if (mi >= 0 && command.argv[mi + 1]?.toLowerCase() === "pip") {
      const verb = command.argv.slice(mi + 2).find((a) => !a.startsWith("-"))?.toLowerCase()
      const hit = verb ? PACKAGE[verb] : undefined
      return hit ? { capability: hit, confidence: "known" } : { capability: "code.execute", confidence: "known" }
    }
  }
  const family = SUBCOMMAND_FAMILIES[program]
  if (family) {
    const words = command.argv.filter((a) => !a.startsWith("-") && !/^\/[A-Za-z?]/.test(a)).map((a) => a.toLowerCase())
    const sub = words[0]
    // `git push --force` is a distinct capability from `git push`.
    if (program === "git" && sub === "push" && command.argv.some((a) => /^--force$/.test(a))) return { capability: "git.force", confidence: "known" }
    // Some CLIs nest the verb: `docker system prune`, `aws s3 ls`. Take the
    // FIRST argument that names a verb we know — deterministic by position.
    for (const w of words) {
      const hit = family[w]
      if (hit) return { capability: hit, confidence: "known" }
    }
    void sub
    // A known family with an unrecognised subcommand is NOT unknown — we know
    // the domain, just not the verb. Fall back to the family's riskiest read-ish
    // member rather than pretending we recognised it.
    return { capability: "unknown", confidence: "unknown" }
  }
  const direct = DIRECT[program]
  if (direct) {
    // A destructive flag turns a mover into a deleter (`rsync --delete`).
    if (program === "rsync" && command.argv.includes("--delete")) return { capability: "filesystem.delete", confidence: "known" }
    return { capability: direct, confidence: "known" }
  }
  return { capability: "unknown", confidence: "unknown" }
}

/** Every capability in an operation, de-duplicated, order-stable. */
export function classifyAll(commands: readonly NormalizedCommand[]): { capabilities: Capability[]; anyUnknown: boolean } {
  const seen = new Set<Capability>()
  let anyUnknown = commands.length === 0
  for (const c of commands) {
    const m = classifyCapability(c)
    seen.add(m.capability)
    if (m.confidence === "unknown") anyUnknown = true
  }
  return { capabilities: [...seen], anyUnknown }
}
