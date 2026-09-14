/**
 * The language-server registry (Sprint 38) — which server, and what to say when
 * there isn't one.
 *
 * The interesting decision is not the table of servers. It is what happens for
 * a language nobody installed a server for, and the answer almost everything
 * gets wrong is "fall back to text search". That fallback is what makes code
 * intelligence untrustworthy: the caller cannot tell a real reference list from
 * a grep, so it has to treat every list as a grep, so the language server buys
 * nothing.
 *
 * Here a language with no server is `unsupported` and says so. The caller may
 * then choose a text search deliberately, with its own name on the decision.
 */

export type ServerId =
  | "typescript-language-server"
  | "pyright"
  | "rust-analyzer"
  | "gopls"
  | "intelephense"

export interface ServerSpec {
  readonly id: ServerId
  readonly languageId: string
  readonly extensions: readonly string[]
  /** Files whose presence identifies the project root for this server. */
  readonly rootMarkers: readonly string[]
  /** argv the host would spawn. This package never spawns it. */
  readonly command: readonly string[]
}

export const SERVERS: readonly ServerSpec[] = [
  {
    id: "typescript-language-server",
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    command: ["typescript-language-server", "--stdio"],
  },
  {
    id: "pyright",
    languageId: "python",
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    command: ["pyright-langserver", "--stdio"],
  },
  {
    id: "rust-analyzer",
    languageId: "rust",
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    command: ["rust-analyzer"],
  },
  {
    id: "gopls",
    languageId: "go",
    extensions: [".go"],
    rootMarkers: ["go.mod", "go.work"],
    command: ["gopls", "serve"],
  },
  {
    id: "intelephense",
    languageId: "php",
    extensions: [".php"],
    rootMarkers: ["composer.json"],
    command: ["intelephense", "--stdio"],
  },
]

export type Selection =
  | { readonly kind: "server"; readonly spec: ServerSpec; readonly root: string }
  | { readonly kind: "unsupported"; readonly extension: string; readonly why: string }

const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

const dirOf = (path: string): string => {
  const normalised = path.replace(/\\/g, "/")
  const cut = normalised.lastIndexOf("/")
  return cut <= 0 ? "/" : normalised.slice(0, cut)
}

/**
 * Choose a server for a file, and find the root it should be started at.
 *
 * The root matters more than it looks: starting one TypeScript server at the
 * monorepo root and asking it about a file in a package with its own tsconfig
 * gives answers derived from the wrong compiler options. So the root is the
 * NEAREST directory carrying a marker, walking up from the file, and the
 * workspace root is only the fallback.
 */
export function selectServer(
  filePath: string,
  workspaceRoot: string,
  exists: (path: string) => boolean,
  servers: readonly ServerSpec[] = SERVERS,
): Selection {
  const extension = extensionOf(filePath)
  const spec = servers.find((s) => s.extensions.includes(extension))
  if (spec === undefined) {
    return {
      kind: "unsupported",
      extension,
      why:
        extension === ""
          ? "the file has no extension, so no language server can be chosen for it"
          : `no language server is registered for ${extension} — a text search may still be used, but it must be chosen deliberately and never presented as a reference list`,
    }
  }

  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  let dir = dirOf(filePath)
  let best: string | undefined
  while (dir.length >= root.length && dir.startsWith(root)) {
    if (spec.rootMarkers.some((marker) => exists(`${dir}/${marker}`))) {
      best = dir
      break
    }
    const parent = dirOf(dir)
    if (parent === dir) break
    dir = parent
  }

  return { kind: "server", spec, root: best ?? root }
}

/**
 * Group a set of files by the server instance that should answer for them.
 *
 * One instance per (server, root) pair: a repository with three languages runs
 * three servers, and a monorepo with two tsconfigs runs two TypeScript servers.
 * Files nobody can serve come back separately rather than being dropped, so a
 * caller cannot quietly receive an answer covering fewer files than it asked
 * about.
 */
export function planServers(
  files: readonly string[],
  workspaceRoot: string,
  exists: (path: string) => boolean,
  servers: readonly ServerSpec[] = SERVERS,
): {
  instances: { id: ServerId; root: string; files: string[] }[]
  unsupported: { file: string; why: string }[]
} {
  const instances = new Map<string, { id: ServerId; root: string; files: string[] }>()
  const unsupported: { file: string; why: string }[] = []

  for (const file of files) {
    const selection = selectServer(file, workspaceRoot, exists, servers)
    if (selection.kind === "unsupported") {
      unsupported.push({ file, why: selection.why })
      continue
    }
    const key = `${selection.spec.id}@${selection.root}`
    const instance = instances.get(key) ?? { id: selection.spec.id, root: selection.root, files: [] }
    instance.files.push(file)
    instances.set(key, instance)
  }

  return {
    instances: [...instances.values()].sort((a, b) => `${a.id}${a.root}`.localeCompare(`${b.id}${b.root}`)),
    unsupported,
  }
}
