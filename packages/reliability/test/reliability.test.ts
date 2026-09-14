/**
 * Batch 5 GATES — S49 SQL, S50 atomic writes, S51 git safety, S52 the package
 * broker, S53 universal redaction, S54 the secret broker, S55 process
 * ownership, S56 container ownership, S57 bounded search, S58 the exam.
 *
 * Several of these encode failures this program has actually hit: the camelCase
 * identifier that Postgres folds, placeholders that bind by appearance, a
 * reaper that could not see pre-label containers, and — measured on this
 * machine an hour before these lines were written — a dev server orphaned for
 * sixteen hours and an emulator orphaned for a day.
 */
import { describe, expect, test } from "bun:test"
import {
  checkResultShape,
  checkSqlPolicy,
  findAbandonedWrites,
  quoteIdent,
  quoteQualified,
  sql,
  writeAtomic,
  type AtomicFs,
} from "../src/data"
import { checkGitSafety, checkInstall, detectManager, DESTRUCTIVE_GIT } from "../src/supply"
import { loggableEnv, parseSecretRef, redact, redactAll, resolveForExecution } from "../src/secrets"
import {
  descendants,
  looksHung,
  OWNER_LABEL,
  planReap,
  planTreeKill,
  searchFiles,
  type ContainerInfo,
  type ProcessNode,
} from "../src/runtime"

