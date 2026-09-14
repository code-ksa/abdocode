/**
 * CL-05 gate. Three claims must hold, and each is proven here rather than
 * asserted in a document:
 *
 *   1. classification is DETERMINISTIC
 *   2. a dangerous command can NEVER score low
 *   3. an unknown command defaults conservatively
 *
 * plus the carry-over from CL-04: resource analysis never shows an empty array
 * that reads as "touches nothing".
 */
import { describe, expect, test } from "bun:test"
import { normalize } from "@abdo/normalizer"
import type { Capability, RiskLevel } from "@abdo/control-contracts"
import { analyzeResources, assessRisk, classifyAll, classifyCapability } from "../src/index"

const op = (command: string) => {
  const parsed = normalize(command, { shell: "bash" })
  return { ...parsed, resources: analyzeResources(parsed) }
}
const caps = (command: string) => classifyAll(op(command).commands ?? []).capabilities
const risk = (command: string, declared: RiskLevel = "low") => {
  const o = op(command)
  const { capabilities, anyUnknown } = classifyAll(o.commands ?? [])
  return assessRisk({ operation: o, capabilities, anyUnknownCapability: anyUnknown, declared, dangerous: false })
}
const ORDER: RiskLevel[] = ["read", "low", "medium", "high", "critical"]
const atLeast = (level: RiskLevel, floor: RiskLevel) => ORDER.indexOf(level) >= ORDER.indexOf(floor)

describe("CL-05.1 capability classification is semantic and deterministic", () => {
  const expectations: [string, Capability][] = [
    ["cat README.md", "filesystem.read"],
    ["rm -rf build", "filesystem.delete"],
    ["cp a.ts b.ts", "filesystem.write"],
    ["chmod -R 777 .", "filesystem.permission"],
    ["npm install", "package.install"],
    ["pnpm update", "package.update"],
    ["npm run build", "package.script"],
    ["npm publish", "artifact.publish"],
    ["git status", "git.read"],
    ["git commit -m x", "git.commit"],
    ["git push origin main", "git.push"],
    ["git push --force origin main", "git.force"],
    ["git reset --hard HEAD~1", "git.reset"],
    ["curl https://example.com", "network.request"],
    ["ssh user@host uptime", "ssh.exec"],
    ["scp a.txt user@host:/tmp", "ssh.copy"],
    ["docker ps", "docker.inspect"],
    ["docker system prune", "docker.prune"],
    ["kubectl get pods", "kubernetes.read"],
    ["kubectl delete pod x", "kubernetes.delete"],
    ["aws s3 ls", "cloud.read"],
    ["systemctl restart nginx", "system.restart"],
    ["kill -9 123", "process.kill"],
    ["node script.js", "code.execute"],
  ]
  for (const [command, capability] of expectations) {
    test(`${command} => ${capability}`, () => {
      expect(caps(command)).toContain(capability)
    })
  }

  test("the SAME command always classifies identically (no ordering or state)", () => {
    for (const c of ["rm -rf build", "git push --force", "npm install", "unknownprog --x"]) {
      const first = caps(c)
      for (let i = 0; i < 5; i++) expect(caps(c)).toEqual(first)
    }
  })

  test("a compound command yields every capability it contains", () => {
    const found = caps("cd api && npm install && rm -rf dist")
    expect(found).toContain("package.install")
    expect(found).toContain("filesystem.delete")
  })

  test("classification is about the COMMAND, not the tool name", () => {
    // The same `shell` tool produces different capabilities per command.
    expect(caps("cat x")).toEqual(["filesystem.read"])
    expect(caps("rm -rf x")).toEqual(["filesystem.delete"])
  })
})

describe("CL-05.2 a dangerous command can NEVER be scored low", () => {
  const destructive = [
    "rm -rf /var/data",
    "git push --force origin main",
    "git reset --hard HEAD~5",
    "docker system prune",
    "kubectl delete deployment api",
    "systemctl stop nginx",
    "chmod -R 777 /",
    "kill -9 1",
    "aws s3 rm s3://bucket --recursive",
    "ssh user@host rm -rf /",
  ]
  for (const command of destructive) {
    test(`${command} is at least high, even declared "read"`, () => {
      const r = risk(command, "read")
      expect(atLeast(r.level, "high")).toBe(true)
    })
  }

  test("a permissive tool policy cannot talk a destructive capability down", () => {
    // The classifier is the authority the policy cannot argue with.
    expect(atLeast(risk("rm -rf build", "read").level, "high")).toBe(true)
    expect(atLeast(risk("rm -rf build", "low").level, "high")).toBe(true)
  })

  test("privilege escalation reaches critical", () => {
    expect(risk("chmod -R 777 /etc").level).toBe("critical")
    expect(risk("systemctl disable firewalld").level).toBe("critical")
  })

  test("the declared policy is a FLOOR, not a ceiling — it can only raise", () => {
    expect(atLeast(risk("cat README.md", "critical").level, "critical")).toBe(true)
  })
})

