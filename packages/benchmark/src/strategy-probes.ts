/**
 * Strategy-guard probe tasks — deliberately NOT part of `FULL_SUITE`.
 *
 * The frozen 100-task suite and its baseline must not move, or the V1↔V2
 * comparison stops being a comparison. These two tasks are separate, and they
 * were written AFTER the guard shipped, from the failure shapes rather than
 * from the implementation — they are probes, not the fixtures the guard was
 * designed against:
 *
 *   install-thrash-unseen         — a Bun project that invites an NPM/Jest detour
 *   monorepo-two-package-installs — two sibling packages that must BOTH install
 *
 * Task success is judged the usual way (objective verification). The guard is
 * judged separately from the event log: `maxStrategyExecutionsPerState <= 1`
 * and legitimate sibling installs never blocked.
 *
 * Run them with: ABDO_TASK_IDS=install-thrash-unseen,monorepo-two-package-installs
 */
import type { BenchTask } from "./tasks"

const BUN_MANIFEST = JSON.stringify(
  {
    name: "probe-bun-app",
    version: "1.0.0",
    packageManager: "bun@1.1.0",
    scripts: { test: "bun test" },
  },
  null,
  2,
)

/**
 * A Bun project with a failing test. The natural wrong move is to install a
 * different test toolchain (jest) and reinstall after every config edit; the
 * right move is `bun test` against the project's own scripts. Objective
 * verification is the project's OWN suite passing, so the guard cannot make a
 * genuinely-needed step look like success.
 */
const installThrashUnseen: BenchTask = {
  id: "install-thrash-unseen",
  category: "tests_diagnose",
  fixture: {
    "package.json": BUN_MANIFEST + "\n",
    "bun.lock": '{"lockfileVersion":1,"packages":{}}\n',
    "src/slugify.ts": "export const slugify = (s: string) => s.trim().toLowerCase().replace(/ /g, '_')\n",
    "src/slugify.test.ts":
      "import { expect, test } from 'bun:test'\n" +
      "import { slugify } from './slugify'\n" +
      "test('slugify', () => expect(slugify('  Hello World  ')).toBe('hello-world'))\n",
  },
  messages: ["The test suite is failing. Fix the SOURCE (not the test) so the project's own test suite passes."],
  timeoutMs: 240_000,
  verification: { test: "bun test", forbidPaths: ["src/slugify.test.ts"] },
}

const rootManifest = JSON.stringify({ name: "probe-monorepo", private: true, workspaces: ["packages/*"] }, null, 2)
const childManifest = (name: string, deps: Record<string, string>) => JSON.stringify({ name, version: "1.0.0", dependencies: deps }, null, 2)

/**
 * Two sibling packages that each need a dependency added and installed. A guard
 * keyed on the workspace root would block the SECOND package's install; a
 * correctly scoped one allows both. Verification is on the manifests, so the
 * task does not depend on a registry being reachable.
 */
const monorepoTwoPackageInstalls: BenchTask = {
  id: "monorepo-two-package-installs",
  category: "multi_file_edit",
  fixture: {
    "package.json": rootManifest + "\n",
    "package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
    "packages/api/package.json": childManifest("api", { fastify: "^4.26.0" }) + "\n",
    "packages/web/package.json": childManifest("web", { react: "^18.2.0" }) + "\n",
  },
  messages: [
    "Add the dependency \"zod\": \"^3.22.0\" to BOTH packages/api/package.json and packages/web/package.json, " +
      "then install dependencies for each package from its own directory.",
  ],
  timeoutMs: 240_000,
  verification: {
    expectPaths: ["packages/api/package.json", "packages/web/package.json"],
    requireContains: [
      { path: "packages/api/package.json", text: "zod" },
      { path: "packages/web/package.json", text: "zod" },
    ],
  },
}

export const STRATEGY_PROBE_TASKS: readonly BenchTask[] = [installThrashUnseen, monorepoTwoPackageInstalls]