describe("S49 GATE — no query is built by concatenation, and no identifier is unquoted", () => {
  test("camelCase survives, because Postgres folds an unquoted identifier", () => {
    expect(quoteIdent("projectId")).toBe('"projectId"')
    expect(quoteQualified("public.projectId")).toBe('"public"."projectId"')
    // `order` is why quoting is unconditional rather than "only if it has capitals"
    expect(quoteIdent("order")).toBe('"order"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })

  test("values never reach the text", () => {
    const query = sql()
      .raw("select * from ")
      .ident("public.projects")
      .raw(" where ")
      .ident("projectId")
      .raw(" = ")
      .param("p_1; drop table users")
      .build()
    expect(query.text).toBe('select * from "public"."projects" where "projectId" = $1')
    expect(query.text).not.toContain("drop table")
    expect(query.values).toEqual(["p_1; drop table users"])
  })

  test("a repeated value reuses its placeholder instead of shifting the later ones", () => {
    // hand-written SQL that reuses $1 shifts every later parameter and still
    // runs, with the wrong values in the wrong columns
    const query = sql()
      .raw("select ")
      .param("same")
      .raw(", ")
      .param("other")
      .raw(", ")
      .param("same")
      .build()
    expect(query.text).toBe("select $1, $2, $1")
    expect(query.values).toEqual(["same", "other"])
  })

  test("an IN list is parameterised element by element", () => {
    const query = sql().raw("select 1 where id in ").list([1, 2, 3]).build()
    expect(query.text).toBe("select 1 where id in ($1, $2, $3)")
    expect(query.values).toEqual([1, 2, 3])
  })

  test("read-only refuses a mutation, and refuses a second statement hiding behind a semicolon", () => {
    expect(checkSqlPolicy({ text: "select 1", values: [] }, "read_only").allowed).toBe(true)
    expect(checkSqlPolicy({ text: "delete from users", values: [] }, "read_only").allowed).toBe(false)
    const sneaky = checkSqlPolicy({ text: "select 1; drop table users", values: [] }, "read_only")
    expect(sneaky.allowed).toBe(false)
    expect(sneaky.why).toContain("only the first word")
    // and it is refused on a read-write connection too
    expect(checkSqlPolicy({ text: "select 1; drop table users", values: [] }, "read_write").allowed).toBe(false)
  })

  test("a schema that moved under the query is caught by the result shape", () => {
    const verdict = checkResultShape({ columns: ["id", "name"], rowCount: 3 }, ["id", "projectId"])
    expect(verdict.ok).toBe(false)
    expect(verdict.why).toContain("the schema moved under a query nobody updated")
  })
})

describe("S50 GATE — a kill mid-write never leaves a half file", () => {
  function fakeFs(failAt?: "write" | "fsync" | "rename") {
    const files = new Map<string, string>()
    const fs: AtomicFs = {
      async writeFile(path, data) {
        if (failAt === "write") {
          files.set(path, data.slice(0, Math.floor(data.length / 2)))
          throw new Error("killed mid-write")
        }
        files.set(path, data)
      },
      async fsync() {
        if (failAt === "fsync") throw new Error("killed during fsync")
      },
      async rename(from, to) {
        if (failAt === "rename") throw new Error("killed during rename")
        const data = files.get(from)
        if (data === undefined) throw new Error(`no such file ${from}`)
        files.set(to, data)
        files.delete(from)
      },
      async remove(path) {
        files.delete(path)
      },
      async exists(path) {
        return files.has(path)
      },
    }
    return { fs, files }
  }

  test("a clean write lands whole, through a temp file and a rename", async () => {
    const { fs, files } = fakeFs()
    const result = await writeAtomic(fs, "a.ts", "complete content")
    expect(files.get("a.ts")).toBe("complete content")
    expect(files.has("a.ts.tmp")).toBe(false)
    expect(result.fsynced).toBe(true)
  })

  test("a kill mid-write leaves the ORIGINAL untouched and no partial file behind", async () => {
    const { fs, files } = fakeFs("write")
    files.set("a.ts", "the original")
    await expect(writeAtomic(fs, "a.ts", "the new content, killed halfway")).rejects.toThrow("killed mid-write")
    // the original survives, and the half-written temp is gone
    expect(files.get("a.ts")).toBe("the original")
    expect(files.has("a.ts.tmp")).toBe(false)
  })

  test("a kill during rename also leaves the original — the rename is the atomic step", async () => {
    const { fs, files } = fakeFs("rename")
    files.set("a.ts", "the original")
    await expect(writeAtomic(fs, "a.ts", "new")).rejects.toThrow("killed during rename")
    expect(files.get("a.ts")).toBe("the original")
  })

  test("a port that cannot fsync says so instead of claiming durability", async () => {
    const { fs } = fakeFs()
    const noSync: AtomicFs = { ...fs, fsync: undefined }
    const result = await writeAtomic(noSync, "a.ts", "x")
    expect(result.fsynced).toBe(false)
  })

  test("temp files from a dead process are REPORTED, not deleted — they are evidence", async () => {
    const { fs, files } = fakeFs()
    files.set("a.ts.tmp", "half")
    expect(await findAbandonedWrites(fs, ["a.ts", "b.ts"])).toEqual(["a.ts.tmp"])
  })
})

describe("S51 GATE — every destructive git operation has a RESTORED backup behind it", () => {
  const backup = { ref: "refs/abdo/backup/1", kind: "ref" as const, commit: "abc", tree: "tree_1", createdAt: 1 }

  test("no backup, no destruction", () => {
    const verdict = checkGitSafety("reset_hard", undefined, undefined)
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("no backup was taken")
  })

  test("a backup nobody restored from is a BELIEF, and does not count", () => {
    const verdict = checkGitSafety("reset_hard", backup, undefined)
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("where every backup system fails")
  })

  test("a restore that produced a different tree is worse than no backup", () => {
    const verdict = checkGitSafety("push_force", backup, { ref: backup.ref, restoredTree: "tree_OTHER", at: 2 })
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("somebody would have trusted it")
  })

  test("a verified restore allows it", () => {
    const verdict = checkGitSafety("clean", backup, { ref: backup.ref, restoredTree: "tree_1", at: 2 })
    expect(verdict.allowed).toBe(true)
  })

  test("a non-destructive operation needs nothing — and this asserts the RIGHT path", () => {
    // the first version of this test used `stash_drop`, which IS destructive,
    // so it passed through the verified-restore branch while claiming to test
    // the other one. A test that asserts a path it never took is the coverage
    // this program keeps refusing to accept.
    const verdict = checkGitSafety("commit", undefined, undefined)
    expect(verdict.allowed).toBe(true)
    expect(verdict.requiresBackup).toBe(false)
    expect(verdict.why).toContain("destroys nothing")

    // and the destructive list is exhaustive about the ones that do
    expect(DESTRUCTIVE_GIT).toContain("filter_branch")
    expect(DESTRUCTIVE_GIT).not.toContain("commit")
    expect(checkGitSafety("stash_drop", undefined, undefined).allowed).toBe(false)
  })
})

describe("S52 GATE — a bun project is not installed with npm", () => {
  test("the lockfile decides, and the refusal explains the real damage", () => {
    const detection = detectManager(["package.json", "bun.lock"])
    expect(detection.kind).toBe("detected")
    const verdict = checkInstall(detection, { manager: "npm", packages: ["zod"], lifecycleScripts: "deny" })
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("would not fail")
    expect(verdict.suggested).toBe("bun install zod")
  })

  test("two lockfiles is AMBIGUOUS, not a coin flip", () => {
    const detection = detectManager(["bun.lock", "package-lock.json"])
    expect(detection.kind).toBe("ambiguous")
    expect(checkInstall(detection, { manager: "bun", lifecycleScripts: "deny" }).allowed).toBe(false)
  })

  test("lifecycle scripts have NO default — somebody has to choose", () => {
    const detection = detectManager(["bun.lock"])
    expect(checkInstall(detection, { manager: "bun" }).allowed).toBe(false)
    expect(checkInstall(detection, { manager: "bun" }).why).toContain("both defaults are wrong")
    expect(checkInstall(detection, { manager: "bun", lifecycleScripts: "deny" }).allowed).toBe(true)
  })

  test("no lockfile is a fact, not a failure", () => {
    const detection = detectManager(["package.json"])
    expect(detection.kind).toBe("none")
    const verdict = checkInstall(detection, { manager: "bun", lifecycleScripts: "allow" })
    expect(verdict.allowed).toBe(true)
    expect(verdict.why).toContain("this will create one")
  })
})

describe("S53 GATE — an injected secret appears in NO output path", () => {
  const secret = "hunter2-super-secret-value"
  const surface = {
    stdout: `connecting to postgres://app:${secret}@db:5432/prod`,
    stderr: `Error: auth failed for token ghp_abcdefghijklmnopqrstuvwxyz012345`,
    toolResult: `DATABASE_PASSWORD=${secret}`,
    errorMessage: `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl`,
    logLine: `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`,
    checkpoint: `{"env":{"API_KEY":"sk-abcdefghijklmnopqrstuvwx"}}`,
  }

  test("every path is cleaned, and the accounting says how much", () => {
    const result = redactAll(surface, [secret])
    for (const [name, text] of Object.entries(result.paths)) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345")
      expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE")
      expect(name.length).toBeGreaterThan(0)
    }
    expect(result.total).toBeGreaterThanOrEqual(6)
    // a censored output must not read like a clean one
    expect(Object.values(result.byPath).every((n) => n > 0)).toBe(true)
  })

  test("the SHAPE survives where it is informative", () => {
    const result = redact("postgres://app:pw123456@db:5432/prod")
    expect(result.text).toContain("postgres://app:[redacted]@")
    expect(result.redactions.map((r) => r.kind)).toContain("url_credentials")
  })

  test("kinds are reported and values never are, not even hashed", () => {
    const result = redact(`API_TOKEN=abcdef123456`)
    expect(JSON.stringify(result.redactions)).not.toContain("abcdef")
    expect(result.redactions[0]!.count).toBe(1)
  })

  test("a clean output reports zero rather than nothing", () => {
    const result = redact("all fine here")
    expect(result.total).toBe(0)
    expect(result.text).toBe("all fine here")
  })
})

describe("S54 GATE — the value is never in the log, the prompt or the process", () => {
  const source = {
    revoked: new Set<string>(),
    async resolve(ref: { raw: string; key: string }) {
      return this.revoked.has(ref.raw) ? undefined : `real-value-of-${ref.key}`
    },
  }

  test("a reference travels; the value appears only in the child environment", async () => {
    const bindings = { DATABASE_URL: "env://DATABASE_URL", NODE_ENV: "production" }
    const loggable = loggableEnv(bindings)
    expect(loggable.DATABASE_URL).toBe("env://DATABASE_URL")
    expect(JSON.stringify(loggable)).not.toContain("real-value-of")

    const resolution = await resolveForExecution(source, bindings)
    expect(resolution.kind).toBe("resolved")
    if (resolution.kind === "resolved") {
      expect(resolution.env.DATABASE_URL).toBe("real-value-of-DATABASE_URL")
      expect(resolution.env.NODE_ENV).toBe("production")
      // the RESOLUTION records the reference, never the value
      expect(JSON.stringify(resolution.refs)).not.toContain("real-value-of")
    }
  })

  test("revoking a reference stops the next execution immediately", async () => {
    source.revoked.add("vault://prod/db")
    const resolution = await resolveForExecution(source, { PASSWORD: "vault://prod/db" })
    expect(resolution.kind).toBe("unavailable")
    if (resolution.kind === "unavailable") expect(resolution.why).toContain("may have been revoked")
  })

  test("an empty value is refused — a service reading an empty password falls back to something worse", async () => {
    const empty = { async resolve() { return "" } }
    const resolution = await resolveForExecution(empty, { PASSWORD: "env://NOTHING" })
    expect(resolution.kind).toBe("unavailable")
  })

  test("both schemes parse, and a plain value is not mistaken for a reference", () => {
    expect(parseSecretRef("env://A")!.scheme).toBe("env")
    expect(parseSecretRef("vault://prod/db")!.key).toBe("prod/db")
    expect(parseSecretRef("just-a-password")).toBeUndefined()
  })
})

describe("S55 GATE — a cancel leaves no process alive", () => {
  const table: ProcessNode[] = [
    { pid: 1, ppid: 0, name: "init" },
    { pid: 100, ppid: 1, name: "agent" },
    { pid: 200, ppid: 100, name: "cmd" },
    { pid: 300, ppid: 200, name: "npm" },
    { pid: 400, ppid: 300, name: "node" },
    { pid: 500, ppid: 400, name: "worker" },
    { pid: 501, ppid: 400, name: "worker" },
    { pid: 900, ppid: 1, name: "unrelated" },
  ]

  test("the grandchildren are found — killing npm alone would leave four", () => {
    expect(descendants(table, 200).map((p) => p.pid).sort()).toEqual([300, 400, 500, 501])
    expect(descendants(table, 200).map((p) => p.pid)).not.toContain(900)
  })

  test("the kill order is deepest first, because a parent can respawn its children", () => {
    const plan = planTreeKill(table, 200)
    expect(plan.order[0]).toBeGreaterThanOrEqual(500)
    expect(plan.order[plan.order.length - 1]).toBe(200)
    expect(plan.order).toHaveLength(5)
  })

  test("the killer refuses to kill itself or its ancestors", () => {
    const plan = planTreeKill(table, 200, [400, 100])
    expect(plan.order).not.toContain(400)
    expect(planTreeKill(table, 100, [100]).order).toEqual([])
    expect(planTreeKill(table, 100, [100]).why).toContain("refusing to kill the process doing the killing")
  })

  test("hung and working are distinguished by CPU, not by age", () => {
    const now = 1_000_000
    const hung: ProcessNode = { pid: 1, ppid: 0, name: "x", cpuMs: 200, startedAt: now - 10_800_000 }
    const working: ProcessNode = { pid: 2, ppid: 0, name: "y", cpuMs: 600_000, startedAt: now - 10_800_000 }
    expect(looksHung(hung, now)).toBe(true)
    expect(looksHung(working, now)).toBe(false)
    // no measurement means no verdict, rather than a guess
    expect(looksHung({ pid: 3, ppid: 0, name: "z" }, now)).toBeUndefined()
  })
})

describe("S56 GATE — the agent reaps what it labelled and nothing else", () => {
  const containers: ContainerInfo[] = [
    { id: "c_dead", name: "abdo-1", labels: { [OWNER_LABEL]: "run_dead" }, running: true },
    { id: "c_live", name: "abdo-2", labels: { [OWNER_LABEL]: "run_live" }, running: true },
    { id: "c_human", name: "abdo-postgres", labels: {}, running: true },
  ]

  test("a container owned by a dead run is reaped", () => {
    expect(planReap(containers, ["run_live"]).reap).toEqual(["c_dead"])
  })

  test("a live run's container is kept", () => {
    expect(planReap(containers, ["run_live"]).keep.map((k) => k.id)).toContain("c_live")
  })

  test("an unlabelled container is REPORTED and never touched, whatever its name looks like", () => {
    const plan = planReap(containers, ["run_live"])
    expect(plan.unlabelled).toEqual(["c_human"])
    expect(plan.reap).not.toContain("c_human")
    expect(plan.keep.find((k) => k.id === "c_human")!.why).toContain("something a human made")
  })
})

describe("S57 GATE — search returns in a stated time with repeatable results", () => {
  const files = Array.from({ length: 200 }, (_, i) => ({
    path: `src/${String(i).padStart(3, "0")}.ts`,
    bytes: 500,
    read: () => `line one\nconst needle = ${i}\nline three\n`,
  }))

  test("results are ordered by path and line, not by the walk", () => {
    const shuffled = [...files].reverse()
    const a = searchFiles(files, /needle/)
    const b = searchFiles(shuffled, /needle/)
    expect(a.hits).toEqual(b.hits)
    expect(a.hits[0]!.path).toBe("src/000.ts")
    expect(a.hits.every((h) => h.line === 2)).toBe(true)
  })

  test("the hit limit truncates and SAYS SO — a truncated result that looks complete is the real danger", () => {
    const outcome = searchFiles(files, /needle/, { maxHits: 10, maxMs: 10_000, maxFileBytes: 1_000_000 })
    expect(outcome.hits).toHaveLength(10)
    expect(outcome.truncated).toBe(true)
    expect(outcome.reason).toBe("hit_limit")
  })

  test("the time limit is enforced against a clock the test controls", () => {
    let t = 0
    const outcome = searchFiles(files, /needle/, { maxHits: 1000, maxMs: 5, maxFileBytes: 1_000_000 }, () => (t += 3))
    expect(outcome.truncated).toBe(true)
    expect(outcome.reason).toBe("time_limit")
  })

  test("a file too large to scan is skipped WITH A REASON, not silently", () => {
    const withBig = [...files, { path: "src/huge.ts", bytes: 50_000_000, read: () => "needle" }]
    const outcome = searchFiles(withBig, /needle/)
    expect(outcome.filesSkipped.map((s) => s.path)).toEqual(["src/huge.ts"])
    expect(outcome.filesSkipped[0]!.why).toContain("exceeds")
  })
})

describe("S58 GATE — the tool reliability exam", () => {
  test("no quoting or encoding failure survives any of the four surfaces", () => {
    const hostile = `p'"; drop table "users" --\n\t$HOME \`whoami\` %PATH% 🙂 عربي`

    // SQL: the value is a parameter and the identifier is quoted
    const query = sql().raw("update ").ident("projectId").raw(" set x = ").param(hostile).build()
    expect(query.text).toBe('update "projectId" set x = $1')
    expect(query.values[0]).toBe(hostile)

    // redaction leaves non-secret hostile text alone
    expect(redact(hostile).text).toBe(hostile)

    // a secret reference is not confused by hostile text around it
    expect(parseSecretRef(hostile)).toBeUndefined()

    // search finds it and truncates the line rather than the file
    const outcome = searchFiles([{ path: "a.ts", bytes: 100, read: () => hostile }], /drop table/)
    expect(outcome.hits).toHaveLength(1)
    expect(outcome.truncated).toBe(false)
  })

  test("every bounded operation states its bound, so none of them ends without one", () => {
    const outcome = searchFiles([], /x/)
    expect(outcome.ms).toBeGreaterThanOrEqual(0)
    expect(outcome.truncated).toBe(false)

    // the three ownership planners all return a `why`, so no refusal is silent
    expect(planTreeKill([], 1).why.length).toBeGreaterThan(10)
    expect(planReap([], []).why.length).toBeGreaterThan(10)
    expect(checkGitSafety("reset_hard", undefined, undefined).why.length).toBeGreaterThan(10)
    expect(checkInstall(detectManager([]), { manager: "bun" }).why.length).toBeGreaterThan(10)
  })
})