describe("CL-05.3 unknown and uncertain default conservatively", () => {
  test("an unrecognised program is at least high and labelled conservative", () => {
    const r = risk("frobnicate --all")
    expect(atLeast(r.level, "high")).toBe(true)
    expect(r.certainty).toBe("conservative_default")
    expect(caps("frobnicate --all")).toEqual(["unknown"])
  })

  test("a known family with an unrecognised subcommand is unknown, not guessed", () => {
    expect(caps("git frobnicate")).toEqual(["unknown"])
    expect(atLeast(risk("git frobnicate").level, "high")).toBe(true)
  })

  test("an uncertain PARSE is conservative even when every program is known", () => {
    const r = risk("cat $TARGET")
    expect(r.certainty).toBe("conservative_default")
    expect(atLeast(r.level, "high")).toBe(true)
    expect(r.dimensions!.parserCertainty).toBe("uncertain")
  })

  test("one unknown command in a compound taints the whole operation", () => {
    const r = risk("cat a.txt && frobnicate")
    expect(r.certainty).toBe("conservative_default")
    expect(atLeast(r.level, "high")).toBe(true)
  })

  test("a fully analysed read-only command is NOT escalated (the floor really lifts)", () => {
    const r = risk("cat README.md")
    expect(r.certainty).toBe("classified")
    expect(ORDER.indexOf(r.level)).toBeLessThan(ORDER.indexOf("high"))
  })
})

describe("CL-05.4 resource analysis: absent means undetermined, never 'nothing'", () => {
  test("literal path arguments are resolved into reads and writes", () => {
    expect(op("cat README.md").resources).toMatchObject({ analysis: "complete", reads: ["README.md"] })
    expect(op("rm -rf build dist").resources).toMatchObject({ analysis: "complete", writes: ["build", "dist"] })
  })

  test("network targets are named", () => {
    expect(op("curl https://api.example.com/v1").resources!.networkHints).toEqual(["api.example.com"])
    expect(op("ssh deploy@prod.example.com uptime").resources!.networkHints).toContain("prod.example.com")
  })

  test("a glob or a variable keeps the analysis below complete, and omits the field", () => {
    const globbed = op("rm -rf build/*")
    expect(globbed.resources!.analysis).not.toBe("complete")
    const dynamic = op("cat $FILE")
    expect(dynamic.resources!.analysis).not.toBe("complete")
    expect(dynamic.resources!.reads).toBeUndefined() // absent, NOT []
  })

  test("an unknown program leaves the analysis incomplete rather than empty", () => {
    const r = op("frobnicate a.txt").resources!
    expect(r.analysis).not.toBe("complete")
    expect(r.reads).toBeUndefined()
    expect(r.writes).toBeUndefined()
    expect(r.networkHints).toBeUndefined()
  })

  test("an install reaches hosts it cannot name, so it is never complete", () => {
    expect(op("npm install").resources!.analysis).not.toBe("complete")
  })

  test("EVERY emitted array is non-empty — an empty one would be a false claim", () => {
    for (const c of ["cat a.txt", "rm -rf b", "curl https://x.io", "npm install", "frobnicate"]) {
      const r = op(c).resources!
      for (const field of [r.reads, r.writes, r.networkHints]) {
        if (field !== undefined) expect(field.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("CL-05.5 dimensions are recorded so a level is explainable", () => {
  test("every assessment carries the full dimension set", () => {
    const d = risk("rm -rf build").dimensions!
    expect(d.reversibility).toBe("irreversible")
    expect(d.blastRadius).toBe("workspace")
    expect(d.parserCertainty).toBe("parsed")
    for (const key of Object.keys(d)) expect(d[key as keyof typeof d]).toBeDefined()
  })

  test("worst-wins across a compound command", () => {
    const d = risk("cat a.txt && rm -rf build").dimensions!
    expect(d.reversibility).toBe("irreversible") // the delete dominates the read
  })

  test("capabilities are recorded on the assessment for audit and policy", () => {
    expect(risk("git push origin main").capabilities).toContain("git.push")
  })
})

describe("CL-05.6 the classifier itself is a pure function", () => {
  test("classifying does not mutate the command", () => {
    const command = { program: "rm", argv: ["-rf", "x"], cwd: "", env: {}, redirections: [], background: false }
    const snapshot = JSON.stringify(command)
    classifyCapability(command)
    expect(JSON.stringify(command)).toBe(snapshot)
  })
})
