import { readdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import {
  KERNEL_PACKAGE_DIR,
  cargoWorkspaceCommand,
  withIsolatedCargo,
  type PreparedCargoContext,
} from "./contracts"

const REPOSITORY_DIR = resolve(KERNEL_PACKAGE_DIR, "..", "..")
/**
 * Directories a build tool owns the contents of.
 *
 * One list, used at both levels, because they were two and they drifted: the
 * repository walk ignored `.turbo` and the package walk did not, so the first
 * `turbo typecheck` to write a log inside this package failed the source
 * allowlist — and failed it saying "package source allowlist drifted", which
 * sends whoever reads it to look for a source change that never happened.
 *
 * Nothing is loosened by listing them here. These are the directories whose
 * contents no commit contains; a file that matters cannot hide in one, because
 * a file that matters is tracked.
 */
const BUILD_OUTPUT_DIRECTORIES = [".cache", ".next", ".turbo", "coverage", "dist", "node_modules", "target"] as const
const IGNORED_PACKAGE_DIRECTORIES = new Set<string>(BUILD_OUTPUT_DIRECTORIES)
const IGNORED_REPOSITORY_DIRECTORIES = new Set<string>([".git", ...BUILD_OUTPUT_DIRECTORIES])
const REPOSITORY_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cmd",
  ".js",
  ".jsx",
  ".mjs",
  ".ps1",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
])
const STATIC_MODULE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"])
const REPOSITORY_CONFIG_FILES = new Set(["Cargo.toml", "package.json", "tsconfig.json"])
const TYPESCRIPT_CONFIG_FILE = /(?:^|\/)tsconfig(?:\.[^/]+)*\.json$/i
const JAVASCRIPT_MODULE_SCANNER = new Bun.Transpiler({ loader: "js" })
const JSX_MODULE_SCANNER = new Bun.Transpiler({ loader: "jsx" })
const TYPESCRIPT_MODULE_SCANNER = new Bun.Transpiler({ loader: "ts" })
const TSX_MODULE_SCANNER = new Bun.Transpiler({ loader: "tsx" })
const KERNEL_TEST_EXECUTABLE_SHA256 = "5806ddd722972d219e61ed52e435532393f55593d5f107ae1107567dbb4a950d"
const S105_JOURNAL_TEST_EXECUTABLE_SHA256 = "1f25cbcd2b571fddceb3c75202459842793727647c11d9ddf4037bab99778c6d"
const BOUNDED_GATE_EXECUTABLE_SHA256 = "dfe3b7f431edf5b676f7f036a4b0802715b796a405e2dee6b83beecad77fc402"
const S106_REDUCER_TEST_EXECUTABLE_SHA256 = "6a91144c56dbb2135efcda847851569f6423da926d911678514c6fd4ca6db3d2"
const S107_SUPERVISOR_TEST_EXECUTABLE_SHA256 = "97e64fbb59b90ecf79e2abe39404304a711f986834a03af40e06d967258977e5"
const S108_RECONCILE_TEST_EXECUTABLE_SHA256 = "1408a35e6fbff7a68a71477c6a8c988ed405ed75b53954621290428bf30bfd5b"
const S109_SESSION_TEST_EXECUTABLE_SHA256 = "bafc7d891a1ea385872935acd83ec873762305f575e79c05b0f7e0e962f87ef5"
const S110_CONTROL_TEST_EXECUTABLE_SHA256 = "8106cde43eb1b011c8535cdafa1cd9e6c552789899300ecd1236d619949c4717"
const S111_SCHEDULE_TEST_EXECUTABLE_SHA256 = "2fc6488dabf1784cca124986ef447983b0bf6770c86249f5d5858f3d4dd0f89d"
const S112_BUDGET_TEST_EXECUTABLE_SHA256 = "0bc5734942236325884449daf019d6e187f8383d3aa2ff0de66975e4523baf95"
const S119_SURFACE_TEST_EXECUTABLE_SHA256 = "d9a7593005c89fbbe04a735f2e18ca20ee08bd577feac10137b8c2025d78723a"
const S118_SECRET_TEST_EXECUTABLE_SHA256 = "ce19d5c132caf1429b5df443202ede2cf45523639710f0deb9583ddbe94731d2"
const S117_WORKER_TEST_EXECUTABLE_SHA256 = "3a1f02c5f6f0ecc4672338266663d3550994e7d0e95f7efdd8f318dcf1c334db"
const S116_DISCLOSURE_TEST_EXECUTABLE_SHA256 = "d48c8660345deade56eccc3977abe7145bc8df11c34f9bf5bf0f88972dd5177e"
const S115_BROKER_TEST_EXECUTABLE_SHA256 = "5e1dd64f976e4355f4fc52d9dd5444b4d082afdda17a1f31530676ddbaee2a04"
const S114_POLICY_TEST_EXECUTABLE_SHA256 = "1d3cb3428d1d2656f918e6b9b98f5e376d128c82d9bb40270a084f819d723748"
const S113_AUTHORITY_TEST_EXECUTABLE_SHA256 = "7eeeb12a3c1570e1d0720d89d906eb067e9b6af4ae540262f34420fec39a3bfa"
const S142_BRIDGE_TEST_EXECUTABLE_SHA256 = "6b7bd37eb994bb76c89a2ea80096d599060f713faa8f6e4cfb6d340385991290"
const CONTRACT_RUST_FILES = [
  "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
  "crates/abdo-contracts/src/codegen.rs",
  "crates/abdo-contracts/src/generator.rs",
  "crates/abdo-contracts/src/lib.rs",
  "crates/abdo-contracts/src/schema.rs",
  "crates/abdo-contracts/src/schema_macros.rs",
  "crates/abdo-contracts/src/wire.rs",
  "crates/abdo-contracts/tests/codegen.rs",
  "crates/abdo-contracts/tests/golden.rs",
  "crates/abdo-contracts/tests/id_10m.rs",
  "crates/abdo-contracts/tests/strict_mutations.rs",
] as const
const CONTRACT_SOURCE_FILES = [
  "crates/abdo-contracts/Cargo.toml",
  ...CONTRACT_RUST_FILES,
  "crates/abdo-contracts/test/fixtures/cancel-command-v1.bin",
  "crates/abdo-contracts/test/fixtures/cancel-command-v1.json",
  "scripts/contracts.ts",
  "src/contracts.ts",
  "src/generated/contracts.ts",
  "test/contracts.test.ts",
] as const
const JOURNAL_RUST_FILES = [
  "crates/abdo-journal/src/bin/abdo-journal-test-child.rs",
  "crates/abdo-journal/src/effects.rs",
  "crates/abdo-journal/src/error.rs",
  "crates/abdo-journal/src/govern.rs",
  "crates/abdo-journal/src/hash.rs",
  "crates/abdo-journal/src/identity.rs",
  "crates/abdo-journal/src/journal.rs",
  "crates/abdo-journal/src/lib.rs",
  "crates/abdo-journal/src/migration.rs",
  "crates/abdo-journal/src/model.rs",
  "crates/abdo-journal/src/test_support.rs",
  "crates/abdo-journal/tests/compaction.rs",
  "crates/abdo-journal/tests/journal.rs",
  "crates/abdo-journal/tests/migration_atomicity.rs",
  "crates/abdo-journal/tests/recovery_10k.rs",
  "crates/abdo-journal/tests/recovery_integrity.rs",
  "crates/abdo-journal/tests/restore_100k.rs",
  "crates/abdo-journal/tests/support/mod.rs",
] as const
const JOURNAL_SOURCE_FILES = [
  "crates/abdo-journal/Cargo.toml",
  "migrations/0001_initial.sql",
  "migrations/0002_effects.sql",
  "migrations/0003_leases_budgets.sql",
  "migrations/0004_compactions.sql",
  ...JOURNAL_RUST_FILES,
] as const
const AUTHORITY_RUST_FILES = [
  "crates/abdo-authority/src/authority.rs",
  "crates/abdo-authority/src/capability.rs",
  "crates/abdo-authority/src/error.rs",
  "crates/abdo-authority/src/identity.rs",
  "crates/abdo-authority/src/lib.rs",
  "crates/abdo-authority/tests/authority.rs",
  "crates/abdo-authority/tests/authority_sweep.rs",
] as const
const AUTHORITY_SOURCE_FILES = ["crates/abdo-authority/Cargo.toml", ...AUTHORITY_RUST_FILES] as const
const KERNEL_CORE_RUST_FILES = [
  "crates/abdo-kernel/src/effect.rs",
  "crates/abdo-kernel/src/fingerprint.rs",
  "crates/abdo-kernel/src/lib.rs",
  "crates/abdo-kernel/src/reduce.rs",
  "crates/abdo-kernel/src/state.rs",
  "crates/abdo-kernel/tests/determinism_1k.rs",
  "crates/abdo-kernel/tests/reduce.rs",
  "crates/abdo-kernel/tests/support/mod.rs",
  "crates/abdo-kernel/tests/transitions_1m.rs",
] as const
const KERNEL_CORE_SOURCE_FILES = [
  "crates/abdo-kernel/Cargo.toml",
  ...KERNEL_CORE_RUST_FILES,
] as const
const POLICY_SOURCE_FILES = [
  "crates/abdo-policy/Cargo.toml",
  "crates/abdo-policy/src/lib.rs",
  "crates/abdo-policy/tests/policy.rs",
] as const
const EVIDENCE_SOURCE_FILES = [
  "crates/abdo-evidence/Cargo.toml",
  "crates/abdo-evidence/src/lib.rs",
] as const
const TOOLS_SOURCE_FILES = [
  "crates/abdo-tools/Cargo.toml",
  "crates/abdo-tools/src/adapters.rs",
  "crates/abdo-tools/src/broker.rs",
  "crates/abdo-tools/src/disclosure.rs",
  "crates/abdo-tools/src/lib.rs",
] as const
const BINARY_SOURCE_FILES = [
  "bins/abdo-kernel/Cargo.toml",
  "bins/abdo-kernel/src/main.rs",
  "bins/abdo-tool-worker/Cargo.toml",
  "bins/abdo-tool-worker/src/main.rs",
  "bins/abdo-tool-worker/src/provider.rs",
  "bins/abdo-tool-worker/tests/provider_gate.rs",
  "bins/abdo-tool-worker/tests/worker_gate.rs",
] as const
const STRUCTURE_SOURCE_FILES = [
  "benches/targets.json",
  "fuzz/targets.json",
  "schemas/kernel-boundary.json",
  "tests/contract/suite.json",
  "tests/crash_injection/suite.json",
  "tests/hostile_inputs/suite.json",
  "tests/platform/suite.json",
  "tests/replay/suite.json",
] as const
const RUNTIME_RUST_FILES = [
  "crates/abdo-runtime/src/adapter_ledger.rs",
  "crates/abdo-runtime/src/authority.rs",
  "crates/abdo-runtime/src/budget.rs",
  "crates/abdo-runtime/src/control.rs",
  "crates/abdo-runtime/src/error.rs",
  "crates/abdo-runtime/src/gatekeeper.rs",
  "crates/abdo-runtime/src/host.rs",
  "crates/abdo-runtime/src/lib.rs",
  "crates/abdo-runtime/src/phase.rs",
  "crates/abdo-runtime/src/reconcile.rs",
  "crates/abdo-runtime/src/schedule.rs",
  "crates/abdo-runtime/src/session.rs",
  "crates/abdo-runtime/src/supervisor.rs",
  "crates/abdo-runtime/src/surface.rs",
  "crates/abdo-runtime/src/vault.rs",
  "crates/abdo-runtime/tests/bridge_gate.rs",
  "crates/abdo-runtime/tests/adapter_ledger.rs",
  "crates/abdo-runtime/tests/broker.rs",
  "crates/abdo-runtime/tests/broker_gate.rs",
  "crates/abdo-runtime/tests/budget.rs",
  "crates/abdo-runtime/tests/budget_fencing.rs",
  "crates/abdo-runtime/tests/control.rs",
  "crates/abdo-runtime/tests/control_throughput.rs",
  "crates/abdo-runtime/tests/crash_boundaries.rs",
  "crates/abdo-runtime/tests/disclosure.rs",
  "crates/abdo-runtime/tests/disclosure_gate.rs",
  "crates/abdo-runtime/tests/gatekeeper.rs",
  "crates/abdo-runtime/tests/no_blind_retry.rs",
  "crates/abdo-runtime/tests/policy_gate.rs",
  "crates/abdo-runtime/tests/reconcile.rs",
  "crates/abdo-runtime/tests/reconcile_sweep.rs",
  "crates/abdo-runtime/tests/schedule.rs",
  "crates/abdo-runtime/tests/secret_gate.rs",
  "crates/abdo-runtime/tests/schedule_100k.rs",
  "crates/abdo-runtime/tests/session.rs",
  "crates/abdo-runtime/tests/session_steps.rs",
  "crates/abdo-runtime/tests/surface_gate.rs",
  "crates/abdo-runtime/tests/support/mod.rs",
  "crates/abdo-runtime/tests/supervisor.rs",
] as const
const RUNTIME_SOURCE_FILES = ["crates/abdo-runtime/Cargo.toml", ...RUNTIME_RUST_FILES] as const
const PACKAGE_SOURCE_FILES = [
  ".gitignore",
  ".prettierignore",
  "Cargo.lock",
  "Cargo.toml",
  "README.md",
  "crates/abdo-contracts/Cargo.toml",
  ...CONTRACT_RUST_FILES,
  "crates/abdo-contracts/test/fixtures/cancel-command-v1.bin",
  "crates/abdo-contracts/test/fixtures/cancel-command-v1.json",
  ...JOURNAL_SOURCE_FILES,
  ...AUTHORITY_SOURCE_FILES,
  ...KERNEL_CORE_SOURCE_FILES,
  ...POLICY_SOURCE_FILES,
  ...EVIDENCE_SOURCE_FILES,
  ...TOOLS_SOURCE_FILES,
  ...BINARY_SOURCE_FILES,
  ...STRUCTURE_SOURCE_FILES,
  ...RUNTIME_SOURCE_FILES,
  "package.json",
  "rust-toolchain.toml",
  "scripts/bounded-gate.ts",
  "scripts/contracts.ts",
  "scripts/guard.ts",
  "scripts/kernel-test.ts",
  "scripts/rust-test.ts",
  "scripts/s105-journal-test.ts",
  "scripts/s106-reducer-test.ts",
  "scripts/s107-supervisor-test.ts",
  "scripts/s108-reconcile-test.ts",
  "scripts/s109-session-test.ts",
  "scripts/s110-control-test.ts",
  "scripts/s111-schedule-test.ts",
  "scripts/s112-budget-test.ts",
  "scripts/s113-authority-test.ts",
  "scripts/s114-policy-test.ts",
  "scripts/s115-broker-test.ts",
  "inventory/tool-surface.json",
  "scripts/inventory.ts",
  "scripts/s116-disclosure-test.ts",
  "scripts/s117-inventory-test.ts",
  "scripts/s118-secret-test.ts",
  "scripts/s119-surface-test.ts",
  "scripts/s142-bridge-test.ts",
  "src/approval.ts",
  "src/catalog.ts",
  "src/contracts.ts",
  "src/control.ts",
  "src/generated/contracts.ts",
  "src/host.ts",
  "src/index.ts",
  "test/approval.test.ts",
  "test/boundary.test.ts",
  "test/catalog.test.ts",
  "test/contracts.test.ts",
  "test/control.test.ts",
  "tsconfig.json",
] as const
const RETIRED_PROBE_PATHS = [
  "scripts/benchmark.ts",
  "scripts/build.ts",
  "src/client.ts",
  "src/hash.ts",
  "src/main.rs",
  "src/protocol.ts",
  "test/fixtures/stall.rs",
] as const
const RUST_BUILTIN_IMPORT_ROOTS = new Set(["alloc", "core", "crate", "self", "std", "super"])
const CONTRACT_LOCAL_IMPORT_ROOTS = new Set(["codegen", "generator", "schema", "schema_macros", "wire"])
const RETIRED_PROBE_MODULE = /(?:^|\/)kernel\/src\/(?:client|hash|protocol)(?:\.[cm]?[jt]sx?)?$/i
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/
const CARGO_REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
const S105_JOURNAL_TABLES = [
  "journal_blobs",
  "journal_budgets",
  "journal_compactions",
  "journal_effects",
  "journal_events",
  "journal_leases",
  "journal_metadata",
  "journal_migrations",
  "journal_projections",
  "journal_snapshots",
  "journal_stream_heads",
] as const
const S105_NORMALIZED_SQLITE_OPTIONS = [
  "DEFAULT_AUTOVACUUM",
  "DEFAULT_CACHE_SIZE=-2000",
  "DEFAULT_FILE_FORMAT=4",
  "DEFAULT_FOREIGN_KEYS",
  "DEFAULT_JOURNAL_SIZE_LIMIT=-1",
  "DEFAULT_MMAP_SIZE=0",
  "DEFAULT_PAGE_SIZE=4096",
  "DEFAULT_PCACHE_INITSZ=20",
  "DEFAULT_RECURSIVE_TRIGGERS",
  "DEFAULT_SECTOR_SIZE=4096",
  "DEFAULT_SYNCHRONOUS=2",
  "DEFAULT_WAL_AUTOCHECKPOINT=1000",
  "DEFAULT_WAL_SYNCHRONOUS=2",
  "DEFAULT_WORKER_THREADS=0",
  "DIRECT_OVERFLOW_READ",
  "ENABLE_API_ARMOR",
  "ENABLE_COLUMN_METADATA",
  "ENABLE_DBSTAT_VTAB",
  "ENABLE_FTS3",
  "ENABLE_FTS3_PARENTHESIS",
  "ENABLE_FTS5",
  "ENABLE_LOAD_EXTENSION",
  "ENABLE_MEMORY_MANAGEMENT",
  "ENABLE_RTREE",
  "ENABLE_STAT4",
  "HAVE_ISNAN",
  "MALLOC_SOFT_LIMIT=1024",
  "MAX_ATTACHED=10",
  "MAX_COLUMN=2000",
  "MAX_COMPOUND_SELECT=500",
  "MAX_DEFAULT_PAGE_SIZE=8192",
  "MAX_EXPR_DEPTH=1000",
  "MAX_FUNCTION_ARG=1000",
  "MAX_LENGTH=1000000000",
  "MAX_LIKE_PATTERN_LENGTH=50000",
  "MAX_PAGE_COUNT=0xfffffffe",
  "MAX_PAGE_SIZE=65536",
  "MAX_SQL_LENGTH=1000000000",
  "MAX_TRIGGER_DEPTH=1000",
  "MAX_VARIABLE_NUMBER=32766",
  "MAX_VDBE_OP=250000000",
  "MAX_WORKER_THREADS=8",
  "SOUNDEX",
  "SYSTEM_MALLOC",
  "TEMP_STORE=1",
  "THREADSAFE=1",
  "USE_URI",
] as const
const S105_LOCKED_PACKAGES = [
  {
    name: "abdo-authority",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-contracts", "hmac", "sha2"],
  },
  { name: "abdo-contracts", version: "0.1.0", source: null, checksum: null, dependencies: [] },
  {
    name: "abdo-evidence",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-contracts", "sha2"],
  },
  {
    name: "abdo-journal",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-contracts", "rusqlite", "sha2"],
  },
  {
    name: "abdo-kernel",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-contracts", "sha2"],
  },
  {
    name: "abdo-kernel-bin",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-runtime"],
  },
  {
    name: "abdo-policy",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-authority", "abdo-contracts", "sha2"],
  },
  {
    name: "abdo-runtime",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-authority", "abdo-contracts", "abdo-evidence", "abdo-journal", "abdo-kernel", "abdo-policy", "abdo-tools", "sha2"],
  },
  {
    name: "abdo-tool-worker",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-contracts", "abdo-runtime", "abdo-tools"],
  },
  {
    name: "abdo-tools",
    version: "0.1.0",
    source: null,
    checksum: null,
    dependencies: ["abdo-authority", "abdo-contracts", "abdo-evidence", "abdo-policy", "sha2"],
  },
  {
    name: "bitflags",
    version: "2.13.1",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "b588b76d00fde79687d7646a9b5bdf3cc0f655e0bbd080335a95d7e96f3587da",
    dependencies: [],
  },
  {
    name: "block-buffer",
    version: "0.12.1",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "d2f6c7dbe95a6ed67ad9f18e57daf93a2f034c524b99fd2b76d18fdfeb6660aa",
    dependencies: ["hybrid-array"],
  },
  {
    name: "cc",
    version: "1.4.4",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "0ad534f4357a5264cce5019c989cf66a4f0dc4e0d1b1d15f8aacec0ff7360273",
    dependencies: ["find-msvc-tools", "shlex"],
  },
  {
    name: "cfg-if",
    version: "1.0.4",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "9330f8b2ff13f34540b44e946ef35111825727b38d33286ef986142615121801",
    dependencies: [],
  },
  {
    name: "cmov",
    version: "0.5.4",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "0c9ea0ac24bc397ab3c98583a3c9ba74fa56b09a4449bbe172b9b1ddb016027a",
    dependencies: [],
  },
  {
    name: "cpufeatures",
    version: "0.3.0",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "8b2a41393f66f16b0823bb79094d54ac5fbd34ab292ddafb9a0456ac9f87d201",
    dependencies: ["libc"],
  },
  {
    name: "crypto-common",
    version: "0.2.2",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "ce6e4c961d6cd6c9a86db418387425e8bdeaf05b3c8bc1411e6dca4c252f1453",
    dependencies: ["hybrid-array"],
  },
  {
    name: "ctutils",
    version: "0.4.2",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "7d5515a3834141de9eafb9717ad39eea8247b5674e6066c404e8c4b365d2a29e",
    dependencies: ["cmov"],
  },
  {
    name: "digest",
    version: "0.11.3",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "f1dd6dbb5841937940781866fa1281a1ff7bd3bf827091440879f9994983d5c2",
    dependencies: ["block-buffer", "crypto-common", "ctutils"],
  },
  {
    name: "fallible-iterator",
    version: "0.3.0",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "2acce4a10f12dc2fb14a218589d4f1f62ef011b2d0cc4b3cb1bba8e94da14649",
    dependencies: [],
  },
  {
    name: "fallible-streaming-iterator",
    version: "0.1.9",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "7360491ce676a36bf9bb3c56c1aa791658183a54d2744120f27285738d90465a",
    dependencies: [],
  },
  {
    name: "find-msvc-tools",
    version: "0.1.11",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "d45db016d36b838f563236e9193d0ee6ce38f3f68b6c94e914b4929c96bbb890",
    dependencies: [],
  },
  {
    name: "hmac",
    version: "0.13.0",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "6303bc9732ae41b04cb554b844a762b4115a61bfaa81e3e83050991eeb56863f",
    dependencies: ["digest"],
  },
  {
    name: "hybrid-array",
    version: "0.4.14",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "707114b52a152fa7bdb290cd7cd5912d9467273b6d74e21b8d81aca1f8533f6b",
    dependencies: ["typenum"],
  },
  {
    name: "libc",
    version: "0.2.189",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2",
    dependencies: [],
  },
  {
    name: "libsqlite3-sys",
    version: "0.38.2",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "f1d20bef17f513b9b3004532233187769cd072d790971f4e4da0e346eb6401e8",
    dependencies: ["cc", "pkg-config", "vcpkg"],
  },
  {
    name: "pkg-config",
    version: "0.3.34",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "f6b464fbc74e149a392436b17d523f769e057cb6877f6a5c4618bc6f11800548",
    dependencies: [],
  },
  {
    name: "rusqlite",
    version: "0.40.2",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "23f2a97da3e3873c73cb2a2e71b35c40ff95e0b1eefa8d72d8499a6928c3b5b3",
    dependencies: ["bitflags", "fallible-iterator", "fallible-streaming-iterator", "libsqlite3-sys", "smallvec"],
  },
  {
    name: "sha2",
    version: "0.11.0",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "446ba717509524cb3f22f17ecc096f10f4822d76ab5c0b9822c5f9c284e825f4",
    dependencies: ["cfg-if", "cpufeatures", "digest"],
  },
  {
    name: "shlex",
    version: "2.0.1",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "f8fadd59c855ef2080decdef8ff161eb6661b86933c9d82e5ba29dc602a55aba",
    dependencies: [],
  },
  {
    name: "smallvec",
    version: "1.15.2",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "8ed6a63f02c8539c91a8685a86f4099661ba3da017932f6ebbea6de3f0fa7c90",
    dependencies: [],
  },
  {
    name: "typenum",
    version: "1.20.1",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "b6f5e870be6c3b371b77fe0ee0bafb859fa4964b4404c27de1d380043c4dda20",
    dependencies: [],
  },
  {
    name: "vcpkg",
    version: "0.2.15",
    source: CARGO_REGISTRY_SOURCE,
    checksum: "accd4ea62f7bb7a82fe23066fb0957d48ef677f6eeb8215f372f52e48bb32426",
    dependencies: [],
  },
] as const
const S105_SELECTED_FEATURES: Readonly<Record<string, readonly string[]>> = {
  "abdo-authority": [],
  "abdo-contracts": [],
  "abdo-journal": ["default"],
  "abdo-kernel": [],
  "abdo-kernel-bin": ["default"],
  "abdo-runtime": ["default"],
  bitflags: [],
  cmov: [],
  ctutils: [],
  "block-buffer": [],
  cc: [],
  "cfg-if": [],
  cpufeatures: [],
  "crypto-common": [],
  digest: ["block-api", "default", "mac"],
  hmac: [],
  "fallible-iterator": ["alloc", "default"],
  "fallible-streaming-iterator": [],
  "find-msvc-tools": [],
  "hybrid-array": [],
  libc: [],
  "libsqlite3-sys": ["bundled", "bundled_bindings", "cc", "default", "min_sqlite_version_3_34_1", "pkg-config", "vcpkg"],
  "pkg-config": [],
  rusqlite: ["bundled", "hooks", "modern_sqlite"],
  sha2: [],
  shlex: ["default", "std"],
  smallvec: [],
  typenum: ["const-generics"],
  vcpkg: [],
}
const S105_DEPENDENCY_EDGE_ALIASES: Readonly<Record<string, string>> = {
  "digest:crypto-common": "common",
}
const S105_BUILD_DEPENDENCY_EDGES = new Set([
  "libsqlite3-sys:cc",
  "libsqlite3-sys:pkg-config",
  "libsqlite3-sys:vcpkg",
])
const IMPORT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "scripts/contracts.ts": ["node:fs", "node:fs/promises", "node:os", "node:path"],
  "scripts/guard.ts": ["./contracts", "node:fs", "node:fs/promises", "node:path"],
  "scripts/kernel-test.ts": [
    "./contracts",
    "./guard",
    "./rust-test",
    "./s105-journal-test",
    "./s106-reducer-test",
    "./s107-supervisor-test",
    "./s108-reconcile-test",
    "./s109-session-test",
    "./s110-control-test",
    "./s111-schedule-test",
    "./s112-budget-test",
    "./s113-authority-test",
    "./s114-policy-test",
    "./s115-broker-test",
    "./s116-disclosure-test",
    "./s117-inventory-test",
    "./s118-secret-test",
    "./s119-surface-test",
    "./s142-bridge-test",
  ],
  "scripts/rust-test.ts": ["./contracts"],
  "scripts/bounded-gate.ts": ["./contracts", "node:fs", "node:path"],
  "scripts/s105-journal-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s106-reducer-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s107-supervisor-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s108-reconcile-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s109-session-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s110-control-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s111-schedule-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s112-budget-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s113-authority-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s114-policy-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s115-broker-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s116-disclosure-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s117-inventory-test.ts": ["./bounded-gate", "./contracts", "./inventory"],
  "scripts/s118-secret-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s119-surface-test.ts": ["./bounded-gate", "./contracts"],
  "scripts/s142-bridge-test.ts": [
    "node:fs",
    "node:path",
    "./bounded-gate",
    "./contracts",
    "../src/host",
    "../src/generated/contracts",
  ],
  "scripts/inventory.ts": ["./contracts", "node:fs/promises", "node:path"],
  "src/approval.ts": ["./generated/contracts"],
  "src/catalog.ts": ["./generated/contracts"],
  "src/contracts.ts": ["./generated/contracts"],
  "src/control.ts": ["./generated/contracts"],
  "src/host.ts": ["./generated/contracts"],
  "src/index.ts": ["./contracts", "./control", "./approval", "./catalog", "./host"],
  "test/boundary.test.ts": [
    "../scripts/contracts",
    "../scripts/guard",
    "../scripts/s105-journal-test",
    "bun:test",
    "node:path",
  ],
  // Imported twice on purpose: named bindings for use, and a namespace so a
  // test can assert what the module does *not* export.
  "test/contracts.test.ts": ["../scripts/contracts", "../src/contracts", "../src/contracts", "bun:test"],
  "test/control.test.ts": ["../src/control", "../src/generated/contracts", "bun:test"],
  "test/approval.test.ts": ["../src/approval", "../src/generated/contracts", "bun:test"],
  "test/catalog.test.ts": ["../src/catalog", "../src/generated/contracts", "bun:test"],
}
const BUN_MEMBER_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "scripts/contracts.ts": ["CryptoHasher", "spawnSync", "spawnSync", "spawnSync", "write"],
  "scripts/guard.ts": [
    "CryptoHasher",
    "JSONC",
    "Transpiler",
    "Transpiler",
    "Transpiler",
    "Transpiler",
    "YAML",
    "file",
    "file",
    "file",
    "spawnSync",
    "TOML",
  ],
  "scripts/kernel-test.ts": ["spawnSync"],
  "scripts/rust-test.ts": ["spawnSync"],
  "scripts/bounded-gate.ts": ["spawn", "spawnSync"],
  "scripts/s105-journal-test.ts": [],
  "scripts/s106-reducer-test.ts": [],
  "scripts/s107-supervisor-test.ts": [],
  "scripts/s108-reconcile-test.ts": [],
  "scripts/s109-session-test.ts": [],
  "scripts/s110-control-test.ts": [],
  "scripts/s111-schedule-test.ts": [],
  "scripts/s112-budget-test.ts": [],
  "scripts/s113-authority-test.ts": [],
  "scripts/s114-policy-test.ts": [],
  "scripts/s115-broker-test.ts": [],
  "scripts/s116-disclosure-test.ts": [],
  "scripts/s117-inventory-test.ts": [],
  "scripts/s118-secret-test.ts": [],
  "scripts/s119-surface-test.ts": [],
  "scripts/s142-bridge-test.ts": [],
  "scripts/inventory.ts": [],
  // The client has to start the host it is the client of. That is the whole of
  // its host surface, written as the one member it may reach rather than as a
  // list of the ones it may not.
  "src/host.ts": ["spawn"],
  "test/boundary.test.ts": ["TOML", "file", "file", "spawnSync"],
  "test/contracts.test.ts": ["file", "file", "file", "file", "file", "file", "file", "file"],
  "test/control.test.ts": [],
  "test/approval.test.ts": [],
  "test/catalog.test.ts": [],
}
const TYPESCRIPT_DYNAMIC_CAPABILITY = new RegExp(
  ["\\bim", "port\\s*\\(|\\bre", "quire\\s*\\(|\\bev", "al\\s*\\(|\\bnew\\s+Fun", "ction\\s*\\("].join(""),
)
const TYPESCRIPT_NETWORK_OR_PROCESS_CAPABILITY = new RegExp(
  [
    "\\bfe",
    "tch\\b|\\bWeb",
    "Socket\\b|\\bEvent",
    "Source\\b|\\bXML",
    "HttpRequest\\b|\\bsend",
    "Beacon\\b|\\bBun\\s*\\.\\s*(?:con",
    "nect|ser",
    "ve|lis",
    "ten|udp",
    "Socket)\\b|\\b(?:node:)?child_",
    "process\\b",
  ].join(""),
)
const TYPESCRIPT_AMBIENT_CAPABILITY_ESCAPE = new RegExp(
  ["\\bglo", "balThis\\b|\\bRef", "lect\\s*\\.\\s*get\\b"].join(""),
)

export interface BoundarySource {
  readonly path: string
  readonly source: string
}

export interface CargoClosureIdentity {
  readonly metadataCommand: readonly string[]
  readonly packageIds: readonly string[]
  readonly packages: readonly {
    readonly name: string
    readonly version: string
    readonly source: string | null
    readonly dependencies: number
    readonly targets: readonly string[]
  }[]
  readonly resolveNodes: readonly { readonly id: string; readonly dependencies: readonly string[] }[]
  readonly workspaceMembers: readonly string[]
}

export interface S104ContractsBoundaryIdentity {
  readonly sourceFiles: readonly string[]
  readonly rustFiles: readonly string[]
  readonly generatedFile: "src/generated/contracts.ts"
  readonly unsafeCodeForbidDirectives: number
  readonly modelCognitionMatches: 0
  readonly privilegedEffectMatches: 0
  readonly externalRustImports: 0
  readonly retiredProbePaths: readonly string[]
}

export interface S105CargoIdentity {
  readonly workspaceMembers: readonly string[]
  readonly journalDependencies: readonly ["abdo-contracts", "rusqlite", "sha2"]
  readonly kernelCoreDependencies: readonly ["abdo-contracts", "sha2"]
  readonly runtimeDependencies: readonly string[]
  readonly lockedPackages: number
  readonly registryPackages: number
  readonly sqlite: {
    readonly rusqlite: "0.40.2"
    readonly libsqlite3Sys: "0.38.2"
    readonly bundled: true
  }
}

export interface S105JournalBoundaryIdentity {
  readonly sourceFiles: typeof JOURNAL_SOURCE_FILES
  readonly rustFiles: readonly string[]
  readonly sqliteFiles: readonly [
    "migrations/0001_initial.sql",
    "migrations/0002_effects.sql",
    "migrations/0003_leases_budgets.sql",
    "migrations/0004_compactions.sql",
  ]
  readonly sqliteTables: typeof S105_JOURNAL_TABLES
  readonly runtimeConnectionOpenSites: 1
  readonly sqliteIdentity: {
    readonly version: "3.53.2"
    readonly sourceId: "d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24"
    readonly normalizedCompileOptions: number
  }
  readonly modelCognitionMatches: 0
  readonly networkMatches: 0
  readonly parallelStoreMatches: 0
}

export async function verifyBoundaryGuards(preparedContext?: PreparedCargoContext) {
  const paths = await listBoundarySourceFiles()
  const sources = await Promise.all(
    paths.map(async (path) => ({
      path,
      source: (await Bun.file(join(KERNEL_PACKAGE_DIR, path)).text()).replaceAll("\r\n", "\n"),
    })),
  )
  const s104ContractsBoundary = assertStaticBoundarySources(sources)
  const dependencyClosure = readCargoDependencyClosure(preparedContext)
  const externalConsumerScan = await verifyNoRetiredProbeConsumers()
  const workflow = assertKernelBoundaryWorkflow(
    await Bun.file(join(REPOSITORY_DIR, ".github", "workflows", "kernel-boundary.yml")).text(),
  )
  return {
    scannedFiles: paths.length,
    dependencyClosure,
    externalConsumerScan,
    s104ContractsBoundary,
    s105CargoIdentity: s104ContractsBoundary.s105CargoIdentity,
    s105JournalBoundary: s104ContractsBoundary.s105JournalBoundary,
    s106ReducerPurity: s104ContractsBoundary.s106ReducerPurity,
    s107RuntimeBoundary: s104ContractsBoundary.s107RuntimeBoundary,
    s113AuthorityBoundary: s104ContractsBoundary.s113AuthorityBoundary,
    s114PolicyBoundary: s104ContractsBoundary.s114PolicyBoundary,
    s115BrokerBoundary: s104ContractsBoundary.s115BrokerBoundary,
    s116DisclosureBoundary: s104ContractsBoundary.s116DisclosureBoundary,
    s117WorkerBoundary: s104ContractsBoundary.s117WorkerBoundary,
    s118SecretBoundary: s104ContractsBoundary.s118SecretBoundary,
    s119SurfaceBoundary: s104ContractsBoundary.s119SurfaceBoundary,
    workflow,
  }
}

export async function listBoundarySourceFiles() {
  const files: string[] = []
  await walkPackage(KERNEL_PACKAGE_DIR, "", files)
  return files.toSorted()
}

export function assertKernelBoundaryWorkflow(source: string) {
  let document: unknown
  try {
    document = Bun.YAML.parse(source)
  } catch {
    throw new Error("S104 kernel boundary workflow is not valid YAML")
  }
  const workflow = requireRecord(document, "kernel boundary workflow")
  if (workflow.name !== "kernel-boundary") throw new Error("S105 kernel boundary workflow name drifted")
  const topLevelKeys = Object.keys(workflow).toSorted()
  if (JSON.stringify(topLevelKeys) !== JSON.stringify(["jobs", "name", "on", "permissions"])) {
    throw new Error(`S104 kernel boundary workflow top-level keys drifted: ${JSON.stringify(topLevelKeys)}`)
  }
  const triggers = requireRecord(workflow.on, "kernel boundary workflow triggers")
  if (JSON.stringify(Object.keys(triggers).toSorted()) !== JSON.stringify(["pull_request", "push", "workflow_dispatch"])) {
    throw new Error("S105 kernel boundary workflow trigger identity drifted")
  }
  for (const event of ["push", "pull_request"]) {
    if (!Object.hasOwn(triggers, event)) throw new Error(`S104 kernel boundary workflow is missing ${event}`)
    const configuration = triggers[event]
    if (configuration === null) continue
    const mapping = requireRecord(configuration, `${event} trigger`)
    if (Object.hasOwn(mapping, "paths") || Object.hasOwn(mapping, "paths-ignore")) {
      throw new Error(`S104 kernel boundary workflow ${event} must not use path filters`)
    }
  }

  const jobs = requireRecord(workflow.jobs, "kernel boundary workflow jobs")
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(["kernel-boundaries"])) {
    throw new Error("S105 kernel boundary workflow job allowlist drifted")
  }
  if (!Object.hasOwn(jobs, "kernel-boundaries")) {
    throw new Error("S105 kernel boundary workflow must retain the kernel-boundaries job key")
  }
  const job = requireRecord(jobs["kernel-boundaries"], "kernel-boundaries job")
  for (const key of ["if", "continue-on-error", "env", "defaults"]) {
    if (Object.hasOwn(job, key)) throw new Error(`S104 kernel boundary workflow job may not define ${key}`)
  }
  if (
    job.name !== "S104 contracts, S105 journal, and bootstrap boundaries" ||
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 90
  ) {
    throw new Error("S105 kernel boundary workflow job identity or timeout drifted")
  }
  const steps = requireArray(job.steps, "kernel-boundaries steps").map((step, index) =>
    requireRecord(step, `kernel-boundaries step ${index}`),
  )
  if (steps.length !== 7) throw new Error(`S105 kernel boundary workflow step count drifted: ${steps.length}`)
  for (const [index, step] of steps.entries()) {
    for (const key of ["if", "continue-on-error", "env", "shell", "working-directory"]) {
      if (Object.hasOwn(step, key)) {
        throw new Error(`S104 kernel boundary workflow step ${index} may not define ${key}`)
      }
    }
    if (step.uses === undefined) continue
    const uses = requireString(step.uses, `kernel-boundaries step ${index} uses`)
    if (!uses.startsWith("./") && !PINNED_ACTION.test(uses)) {
      throw new Error(`S104 kernel boundary workflow step ${index} action is not pinned to a full commit SHA`)
    }
  }

  const permissions = requireRecord(workflow.permissions, "kernel boundary workflow permissions")
  if (JSON.stringify(permissions) !== JSON.stringify({ contents: "read" })) {
    throw new Error("S105 kernel boundary workflow permissions drifted")
  }
  const actions = steps.filter((step) => step.uses !== undefined)
  const expectedActions = [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  ]
  if (JSON.stringify(actions.map((step) => step.uses)) !== JSON.stringify(expectedActions)) {
    throw new Error("S105 kernel boundary workflow action identity drifted")
  }
  if (actions[0]!.with !== undefined) throw new Error("S105 checkout action inputs drifted")
  if (JSON.stringify(actions[1]!.with) !== JSON.stringify({ "bun-version": "1.3.14" })) {
    throw new Error("S105 Bun action input drifted")
  }

  const requiredCommands = [
    "bun install --frozen-lockfile",
    "bun test --timeout 120000 packages/kernel",
    "bun run --cwd packages/kernel typecheck",
    "bun run structure",
    "bun run typecheck",
  ]
  const expectedRunBlocks = [
    "rustup toolchain install 1.94.1 --profile minimal --component clippy,rustfmt",
    "bun install --frozen-lockfile",
    "bun test --timeout 120000 packages/kernel\nbun run --cwd packages/kernel typecheck",
    "bun run structure",
    "bun run typecheck",
  ]
  const runBlocks = steps
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string")
    .map((run) => run.replaceAll("\r\n", "\n").trim())
  if (JSON.stringify(runBlocks) !== JSON.stringify(expectedRunBlocks)) {
    throw new Error("S105 kernel boundary workflow run blocks drifted from the exact fail-closed sequence")
  }
  return { job: "kernel-boundaries" as const, requiredCommands, pinnedActions: steps.filter((step) => step.uses).length }
}

export function assertStaticBoundarySources(sources: readonly BoundarySource[]) {
  const paths = sources.map((entry) => entry.path).toSorted()
  if (new Set(paths).size !== paths.length) throw new Error("kernel guard received duplicate source paths")
  const blueprint = JSON.parse(readFileSync(join(REPOSITORY_DIR, "architecture", "original-rust-blueprint.json"), "utf8")) as {
    schemaVersion?: unknown; elementCount?: unknown; elements?: { path?: unknown; kind?: unknown }[]
  }
  if (blueprint.schemaVersion !== 1 || blueprint.elementCount !== 327 || !Array.isArray(blueprint.elements) || blueprint.elements.length !== 327) {
    throw new Error("S104 original blueprint manifest identity drifted")
  }
  const facadePaths = blueprint.elements.flatMap((element): string[] =>
    element.kind === "file" && typeof element.path === "string" && element.path.endsWith(".rs") ? [element.path] : [],
  )
  const facadeRegistries = ["abdo-contracts", "abdo-kernel", "abdo-journal", "abdo-authority", "abdo-policy", "abdo-runtime", "abdo-tools", "abdo-evidence"]
    .map((crate) => `crates/${crate}/src/blueprint_facades.rs`)
  const expected = [...new Set([...PACKAGE_SOURCE_FILES, ...facadePaths, ...facadeRegistries])].toSorted()
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    throw new Error(`S104 package source allowlist drifted: ${JSON.stringify(paths)}`)
  }
  for (const path of facadePaths) {
    if ((PACKAGE_SOURCE_FILES as readonly string[]).includes(path)) continue
    const entry = sources.find((source) => source.path === path)
    const canonical = /^\/\/! BLUEPRINT_FACADE_V1 canonical=([^\r\n]+)$/m.exec(entry?.source ?? "")?.[1]
    if (!canonical || !existsSync(join(KERNEL_PACKAGE_DIR, ...canonical.split("/")))) {
      throw new Error(`S104 blueprint facade is not bound to a canonical source: ${path}`)
    }
  }
  for (const retired of RETIRED_PROBE_PATHS) {
    if (paths.includes(retired)) throw new Error(`retired S101 probe source returned: ${retired}`)
  }
  const blueprintOnly = new Set([...facadePaths.filter((path) => !(PACKAGE_SOURCE_FILES as readonly string[]).includes(path)), ...facadeRegistries])
  const canonicalSources = sources.filter((entry) => !blueprintOnly.has(entry.path))
  for (const entry of canonicalSources.filter((item) => item.path.endsWith(".ts"))) assertTypeScriptSource(entry)
  assertPackageManifest(canonicalSources)
  assertPinnedToolchainAndWorkspace(canonicalSources)
  const s104 = assertS104ContractsBoundary(canonicalSources)
  return {
    ...s104,
    s105CargoIdentity: assertS105CargoIdentity(canonicalSources),
    s105JournalBoundary: assertS105JournalCapabilities(canonicalSources),
    s106ReducerPurity: assertS106ReducerPurity(canonicalSources),
    s107RuntimeBoundary: assertS107RuntimeBoundary(canonicalSources),
    s113AuthorityBoundary: assertS113AuthorityBoundary(canonicalSources),
    s114PolicyBoundary: assertS114PolicyBoundary(canonicalSources),
    s115BrokerBoundary: assertS115BrokerBoundary(canonicalSources),
    s116DisclosureBoundary: assertS116DisclosureBoundary(canonicalSources),
    s117WorkerBoundary: assertS117WorkerBoundary(canonicalSources),
    s118SecretBoundary: assertS118SecretBoundary(canonicalSources),
    s119SurfaceBoundary: assertS119SurfaceBoundary(canonicalSources),
  }
}

export function assertS104ContractsBoundary(sources: readonly BoundarySource[]): S104ContractsBoundaryIdentity {
  sources = sources.filter((entry) => !entry.source.startsWith("//! BLUEPRINT_FACADE_V1") && !entry.path.endsWith("/src/blueprint_facades.rs"))
  const paths = new Set(sources.map((entry) => entry.path))
  const sourceFiles = CONTRACT_SOURCE_FILES.filter((path) => paths.has(path))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(CONTRACT_SOURCE_FILES)) {
    const missing = CONTRACT_SOURCE_FILES.filter((path) => !paths.has(path))
    throw new Error(`S104 contract source surface is incomplete: ${JSON.stringify(missing)}`)
  }

  const rustSources = sources
    .filter((entry) => entry.path.startsWith("crates/abdo-contracts/") && entry.path.endsWith(".rs"))
    .toSorted((left, right) => compareText(left.path, right.path))
  const rustFiles = rustSources.map((entry) => entry.path)
  if (JSON.stringify(rustFiles) !== JSON.stringify(CONTRACT_RUST_FILES)) {
    throw new Error(`S104 contract Rust source allowlist drifted: ${JSON.stringify(rustFiles)}`)
  }

  let unsafeCodeForbidDirectives = 0
  for (const entry of rustSources) {
    const forbidDirectives = entry.source.match(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g) ?? []
    const isCrateRoot =
      entry.path.endsWith("/src/lib.rs") || entry.path.includes("/src/bin/") || entry.path.includes("/tests/")
    const expectedDirectives = isCrateRoot ? 1 : 0
    if (forbidDirectives.length !== expectedDirectives) {
      throw new Error(
        `S104 contract crate roots must contain exactly one forbid(unsafe_code) directive and modules inherit it: ${entry.path}`,
      )
    }
    unsafeCodeForbidDirectives += forbidDirectives.length
    const capabilitySource = isS105ProductionRuntimePath(entry.path)
      ? stripRustCfgTestModules(entry.source)
      : entry.source
    const code = maskRustNonCode(capabilitySource)
    const withoutDirective = code.replace(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g, "")
    if (/\bunsafe\b/.test(withoutDirective)) throw new Error(`S104 contracts contain unsafe code in ${entry.path}`)
    assertNoRustNamespaceEscape(entry, code)
    assertRustMacroSurface(entry, code)
    assertRustInclusionBoundary(entry, code)
    if (/\b\w*(?:model|llm|prompt|inference|cognition|reasoning|planner|agent_loop|tool_call)\w*\b/i.test(code)) {
      throw new Error(`S104 contracts contain model or cognition semantics in ${entry.path}`)
    }
    if (entry.path.endsWith("/src/bin/abdo-contracts-codegen.rs")) assertBoundedCodegenCapabilities(entry, code)
    else if (entry.path.endsWith("/src/bin/abdo-effects-worker.rs")) assertBoundedWorkerCapabilities(entry, code)
    else if (entry.path.endsWith("/tests/worker_gate.rs")) assertBoundedWorkerGateCapabilities(entry, code)
    else if (entry.path.endsWith("/tests/id_10m.rs")) assertBoundedIdStressCapabilities(entry, code)
    else assertNoRuntimeCapabilities(entry, code)
    assertBuiltinOnlyRustImports(entry.path, code)
  }

  const facade = requiredSource(sources, "src/contracts.ts").trim()
  if (facade !== 'export * from "./generated/contracts"') {
    throw new Error("S104 TypeScript contract facade must remain an exact generated-surface re-export")
  }
  const root = requiredSource(sources, "src/index.ts").trim()
  // The root exports the generated contract facade, the engine-side control
  // client and the approval gate, and nothing else. The client is the second
  // half of the boundary: the plan puts the IPC client in this package, and a
  // kernel that bounded its own mailboxes while the engine queued without a
  // bound would hold the memory guarantee on one side only, which is the same
  // as not holding it. The approval gate is here for the same reason on the
  // other axis: a kernel that refuses without an operator, paired with an
  // engine that approves when nobody answers, refuses nothing.
  if (
    root !==
    'export * from "./contracts"\nexport * from "./control"\nexport * from "./approval"\nexport * from "./catalog"\nexport * from "./host"'
  ) {
    throw new Error(
      "kernel root must export exactly the contract facade, the control client, the approval gate and the host client",
    )
  }
  const client = requiredSource(sources, "src/control.ts")
  if (!/if \(this\.#queue\.length >= this\.#capacity\) \{/.test(client)) {
    throw new Error("S110 the engine-side client no longer checks its capacity before queueing")
  }
  if ((client.match(/#queue\.push\(/g)?.length ?? 0) !== 1) {
    throw new Error("S110 the engine-side client gained a second way to enqueue")
  }
  // The client must not re-implement the protocol. Decoding by hand here would
  // be a second opinion about the wire, and two opinions is how a boundary
  // stops being one.
  if (/DataView|readUInt|\bslice\(\s*\d+\s*,/.test(maskTypeScriptStringsAndComments(client).code)) {
    throw new Error("S110 the engine-side client parses frames itself instead of using the codec")
  }
  if (!client.includes("CONTRACT_DESCRIPTOR.types.InputChannel")) {
    throw new Error("S110 the engine-side channel list is no longer read from the contract")
  }

  // The host client carries effects rather than envelopes, and it has to hold
  // the same two properties on this side of the boundary: a bound that refuses
  // instead of growing, and no answer that is silence.
  const hostClient = requiredSource(sources, "src/host.ts")
  if (!/if \(this\.#waiting\.length >= this\.#capacity\) \{/.test(hostClient)) {
    throw new Error("S142 the host client no longer checks its capacity before accepting an effect")
  }
  if ((hostClient.match(/#waiting\.push\(/g)?.length ?? 0) !== 1) {
    throw new Error("S142 the host client gained a second way to put an effect in flight")
  }
  // Every call in flight is answered when the host dies. A client that dropped
  // them would leave a caller waiting forever on a process that is gone, which
  // is the failure this whole shape exists to make impossible.
  if (!/while \(this\.#waiting\.length > 0\) \{/.test(hostClient)) {
    throw new Error("S142 the host client no longer answers the calls a dead host left in flight")
  }
  if (!hostClient.includes("decodeFrameHeader(")) {
    throw new Error("S142 the host client no longer takes its frame lengths from the codec")
  }
  if (/DataView|readUInt|\bslice\(\s*\d+\s*,/.test(maskTypeScriptStringsAndComments(hostClient).code)) {
    throw new Error("S142 the host client parses frames itself instead of using the codec")
  }

  const generated = requiredSource(sources, "src/generated/contracts.ts")
  if (!generated.startsWith("// @generated by abdo-contracts-codegen; DO NOT EDIT.\n")) {
    throw new Error("S104 generated contracts are missing the canonical read-only header")
  }
  if (!generated.includes("Source of truth: crates/abdo-contracts/src/schema.rs")) {
    throw new Error("S104 generated contracts do not identify the Rust source of truth")
  }

  const generatedDeclarations = new Set(
    [...generated.matchAll(/\bexport\s+(?:interface|type|class|const|function)\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1]!,
    ),
  )
  if (generatedDeclarations.size < 50) {
    throw new Error(`S104 generated declaration inventory is unexpectedly small: ${generatedDeclarations.size}`)
  }
  const duplicates = sources.filter((entry) => {
    if (!entry.path.startsWith("src/") || entry.path === "src/generated/contracts.ts") return false
    // Naming a generated type in an import or a re-export is not declaring a
    // second copy of it. Matching on the keyword alone confuses the two, and a
    // check that fires on correct code is one somebody routes around.
    // A top-level declaration begins a line. A name inside an import or a
    // re-export list is indented within braces. Anchoring at column zero tells
    // declaring from merely naming, without parsing import syntax, which is the
    // part that kept misreading correct code as a duplicate.
    const declarations = [
      ...maskTypeScriptStringsAndComments(entry.source).code.matchAll(
        /^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|const|function)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ]
    return declarations.some((match) => generatedDeclarations.has(match[1]!))
  })
  if (duplicates.length > 0) {
    throw new Error(
      `S104 handwritten contract duplicate outside generated source: ${duplicates.map((entry) => entry.path).join(", ")}`,
    )
  }

  return {
    sourceFiles,
    rustFiles,
    generatedFile: "src/generated/contracts.ts",
    unsafeCodeForbidDirectives,
    modelCognitionMatches: 0,
    privilegedEffectMatches: 0,
    externalRustImports: 0,
    retiredProbePaths: [...RETIRED_PROBE_PATHS],
  }
}

function assertNoRustNamespaceEscape(entry: BoundarySource, code: string) {
  if (/\bextern\s+crate\s+(?:std|core|alloc|crate|self|super)\s+as\s+/i.test(code)) {
    throw new Error(`S104 Rust namespace alias escapes the capability guard in ${entry.path}`)
  }
  for (const match of code.matchAll(/\buse\s+([^;]+);/g)) {
    const statement = match[1]!
      .replaceAll(/\s+/g, " ")
      .trim()
      .replace(/^::\s*/, "")
    const withoutIgnoredTraitAlias = statement.replaceAll(/\bas\s+_(?=\s|,|\}|$)/g, "")
    if (/\bas\s+\S+/.test(withoutIgnoredTraitAlias)) {
      const allowedProcessAlias =
        entry.path.endsWith("/tests/id_10m.rs") && statement === "std::process::Command as ProcessCommand"
      if (!allowedProcessAlias) {
        throw new Error(`S104 Rust namespace alias escapes the capability guard in ${entry.path}`)
      }
    }
    if (/^(?:std|core|alloc|crate|self|super)\s*::[\s\S]*\*/.test(statement)) {
      const allowedLocalTestImport = entry.path.endsWith("/src/generator.rs") && statement === "super::*"
      if (!allowedLocalTestImport) {
        throw new Error(`S104 Rust wildcard import escapes the exact import boundary in ${entry.path}`)
      }
    }
  }
}

function assertRustMacroSurface(entry: BoundarySource, code: string) {
  const names = [...code.matchAll(/\bmacro_rules\s*!\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!)
  const tokenCount = code.match(/\bmacro_rules\s*!/g)?.length ?? 0
  const expected = entry.path.endsWith("/src/schema_macros.rs")
    ? [
        "schema_rule_reason",
        "schema_rule_failed",
        "schema_validate_encode",
        "schema_validate_decode",
        "schema_rule_descriptor",
        "schema_id_type",
        "schema_fixed_bytes_type",
        "schema_unit_type",
        "schema_struct_type",
        "schema_integrity_struct_type",
        "schema_enum_type",
        "schema_union_type",
        "contract_schema",
      ]
    : entry.path.endsWith("/src/wire.rs")
      ? ["integer_codec"]
      : []
  if (tokenCount !== names.length || JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`S104 Rust macro_rules surface drifted in ${entry.path}`)
  }
  if (names.length > 0) {
    if (/\$\s*[^\s!()[\]{}:,;]+\s*!|#\s*\[\s*\$|\binclude(?:_bytes|_str)?\s*!|#\s*\[\s*path\s*=/.test(code)) {
      throw new Error(`S104 Rust macro indirection can escape the scanned source boundary in ${entry.path}`)
    }
  }
}

function assertRustInclusionBoundary(entry: BoundarySource, code: string) {
  if (/#\s*\[\s*path\s*=|\binclude\s*!\s*\(/.test(code)) {
    throw new Error(`S104 Rust source inclusion escapes the scanned source boundary in ${entry.path}`)
  }
  const byteIncludes = code.match(/\binclude_bytes\s*!\s*\(/g)?.length ?? 0
  const textIncludes = code.match(/\binclude_str\s*!\s*\(/g)?.length ?? 0
  const calls = extractRustIncludeCalls(entry.source)
  if (calls.length !== byteIncludes + textIncludes) {
    throw new Error(`S104 Rust fixture inclusion must use one directly scanned literal in ${entry.path}`)
  }
  if (entry.path.endsWith("/tests/golden.rs")) {
    const expected = [
      { macro: "include_bytes", path: "../test/fixtures/cancel-command-v1.bin" },
      { macro: "include_str", path: "../test/fixtures/cancel-command-v1.json" },
    ]
    if (JSON.stringify(calls) !== JSON.stringify(expected)) {
      throw new Error(`S104 Rust golden fixture inclusion surface drifted in ${entry.path}`)
    }
    return
  }
  if (byteIncludes !== 0 || textIncludes !== 0) {
    throw new Error(`S104 Rust source inclusion escapes the scanned source boundary in ${entry.path}`)
  }
}

function extractRustIncludeCalls(source: string) {
  const uncommented = stripRustComments(source)
  return [...uncommented.matchAll(/\b(include_bytes|include_str)\s*!\s*\(\s*\x22((?:\\.|[^\x22\\])*)\x22\s*\)/g)].map(
    (match) => ({ macro: match[1]!, path: match[2]! }),
  )
}

function stripRustComments(source: string) {
  let output = ""
  let index = 0
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      output += "\n"
      continue
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index += 2
      let depth = 1
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1
          index += 2
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1
          index += 2
        } else index += 1
      }
      if (depth !== 0) throw new Error("unterminated Rust block comment")
      output += " "
      continue
    }
    const raw = source.slice(index).match(/^r(#{0,16})\x22/)
    if (raw) {
      const terminator = `"${raw[1]!}`
      const end = source.indexOf(terminator, index + raw[0].length)
      if (end === -1) throw new Error("unterminated Rust raw string")
      output += source.slice(index, end + terminator.length)
      index = end + terminator.length
      continue
    }
    const characterLiteralEnd = source[index] === "'" ? source.indexOf("'", index + 1) : -1
    const isCharacterLiteral =
      source[index] === "'" && characterLiteralEnd > index + 1 && characterLiteralEnd <= index + 5
    if (source[index] === '"' || isCharacterLiteral) {
      const quote = source[index]!
      do {
        output += source[index]!
        index += 1
        if (output.at(-1) === "\\" && index < source.length) {
          output += source[index]!
          index += 1
        }
      } while (index < source.length && source[index] !== quote)
      if (source[index] !== quote) throw new Error("unterminated Rust literal")
      output += source[index]!
      index += 1
      continue
    }
    output += source[index]!
    index += 1
  }
  return output
}

function assertNoRuntimeCapabilities(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:fs|net|env|os|ffi|arch|process|io|path|time|thread)\b|\buse\s+(?:::)?\s*std\s*::\s*\{[^}]*\b(?:fs|net|env|os|ffi|arch|process|io|path|time|thread)\b|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:option_)?env!\s*\(|\b(?:global_)?asm!\s*\(|\b(?:winapi|windows_sys|libc|nix)\s*::|\b(?:File|OpenOptions|Child|Stdio|TcpStream|UdpSocket|UnixStream)\s*::/i.test(
      code,
    )
  ) {
    throw new Error(`S104 contracts contain a privileged, process or network capability in ${entry.path}`)
  }
}

/**
 * The effect worker gets a pipe and an exit code, and nothing else.
 *
 * It is a binary, so it needs standard input and standard output; that is the
 * whole of its host surface. The allowance is written as an exact site list
 * rather than a prohibition, because a prohibition has to anticipate every way
 * in and this only has to name the two ways that are allowed.
 *
 * Notably absent: any way to run something. A worker that could spawn is the
 * escape hatch the `effectful-dispatch` feature exists to keep shut, and it
 * would be shut in the runtime while standing open here.
 */
function assertBoundedWorkerCapabilities(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:fs|net|env|os|ffi|arch|thread|time)\b|\bprocess\s*::\s*Command\b|\b(?:Command|Child|Stdio|TcpStream|UdpSocket|UnixStream|File|OpenOptions)\s*::|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:option_)?env!\s*\(|\b(?:global_)?asm!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error(`S117 the effect worker contains a capability beyond its pipe in ${entry.path}`)
  }
  const boundedSites = [...code.matchAll(/\b(io|process)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => `${match[1]}::${match[2]}`)
    .toSorted()
  // Six exit-code sites: the signature, one success and four refusals — an
  // unreadable frame, an oversized one, a spec that will not decode, and a
  // report that will not encode. Pinned as a count so a new way out of this
  // binary has to be added here as well as there.
  const expected = [
    "io::stdin",
    "io::stdout",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
  ].toSorted()
  if (JSON.stringify(boundedSites) !== JSON.stringify(expected)) {
    throw new Error(`S117 effect worker capability allowlist drifted: ${JSON.stringify(boundedSites)}`)
  }
}

/**
 * The kernel host gets a pipe, a clock, a command line and the objects it was
 * bound to. Nothing else.
 *
 * It needs more than the effect worker does, because it is a host: it opens the
 * journal, reads the object it was told about, and stamps phases with a real
 * time. Every one of those is forbidden inside the library it links, which is
 * the point of writing the allowance here as an exact site list. A prohibition
 * would have to anticipate every way in; this only has to name the ways that
 * are allowed.
 *
 * Notably absent: any way to run something. A host that could spawn would be
 * the escape hatch `effectful-dispatch` exists to keep shut, standing open
 * beside the door it guards.
 */
function assertBoundedHostCapabilities(source: string) {
  const code = maskRustNonCode(source)
  if (
    /\bstd\s*::\s*(?:net|os|ffi\s*::\s*c|arch|thread)\b|\bprocess\s*::\s*Command\b|\b(?:Command|Child|Stdio|TcpStream|UdpSocket|UnixStream|OpenOptions)\s*::|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:option_)?env!\s*\(|\b(?:global_)?asm!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error("S142 the kernel host contains a capability beyond its pipe, clock and bindings")
  }

  const boundedSites = [...code.matchAll(/\b(io|fs|env|process)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => `${match[1]}::${match[2]}`)
    .toSorted()
  // Three standard streams; one file opener; one argument reader; one process
  // identity; and five exit-code sites — the two signatures, a clean shutdown,
  // a failure, and the status a host reports when it was told to be killed and
  // was not. Pinned as a list so a new way out of this binary has to be added
  // here as well as there.
  const expected = [
    "env::args_os",
    "fs::File",
    "io::stderr",
    "io::stdin",
    "io::stdout",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::ExitCode",
    "process::id",
  ].toSorted()
  if (JSON.stringify(boundedSites) !== JSON.stringify(expected)) {
    throw new Error(`S142 kernel host capability allowlist drifted: ${JSON.stringify(boundedSites)}`)
  }

  // One clock reading, in one function. A host reads the clock; the library it
  // links must not, and a single site is what makes that difference checkable
  // rather than merely stated.
  if ((code.match(/\bSystemTime\s*::\s*now\s*\(/g)?.length ?? 0) !== 1) {
    throw new Error("S142 the kernel host reads the clock in more than one place")
  }
  // The object is read through a bounded take, never slurped whole. A file's
  // length is not this process's to trust.
  if (!/\.take\(limit\.saturating_add\(1\)\)/.test(code)) {
    throw new Error("S142 the kernel host no longer bounds a read before it performs it")
  }

  // The one guarded entry point, and no second copy of the gate it enforces.
  const dispatches = code.match(/supervisor\s*\.\s*dispatch\s*\(/g)?.length ?? 0
  if (dispatches !== 1) {
    throw new Error(`S142 the kernel host reaches the adapter through ${dispatches} paths, and may reach it through one`)
  }
  // Matched without the feature name: the masker blanks Rust string literals
  // before this runs, so a check that named the feature would never fire and
  // would read as a passing guard over a hole.
  if (/\bcfg!\s*\(\s*feature\s*=/.test(code)) {
    throw new Error("S142 the kernel host carries its own copy of the dispatch gate")
  }

  // Stopping means stopping after the dispatch is durable and before the
  // adapter runs. A halt on the other side of either would be a different state
  // wearing the name of the one recovery exists for.
  const commitIndex = code.indexOf("commit_dispatch(")
  const stopIndex = code.indexOf("if stop_after_commit {")
  const adapterIndex = code.indexOf("supervisor.dispatch(")
  if (stopIndex < 0 || commitIndex < stopIndex || adapterIndex < commitIndex) {
    throw new Error("S142 the kernel host no longer stops between the committed dispatch and the adapter")
  }
}

/**
 * The gate that drives the worker may spawn it, and only it.
 *
 * A test that proves a binary refuses malformed input has to run the binary.
 * What it may not do is reach anything else, so the allowance names the one
 * command it is permitted to build and nothing more.
 */
function assertBoundedWorkerGateCapabilities(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:fs|net|os|ffi|arch|thread)\b|\b(?:TcpStream|UdpSocket|UnixStream|File|OpenOptions)\s*::|\bextern\s+crate\b|\b(?:global_)?asm!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error(`S117 the worker gate reached beyond the binary it drives in ${entry.path}`)
  }
  const spawns = code.match(/\bCommand::new\(/g)?.length ?? 0
  if (spawns !== 1) {
    throw new Error(`S117 the worker gate builds ${spawns} commands, and may build exactly one`)
  }
  if (!code.includes("worker_path()")) {
    throw new Error("S117 the worker gate no longer spawns the artefact this build produced")
  }
}

function assertBoundedCodegenCapabilities(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:net|os|ffi|arch|thread)\b|\bstd\s*::\s*process\s*::\s*Command\b|\b(?:ProcessCommand|Child|Stdio|TcpStream|UdpSocket|UnixStream)\s*::|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:option_)?env!\s*\(|\b(?:global_)?asm!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error(`S104 codegen contains network, subprocess or unbounded native capability in ${entry.path}`)
  }
  const expectedSites: readonly [RegExp, number, string][] = [
    [/\benv\s*::\s*args_os\s*\(/g, 1, "environment argument reader"],
    [/\bfs\s*::\s*read\s*\(/g, 2, "canonical artifact and fixture readers"],
    [/\bfs\s*::\s*write\s*\(/g, 2, "explicit artifact and fixture writers"],
    [/\bfs\s*::\s*create_dir_all\s*\(/g, 1, "explicit fixture directory writer"],
    [/\bio\s*::\s*stdout\s*\(/g, 1, "stdout writer"],
    [/\bstd\s*::\s*process\s*::\s*exit\s*\(/g, 1, "failure exit"],
  ]
  for (const [pattern, expected, name] of expectedSites) {
    const actual = code.match(pattern)?.length ?? 0
    if (actual !== expected)
      throw new Error(`S104 codegen ${name} site count drifted: expected ${expected}, saw ${actual}`)
  }
  const boundedSites = [...code.matchAll(/\b(env|fs|io)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => `${match[1]}::${match[2]}`)
    .toSorted()
  const expectedBoundedSites = [
    "env::args_os",
    "fs::create_dir_all",
    "fs::read",
    "fs::read",
    "fs::write",
    "fs::write",
    "io::stdout",
  ].toSorted()
  if (JSON.stringify(boundedSites) !== JSON.stringify(expectedBoundedSites)) {
    throw new Error(`S104 codegen bounded capability allowlist drifted: ${JSON.stringify(boundedSites)}`)
  }
  const allowedProcess = code.replace(/\bstd\s*::\s*process\s*::\s*exit\s*\(/g, "")
  if (/\b(?:std\s*::\s*)?process\s*::/.test(allowedProcess)) {
    throw new Error(`S104 codegen contains an unapproved process capability in ${entry.path}`)
  }
}

function assertBoundedIdStressCapabilities(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:net|os|ffi|arch|thread)\b|\b(?:TcpStream|UdpSocket|UnixStream)\s*::|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:option_)?env!\s*\(|\b(?:global_)?asm!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error(`S104 10M test contains network or unbounded native capability in ${entry.path}`)
  }
  if (
    /\btype\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:(?:std\s*::\s*process\s*::\s*)?Command|ProcessCommand)\b|\.\s*(?:status|output|exec)\s*\(/.test(
      code,
    )
  ) {
    throw new Error(`S104 10M test contains an unapproved process execution surface in ${entry.path}`)
  }
  const expectedSites: readonly [RegExp, number, string][] = [
    [/\benv\s*::\s*var_os\s*\(/g, 5, "bounded child environment"],
    [/\benv\s*::\s*var\s*\(/g, 1, "forced parent gate"],
    [/\benv\s*::\s*temp_dir\s*\(/g, 1, "temporary directory"],
    [/\benv\s*::\s*current_exe\s*\(/g, 1, "pinned test executable"],
    [/\b(?:ProcessCommand|Command|std\s*::\s*process\s*::\s*Command)\s*::\s*new\s*\(/g, 1, "self-spawn constructor"],
    [/\.\s*env\s*\(/g, 4, "bounded child environment setter"],
    [/\.\s*env_remove\s*\(/g, 1, "forced parent gate removal"],
    [/\.\s*spawn\s*\(/g, 1, "self-spawn"],
    [/\.\s*wait\s*\(/g, 1, "child reap"],
    [/\bfs\s*::\s*create_dir\s*\(/g, 1, "temporary directory create"],
    [/\bfs\s*::\s*canonicalize\s*\(/g, 2, "canonical child path validation"],
    [/\bfs\s*::\s*read\s*\(/g, 1, "temporary shard read"],
    [/\bfs\s*::\s*read_to_string\s*\(/g, 1, "handshake read"],
    [/\bfs\s*::\s*remove_file\s*\(/g, 2, "temporary artifact removal"],
    [/\bfs\s*::\s*remove_dir\s*\(/g, 1, "temporary directory removal"],
    [/\bFile\s*::\s*create\s*\(/g, 1, "temporary shard writer"],
    [/\bOpenOptions\s*::\s*new\s*\(/g, 1, "exclusive handshake writer"],
  ]
  for (const [pattern, expected, name] of expectedSites) {
    const actual = code.match(pattern)?.length ?? 0
    if (actual !== expected)
      throw new Error(`S104 10M test ${name} site count drifted: expected ${expected}, saw ${actual}`)
  }
}

/**
 * The reducer crate is pure by construction, not by intention.
 *
 * A clock, a file, an environment read or a thread inside `reduce` would make
 * two folds of the same events disagree, which is exactly the property S106
 * exists to guarantee. Test targets may read their own parent-gate marker and
 * measure elapsed time to report evidence; the library may not.
 */
export function assertS106ReducerPurity(sources: readonly BoundarySource[]) {
  const paths = new Set(sources.map((entry) => entry.path))
  const sourceFiles = KERNEL_CORE_SOURCE_FILES.filter((path) => paths.has(path))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(KERNEL_CORE_SOURCE_FILES)) {
    const missing = KERNEL_CORE_SOURCE_FILES.filter((path) => !paths.has(path))
    throw new Error(`S106 reducer source surface is incomplete: ${JSON.stringify(missing)}`)
  }
  const library = sources.filter(
    (entry) => entry.path.startsWith("crates/abdo-kernel/src/") && entry.path.endsWith(".rs"),
  )
  if (library.length !== 5) throw new Error("S106 reducer library surface drifted")
  for (const entry of library) {
    const code = maskRustNonCode(entry.source)
    if (
      /\bstd\s*::\s*(?:fs|net|env|os|ffi|arch|process|io|path|time|thread|sync)\b|\bInstant\b|\bSystemTime\b|\bthread_local!|\bstatic\s+mut\b|\bCell\b|\bRefCell\b|\bMutex\b|\bAtomic[A-Za-z0-9]*\b|\brand\s*::|\btokio\s*::|\bextern\s+crate\b|\b(?:option_)?env!\s*\(/i.test(
        code,
      )
    ) {
      throw new Error(`S106 reducer reached for a clock, host, task or shared-mutable capability in ${entry.path}`)
    }
    if (/\bHashMap\b|\bHashSet\b/.test(code)) {
      throw new Error(
        `S106 reducer used a hash container in ${entry.path}; iteration order would depend on process-local seeding`,
      )
    }
    if (/\bunsafe\b/.test(code.replace(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g, ""))) {
      throw new Error(`S106 reducer contains unsafe code in ${entry.path}`)
    }
    if (/\b\w*(?:model|llm|prompt|inference|cognition|reasoning|planner|agent_loop|tool_call)\w*\b/i.test(code)) {
      throw new Error(`S106 reducer contains model or cognition semantics in ${entry.path}`)
    }
  }
  const root = requiredSource(sources, "crates/abdo-kernel/src/lib.rs")
  if (!/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/.test(root)) {
    throw new Error("S106 reducer crate root must forbid unsafe code")
  }
  return { libraryFiles: library.length, hashContainers: 0, clockSites: 0 }
}

/**
 * The supervisor lives inside the trusted core and must stay there.
 *
 * It may talk to the durable ledger and to nothing else: a process, a socket or
 * an environment read inside the supervisor would be an effect that escaped the
 * very machinery built to broker effects.
 */
export function assertS107RuntimeBoundary(sources: readonly BoundarySource[]) {
  const paths = new Set(sources.map((entry) => entry.path))
  const sourceFiles = RUNTIME_SOURCE_FILES.filter((path) => paths.has(path))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(RUNTIME_SOURCE_FILES)) {
    const missing = RUNTIME_SOURCE_FILES.filter((path) => !paths.has(path))
    throw new Error(`S107 runtime source surface is incomplete: ${JSON.stringify(missing)}`)
  }
  // The binary is not the library. It is a host, so it reads a clock, opens a
  // file and parses a command line — every one of which the library below must
  // never do. Counting it as library code would either fail this check or force
  // the check to be loosened for everything, and the second is how a capability
  // gets into a supervisor.
  const library = sources.filter(
    (entry) =>
      entry.path.startsWith("crates/abdo-runtime/src/") &&
      entry.path.endsWith(".rs") &&
      entry.path !== "crates/abdo-runtime/src/host.rs",
  )
  if (library.length !== 14) throw new Error("S107 runtime library surface drifted")
  assertBoundedHostCapabilities(requiredSource(sources, "crates/abdo-runtime/src/host.rs"))
  for (const entry of library) {
    const code = maskRustNonCode(entry.source)
    if (
      /\bstd\s*::\s*(?:fs|net|env|os|ffi|arch|process|thread)\b|\bInstant\b|\bSystemTime\b|\b(?:option_)?env!\s*\(|\bextern\s+crate\b|\b(?:winapi|windows_sys|libc|nix)\s*::|\b(?:File|OpenOptions|Child|Stdio|TcpStream|UdpSocket|UnixStream)\s*::/i.test(
        code,
      )
    ) {
      throw new Error(`S107 runtime reached for a host capability in ${entry.path}`)
    }
    if (/\bunsafe\b/.test(code.replace(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g, ""))) {
      throw new Error(`S107 runtime contains unsafe code in ${entry.path}`)
    }
    if (/\b\w*(?:model|llm|prompt|inference|cognition|reasoning|planner|agent_loop)\w*\b/i.test(code)) {
      throw new Error(`S107 runtime contains model or cognition semantics in ${entry.path}`)
    }
  }

  // The barrier ordering is the sprint. Recording the dispatch after running it
  // would be indistinguishable, after a crash, from never having run it.
  const supervisor = requiredSource(sources, "crates/abdo-runtime/src/supervisor.rs")
  const commitIndex = supervisor.indexOf("pub fn commit_dispatch(")
  const invokeIndex = supervisor.indexOf("pub fn invoke<D: Dispatcher>(")
  const adapterIndex = supervisor.indexOf("dispatcher.dispatch(dispatching.intent_id")
  const recordStartedIndex = supervisor.indexOf("pub fn record_started(")
  if (
    commitIndex < 0 ||
    invokeIndex < commitIndex ||
    adapterIndex < invokeIndex ||
    recordStartedIndex < adapterIndex
  ) {
    throw new Error("S107 dispatch barrier no longer precedes the adapter call")
  }
  // The adapter call and the record that follows it must stay separate, or the
  // gap between "it ran" and "we wrote that it ran" becomes a state no test can
  // stop at while every gate still claims to cover it.
  if (supervisor.slice(invokeIndex, recordStartedIndex).includes("self.record(")) {
    throw new Error("S107 the adapter call and its record were fused back together")
  }
  if ((supervisor.match(/dispatcher\.dispatch\(/g)?.length ?? 0) !== 1) {
    throw new Error("S107 supervisor calls an adapter from more than one site")
  }
  const authority = requiredSource(sources, "crates/abdo-runtime/src/authority.rs")
  if (!authority.includes("AuthorityDecision::Denied") || authority.includes("fn authorize(&self, _request: &AuthorityRequest<'_>) -> AuthorityDecision {\n        AuthorityDecision::Granted")) {
    throw new Error("S107 shipped authority must deny by default")
  }
  const guarded = supervisor.includes('if !cfg!(feature = "effectful-dispatch") {')
  if (!guarded) throw new Error("S107 production dispatch is no longer feature-gated")

  // S108: reconciliation must be unable to dispatch, not merely instructed not
  // to. If the reconciler ever names a Dispatcher, "blind retry is zero" stops
  // being a property of the code and becomes a promise about behaviour.
  const reconcile = requiredSource(sources, "crates/abdo-runtime/src/reconcile.rs")
  if (/\bDispatcher\b|\bdispatch\s*\(/.test(maskRustNonCode(reconcile))) {
    throw new Error("S108 reconciliation gained a way to dispatch")
  }
  if (!reconcile.includes("pub fn outstanding(")) {
    throw new Error("S108 reconciliation no longer reports what is unresolved")
  }
  // Escalation is not resolution. If Escalated ever counts as resolved, an
  // unconfirmed action stops being reported and nobody is watching it.
  const phase = requiredSource(sources, "crates/abdo-runtime/src/phase.rs")
  const resolved = /pub const fn is_resolved\(self\) -> bool \{[\s\S]*?\}/.exec(phase)?.[0] ?? ""
  if (resolved.includes("Escalated") || !resolved.includes("Verified")) {
    throw new Error("S108 escalation must never count as a resolved effect")
  }
  // S109: one writer per session, and a configuration that can only move at a
  // step boundary. Both are properties of where the code is, not of what it
  // intends, so the guard checks the shape rather than the comment.
  const session = requiredSource(sources, "crates/abdo-runtime/src/session.rs")
  const writerDerives = /#\[derive\([^)]*\)\]\s*pub struct SessionWriter/.exec(session)?.[0] ?? ""
  if (/\bClone\b|\bCopy\b/.test(writerDerives)) {
    throw new Error("S109 a session writer became copyable, so two can exist")
  }
  const stepBody = /pub fn begin_step\(&mut self\)[\s\S]*?\n    \}/.exec(session)?.[0] ?? ""
  if (!stepBody.includes("self.staged.take()")) {
    throw new Error("S109 a staged configuration no longer takes effect at the step boundary")
  }
  const roundBody = /pub fn begin_round\(&mut self\)[\s\S]*?\n    \}/.exec(session)?.[0] ?? ""
  if (roundBody.includes("staged")) {
    throw new Error("S109 a retry round can now change the configuration under a live request")
  }
  const stagedSites = session.match(/self\.staged\.take\(\)/g)?.length ?? 0
  if (stagedSites !== 1) {
    throw new Error("S109 staged configuration is applied from more than one site")
  }
  // S110: a mailbox that can grow is not a bounded mailbox. The queue must be
  // a bounded container and the capacity check must precede every push, or the
  // memory bound becomes a hope.
  const control = requiredSource(sources, "crates/abdo-runtime/src/control.rs")
  if (!control.includes("if self.queue.len() >= self.capacity {")) {
    throw new Error("S110 a mailbox no longer checks its capacity before queueing")
  }
  if ((control.match(/self\.queue\.push_back\(/g)?.length ?? 0) !== 1) {
    throw new Error("S110 a mailbox gained a second way to enqueue")
  }
  // A policy interrupt must stay unsheddable: the kernel would otherwise be
  // likeliest to ignore a withdrawal of permission exactly when busiest.
  const sheddable = /fn is_sheddable\(self\) -> bool \{[\s\S]*?\n    \}/.exec(control)?.[0] ?? ""
  if (!sheddable.includes("PolicyInterrupt")) {
    throw new Error("S110 a policy interrupt became sheddable under load")
  }
  const wakes = /fn wakes\(self\) -> bool \{[\s\S]*?\n    \}/.exec(control)?.[0] ?? ""
  if (!wakes.includes("SystemInject")) {
    throw new Error("S110 waking is no longer a declared property of the channel")
  }
  // The channel itself belongs to the contract now, because it crosses the
  // boundary. The runtime must use that one definition: a second enum here
  // would be two live implementations of one concept.
  if (!control.includes("pub use abdo_contracts::InputChannel;")) {
    throw new Error("S110 the runtime declared its own input channel instead of using the contract")
  }
  const schema = requiredSource(sources, "crates/abdo-contracts/src/schema.rs")
  const declaredChannels =
    /InputChannel \{[\s\S]*?\n        \}/.exec(schema)?.[0].match(/^\s+[A-Z][A-Za-z]+ = \d+,$/gm)
      ?.length ?? 0
  if (declaredChannels !== 6) {
    throw new Error("S110 the classified input channels drifted from six")
  }
  const channels = declaredChannels
  // S111: shared reads are the only compatible overlap, and the scheduler
  // must have no clock of its own. A scheduler that read the time would order
  // work by when it happened to look, which is the opposite of deterministic.
  const schedule = requiredSource(sources, "crates/abdo-runtime/src/schedule.rs")
  const conflictRule =
    /pub const fn conflicts_with\(self, other: Self\) -> bool \{[\s\S]*?\n    \}/.exec(schedule)?.[0] ??
    ""
  if (!/!matches!\(\(self, other\), \(Self::Read, Self::Read\)\)/.test(conflictRule)) {
    throw new Error("S111 the conflict rule no longer treats shared reads as the only overlap")
  }
  if (/\bInstant\b|\bSystemTime\b|\bHashMap\b|\bHashSet\b/.test(maskRustNonCode(schedule))) {
    throw new Error("S111 the scheduler gained a clock or a hash container, so it is not deterministic")
  }
  if (!schedule.includes("self.cursor = self.cursor.wrapping_add(1);")) {
    throw new Error("S111 the fairness rotation no longer advances, so a lane can starve")
  }
  // S112: a budget that is checked after the fact is an accounting note. The
  // look-ahead must precede every charge, and no dimension may be charged while
  // a later one can still refuse.
  const budget = requiredSource(sources, "crates/abdo-runtime/src/budget.rs")
  const admit = /pub fn admit\([\s\S]*?\n    \}/.exec(budget)?.[0] ?? ""
  const fenceIndex = admit.indexOf("self.check_fence(")
  const lookAheadIndex = admit.indexOf("if line.remaining() < requested {")
  const chargeIndex = admit.indexOf("journal\n                .charge(")
  if (
    fenceIndex < 0 ||
    lookAheadIndex < fenceIndex ||
    chargeIndex < lookAheadIndex ||
    admit.indexOf("Refusal::StaleLease") >= 0
  ) {
    throw new Error("S112 a budget may be charged before fencing and the look-ahead have cleared")
  }
  if ((budget.match(/\.charge\(/g)?.length ?? 0) !== 1) {
    throw new Error("S112 a budget is charged from more than one site")
  }
  return {
    libraryFiles: library.length,
    adapterCallSites: 1,
    hostCapabilities: 0,
    reconcilerDispatchSites: 0,
    stagedConfigApplySites: stagedSites,
    mailboxEnqueueSites: 1,
    inputChannels: channels,
    schedulerClockSites: 0,
    budgetChargeSites: 1,
  }
}

/**
 * S113: one authority, and no way to be your own.
 *
 * The contract used to offer a verifier that took a closure and returned a
 * value called verified. That made every caller its own authority, which is
 * another way of saying there was none. The sprint requires it gone, so the
 * check is a search rather than a promise: if any of those names come back,
 * this fails.
 */
export function assertS113AuthorityBoundary(sources: readonly BoundarySource[]) {
  const paths = new Set(sources.map((entry) => entry.path))
  const sourceFiles = AUTHORITY_SOURCE_FILES.filter((path) => paths.has(path))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(AUTHORITY_SOURCE_FILES)) {
    const missing = AUTHORITY_SOURCE_FILES.filter((path) => !paths.has(path))
    throw new Error(`S113 authority source surface is incomplete: ${JSON.stringify(missing)}`)
  }

  const retired = [
    "IntegrityVerifiedTrustReceipt",
    "verify_integrity_with",
    "IntegrityVerificationError",
    "verifyTrustReceiptIntegrity",
    "TrustReceiptIntegrityVerifier",
    "DenyAllAuthority",
  ]
  const offenders: string[] = []
  for (const entry of sources) {
    // Strings and comments are masked first, so naming the adapter in order to
    // assert it is gone does not count as it surviving. The question is whether
    // any code still uses these, not whether any file mentions them.
    // Only source can use a name. Manifests, SQL and binary fixtures cannot,
    // and feeding a fixture to a TypeScript masker is how a guard learns to
    // fail on a file it was never meant to read.
    if (!entry.path.endsWith(".rs") && !entry.path.endsWith(".ts")) continue
    const code = entry.path.endsWith(".rs")
      ? maskRustNonCode(entry.source)
      : maskTypeScriptStringsAndComments(entry.source).code
    for (const name of retired) {
      if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${entry.path}:${name}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`S113 retired trust adapter survives: ${offenders.join(", ")}`)
  }

  // The authority reads nothing for itself. One that discovered facts could not
  // prove what it was told, and the boot and process it binds to are exactly
  // the facts an attacker would want it to discover wrongly.
  const library = sources.filter(
    (entry) => entry.path.startsWith("crates/abdo-authority/src/") && entry.path.endsWith(".rs"),
  )
  if (library.length !== 5) throw new Error("S113 authority library surface drifted")
  for (const entry of library) {
    const code = maskRustNonCode(entry.source)
    if (
      /\bstd\s*::\s*(?:fs|net|env|os|ffi|arch|process|thread|time)\b|\bInstant\b|\bSystemTime\b|\b(?:option_)?env!\s*\(|\bHashMap\b|\bHashSet\b/.test(
        code,
      )
    ) {
      throw new Error(`S113 authority reached for a host capability or a hash container in ${entry.path}`)
    }
    if (/\bunsafe\b/.test(code.replace(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g, ""))) {
      throw new Error(`S113 authority contains unsafe code in ${entry.path}`)
    }
  }

  // A PID on its own is handed out again. The digest must bind the start time
  // too, or a recycled number inherits a dead process's authority.
  const identity = requiredSource(sources, "crates/abdo-authority/src/identity.rs")
  const digestFn = /pub fn digest\(&self\) -> Digest \{[\s\S]*?\n    \}/.exec(identity)?.[0] ?? ""
  if (!digestFn.includes("self.pid") || !digestFn.includes("self.started_at_ms")) {
    throw new Error("S113 process identity no longer binds both the PID and the start time")
  }

  // The seal is checked before any field is read, because reading a field off
  // an unsealed receipt is reading whatever the presenter wanted it to say.
  const authority = requiredSource(sources, "crates/abdo-authority/src/authority.rs")
  const verify = /pub fn verify_receipt\([\s\S]*?\n    \}/.exec(authority)?.[0] ?? ""
  const sealIndex = verify.indexOf("constant_time_eq(")
  const bootIndex = verify.indexOf("receipt.boot_id")
  if (sealIndex < 0 || bootIndex < sealIndex) {
    throw new Error("S113 a receipt field is read before its seal is checked")
  }
  if (!authority.includes("fn constant_time_eq(")) {
    throw new Error("S113 seal comparison is no longer constant time")
  }
  return { libraryFiles: library.length, retiredAdapterMatches: 0 }
}

/**
 * S114: risk is assigned, silence is refusal, and there is one door.
 *
 * Three properties, each of which a plausible refactor would quietly remove.
 * The first is that an unclassified operation lands in the top band: a default
 * of harmless is how a newly added tool ships with no supervision. The second
 * is that a missing answer is a refusal rather than a pass. The third is that
 * `Prepared -> Authorized` does not exist as a transition, so a caller holding
 * a prepared token cannot reach the world without policy having spoken.
 */
export function assertS114PolicyBoundary(sources: readonly BoundarySource[]) {
  const policy = requiredSource(sources, "crates/abdo-policy/src/lib.rs")
  const policyCode = maskRustNonCode(policy)

  // Unclassified means the top band. Written as a search for the fallback,
  // because the failure mode is somebody changing the default rather than
  // deleting the function.
  const riskOf = /pub fn risk_of\([\s\S]*?\n    \}/.exec(policyCode)?.[0] ?? ""
  if (!/unwrap_or\(\s*Risk::R4\s*\)/.test(riskOf)) {
    throw new Error("S114 an unclassified operation no longer defaults to the highest risk band")
  }
  if (!/pub const fn allows_standing_approval\(self\) -> bool \{\s*!matches!\(self, Self::R4\)/.test(policyCode)) {
    throw new Error("S114 the irreversible band accepts a standing approval")
  }

  // Denial is checked before anything that could allow. Order, not presence.
  const evaluate = /pub fn evaluate\([\s\S]*?\n    \}/.exec(policyCode)?.[0] ?? ""
  const denyIndex = evaluate.indexOf("self.denied.contains(")
  const allowIndex = evaluate.indexOf("self.allowed.contains(")
  if (denyIndex < 0 || allowIndex < 0 || denyIndex > allowIndex) {
    throw new Error("S114 a denial is no longer checked before an allowance")
  }

  // The binding is recomputed from the request rather than read off the
  // approval. Trusting an approval to describe itself is how an edited payload
  // travels on somebody else's yes.
  const admit = /pub fn admit\([\s\S]*?\n    \}/.exec(policyCode)?.[0] ?? ""
  if (!admit.includes("ApprovalBinding {") || !admit.includes("if approval.binding != expected")) {
    throw new Error("S114 an approval is admitted without recomputing what it was granted for")
  }
  if (!admit.includes("self.consumed.insert(")) {
    throw new Error("S114 an approval is no longer one-shot")
  }

  // Silence refuses. Both halves: the Rust port and the engine gate.
  const gatekeeper = maskRustNonCode(requiredSource(sources, "crates/abdo-runtime/src/gatekeeper.rs"))
  if (!/let Some\(approval\) = answer else \{/.test(gatekeeper)) {
    throw new Error("S114 a missing answer no longer takes the refusal path")
  }
  if (!/impl ApprovalPort for NoOperator \{[\s\S]*?None\s*\n    \}/.test(gatekeeper)) {
    throw new Error("S114 the unattended port no longer answers nothing")
  }
  const approvalGate = maskTypeScriptStringsAndComments(requiredSource(sources, "src/approval.ts")).code
  for (const required of [
    "if (this.#handler === undefined) return this.#refuse(",
    "if (answer === undefined) return this.#refuse(",
    "} catch {",
  ]) {
    if (!approvalGate.includes(required)) {
      throw new Error("S114 the engine approval gate no longer denies when nobody answers")
    }
  }

  // One door into authorisation. `Prepared -> Authorized` must be absent, and
  // `Cleared -> Authorized` must be the only edge that reaches it.
  const phase = maskRustNonCode(requiredSource(sources, "crates/abdo-runtime/src/phase.rs"))
  const mayPrecede = /pub const fn may_precede\(self, next: Self\) -> bool \{[\s\S]*?\n    \}/.exec(phase)?.[0] ?? ""
  if (mayPrecede === "") throw new Error("S114 the phase transition table is unreadable")
  const intoAuthorized = [...mayPrecede.matchAll(/\(\s*Self::(\w+)\s*,\s*Self::Authorized\s*\)/g)].map(
    (entry) => entry[1],
  )
  if (JSON.stringify(intoAuthorized) !== JSON.stringify(["Cleared"])) {
    throw new Error(`S114 authorisation is reachable other than through a clearance: ${intoAuthorized.join(", ")}`)
  }
  // And nothing leaves a refusal.
  if (/\(\s*Self::ApprovalRefused\s*,/.test(mayPrecede)) {
    throw new Error("S114 a refused effect can still move somewhere")
  }
  return { intoAuthorized: intoAuthorized.length }
}

/**
 * S115: no boolean may claim isolation, and recovery is not optional.
 *
 * The first half is the one that matters. A field called `sandboxed`, or
 * `isolated`, or `confined`, can say only yes or no, and the true answer is
 * usually "partly, by this backend, with these gaps" — which a boolean reports
 * as a clean yes. So the guard searches for one coming back, in the contract
 * and in the broker, rather than trusting that nobody will add it.
 *
 * The second half is structural and only needs confirming: recovery lives
 * inside the effect classes that can need it, so a mutating tool without one is
 * a value that cannot be built. If a `recovery` field ever leaves
 * `MutatingEffect`, that stops being true silently, and this catches it.
 */
export function assertS115BrokerBoundary(sources: readonly BoundarySource[]) {
  const schema = maskRustNonCode(requiredSource(sources, "crates/abdo-contracts/src/schema.rs"))
  const broker = maskRustNonCode(requiredSource(sources, "crates/abdo-tools/src/broker.rs"))

  // A boolean attestation, anywhere in either file, under any of the names it
  // travels under.
  const BOOLEAN_ATTESTATION =
    /\b(?:sandboxed|isolated|confined|is_sandboxed|is_isolated|sandbox_ok|enforced)\b\s*:\s*bool\b/
  for (const [where, code] of [
    ["the contract", schema],
    ["the broker", broker],
  ] as const) {
    if (BOOLEAN_ATTESTATION.test(code)) {
      throw new Error(`S115 ${where} attests isolation with a boolean`)
    }
  }
  // And the three-way verdict is still three ways. Two would be a boolean with
  // extra steps.
  const enforcement = /Enforcement \{[\s\S]*?\n        \}/.exec(schema)?.[0] ?? ""
  const verdicts = [...enforcement.matchAll(/\b(Full|Partial|Unavailable)\b\s*=\s*\d+/g)].map(
    (entry) => entry[1],
  )
  if (JSON.stringify(verdicts) !== JSON.stringify(["Full", "Partial", "Unavailable"])) {
    throw new Error(`S115 the enforcement verdict is no longer three-way: ${verdicts.join(", ")}`)
  }

  // Recovery inside the classes that can need it, and absent from the two that
  // cannot: reading changes nothing, and irreversible work carries evidence
  // because there is nothing to compensate.
  for (const carrier of ["MutatingEffect", "ReachingEffect", "SpendingEffect"]) {
    const declared = new RegExp(`${carrier} \\{[^}]*recovery: RecoveryPlan,`).test(schema)
    if (!declared) {
      throw new Error(`S115 ${carrier} no longer carries its recovery, so one can be omitted`)
    }
  }
  if (/IrreversibleEffect \{[^}]*recovery:/.test(schema)) {
    throw new Error("S115 irreversible work claims a compensation it cannot have")
  }

  // The lease is what a worker holds. It may carry limits and a digest, and
  // nothing that would let a worker read the rules it is judged by.
  const lease = /pub struct ToolLease \{[\s\S]*?\n\}/.exec(broker)?.[0] ?? ""
  if (lease === "") throw new Error("S115 the tool lease is unreadable")
  if (/\b(?:Policy|ToolSpec|Capability|SealingKey|Approval|Authority)\b/.test(lease)) {
    throw new Error("S115 a worker lease reaches the policy, the spec or a key")
  }

  // Registration refuses a spec whose handler the host does not have, before it
  // is stored. A catalog that accepted it would serve a lookup that fails at
  // call time, when the caller has already committed.
  const register = /pub fn register\([\s\S]*?\n    \}/.exec(broker)?.[0] ?? ""
  const handlerIndex = register.indexOf("RegistrationError::NoHandler")
  const insertIndex = register.indexOf("self.tools.insert(")
  if (handlerIndex < 0 || insertIndex < 0 || handlerIndex > insertIndex) {
    throw new Error("S115 a schema with no handler can reach the catalog")
  }
  return { enforcementVerdicts: verdicts.length }
}

/**
 * S116: a snapshot is a copy, and a search has no clock.
 *
 * The property the sprint rests on is that a step's catalog cannot move under
 * it. That holds because [`CatalogSnapshot`] *owns* its entries rather than
 * borrowing them from the live catalog — so the check is that it still owns
 * them. A lifetime creeping into that struct would turn a copy back into a
 * view, and the failure would be a step that saw a tool registered after it
 * started, which is exactly the bug nobody would look for.
 *
 * The search must also be deterministic, for the same reason the reducer is: a
 * hash container or a clock makes two machines answer differently, and a step
 * recorded against a snapshot digest could then not be replayed.
 */
export function assertS116DisclosureBoundary(sources: readonly BoundarySource[]) {
  const disclosure = requiredSource(sources, "crates/abdo-tools/src/disclosure.rs")
  const code = maskRustNonCode(disclosure)

  const snapshot = /pub struct CatalogSnapshot(<[^>]*>)? \{[\s\S]*?\n\}/.exec(code)?.[0] ?? ""
  if (snapshot === "") throw new Error("S116 the catalog snapshot is unreadable")
  if (/&\s*'|<\s*'/.test(snapshot)) {
    throw new Error("S116 the snapshot borrows from the catalog, so a step can be moved under")
  }
  if (!/entries:\s*BTreeMap</.test(snapshot)) {
    throw new Error("S116 the snapshot no longer owns an ordered copy of its entries")
  }

  // Deterministic: no clock, no hash container, in the whole module.
  if (/\bHashMap\b|\bHashSet\b|\bInstant\b|\bSystemTime\b/.test(code)) {
    throw new Error("S116 disclosure reached for a clock or a hash container")
  }
  // And ties broken by identifier rather than left to the sort, or two machines
  // disagree whenever two tools are equally close.
  const search = /pub fn capability_search\([\s\S]*?\n    \}/.exec(code)?.[0] ?? ""
  if (!search.includes("ranked.sort_unstable()")) {
    throw new Error("S116 the search no longer orders its candidates")
  }
  if (!search.includes("query.limit")) {
    throw new Error("S116 the search no longer respects a disclosure budget")
  }

  // A brief is a summary. One that grew the schema digests would be a full
  // disclosure arriving one field at a time.
  const brief = /pub struct Brief \{[\s\S]*?\n\}/.exec(code)?.[0] ?? ""
  if (brief === "") throw new Error("S116 the brief is unreadable")
  for (const forbidden of ["input_schema_digest", "output_schema_digest", "resources", "effect:"]) {
    if (brief.includes(forbidden)) {
      throw new Error(`S116 a brief carries ${forbidden}, which belongs to the full schema`)
    }
  }

  // No second token estimator. The divisor lives in one file in this product
  // and this module measures characters precisely so it does not need one.
  if (/\/\s*3\b|\/\s*4\b|CHARS_PER_TOKEN|estimateTokens/.test(code)) {
    throw new Error("S116 disclosure grew its own token estimate")
  }

  const step = maskTypeScriptStringsAndComments(requiredSource(sources, "src/catalog.ts")).code
  if (!step.includes("if (!sameSnapshot(disclosure.snapshot, this.#snapshot))")) {
    throw new Error("S116 the engine step merges disclosures from other snapshots")
  }
  if (!step.includes("> this.#budget")) {
    throw new Error("S116 the engine step no longer refuses past its budget")
  }
  return { snapshotOwnsEntries: true }
}

/**
 * S117: the worker is bounded and can only admit compiled handlers through the
 * canonical tool catalog. Its exact dependency graph is pinned by Cargo
 * identity above; this check pins the source boundary and fail-closed behavior.
 */
export function assertS117WorkerBoundary(sources: readonly BoundarySource[]) {
  const worker = requiredSource(sources, "bins/abdo-tool-worker/src/main.rs")
  const code = maskRustNonCode(worker)

  for (const forbidden of ["abdo_authority", "abdo_journal", "abdo_kernel"]) {
    if (new RegExp(`\\b${forbidden}\\b`).test(code)) {
      throw new Error(`S117 the tool worker reached for ${forbidden}`)
    }
  }
  // It performs no effect. Dispatch stays behind a feature that is off, and a
  // worker that ran things before that gate opened would be the escape hatch
  // the gate exists to close.
  if (/\bCommand::new\b|\bstd\s*::\s*(?:fs|net)\b/.test(code)) {
    throw new Error("S117 the tool worker performs an effect outside the broker")
  }
  // Bounded before the read, not after: an unbounded read from a pipe is a
  // memory budget somebody else controls.
  if (!code.includes(".take(MAX_FRAME_BYTES as u64 + 1)")) {
    throw new Error("S117 the tool worker reads a frame without a bound")
  }
  const broker = maskRustNonCode(requiredSource(sources, "crates/abdo-tools/src/broker.rs"))
  if (!code.includes("CompiledBoundary::new(") || !broker.includes("Enforcement::Partial")) {
    throw new Error("S117 the tool worker no longer attests its measured application boundary")
  }
  for (const required of ["adapter_kind(&spec)", "ToolCatalog::new()", ".register(spec, &sandbox)", "handler is not compiled into this worker"]) {
    if (!worker.includes(required)) throw new Error("S117 the worker bypasses canonical tool admission")
  }

  // And the inventory itself: one owned TypeScript surface plus explicit broker
  // roots. Both directions are checked so neither an unlisted shipped tool nor
  // a stale manifest entry can pass.
  const inventory = requiredSource(sources, "inventory/tool-surface.json")
  if (!inventory.includes('"rust-tool-broker"') || !inventory.includes('"owned-registry"')) {
    throw new Error("S117 the inventory no longer names the canonical tool owners")
  }
  const checker = maskTypeScriptStringsAndComments(requiredSource(sources, "scripts/inventory.ts")).code
  if (!checker.includes("declaredIds(declaring).has(entry.id)")) {
    throw new Error("S117 the inventory no longer verifies that a file declares what it claims")
  }
  if (!checker.includes("listedIds.size !== shippedIds.size")) {
    throw new Error("S117 the inventory no longer fails when a shipped tool is missing from it")
  }
  return { workerDependencies: 3 }
}

/**
 * S118: the kernel has no field a secret could sit in.
 *
 * Redaction is what you need when the value is present and you are hoping to
 * catch it on the way out. This checks the other thing: that it was never
 * present. A `SecretLease` carries a handle, a consumer, a scope, an expiry and
 * a generation, and the guard fails if a field appears that could hold material
 * — because the moment one does, every absence the canary sweep reports becomes
 * a statement about that particular run rather than about the design.
 */
export function assertS118SecretBoundary(sources: readonly BoundarySource[]) {
  const vault = requiredSource(sources, "crates/abdo-runtime/src/vault.rs")
  const code = maskRustNonCode(vault)

  const lease = /pub struct SecretLease \{[\s\S]*?\n\}/.exec(code)?.[0] ?? ""
  if (lease === "") throw new Error("S118 the secret lease is unreadable")
  // Anything that could carry bytes. A digest is fine — it is a name, not a
  // value — but a string, a byte vector or anything called material is not.
  if (/\bString\b|\bVec\s*<\s*u8|&\s*str\b|&\s*\[\s*u8|\b(?:secret|material|value|plaintext|token)\b/i.test(
    lease,
  )) {
    throw new Error("S118 the secret lease grew a field that could hold material")
  }
  // The same for what a caller hands in. A parameter is a door.
  const issue = /pub fn issue\([\s\S]*?\n    \) -> Result<SecretLease, LeaseRefusal> \{/.exec(code)?.[0] ?? ""
  if (issue === "") throw new Error("S118 the issue signature is unreadable")
  // No leading \b: a word boundary cannot sit before `&`, so wrapping the
  // whole alternation in one made the byte-slice and &str arms unreachable —
  // a mutation adding `material: &[u8]` walked straight through the check
  // that exists to stop exactly that.
  if (/\bString\b|\bVec\s*<\s*u8|&\s*str\b|&\s*\[\s*u8/.test(issue)) {
    throw new Error("S118 a secret can be handed to the vault, which is the one thing it must not accept")
  }

  // Consumer and scope are re-supplied at use and compared. A lease that
  // vouched for its own holder would be a bearer token.
  const admit = /pub fn admit\([\s\S]*?\n    \}/.exec(code)?.[0] ?? ""
  for (const required of [
    "lease.consumer_digest != presentation.consumer_digest",
    "&lease.scope != presentation.scope",
    "lease.generation != self.generation",
  ]) {
    if (!admit.includes(required)) {
      throw new Error("S118 a lease is admitted without checking who, where or when")
    }
  }
  // Revocation is one increment, not a walk. A walk has a halfway point.
  const revoke = /pub fn revoke_all\(&mut self\) -> u64 \{[\s\S]*?\n    \}/.exec(code)?.[0] ?? ""
  if (!revoke.includes("self.generation += 1") || /\bfor\b|\bretain\b|\bclear\(\)/.test(revoke)) {
    throw new Error("S118 revocation walks a list instead of moving one number")
  }
  // And the handle does not print itself into every line that formats a lease.
  // Checked against the raw source, not the masked code: the mask replaces
  // string literals, and this is a claim about which literal is written.
  if (!vault.includes('formatter.write_str("SecretHandle(…)")')) {
    throw new Error("S118 the secret handle displays its own bytes")
  }
  return { leaseMaterialFields: 0 }
}

/**
 * S119: three counters, and no driver.
 *
 * The sprint says the contract only — no CDP, no UIA, no vision — and that is
 * the easier half to keep by accident and the harder one to notice losing. So
 * the guard searches for a driver appearing, in the contract and in the
 * registry, rather than trusting that nobody will add one.
 *
 * The other half is that the three generations stay three. Folding them into
 * one counter would still compile, still pass a gate that only counted
 * refusals, and would silently stop distinguishing a replaced document from a
 * scrolled one — which are different enough that a caller told the wrong one
 * retries into the wrong world.
 */
export function assertS119SurfaceBoundary(sources: readonly BoundarySource[]) {
  const schema = maskRustNonCode(requiredSource(sources, "crates/abdo-contracts/src/schema.rs"))
  const registry = maskRustNonCode(requiredSource(sources, "crates/abdo-runtime/src/surface.rs"))

  const DRIVER = /\b(?:cdp|chrome_devtools|devtools_protocol|uia|automation_element|screenshot|ocr|vision|pixel|websocket)\b/i
  for (const [where, code] of [
    ["the surface contract", schema],
    ["the surface registry", registry],
  ] as const) {
    if (DRIVER.test(code)) {
      throw new Error(`S119 ${where} contains a driver, which this sprint excludes`)
    }
  }

  // Three generations, named, all required non-zero. A zero would read as
  // "unknown" to one reader and "first" to another.
  const declared = /SurfaceGenerations \{[\s\S]*?\n        \}/.exec(schema)?.[0] ?? ""
  const fields = [...declared.matchAll(/^\s+(navigation|window|view): u64,$/gm)].map(
    (entry) => entry[1],
  )
  if (JSON.stringify(fields) !== JSON.stringify(["navigation", "window", "view"])) {
    throw new Error(`S119 the surface generations are no longer three: ${fields.join(", ")}`)
  }

  // And all three are compared. A comparison that dropped one would refuse
  // fewer stale actions while the gate's zero stayed zero.
  const admit = /pub fn admit\([\s\S]*?\n    \}/.exec(registry)?.[0] ?? ""
  for (const [field, refusal] of [
    ["navigation", "Navigated"],
    ["window", "Reframed"],
    ["view", "Scrolled"],
  ] as const) {
    if (!admit.includes(`seen.${field} != current.${field}`) || !admit.includes(`Staleness::${refusal}`)) {
      throw new Error(`S119 the ${field} generation is no longer compared`)
    }
  }
  // The action carries what the caller believed. A registry that read the
  // current generations to build the comparison would compare them with
  // themselves and admit everything.
  if (!admit.includes("let seen = &action.generations;")) {
    throw new Error("S119 staleness is decided from the registry rather than from what the caller saw")
  }
  return { surfaceGenerations: fields.length }
}

export function assertS105CargoIdentity(sources: readonly BoundarySource[]): S105CargoIdentity {
  sources = sources.filter((entry) => !entry.source.startsWith("//! BLUEPRINT_FACADE_V1") && !entry.path.endsWith("/src/blueprint_facades.rs"))
  const workspace = parseTomlRecord(requiredSource(sources, "Cargo.toml"), "Cargo workspace manifest")
  assertExactSemantic(
    workspace,
    {
      workspace: {
        members: [
          "crates/abdo-contracts",
          "crates/abdo-journal",
          "crates/abdo-kernel",
          "crates/abdo-authority",
          "crates/abdo-policy",
          "crates/abdo-evidence",
          "crates/abdo-tools",
          "crates/abdo-runtime",
          "bins/abdo-kernel",
          "bins/abdo-tool-worker",
        ],
        resolver: "2",
        package: { version: "0.1.0", edition: "2021", publish: false },
      },
      profile: {
        release: {
          panic: "abort",
          "opt-level": 3,
          lto: "thin",
          strip: true,
          incremental: false,
          "codegen-units": 1,
        },
      },
    },
    "S105 virtual Cargo workspace identity drifted",
  )

  const contracts = parseTomlRecord(
    requiredSource(sources, "crates/abdo-contracts/Cargo.toml"),
    "contracts manifest",
  )
  assertExactSemantic(
    contracts,
    {
      package: {
        name: "abdo-contracts",
        version: { workspace: true },
        edition: { workspace: true },
        publish: { workspace: true },
        description: "Dependency-free wire contracts for the Abdo Code trusted kernel boundary",
      },
      lib: { path: "src/lib.rs" },
      bin: [{ name: "abdo-contracts-codegen", path: "src/bin/abdo-contracts-codegen.rs" }],
      dependencies: {},
    },
    "S104 contracts Cargo manifest identity drifted",
  )

  const journal = parseTomlRecord(
    requiredSource(sources, "crates/abdo-journal/Cargo.toml"),
    "journal manifest",
  )
  assertExactSemantic(
    journal,
    {
      package: {
        name: "abdo-journal",
        version: { workspace: true },
        edition: { workspace: true },
        publish: { workspace: true },
        description: "Single-writer semantic SQLite journal for the Abdo Code trusted kernel",
      },
      features: { default: [], "test-hooks": [] },
      dependencies: {
        "abdo-contracts": { path: "../abdo-contracts" },
        rusqlite: { version: "=0.40.2", "default-features": false, features: ["bundled", "hooks"] },
        sha2: { version: "=0.11.0", "default-features": false },
      },
      lib: { path: "src/lib.rs" },
      bin: [
        {
          name: "abdo-journal-test-child",
          path: "src/bin/abdo-journal-test-child.rs",
          "required-features": ["test-hooks"],
          test: false,
          bench: false,
        },
      ],
    },
    "S105 journal dependency, feature or target identity drifted",
  )

  const kernelCore = parseTomlRecord(
    requiredSource(sources, "crates/abdo-kernel/Cargo.toml"),
    "kernel core manifest",
  )
  assertExactSemantic(
    kernelCore,
    {
      package: {
        name: "abdo-kernel",
        version: { workspace: true },
        edition: { workspace: true },
        publish: { workspace: true },
        description: "Pure deterministic reducer for the Abdo Code trusted kernel",
      },
      dependencies: {
        "abdo-contracts": { path: "../abdo-contracts" },
        sha2: { version: "=0.11.0", "default-features": false },
      },
      lib: { path: "src/lib.rs" },
    },
    "S106 reducer dependency or target identity drifted",
  )

  const runtime = parseTomlRecord(
    requiredSource(sources, "crates/abdo-runtime/Cargo.toml"),
    "runtime manifest",
  )
  assertExactSemantic(
    runtime,
    {
      package: {
        name: "abdo-runtime",
        version: { workspace: true },
        edition: { workspace: true },
        publish: { workspace: true },
        description: "Trusted effect supervisor for the Abdo Code kernel",
      },
      features: {
        default: [],
        "effectful-dispatch": [],
        "test-hooks": ["abdo-journal/test-hooks"],
      },
      dependencies: {
        "abdo-authority": { path: "../abdo-authority" },
        "abdo-contracts": { path: "../abdo-contracts" },
        "abdo-journal": { path: "../abdo-journal" },
        "abdo-kernel": { path: "../abdo-kernel" },
        "abdo-policy": { path: "../abdo-policy" },
        "abdo-evidence": { path: "../abdo-evidence" },
        "abdo-tools": { path: "../abdo-tools" },
        sha2: { version: "=0.11.0", "default-features": false },
      },
      lib: { path: "src/lib.rs" },
    },
    "S107 runtime dependency, feature or target identity drifted",
  )

  const authorityManifest = parseTomlRecord(
    requiredSource(sources, "crates/abdo-authority/Cargo.toml"),
    "authority manifest",
  )
  assertExactSemantic(
    authorityManifest,
    {
      package: {
        name: "abdo-authority",
        version: { workspace: true },
        edition: { workspace: true },
        publish: { workspace: true },
        description: "Capability, trust and process identity authority for the Abdo Code kernel",
      },
      dependencies: {
        "abdo-contracts": { path: "../abdo-contracts" },
        hmac: { version: "=0.13.0", "default-features": false },
        sha2: { version: "=0.11.0", "default-features": false },
      },
      lib: { path: "src/lib.rs" },
    },
    "S113 authority dependency or target identity drifted",
  )

  const policyManifest = parseTomlRecord(requiredSource(sources, "crates/abdo-policy/Cargo.toml"), "policy manifest")
  assertExactSemantic(policyManifest, {
    package: {
      name: "abdo-policy",
      version: { workspace: true },
      edition: { workspace: true },
      publish: { workspace: true },
      description: "Fail-closed risk policy and approval binding for the Abdo Code kernel",
    },
    dependencies: {
      "abdo-authority": { path: "../abdo-authority" },
      "abdo-contracts": { path: "../abdo-contracts" },
      sha2: { version: "=0.11.0", "default-features": false },
    },
    lib: { path: "src/lib.rs" },
  }, "policy dependency or target identity drifted")

  const evidenceManifest = parseTomlRecord(requiredSource(sources, "crates/abdo-evidence/Cargo.toml"), "evidence manifest")
  assertExactSemantic(evidenceManifest, {
    package: {
      name: "abdo-evidence",
      version: { workspace: true },
      edition: { workspace: true },
      publish: { workspace: true },
      description: "Tamper-evident execution receipts for the Abdo Code kernel",
    },
    dependencies: {
      "abdo-contracts": { path: "../abdo-contracts" },
      sha2: { version: "=0.11.0", "default-features": false },
    },
    lib: { path: "src/lib.rs" },
  }, "evidence dependency or target identity drifted")

  const toolsManifest = parseTomlRecord(requiredSource(sources, "crates/abdo-tools/Cargo.toml"), "tools manifest")
  assertExactSemantic(toolsManifest, {
    package: {
      name: "abdo-tools",
      version: { workspace: true },
      edition: { workspace: true },
      publish: { workspace: true },
      description: "Canonical tool catalog, disclosure and enforcement broker for Abdo Code",
    },
    dependencies: {
      "abdo-authority": { path: "../abdo-authority" },
      "abdo-contracts": { path: "../abdo-contracts" },
      "abdo-evidence": { path: "../abdo-evidence" },
      "abdo-policy": { path: "../abdo-policy" },
      sha2: { version: "=0.11.0", "default-features": false },
    },
    lib: { path: "src/lib.rs" },
  }, "tools dependency or target identity drifted")

  const kernelBinManifest = parseTomlRecord(requiredSource(sources, "bins/abdo-kernel/Cargo.toml"), "kernel binary manifest")
  assertExactSemantic(kernelBinManifest, {
    package: {
      name: "abdo-kernel-bin",
      version: { workspace: true },
      edition: { workspace: true },
      publish: { workspace: true },
      description: "Abdo Code kernel process",
    },
    features: { default: [], "effectful-dispatch": ["abdo-runtime/effectful-dispatch"] },
    dependencies: { "abdo-runtime": { path: "../../crates/abdo-runtime" } },
    bin: [{ name: "abdo-kernel", path: "src/main.rs", test: false, bench: false }],
  }, "kernel binary dependency or target identity drifted")

  const workerManifest = parseTomlRecord(requiredSource(sources, "bins/abdo-tool-worker/Cargo.toml"), "tool worker manifest")
  assertExactSemantic(workerManifest, {
    package: {
      name: "abdo-tool-worker",
      version: { workspace: true },
      edition: { workspace: true },
      publish: { workspace: true },
      description: "Bounded tool admission worker for the Abdo Code Rust runtime",
    },
    dependencies: {
      "abdo-contracts": { path: "../../crates/abdo-contracts" },
      "abdo-runtime": { path: "../../crates/abdo-runtime" },
      "abdo-tools": { path: "../../crates/abdo-tools" },
    },
    bin: [{ name: "abdo-tool-worker", path: "src/main.rs", test: false, bench: false }],
  }, "tool worker dependency or target identity drifted")
  if ((runtime as { features?: { default?: unknown[] } }).features?.default?.length !== 0) {
    throw new Error("S107 effectful dispatch must stay out of the default feature set")
  }

  const lock = validateCargoLock(requiredSource(sources, "Cargo.lock"))
  return {
    workspaceMembers: [
      "crates/abdo-contracts",
      "crates/abdo-journal",
      "crates/abdo-kernel",
      "crates/abdo-authority",
      "crates/abdo-policy",
      "crates/abdo-evidence",
      "crates/abdo-tools",
      "crates/abdo-runtime",
      "bins/abdo-kernel",
      "bins/abdo-tool-worker",
    ],
    journalDependencies: ["abdo-contracts", "rusqlite", "sha2"],
    kernelCoreDependencies: ["abdo-contracts", "sha2"],
    runtimeDependencies: ["abdo-authority", "abdo-contracts", "abdo-evidence", "abdo-journal", "abdo-kernel", "abdo-policy", "abdo-tools"],
    lockedPackages: lock.lockedPackages,
    registryPackages: lock.registryPackages,
    sqlite: { rusqlite: "0.40.2", libsqlite3Sys: "0.38.2", bundled: true },
  }
}

export function validateCargoLock(source: string) {
  const lock = parseTomlRecord(source, "Cargo.lock")
  const keys = Object.keys(lock).toSorted()
  if (JSON.stringify(keys) !== JSON.stringify(["package", "version"])) {
    throw new Error(`S105 Cargo.lock top-level identity drifted: ${JSON.stringify(keys)}`)
  }
  if (lock.version !== 4) throw new Error("S105 Cargo.lock format version drifted")
  const packages = requireArray(lock.package, "Cargo.lock packages").map((value) => {
    const packageValue = requireRecord(value, "Cargo.lock package")
    const name = requireString(packageValue.name, "Cargo.lock package name")
    const version = requireString(packageValue.version, `Cargo.lock ${name} version`)
    const sourceValue = packageValue.source
    const checksumValue = packageValue.checksum
    const dependenciesValue = packageValue.dependencies
    const identity = {
      name,
      version,
      source: sourceValue === undefined ? null : requireString(sourceValue, `Cargo.lock ${name} source`),
      checksum: checksumValue === undefined ? null : requireString(checksumValue, `Cargo.lock ${name} checksum`),
      dependencies:
        dependenciesValue === undefined
          ? []
          : requireStringArray(dependenciesValue, `Cargo.lock ${name} dependencies`).toSorted(),
    }
    const expectedKeys = ["name", "version"]
    if (sourceValue !== undefined) expectedKeys.push("source")
    if (checksumValue !== undefined) expectedKeys.push("checksum")
    if (dependenciesValue !== undefined) expectedKeys.push("dependencies")
    if (JSON.stringify(Object.keys(packageValue).toSorted()) !== JSON.stringify(expectedKeys.toSorted())) {
      throw new Error(`S105 Cargo.lock ${name} fields drifted`)
    }
    return identity
  })
  const sorted = packages.toSorted((left, right) => compareText(left.name, right.name))
  if (new Set(sorted.map((item) => item.name)).size !== sorted.length) {
    throw new Error("S105 Cargo.lock contains duplicate package names or versions")
  }
  if (JSON.stringify(sorted) !== JSON.stringify(S105_LOCKED_PACKAGES)) {
    throw new Error("S105 Cargo.lock package versions, sources, checksums or dependency edges drifted")
  }
  const registryPackages = sorted.filter((item) => item.source === CARGO_REGISTRY_SOURCE)
  if (registryPackages.length !== 23 || registryPackages.some((item) => item.checksum === null)) {
    throw new Error("S105 Cargo registry closure or checksum coverage drifted")
  }
  if (sorted.some((item) => item.source !== null && item.source !== CARGO_REGISTRY_SOURCE)) {
    throw new Error("S105 Cargo.lock contains a non-registry external source")
  }
  return { lockedPackages: sorted.length, registryPackages: registryPackages.length, packages: sorted }
}

export function assertS105JournalCapabilities(
  sources: readonly BoundarySource[],
): S105JournalBoundaryIdentity {
  sources = sources.filter((entry) => !entry.source.startsWith("//! BLUEPRINT_FACADE_V1") && !entry.path.endsWith("/src/blueprint_facades.rs"))
  const sourcePaths = new Set(sources.map((entry) => entry.path))
  const sourceFiles = JOURNAL_SOURCE_FILES.filter((path) => sourcePaths.has(path))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(JOURNAL_SOURCE_FILES)) {
    throw new Error("S105 journal source surface is incomplete")
  }
  const rustSources = sources
    .filter((entry) => entry.path.startsWith("crates/abdo-journal/") && entry.path.endsWith(".rs"))
    .toSorted((left, right) => compareText(left.path, right.path))
  const rustFiles = rustSources.map((entry) => entry.path)
  if (JSON.stringify(rustFiles) !== JSON.stringify(JOURNAL_RUST_FILES)) {
    throw new Error(`S105 journal Rust source allowlist drifted: ${JSON.stringify(rustFiles)}`)
  }
  const sqlSources = sources.filter(
    (entry) => entry.path.startsWith("migrations/") && entry.path.endsWith(".sql"),
  )
  // One store, an ordered ledger of migrations. The check is that the set is
  // exactly the declared one, not that there is only ever one file: a schema
  // that can never be extended is a schema that gets extended somewhere else,
  // which is how a second store appears.
  const expectedSql = [
    "migrations/0001_initial.sql",
    "migrations/0002_effects.sql",
    "migrations/0003_leases_budgets.sql",
    "migrations/0004_compactions.sql",
  ]
  if (JSON.stringify(sqlSources.map((entry) => entry.path).toSorted()) !== JSON.stringify(expectedSql)) {
    throw new Error("S105 journal must own exactly its declared canonical SQLite migrations")
  }

  for (const entry of rustSources) {
    const forbidDirectives = entry.source.match(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g) ?? []
    const isCrateRoot =
      entry.path === "crates/abdo-journal/src/lib.rs" ||
      entry.path === "crates/abdo-journal/src/bin/abdo-journal-test-child.rs" ||
      (/\/tests\/[^/]+\.rs$/.test(entry.path) && entry.path !== "crates/abdo-journal/tests/support/mod.rs")
    if (forbidDirectives.length !== (isCrateRoot ? 1 : 0)) {
      throw new Error(`S105 journal crate-root forbid(unsafe_code) identity drifted in ${entry.path}`)
    }
    const code = maskRustNonCode(entry.source)
    const withoutForbid = code.replace(/#!\s*\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]/g, "")
    if (/\bunsafe\b/.test(withoutForbid)) throw new Error(`S105 journal contains unsafe code in ${entry.path}`)
    if (
      /\b\w*(?:llm|prompt|inference|cognition|reasoning|planner|agent_loop|tool_call|language_model|model_provider|model_client|model_request|model_response)\w*\b/i.test(
        code,
      )
    ) {
      throw new Error(`S105 journal contains model or cognition semantics in ${entry.path}`)
    }
    if (
      /\bstd\s*::\s*(?:net|arch)\b|\buse\s+(?:::)?\s*std\s*::\s*\{[^}]*\b(?:net|arch)\b|\b(?:TcpStream|UdpSocket|UnixStream)\s*::|\bextern\s+crate\b|#\s*\[\s*(?:link|link_name)\b|\b(?:global_)?asm!\s*\(/i.test(
        code,
      )
    ) {
      throw new Error(`S105 journal contains a network or unbounded native capability in ${entry.path}`)
    }
    if (isS105ProductionRuntimePath(entry.path)) {
      assertNoJournalRuntimeEnvironmentOrProcess(entry, code)
      assertNoJournalRuntimeNamespaceEscape(entry, code)
      if (/\bmacro_rules\s*!|\b(?:concat|stringify)\s*!\s*\(/.test(code)) {
        throw new Error(`S105 journal runtime contains macro indirection in ${entry.path}`)
      }
    } else if (entry.path === "crates/abdo-journal/src/bin/abdo-journal-test-child.rs") {
      assertBoundedS105TestChild(entry, code)
    } else if (entry.path === "crates/abdo-journal/src/test_support.rs") {
      assertBoundedS105TestSupport(entry, code)
    }
    if (/\binclude(?:_bytes)?\s*!\s*\(|#\s*\[\s*path\s*=/.test(code)) {
      throw new Error(`S105 journal source inclusion escapes the canonical migration in ${entry.path}`)
    }
    const includes = extractRustIncludeCalls(entry.source)
    const expectedIncludes = entry.path.endsWith("/src/migration.rs")
      ? [
          { macro: "include_str", path: "../../../migrations/0001_initial.sql" },
          { macro: "include_str", path: "../../../migrations/0002_effects.sql" },
          { macro: "include_str", path: "../../../migrations/0003_leases_budgets.sql" },
          { macro: "include_str", path: "../../../migrations/0004_compactions.sql" },
        ]
      : []
    if (JSON.stringify(includes) !== JSON.stringify(expectedIncludes)) {
      throw new Error(`S105 journal source inclusion surface drifted in ${entry.path}`)
    }
  }

  // Read every migration, not the first. A second-database escape hidden in
  // a later file would otherwise never be looked at.
  const migration = sqlSources
    .toSorted((left, right) => compareText(left.path, right.path))
    .map((entry) => entry.source)
    .join("\n")
  if (/\b(?:ATTACH|DETACH)\b|\bVACUUM\s+INTO\b/i.test(migration)) {
    throw new Error("S105 journal migration attempts to open a second database")
  }
  const sqliteTables = [...migration.matchAll(/\bCREATE\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]!.toLowerCase())
    .toSorted()
  if (JSON.stringify(sqliteTables) !== JSON.stringify(S105_JOURNAL_TABLES)) {
    throw new Error(`S105 journal SQLite table identity drifted: ${JSON.stringify(sqliteTables)}`)
  }
  const compactMigration = migration.replaceAll(/\s+/g, " ")
  for (const required of [
    "UNIQUE (stream_id, stream_sequence, global_sequence, event_hash)",
    "FOREIGN KEY (stream_id, stream_sequence, global_sequence, event_hash) REFERENCES journal_events(stream_id, stream_sequence, global_sequence, event_hash)",
    "CREATE TABLE journal_blobs",
    "sqlite_version TEXT NOT NULL",
    "sqlite_source_id TEXT NOT NULL",
    "database_path_hash BLOB NOT NULL CHECK (length(database_path_hash) = 32)",
    "size INTEGER NOT NULL CHECK (size >= 0 AND size <= 16777216 AND size = length(bytes))",
    "OR NEW.database_path_hash != OLD.database_path_hash",
  ]) {
    if (!compactMigration.includes(required)) throw new Error("S105 journal 4-tuple head FK or canonical schema drifted")
  }
  assertS105SchemaManifestIdentity(sources)
  const journalRuntime = requiredSource(sources, "crates/abdo-journal/src/journal.rs").replaceAll(/\s+/g, " ")
  for (const required of ['.pragma_update(None, "temp_store", "MEMORY")', '("temp_store", 2_i64)']) {
    if (!journalRuntime.includes(required)) throw new Error("S105 journal temp_store=2 runtime identity drifted")
  }
  const recoveryEvidence = [
    {
      path: "crates/abdo-journal/tests/migration_atomicity.rs",
      marker: "S105_MIGRATION_ATOMICITY points={} elapsed_ms={}",
      cleanup: "directory.remove();",
    },
    {
      path: "crates/abdo-journal/tests/restore_100k.rs",
      marker:
        "S105_RESTORE_100K events={EVENT_COUNT} snapshot={SNAPSHOT_SEQUENCE} tail={TAIL_COUNT} fixture_ms={} open_ms={} restore_ms={} fold_ms={} total_ms={}",
      cleanup: "directory.remove();",
    },
    {
      path: "crates/abdo-journal/tests/recovery_10k.rs",
      marker:
        "S105_RECOVERY_10K injections={INJECTION_COUNT} lanes={LANE_COUNT} phase_counts={phase_counts:?} elapsed_ms={}",
      cleanup: "directory.remove();",
    },
  ] as const
  for (const evidence of recoveryEvidence) {
    const source = requiredSource(sources, evidence.path)
    const markerIndex = source.indexOf(evidence.marker)
    const cleanupIndex = source.lastIndexOf(evidence.cleanup, markerIndex)
    if (markerIndex < 0 || cleanupIndex < 0 || cleanupIndex >= markerIndex) {
      throw new Error(`S105 recovery success evidence must follow cleanup in ${evidence.path}`)
    }
  }
  assertS105RecoveryGateContracts(sources)
  for (const entry of rustSources) {
    let capabilitySource = isS105ProductionRuntimePath(entry.path)
      ? stripRustCfgTestModules(entry.source)
      : entry.source
    if (entry.path === "crates/abdo-journal/tests/journal.rs") {
      capabilitySource = stripExactS105AuthorizationProbe(capabilitySource)
    }
    const decodedLiterals = extractDecodedRustStringLiterals(capabilitySource).join("\n")
    if (
      /(?:^|\n)\s*(?:ATTACH|DETACH)\s+(?:DATABASE\s+)?|(?:^|\n)\s*VACUUM\s+INTO\b/i.test(decodedLiterals)
    ) {
      throw new Error(`S105 journal Rust source attempts to open a second database in ${entry.path}`)
    }
    if (
      /\b(?:Evidence|Receipt)(?:Store|Database|Db|Repository)\b|\b(?:evidence|receipt)_(?:store|database|db|events|receipts)\b/i.test(
        maskRustNonCode(capabilitySource),
      )
    ) {
      throw new Error(`S105 journal defines a parallel evidence store in ${entry.path}`)
    }
    if (
      entry.path !== "crates/abdo-journal/src/migration.rs" &&
      /(?:^|\n)\s*CREATE\s+TABLE\b/i.test(decodedLiterals)
    ) {
      throw new Error(`S105 journal defines SQLite schema outside the canonical migration in ${entry.path}`)
    }
  }
  const parallelPaths = sources.filter((entry) =>
    /(?:^|\/)(?:evidence-store|evidence_database|evidence_db)(?:\/|\.|$)/i.test(entry.path),
  )
  if (parallelPaths.length !== 0) {
    throw new Error(`S105 journal contains a parallel evidence-store path: ${parallelPaths[0]!.path}`)
  }

  const productionRuntime = rustSources.filter((entry) => isS105ProductionRuntimePath(entry.path))
  const connectionOpenSites = productionRuntime.flatMap((entry) => [
    ...maskRustNonCode(stripRustCfgTestModules(entry.source)).matchAll(
      /(?:<\s*)?\b(?:Connection|rusqlite\s*::\s*Connection)\b(?:\s*>)?\s*::\s*open[A-Za-z0-9_]*/g,
    ),
  ])
  if (connectionOpenSites.length !== 1) {
    throw new Error(`S105 journal runtime must have exactly one SQLite connection-open site, saw ${connectionOpenSites.length}`)
  }
  const sqliteIdentity = assertS105SqliteIdentity(sources)

  return {
    sourceFiles: JOURNAL_SOURCE_FILES,
    rustFiles,
    sqliteFiles: [
      "migrations/0001_initial.sql",
      "migrations/0002_effects.sql",
      "migrations/0003_leases_budgets.sql",
      "migrations/0004_compactions.sql",
    ],
    sqliteTables: S105_JOURNAL_TABLES,
    runtimeConnectionOpenSites: 1,
    sqliteIdentity,
    modelCognitionMatches: 0,
    networkMatches: 0,
    parallelStoreMatches: 0,
  }
}

function assertS105SqliteIdentity(sources: readonly BoundarySource[]) {
  const identity = requiredSource(sources, "crates/abdo-journal/src/identity.rs")
  const compact = identity.replaceAll(/\s+/g, " ")
  for (const required of [
    'pub const PINNED_SQLITE_VERSION: &str = "3.53.2";',
    'pub const PINNED_SQLITE_SOURCE_ID: &str = "2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24";',
    'query_row("SELECT sqlite_version()"',
    'query_row("SELECT sqlite_source_id()"',
    '.prepare("PRAGMA compile_options")',
    'if normalized_compile_options != PINNED_NORMALIZED_COMPILE_OPTIONS',
    'DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true',
    'DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false',
    'DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true',
    'DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, true',
  ]) {
    if (!compact.includes(required)) throw new Error("S105 SQLite runtime identity or hardening check drifted")
  }
  const arrays = [
    [
      "REQUIRED_COMPILE_OPTIONS",
      [
        "DEFAULT_FOREIGN_KEYS",
        "ENABLE_API_ARMOR",
        "MAX_COLUMN=2000",
        "MAX_EXPR_DEPTH=1000",
        "MAX_VARIABLE_NUMBER=32766",
        "THREADSAFE=1",
      ],
    ],
    ["FORBIDDEN_COMPILE_OPTIONS", ["OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_WAL", "THREADSAFE=0"]],
    ["PLATFORM_DIAGNOSTIC_PREFIXES", ["ATOMIC_INTRINSICS=", "COMPILER=", "MAX_MMAP_SIZE=", "MUTEX_"]],
    ["PINNED_NORMALIZED_COMPILE_OPTIONS", S105_NORMALIZED_SQLITE_OPTIONS],
  ] as const
  for (const [name, expected] of arrays) {
    const actual = extractRustStringArray(identity, name)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`S105 SQLite ${name} identity drifted`)
    }
  }

  const journalTest = requiredSource(sources, "crates/abdo-journal/tests/journal.rs").replaceAll(/\s+/g, " ")
  for (const required of [
    "assert_eq!(identity.version, PINNED_SQLITE_VERSION)",
    "assert_eq!(identity.source_id, PINNED_SQLITE_SOURCE_ID)",
    'assert_eq!(identity.journal_mode, "wal")',
    'item == "THREADSAFE=1"',
    'item == "DEFAULT_FOREIGN_KEYS"',
  ]) {
    if (!journalTest.includes(required)) throw new Error("S105 SQLite identity integration test drifted")
  }
  return {
    version: "3.53.2" as const,
    sourceId: "d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24" as const,
    normalizedCompileOptions: S105_NORMALIZED_SQLITE_OPTIONS.length,
  }
}

function assertS105RecoveryGateContracts(sources: readonly BoundarySource[]) {
  const migration = requiredSource(sources, "crates/abdo-journal/tests/migration_atomicity.rs")
  for (const required of [
    '#[ignore = "S105 atomic migration process-death gate"]',
    "fn migration_interruption_is_atomic()",
    "let crash_points = migration_crash_points();",
    "assert_migration_inventory_complete(&crash_points);",
    '"migration.before_begin"',
    '"migration.after_begin"',
    '"migration.before_record"',
    '"migration.after_record"',
    '"migration.before_commit"',
    '"migration.after_commit"',
    '.strip_prefix("migration.after_statement.1.")',
    "(1..=statement_indices.len()).collect::<Vec<_>>()",
  ]) {
    if (migration.split(required).length !== 2) {
      throw new Error("S105 migration dynamic crash-point inventory or ignore contract drifted")
    }
  }

  const restore = requiredSource(sources, "crates/abdo-journal/tests/restore_100k.rs")
  for (const required of [
    '#[ignore = "S105 100,000-event warm-filesystem-cache host benchmark; not a universal latency claim"]',
    "fn restores_hundred_thousand_events_within_two_seconds()",
    "const EVENT_COUNT: u64 = 100_000;",
    "const SNAPSHOT_SEQUENCE: u64 = 90_000;",
    "const TAIL_COUNT: usize = 10_000;",
    "const RESTORE_LIMIT: Duration = Duration::from_secs(2);",
  ]) {
    if (restore.split(required).length !== 2) {
      throw new Error("S105 restore 100k/90k/10k/2s or ignore contract drifted")
    }
  }

  const crash = requiredSource(sources, "crates/abdo-journal/tests/recovery_10k.rs")
  for (const required of [
    '#[ignore = "S105 exact 10,000 process-death/WAL recovery gate; not a power-loss claim"]',
    "fn crash_injection_ten_thousand_process_deaths()",
    "const INJECTION_COUNT: usize = 10_000;",
    "const LANE_COUNT: usize = 16;",
    "const GLOBAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);",
    "const CRASH_PHASES: [CrashPhase; 10]",
    'name: "append.before_begin"',
    'name: "append.after_begin"',
    'name: "append.after_event_insert"',
    'name: "append.after_projection"',
    'name: "append.after_snapshot"',
    'name: "append.after_head_cas"',
    'name: "append.before_commit"',
    'name: "append.after_commit_before_ack"',
    'name: "checkpoint.before"',
    'name: "checkpoint.after"',
  ]) {
    if (crash.split(required).length !== 2) {
      throw new Error("S105 crash 10k/16-lane/10-phase/30m or ignore contract drifted")
    }
  }
  const crashPhaseBody = /const CRASH_PHASES:\s*\[CrashPhase; 10\]\s*=\s*\[([\s\S]*?)\];/.exec(crash)?.[1]
  if (crashPhaseBody === undefined || (crashPhaseBody.match(/\bCrashPhase\s*\{/g)?.length ?? 0) !== 10) {
    throw new Error("S105 crash phase inventory must contain exactly ten entries")
  }
}

function assertS105SchemaManifestIdentity(sources: readonly BoundarySource[]) {
  const migrationRuntime = requiredSource(sources, "crates/abdo-journal/src/migration.rs")
  const body = /const SCHEMA_OBJECT_IDENTITIES:\s*&\[\(&str, &str, &str\)\]\s*=\s*&\[([\s\S]*?)\];/.exec(
    migrationRuntime,
  )?.[1]
  if (body === undefined) throw new Error("S105 SQLite schema-object manifest is missing")
  const identities = [...body.matchAll(/\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",?\s*\)/g)].map(
    (match) => [match[1]!, match[2]!, match[3]!] as const,
  )
  const residue = body.replace(/\(\s*"[^"]+",\s*"[^"]+",\s*"[^"]+",?\s*\)/g, "").replace(/[\s,]/g, "")
  const expectedIdentities = [
    ["index", "journal_compactions_latest", "journal_compactions"],
    ["index", "journal_effects_latest", "journal_effects"],
    ["index", "journal_leases_current", "journal_leases"],
    ["index", "journal_snapshots_latest", "journal_snapshots"],
    ["table", "journal_blobs", "journal_blobs"],
    ["table", "journal_budgets", "journal_budgets"],
    ["table", "journal_compactions", "journal_compactions"],
    ["table", "journal_effects", "journal_effects"],
    ["table", "journal_events", "journal_events"],
    ["table", "journal_leases", "journal_leases"],
    ["table", "journal_metadata", "journal_metadata"],
    ["table", "journal_migrations", "journal_migrations"],
    ["table", "journal_projections", "journal_projections"],
    ["table", "journal_snapshots", "journal_snapshots"],
    ["table", "journal_stream_heads", "journal_stream_heads"],
    ["trigger", "journal_blobs_no_delete", "journal_blobs"],
    ["trigger", "journal_blobs_no_update", "journal_blobs"],
    ["trigger", "journal_budgets_consumption_only_grows", "journal_budgets"],
    ["trigger", "journal_budgets_no_delete", "journal_budgets"],
    ["trigger", "journal_compactions_no_delete", "journal_compactions"],
    ["trigger", "journal_compactions_no_update", "journal_compactions"],
    ["trigger", "journal_effects_no_delete", "journal_effects"],
    ["trigger", "journal_effects_no_update", "journal_effects"],
    ["trigger", "journal_events_no_delete", "journal_events"],
    ["trigger", "journal_events_no_update", "journal_events"],
    ["trigger", "journal_leases_no_delete", "journal_leases"],
    ["trigger", "journal_leases_no_update", "journal_leases"],
    ["trigger", "journal_metadata_identity_no_update", "journal_metadata"],
    ["trigger", "journal_metadata_no_delete", "journal_metadata"],
    ["trigger", "journal_migrations_no_delete", "journal_migrations"],
    ["trigger", "journal_migrations_no_update", "journal_migrations"],
    ["trigger", "journal_snapshots_no_delete", "journal_snapshots"],
    ["trigger", "journal_snapshots_no_update", "journal_snapshots"],
  ]
  if (residue !== "" || JSON.stringify(identities) !== JSON.stringify(expectedIdentities)) {
    throw new Error("S105 SQLite exact 33-object schema manifest drifted")
  }

  const digestBody = /const EXPECTED_SCHEMA_MANIFEST_DIGEST:\s*\[u8; 32\]\s*=\s*\[([\s\S]*?)\];/.exec(
    migrationRuntime,
  )?.[1]
  const digest = digestBody === undefined
    ? ""
    : [...digestBody.matchAll(/0x([0-9a-fA-F]{2})/g)].map((match) => match[1]!.toLowerCase()).join("")
  if (digest !== "e604e8b2b149c66790d76932a5b13fd855e133c0b2766bc1e95d9ec6fd3a6ab4") {
    throw new Error("S105 SQLite schema-manifest digest drifted")
  }
  const compactRuntime = migrationRuntime.replaceAll(/\s+/g, " ")
  for (const required of [
    'const SCHEMA_MANIFEST_DOMAIN: &[u8] = b"ABDO/JOURNAL/SQLITE-SCHEMA/1\\0"',
    "if expected_digest != EXPECTED_SCHEMA_MANIFEST_DIGEST",
    "if actual_digest != EXPECTED_SCHEMA_MANIFEST_DIGEST || actual != expected",
    "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND (name GLOB 'journal_*' OR tbl_name GLOB 'journal_*') ORDER BY type, name, tbl_name",
  ]) {
    if (!compactRuntime.includes(required)) throw new Error("S105 SQLite schema-manifest verification flow drifted")
  }
  const journalRuntime = requiredSource(sources, "crates/abdo-journal/src/journal.rs")
  for (const required of ["journal.verify_on_open()?;", "verify_schema_manifest(&self.connection)?;"]) {
    if (journalRuntime.split(required).length !== 2) {
      throw new Error("S105 SQLite schema manifest must be verified exactly once on open and verify")
    }
  }
}

function stripExactS105AuthorizationProbe(source: string) {
  const declaration =
    '#[cfg(feature = "test-hooks")]\n#[test]\nfn runtime_authorizer_denies_database_escape_and_schema_ddl()'
  if (source.split(declaration).length !== 2) {
    throw new Error("S105 runtime-authorizer test-hook probe declaration drifted")
  }
  const declarationStart = source.indexOf(declaration)
  const openBrace = source.indexOf("{", declarationStart + declaration.length)
  if (openBrace === -1) throw new Error("S105 runtime-authorizer test-hook probe body is missing")
  const closeBrace = findMatchingRustBrace(source, openBrace)
  const probe = source.slice(declarationStart, closeBrace + 1)
  const sqlCapabilities = extractDecodedRustStringLiterals(probe).filter((literal) =>
    /^\s*(?:(?:ATTACH|DETACH)\s+(?:DATABASE\s+)?|VACUUM\s+INTO\b|CREATE\s+TABLE\b)/i.test(literal),
  )
  const expectedSqlCapabilities = [
    "ATTACH DATABASE ':memory:' AS escaped",
    "DETACH DATABASE escaped",
    "CREATE TABLE escaped_table(value INTEGER)",
    "VACUUM INTO '{}'",
  ]
  if (JSON.stringify(sqlCapabilities) !== JSON.stringify(expectedSqlCapabilities)) {
    throw new Error("S105 runtime-authorizer test-hook SQL probe surface drifted")
  }
  return `${source.slice(0, declarationStart)}${"\n".repeat(probe.match(/\n/g)?.length ?? 0)}${source.slice(closeBrace + 1)}`
}

function extractRustStringArray(source: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const body = source.match(new RegExp(`\\b${escapedName}\\s*:\\s*&\\s*\\[\\s*&str\\s*\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`))?.[1]
  if (body === undefined) throw new Error(`S105 SQLite ${name} array is missing`)
  const strings = [...body.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]!)
  const residue = body.replace(/"(?:\\.|[^"\\])*"/g, "").replace(/[\s,]/g, "")
  if (residue !== "") throw new Error(`S105 SQLite ${name} contains a non-literal entry`)
  return strings
}

function assertNoJournalRuntimeEnvironmentOrProcess(entry: BoundarySource, code: string) {
  if (
    /\bstd\s*::\s*(?:env|process|thread)\b|\buse\s+(?:::)?\s*std\s*::\s*\{[^}]*\b(?:env|process|thread)\b|\b(?:Command|Child|Stdio)\s*::|\bprocess\s*::|\benv\s*::|\b(?:option_)?env!\s*\(/i.test(
      code,
    )
  ) {
    throw new Error(`S105 journal runtime contains environment or process capability in ${entry.path}`)
  }
}

function assertNoJournalRuntimeNamespaceEscape(entry: BoundarySource, code: string) {
  if (/\bextern\s+crate\s+(?:std|core|alloc)\s+as\s+/i.test(code)) {
    throw new Error(`S105 journal runtime aliases a host namespace in ${entry.path}`)
  }
  for (const match of code.matchAll(/\buse\s+([^;]+);/g)) {
    const statement = match[1]!.replaceAll(/\s+/g, " ").trim().replace(/^::\s*/, "")
    if (/^(?:std|core|alloc)\b[\s\S]*\bas\s+(?!_\b)/.test(statement)) {
      throw new Error(`S105 journal runtime aliases a host namespace in ${entry.path}`)
    }
    if (/^(?:std|core|alloc)\s*::[\s\S]*\*/.test(statement)) {
      throw new Error(`S105 journal runtime uses a host wildcard import in ${entry.path}`)
    }
    if (/^rusqlite\b[\s\S]*\bas\s+(?!_\b)/.test(statement) || /^rusqlite\b[\s\S]*\*/.test(statement)) {
      throw new Error(`S105 journal runtime aliases or wildcard-imports rusqlite in ${entry.path}`)
    }
  }
  if (/\bextern\s+crate\s+rusqlite\b|\btype\s+[^\s=]+\s*=\s*(?:rusqlite\s*::\s*)?Connection\b/.test(code)) {
    throw new Error(`S105 journal runtime aliases the SQLite connection type in ${entry.path}`)
  }
}

function isS105ProductionRuntimePath(path: string) {
  return (
    path.startsWith("crates/abdo-journal/src/") &&
    path !== "crates/abdo-journal/src/test_support.rs" &&
    path !== "crates/abdo-journal/src/bin/abdo-journal-test-child.rs"
  )
}

function assertBoundedS105TestChild(entry: BoundarySource, code: string) {
  if (
    /\b(?:ProcessCommand|Command|Child|Stdio)\b|\bConnection\s*::\s*open|\brusqlite\b|\bmacro_rules\s*!|\b(?:concat|stringify)\s*!\s*\(/.test(
      code,
    )
  ) {
    throw new Error(`S105 test child contains an unapproved process, SQLite or macro capability in ${entry.path}`)
  }
  const sites: readonly [RegExp, number, string][] = [
    [/\bstd\s*::\s*env\s*::\s*var\s*\(/g, 2, "role and token environment readers"],
    [/\bstd\s*::\s*env\s*::\s*var_os\s*\(/g, 2, "parent-marker and directory environment readers"],
    [/\bstd\s*::\s*env\s*::\s*args_os\s*\(/g, 1, "argument reader"],
    [/\bstd\s*::\s*process\s*::\s*exit\s*\(/g, 3, "bounded exit"],
    [/\bstd\s*::\s*fs\s*::\s*canonicalize\s*\(/g, 2, "canonical path reader"],
    [/\bJournal\s*::\s*open\s*\(/g, 4, "journal open"],
  ]
  assertExactRustSites(entry, code, sites, "S105 test child")
}

function assertBoundedS105TestSupport(entry: BoundarySource, code: string) {
  if (/\b(?:ProcessCommand|Command|Child|Stdio)\b|\bmacro_rules\s*!|\b(?:concat|stringify)\s*!\s*\(/.test(code)) {
    throw new Error(`S105 test support contains an unapproved subprocess or macro capability in ${entry.path}`)
  }
  const sites: readonly [RegExp, number, string][] = [
    [/\bstd\s*::\s*env\s*::\s*var\s*\(/g, 5, "test environment reader"],
    [/\bstd\s*::\s*env\s*::\s*var_os\s*\(/g, 2, "test OS environment reader"],
    [/\bstd\s*::\s*process\s*::\s*exit\s*\(/g, 1, "crash exit"],
    [/\bConnection\s*::\s*open_with_flags\s*\(/g, 1, "read-only verification connection"],
  ]
  assertExactRustSites(entry, code, sites, "S105 test support")
}

function assertExactRustSites(
  entry: BoundarySource,
  code: string,
  sites: readonly [RegExp, number, string][],
  surface: string,
) {
  for (const [pattern, expected, name] of sites) {
    const actual = code.match(pattern)?.length ?? 0
    if (actual !== expected) {
      throw new Error(`${surface} ${name} site count drifted in ${entry.path}: expected ${expected}, saw ${actual}`)
    }
  }
}

export function readCargoDependencyClosure(preparedContext?: PreparedCargoContext): CargoClosureIdentity {
  const command = cargoWorkspaceCommand("metadata", "--locked", "--offline", "--format-version", "1")
  const result = withIsolatedCargo(
    ({ cwd, environment }) =>
      Bun.spawnSync(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" }),
    preparedContext,
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `cargo metadata dependency closure failed (${result.exitCode})\n${result.stderr.toString()}${result.stdout.toString()}`,
    )
  }
  return validateCargoMetadata(JSON.parse(result.stdout.toString()))
}

export function validateCargoMetadata(value: unknown): CargoClosureIdentity {
  const metadata = requireRecord(value, "cargo metadata")
  const packages = requireArray(metadata.packages, "cargo metadata packages").map((item) =>
    requireRecord(item, "cargo package"),
  )
  if (packages.length !== S105_LOCKED_PACKAGES.length) {
    throw new Error(
      `S105 cargo dependency closure must contain exactly ${S105_LOCKED_PACKAGES.length} packages, saw ${packages.length}`,
    )
  }

  const packagesByName = new Map<string, Record<string, unknown>>()
  const packagesById = new Map<string, Record<string, unknown>>()
  for (const packageValue of packages) {
    const name = requireString(packageValue.name, "cargo package name")
    const id = requireString(packageValue.id, `cargo package ${name} id`)
    if (packagesByName.has(name) || packagesById.has(id)) {
      throw new Error(`S105 cargo metadata contains a duplicate package identity: ${name}`)
    }
    packagesByName.set(name, packageValue)
    packagesById.set(id, packageValue)
  }

  const actualPackageNames = [...packagesByName.keys()].toSorted(compareText)
  const expectedPackageNames = S105_LOCKED_PACKAGES.map((entry) => entry.name).toSorted(compareText)
  if (JSON.stringify(actualPackageNames) !== JSON.stringify(expectedPackageNames)) {
    throw new Error(`S105 cargo package allowlist drifted: ${JSON.stringify(actualPackageNames)}`)
  }

  for (const expected of S105_LOCKED_PACKAGES) {
    const packageValue = packagesByName.get(expected.name)!
    const source = packageValue.source === undefined ? null : packageValue.source
    const checksum = packageValue.checksum === undefined ? null : packageValue.checksum
    if (source !== null && typeof source !== "string") {
      throw new Error(`S105 cargo package ${expected.name} source must be a string or null`)
    }
    if (checksum !== null && typeof checksum !== "string") {
      throw new Error(`S105 cargo package ${expected.name} checksum must be a string or null`)
    }
    if (
      packageValue.version !== expected.version ||
      source !== expected.source ||
      (packageValue.checksum !== undefined && checksum !== expected.checksum)
    ) {
      throw new Error(`S105 cargo package version, source or checksum drifted for ${expected.name}`)
    }
    requireArray(packageValue.dependencies, `cargo package ${expected.name} dependencies`)
    requireArray(packageValue.targets, `cargo package ${expected.name} targets`)
  }

  const contractsPackage = packagesByName.get("abdo-contracts")!
  const journalPackage = packagesByName.get("abdo-journal")!
  const kernelCorePackage = packagesByName.get("abdo-kernel")!
  const runtimePackage = packagesByName.get("abdo-runtime")!
  const authorityPackage = packagesByName.get("abdo-authority")!
  const policyPackage = packagesByName.get("abdo-policy")!
  const evidencePackage = packagesByName.get("abdo-evidence")!
  const toolsPackage = packagesByName.get("abdo-tools")!
  const kernelBinPackage = packagesByName.get("abdo-kernel-bin")!
  const workerPackage = packagesByName.get("abdo-tool-worker")!
  assertWorkspaceCargoPackage(contractsPackage, {
    name: "abdo-contracts",
    manifestPath: "crates/abdo-contracts/Cargo.toml",
    dependencies: [],
    features: {},
    targets: [
      cargoTarget(
        "abdo-contracts-codegen",
        "crates/abdo-contracts/src/bin/abdo-contracts-codegen.rs",
        "bin",
        true,
        false,
      ),
      cargoTarget("abdo_contracts", "crates/abdo-contracts/src/lib.rs", "lib", true, true),
      cargoTarget("codegen", "crates/abdo-contracts/tests/codegen.rs", "test", true, false),
      cargoTarget("golden", "crates/abdo-contracts/tests/golden.rs", "test", true, false),
      cargoTarget("id_10m", "crates/abdo-contracts/tests/id_10m.rs", "test", true, false),
      cargoTarget(
        "strict_mutations",
        "crates/abdo-contracts/tests/strict_mutations.rs",
        "test",
        true,
        false,
      ),
    ],
  })
  assertWorkspaceCargoPackage(journalPackage, {
    name: "abdo-journal",
    manifestPath: "crates/abdo-journal/Cargo.toml",
    dependencies: [
      {
        name: "abdo-contracts",
        source: null,
        req: "*",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: true,
        features: [],
        path: "crates/abdo-contracts",
      },
      {
        name: "rusqlite",
        source: CARGO_REGISTRY_SOURCE,
        req: "=0.40.2",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: false,
        features: ["bundled", "hooks"],
        path: null,
      },
      {
        name: "sha2",
        source: CARGO_REGISTRY_SOURCE,
        req: "=0.11.0",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: false,
        features: [],
        path: null,
      },
    ],
    features: { default: [], "test-hooks": [] },
    targets: [
      cargoTarget(
        "abdo-journal-test-child",
        "crates/abdo-journal/src/bin/abdo-journal-test-child.rs",
        "bin",
        false,
        false,
        ["test-hooks"],
      ),
      cargoTarget("abdo_journal", "crates/abdo-journal/src/lib.rs", "lib", true, true),
      cargoTarget("compaction", "crates/abdo-journal/tests/compaction.rs", "test", true, false),
      cargoTarget("journal", "crates/abdo-journal/tests/journal.rs", "test", true, false),
      cargoTarget(
        "migration_atomicity",
        "crates/abdo-journal/tests/migration_atomicity.rs",
        "test",
        true,
        false,
      ),
      cargoTarget("recovery_10k", "crates/abdo-journal/tests/recovery_10k.rs", "test", true, false),
      cargoTarget(
        "recovery_integrity",
        "crates/abdo-journal/tests/recovery_integrity.rs",
        "test",
        true,
        false,
      ),
      cargoTarget("restore_100k", "crates/abdo-journal/tests/restore_100k.rs", "test", true, false),
    ],
  })
  assertWorkspaceCargoPackage(kernelCorePackage, {
    name: "abdo-kernel",
    manifestPath: "crates/abdo-kernel/Cargo.toml",
    dependencies: [
      {
        name: "abdo-contracts",
        source: null,
        req: "*",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: true,
        features: [],
        path: "crates/abdo-contracts",
      },
      {
        name: "sha2",
        source: CARGO_REGISTRY_SOURCE,
        req: "=0.11.0",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: false,
        features: [],
        path: null,
      },
    ],
    features: {},
    targets: [
      cargoTarget("abdo_kernel", "crates/abdo-kernel/src/lib.rs", "lib", true, true),
      cargoTarget(
        "determinism_1k",
        "crates/abdo-kernel/tests/determinism_1k.rs",
        "test",
        true,
        false,
      ),
      cargoTarget("reduce", "crates/abdo-kernel/tests/reduce.rs", "test", true, false),
      cargoTarget(
        "transitions_1m",
        "crates/abdo-kernel/tests/transitions_1m.rs",
        "test",
        true,
        false,
      ),
    ],
  })

  assertWorkspaceCargoPackage(authorityPackage, {
    name: "abdo-authority",
    manifestPath: "crates/abdo-authority/Cargo.toml",
    dependencies: [
      {
        name: "abdo-contracts",
        source: null,
        req: "*",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: true,
        features: [],
        path: "crates/abdo-contracts",
      },
      {
        name: "hmac",
        source: CARGO_REGISTRY_SOURCE,
        req: "=0.13.0",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: false,
        features: [],
        path: null,
      },
      {
        name: "sha2",
        source: CARGO_REGISTRY_SOURCE,
        req: "=0.11.0",
        kind: null,
        rename: null,
        optional: false,
        usesDefaultFeatures: false,
        features: [],
        path: null,
      },
    ],
    features: {},
    targets: [
      cargoTarget("abdo_authority", "crates/abdo-authority/src/lib.rs", "lib", true, true),
      cargoTarget("authority", "crates/abdo-authority/tests/authority.rs", "test", true, false),
      cargoTarget(
        "authority_sweep",
        "crates/abdo-authority/tests/authority_sweep.rs",
        "test",
        true,
        false,
      ),
    ],
  })

  const contractsId = requireString(contractsPackage.id, "contracts package id")
  const journalId = requireString(journalPackage.id, "journal package id")
  const kernelCoreId = requireString(kernelCorePackage.id, "kernel core package id")
  const runtimeId = requireString(runtimePackage.id, "runtime package id")
  const authorityId = requireString(authorityPackage.id, "authority package id")
  const policyId = requireString(policyPackage.id, "policy package id")
  const evidenceId = requireString(evidencePackage.id, "evidence package id")
  const toolsId = requireString(toolsPackage.id, "tools package id")
  const kernelBinId = requireString(kernelBinPackage.id, "kernel binary package id")
  const workerId = requireString(workerPackage.id, "tool worker package id")
  const expectedWorkspaceMembers = [
    contractsId,
    journalId,
    kernelCoreId,
    runtimeId,
    authorityId,
    policyId,
    evidenceId,
    toolsId,
    kernelBinId,
    workerId,
  ].toSorted(compareText)
  const workspaceMembers = requireStringArray(metadata.workspace_members, "cargo workspace members").toSorted(compareText)
  const workspaceDefaultMembers = requireStringArray(
    metadata.workspace_default_members,
    "cargo default workspace members",
  ).toSorted(compareText)
  if (JSON.stringify(workspaceMembers) !== JSON.stringify(expectedWorkspaceMembers)) {
    throw new Error("S105 cargo workspace member allowlist drifted")
  }
  if (JSON.stringify(workspaceDefaultMembers) !== JSON.stringify(expectedWorkspaceMembers)) {
    throw new Error("S105 cargo default workspace member allowlist drifted")
  }

  const resolve = requireRecord(metadata.resolve, "cargo resolve graph")
  if (resolve.root !== null) throw new Error("S105 virtual Cargo workspace resolve root drifted")
  const nodes = requireArray(resolve.nodes, "cargo resolve nodes").map((item) =>
    requireRecord(item, "cargo resolve node"),
  )
  if (nodes.length !== S105_LOCKED_PACKAGES.length) {
    throw new Error(
      `S105 cargo resolve graph must contain exactly ${S105_LOCKED_PACKAGES.length} nodes, saw ${nodes.length}`,
    )
  }
  const nodesById = new Map<string, Record<string, unknown>>()
  for (const node of nodes) {
    const id = requireString(node.id, "cargo resolve node id")
    if (!packagesById.has(id) || nodesById.has(id)) {
      throw new Error(`S105 cargo resolve graph contains an unknown or duplicate node: ${id}`)
    }
    nodesById.set(id, node)
  }
  if (nodesById.size !== packagesById.size) throw new Error("S105 cargo resolve graph omitted an allowlisted package")

  const resultNodes: { id: string; dependencies: string[] }[] = []
  for (const expected of S105_LOCKED_PACKAGES) {
    const packageValue = packagesByName.get(expected.name)!
    const id = requireString(packageValue.id, `cargo package ${expected.name} id`)
    const node = nodesById.get(id)!
    const dependencyIds = requireStringArray(node.dependencies, `cargo resolve ${expected.name} dependencies`).toSorted(
      compareText,
    )
    const dependencyNames = dependencyIds.map((dependencyId) => {
      const dependencyPackage = packagesById.get(dependencyId)
      if (!dependencyPackage) throw new Error(`S105 cargo resolve ${expected.name} references an unknown package`)
      return requireString(dependencyPackage.name, "cargo dependency package name")
    })
    if (JSON.stringify(dependencyNames.toSorted(compareText)) !== JSON.stringify([...expected.dependencies].toSorted(compareText))) {
      throw new Error(`S105 cargo resolve dependency edges drifted for ${expected.name}`)
    }

    const dependencyEdges = requireArray(node.deps, `cargo resolve ${expected.name} dependency edges`)
      .map((edge) => requireRecord(edge, `cargo resolve ${expected.name} dependency edge`))
      .map((edge) => {
        const dependencyId = requireString(edge.pkg, `cargo resolve ${expected.name} dependency package id`)
        const dependencyPackage = packagesById.get(dependencyId)
        if (!dependencyPackage) throw new Error(`S105 cargo resolve ${expected.name} edge references an unknown package`)
        const dependencyName = requireString(dependencyPackage.name, "cargo edge package name")
        const edgeName = requireString(edge.name, `cargo resolve ${expected.name} dependency edge name`)
        const expectedEdgeName =
          S105_DEPENDENCY_EDGE_ALIASES[`${expected.name}:${dependencyName}`] ?? dependencyName.replaceAll("-", "_")
        if (edgeName !== expectedEdgeName) {
          throw new Error(`S105 cargo resolve dependency alias drifted for ${expected.name} -> ${dependencyName}`)
        }
        const dependencyKinds = requireArray(edge.dep_kinds, `cargo resolve ${expected.name} dependency kinds`).map(
          (kind) => requireRecord(kind, `cargo resolve ${expected.name} dependency kind`),
        )
        if (dependencyKinds.length === 0) {
          throw new Error(`S105 cargo resolve dependency kinds are empty for ${expected.name} -> ${dependencyName}`)
        }
        const expectedKind = S105_BUILD_DEPENDENCY_EDGES.has(`${expected.name}:${dependencyName}`) ? "build" : null
        for (const dependencyKind of dependencyKinds) {
          if (dependencyKind.kind !== expectedKind) {
            throw new Error(`S105 cargo resolve dependency kind drifted for ${expected.name} -> ${dependencyName}`)
          }
          if (dependencyKind.target !== null && typeof dependencyKind.target !== "string") {
            throw new Error(`S105 cargo resolve dependency target drifted for ${expected.name} -> ${dependencyName}`)
          }
        }
        return dependencyName
      })
      .toSorted(compareText)
    if (JSON.stringify(dependencyEdges) !== JSON.stringify([...expected.dependencies].toSorted(compareText))) {
      throw new Error(`S105 cargo resolve named dependency edges drifted for ${expected.name}`)
    }

    const features = requireStringArray(node.features, `cargo resolve ${expected.name} features`).toSorted(compareText)
    const expectedFeatures = [...(S105_SELECTED_FEATURES[expected.name] ?? [])].toSorted(compareText)
    if (JSON.stringify(features) !== JSON.stringify(expectedFeatures)) {
      throw new Error(`S105 cargo selected feature set drifted for ${expected.name}`)
    }
    resultNodes.push({ id, dependencies: dependencyIds })
  }

  return {
    metadataCommand: cargoWorkspaceCommand("metadata", "--locked", "--offline", "--format-version", "1"),
    packageIds: S105_LOCKED_PACKAGES.map((expected) =>
      requireString(packagesByName.get(expected.name)!.id, `cargo package ${expected.name} id`),
    ),
    packages: S105_LOCKED_PACKAGES.map((expected) => ({
      name: expected.name,
      version: expected.version,
      source: expected.source,
      dependencies: expected.dependencies.length,
      targets:
        expected.source === null
          ? requireArray(packagesByName.get(expected.name)!.targets, `cargo package ${expected.name} targets`)
              .map((target) => requireString(requireRecord(target, "cargo target").name, "cargo target name"))
              .toSorted(compareText)
          : [],
    })),
    resolveNodes: resultNodes,
    workspaceMembers,
  }
}

interface ExpectedWorkspaceCargoPackage {
  readonly name: string
  readonly manifestPath: string
  readonly dependencies: readonly {
    readonly name: string
    readonly source: string | null
    readonly req: string
    readonly kind: string | null
    readonly rename: string | null
    readonly optional: boolean
    readonly usesDefaultFeatures: boolean
    readonly features: readonly string[]
    readonly path: string | null
  }[]
  readonly features: Readonly<Record<string, readonly string[]>>
  readonly targets: readonly {
    readonly name: string
    readonly path: string
    readonly kinds: readonly string[]
    readonly requiredFeatures: readonly string[]
    readonly test: boolean
    readonly doctest: boolean
  }[]
}

function cargoTarget(
  name: string,
  path: string,
  kind: string,
  test: boolean,
  doctest: boolean,
  requiredFeatures: readonly string[] = [],
) {
  return { name, path, kinds: [kind], requiredFeatures, test, doctest }
}

function assertWorkspaceCargoPackage(
  packageValue: Record<string, unknown>,
  expected: ExpectedWorkspaceCargoPackage,
) {
  if (packageValue.edition !== "2021") throw new Error(`S105 ${expected.name} package edition drifted`)
  const manifestPath = normalizedPackagePath(requireString(packageValue.manifest_path, `${expected.name} manifest path`))
  if (manifestPath !== expected.manifestPath) {
    throw new Error(`S105 ${expected.name} package manifest drifted: ${manifestPath}`)
  }

  const features = Object.fromEntries(
    Object.entries(requireRecord(packageValue.features, `${expected.name} package features`))
      .map(
        ([name, values]) =>
          [name, requireStringArray(values, `${expected.name} feature ${name}`).toSorted(compareText)] as const,
      )
      .toSorted(([left], [right]) => compareText(left, right)),
  )
  const expectedFeatures = Object.fromEntries(
    Object.entries(expected.features)
      .map(([name, values]) => [name, [...values].toSorted(compareText)] as const)
      .toSorted(([left], [right]) => compareText(left, right)),
  )
  if (JSON.stringify(features) !== JSON.stringify(expectedFeatures)) {
    throw new Error(`S105 ${expected.name} package feature definitions drifted`)
  }

  const dependencies = requireArray(packageValue.dependencies, `${expected.name} package dependencies`)
    .map((dependency) => requireRecord(dependency, `${expected.name} dependency`))
    .map((dependency) => {
      const pathValue = dependency.path === undefined ? null : dependency.path
      if (pathValue !== null && typeof pathValue !== "string") {
        throw new Error(`S105 ${expected.name} dependency path must be a string or null`)
      }
      const sourceValue = dependency.source
      const kindValue = dependency.kind
      const renameValue = dependency.rename
      if (sourceValue !== null && typeof sourceValue !== "string") {
        throw new Error(`S105 ${expected.name} dependency source must be a string or null`)
      }
      if (kindValue !== null && typeof kindValue !== "string") {
        throw new Error(`S105 ${expected.name} dependency kind must be a string or null`)
      }
      if (renameValue !== null && typeof renameValue !== "string") {
        throw new Error(`S105 ${expected.name} dependency rename must be a string or null`)
      }
      if (typeof dependency.optional !== "boolean" || typeof dependency.uses_default_features !== "boolean") {
        throw new Error(`S105 ${expected.name} dependency flags must be booleans`)
      }
      return {
        name: requireString(dependency.name, `${expected.name} dependency name`),
        source: sourceValue,
        req: requireString(dependency.req, `${expected.name} dependency requirement`),
        kind: kindValue,
        rename: renameValue,
        optional: dependency.optional,
        usesDefaultFeatures: dependency.uses_default_features,
        features: requireStringArray(dependency.features, `${expected.name} dependency features`).toSorted(compareText),
        path: pathValue === null ? null : normalizedPackagePath(pathValue),
      }
    })
    .toSorted((left, right) => compareText(left.name, right.name))
  if (JSON.stringify(dependencies) !== JSON.stringify(expected.dependencies)) {
    throw new Error(`S105 ${expected.name} direct dependency metadata drifted`)
  }

  const targets = requireArray(packageValue.targets, `${expected.name} package targets`)
    .map((target) => requireRecord(target, `${expected.name} target`))
    .map((target) => {
      if (typeof target.test !== "boolean" || typeof target.doctest !== "boolean") {
        throw new Error(`S105 ${expected.name} target test flags must be booleans`)
      }
      return {
        name: requireString(target.name, `${expected.name} target name`),
        path: normalizedPackagePath(requireString(target.src_path, `${expected.name} target source path`)),
        kinds: requireStringArray(target.kind, `${expected.name} target kind`).toSorted(compareText),
        requiredFeatures: requireStringArray(
          target["required-features"] ?? [],
          `${expected.name} target required features`,
        ).toSorted(compareText),
        test: target.test,
        doctest: target.doctest,
      }
    })
    .toSorted((left, right) => compareText(left.name, right.name))
  const expectedTargets = [...expected.targets].toSorted((left, right) => compareText(left.name, right.name))
  if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
    throw new Error(`S105 ${expected.name} target allowlist drifted or a retired probe target returned`)
  }
}

function assertPinnedToolchainAndWorkspace(sources: readonly BoundarySource[]) {
  const toolchain = requiredSource(sources, "rust-toolchain.toml").replaceAll("\r\n", "\n").trim()
  const expectedToolchain = [
    "[toolchain]",
    'channel = "1.94.1"',
    'profile = "minimal"',
    'components = ["clippy", "rustfmt"]',
  ].join("\n")
  if (toolchain !== expectedToolchain) throw new Error("S105 Rust toolchain identity drifted")

  const harness = requiredSource(sources, "scripts/contracts.ts")
  for (const required of [
    'export const RUST_VERSION = "1.94.1"',
    "export const RUST_HOST = trustedRustHost()",
    'export const RUST_TOOLCHAIN = `${RUST_VERSION}-${RUST_HOST}`',
    '"win32:x64": "x86_64-pc-windows-msvc"',
    'export const RUSTC_VERSION_IDENTITY = "rustc 1.94.1 (e408947bf 2026-03-25)"',
    'export const CARGO_VERSION_IDENTITY = "cargo 1.94.1 (29ea6fb6a 2026-03-24)"',
    "const requestedUserHome = resolve(userInfo().homedir)",
    'canonicalDirectory(join(canonicalUserHome, ".cargo", "bin"), "Rustup binary directory")',
    'const rustupName = process.platform === "win32" ? "rustup.exe" : "rustup"',
    "!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()",
    "const rustupExecutable = realpathSync(requestedRustup)",
    "executableIdentity.isSymbolicLink()",
    "!sameCanonicalPath(dirname(rustupExecutable), canonicalCargoBin)",
    'canonicalDirectory(join(canonicalUserHome, ".rustup"), "Rustup home")',
    'return [toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "cargo", command, ...args]',
    "environment.RUSTUP_HOME = trustedRustToolchainIdentity().rustupHome",
    "assertTrustedRustToolchainPreflight(cwd, toolchainEnvironment)",
    '[toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "rustc", "-Vv"]',
    '[toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "cargo", "-V"]',
    "validateRustToolchainPreflight(rustc, cargo)",
    "fields.get(\"release\") !== RUST_VERSION",
    "fields.get(\"host\") !== RUST_HOST",
    '!/^e408947bf[0-9a-f]{31}$/.test(fields.get("commit-hash") ?? "")',
    'fields.get("commit-date") !== "2026-03-25"',
    "cargoOutput.trim() !== CARGO_VERSION_IDENTITY",
    "context.environment.RUSTUP_HOME !== trustedRustToolchainIdentity().rustupHome",
    'const cargoLockBeforeFetch = cargoLockSha256()',
    'cargoWorkspaceCommand("fetch", "--locked")',
    'delete fetchEnvironment.CARGO_NET_OFFLINE',
    'timeout: 120_000',
    'if (cargoLockAfterFetch !== cargoLockBeforeFetch)',
    'assertFetchedCargoHome(cargoHome)',
    "export function trustedBunExecutable()",
    "const requestedPath = resolve(process.execPath)",
    "!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()",
    "const executablePath = realpathSync(requestedPath)",
    "!/^bun(?:\\.exe)?$/i.test(basename(executablePath))",
    'fetchCount: 1',
    'networkState: "offline"',
    'preparedContextTokens.set(context, token)',
    'assertPreparedCargoMarker(context, marker, token, [process.ppid])',
    'context.environment.CARGO_NET_OFFLINE !== "true"',
    'runCodegen(["--out", temporaryContracts, temporaryFixtures], cargoLease.context)',
    'runCodegen(["--check", GENERATED_CONTRACTS_PATH, CONTRACT_FIXTURE_DIR], cargoLease.context)',
    'if (mode === "write")',
    "bytesEqual(current, file.bytes)",
    'const environment: Record<string, string> = { CARGO_NET_OFFLINE: "true" }',
    "CARGO_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())",
    "assertCargoConfigFreeAncestors(context.cwd)",
    '{ cwd, env: environment, stdout: "pipe", stderr: "pipe" }',
    'for (const forbidden of ["config", "config.toml", "credentials", "credentials.toml"])',
  ]) {
    if (!harness.includes(required)) throw new Error(`S105 prepared Cargo or codegen harness shape drifted: ${required}`)
  }
  const compactHarness = harness.replaceAll(/\s+/g, " ")
  const preflightIndex = harness.indexOf("assertTrustedRustToolchainPreflight(cwd, toolchainEnvironment)")
  const lockBeforeIndex = harness.indexOf("const cargoLockBeforeFetch = cargoLockSha256()")
  const fetchIndex = harness.indexOf('cargoWorkspaceCommand("fetch", "--locked")')
  if (preflightIndex < 0 || lockBeforeIndex <= preflightIndex || fetchIndex <= lockBeforeIndex) {
    throw new Error("S105 trusted Rust toolchain preflight must run before the single locked fetch")
  }
  const cargoPathLookup = new RegExp(
    ["return\\s*\\[\\s*[\\x22\\x27]ca", "rgo[\\x22\\x27]"].join(""),
  )
  if (cargoPathLookup.test(harness) || harness.includes('`+${RUST_TOOLCHAIN}`')) {
    throw new Error("S105 Cargo commands may not use PATH lookup or implicit Rustup proxies")
  }
  if ((harness.match(/requestedIdentity\.isSymbolicLink\(\)/g)?.length ?? 0) !== 3) {
    throw new Error("S105 Rustup/Bun requested path symlink checks drifted")
  }
  if ((harness.match(/executableIdentity\.isSymbolicLink\(\)/g)?.length ?? 0) !== 2) {
    throw new Error("S105 Rustup/Bun canonical executable symlink checks drifted")
  }
  const fetchCallPattern = new RegExp(['cargoWorkspaceCommand\\("fe', 'tch",\\s*"--locked"\\)'].join(""), "g")
  if ((harness.match(fetchCallPattern)?.length ?? 0) !== 1) {
    throw new Error("S105 prepared Cargo context must perform exactly one locked fetch")
  }
  const exactCodegenCommand = [
    'cargoWorkspaceCommand( "run", "--locked", "--offline", "--quiet",',
    '"--package", "abdo-contracts", "--bin", "abdo-contracts-codegen", "--", ...arguments_, )',
  ].join(" ")
  if (!compactHarness.includes(exactCodegenCommand)) {
    throw new Error("S105 TypeScript codegen must remain locked and offline")
  }
  const environmentAllowlist = harness.match(/const CARGO_ENVIRONMENT_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)?.[1]
  const environmentNames = [...(environmentAllowlist ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!)
  const expectedEnvironmentNames = [
    "COMSPEC",
    "HOME",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ]
  if (JSON.stringify(environmentNames) !== JSON.stringify(expectedEnvironmentNames)) {
    throw new Error("S105 Cargo environment allowlist drifted")
  }
  for (const forbidden of [
    "CC",
    "CXX",
    "RUSTFLAGS",
    "CARGO_BUILD_TARGET",
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "VCINSTALLDIR",
    "VCTOOLSINSTALLDIR",
    "WINDOWSSDKDIR",
  ]) {
    if (environmentNames.includes(forbidden)) throw new Error(`S105 Cargo environment admits ambient ${forbidden}`)
  }

  const master = requiredSource(sources, "scripts/kernel-test.ts")
  const masterExecutable = canonicalTypeScriptExecutable("scripts/kernel-test.ts", master)
  const masterCalls = [
    "prepareCargoContext()",
    'synchronizeGeneratedContracts("check", cargoLease.context)',
    "verifyBoundaryGuards(cargoLease.context)",
    "runRustTestsBeforeS105(cargoLease.context)",
    "runS105JournalGates(cargoLease.context)",
    "runRustClippy(cargoLease.context)",
    "const bunExecutable = trustedBunExecutable()",
    'Bun.spawnSync([bunExecutable, "test"]',
    "preparedCargoChildEnvironment(cargoLease.context)",
    "cargoLease.dispose()",
  ]
  let previousIndex = -1
  for (const call of masterCalls) {
    const matches = masterExecutable.split(call).length - 1
    const index = masterExecutable.indexOf(call)
    if (matches !== 1 || index <= previousIndex) {
      throw new Error(`S105 master Cargo gate call order or cardinality drifted at ${call}`)
    }
    previousIndex = index
  }
  const masterCargoBypass = new RegExp(
    ["cargoWorkspaceCommand|\\bcargo\\s+(?:fe", "tch|test|clippy|run|metadata)\\b"].join(""),
  )
  if (masterCargoBypass.test(masterExecutable)) {
    throw new Error("S105 master gate may not bypass the prepared Cargo runners")
  }
  const bunPathLookup = new RegExp("Bun\\.spawnSync\\(\\[\\s*[\\\"\\x27]bun(?:\\.exe)?[\\\"\\x27]", "i")
  if (bunPathLookup.test(masterExecutable)) {
    throw new Error("S105 child Bun gate may not use PATH lookup or a literal executable name")
  }
  if (typeScriptExecutableSha256(masterExecutable) !== KERNEL_TEST_EXECUTABLE_SHA256) {
    throw new Error("S105 master executable control-flow digest drifted")
  }

  const rustHarness = requiredSource(sources, "scripts/rust-test.ts")
  for (const required of [
    'const ID_STRESS_PARENT_GATE = "ABDO_ID_10M_PARENT_GATE"',
    "const gateEnvironment = { ...environment, [ID_STRESS_PARENT_GATE]: createParentGate() }",
    "crypto.getRandomValues(new Uint8Array(32))",
    '"id_generator_ten_million_unique"',
    'cargoWorkspaceCommand("test", "--locked", "--offline")',
    '"--workspace",',
    '"--all-targets",',
    '"--all-features",',
    '"-D",',
    '"warnings",',
  ]) {
    if (!rustHarness.includes(required)) throw new Error("S105 Rust gate or sanitized environment shape drifted")
  }
  const compactRustHarness = rustHarness.replaceAll(/\s+/g, " ")
  const exactStressCommand = [
    'cargoWorkspaceCommand( "test", "--locked", "--offline", "--release", "-p", "abdo-contracts",',
    '"--test", "id_10m", "id_generator_ten_million_unique", "--", "--ignored", "--exact", )',
  ].join(" ")
  if (!compactRustHarness.includes(exactStressCommand)) {
    throw new Error("S104 Rust gate or sanitized environment shape drifted")
  }

  assertBoundedGateRunner(sources)
  assertSprintGateTable(sources, S105_JOURNAL_GATE_TABLE)
  assertSprintGateTable(sources, S106_REDUCER_GATE_TABLE)
  assertSprintGateTable(sources, S107_SUPERVISOR_GATE_TABLE)
  assertSprintGateTable(sources, S108_RECONCILE_GATE_TABLE)
  assertSprintGateTable(sources, S109_SESSION_GATE_TABLE)
  assertSprintGateTable(sources, S110_CONTROL_GATE_TABLE)
  assertSprintGateTable(sources, S111_SCHEDULE_GATE_TABLE)
  assertSprintGateTable(sources, S112_BUDGET_GATE_TABLE)
  assertSprintGateTable(sources, S113_AUTHORITY_GATE_TABLE)
  assertSprintGateTable(sources, S114_POLICY_GATE_TABLE)
  assertSprintGateTable(sources, S115_BROKER_GATE_TABLE)
  assertSprintGateTable(sources, S116_DISCLOSURE_GATE_TABLE)
  assertSprintGateTable(sources, S117_WORKER_GATE_TABLE)
  assertSprintGateTable(sources, S118_SECRET_GATE_TABLE)
  assertSprintGateTable(sources, S119_SURFACE_GATE_TABLE)
  assertSprintGateTable(sources, S142_BRIDGE_GATE_TABLE)
}

/**
 * The one shared runner that every sprint gate goes through.
 *
 * These pins used to live inside the S105 harness. They moved here with the
 * code: a pin that names a file the logic has left is a check that certifies a
 * property it no longer tests, which is worse than no check because it is
 * believed.
 */
function assertBoundedGateRunner(sources: readonly BoundarySource[]) {
  const runner = requiredSource(sources, "scripts/bounded-gate.ts")
  const executable = canonicalTypeScriptExecutable("scripts/bounded-gate.ts", runner)
  for (const required of [
    "const PROCESS_REAP_TIMEOUT_MS = 10_000",
    "const MAX_GATE_OUTPUT_BYTES = 8 * 1024 * 1024",
    "const gateEnvironment: Record<string, string> = { ...environment }",
    "for (const marker of family.parentEnvironments) delete gateEnvironment[marker]",
    'const featureArguments = gate.features === undefined ? [] : ["--features", gate.features]',
    "const gate = family.gates.find((entry) => entry.name === name)",
    "activeMarkers.length !== 1 || activeMarkers[0] !== gate.parentEnvironment",
    "gate parent markers must be mutually exclusive",
    '"--locked",',
    '"--offline",',
    '"--release",',
    '"--ignored",',
    '"--exact",',
    '"--nocapture",',
    '"--test-threads=1",',
    'if (gate.buildPackage !== undefined)',
    '"build",',
    "gate.buildPackage,",
    'runBoundedCargoGate(family, gate, buildCommand, root, cwd, gateEnvironment, "build")',
    'reportFailedGate(family, gate, "build", buildCommand, build)',
    "if (build.exitCode !== 0) return build.exitCode",
    'runBoundedCargoGate(family, gate, command, root, cwd, gateEnvironment, "test")',
    'reportFailedGate(family, gate, "test", command, result)',
    "if (result.exitCode === 0) return",
    "the child produced no output at all",
    "if (result.exitCode !== 0) return result.exitCode",
    "family.validate(gate.name, `${result.stdout}\\n${result.stderr}`)",
    "child = Bun.spawn([...command]",
    "const observed = await awaitExitWithin(child, gate.timeoutMs)",
    "terminateAndReapProcessTree(child, environment)",
    'taskkill, "/PID", child.pid.toString(), "/T", "/F"',
    'process.kill(-child.pid, "SIGKILL")',
    "const reaped = await awaitExitWithin(child, PROCESS_REAP_TIMEOUT_MS)",
    "if (size > MAX_GATE_OUTPUT_BYTES)",
    'requireOnlyCargoSummaryLine(label, lines, /^running \\d+ tests?$/, "running 1 test", "test-count")',
    "const evidence = requireNamedTestEvidence(label, lines, testName)",
    "testLines.length !== 1 || matches.length !== 1",
    "Cargo output must contain exactly one named test evidence line",
    "1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    "crypto.getRandomValues(new Uint8Array(32))",
  ]) {
    if (!runner.includes(required)) throw new Error("bounded Cargo gate runner shape drifted")
  }
  if ((runner.match(/terminateAndReapProcessTree\(child, environment\)/g)?.length ?? 0) !== 2) {
    throw new Error("bounded gate process-tree cleanup coverage drifted")
  }
  const compactRunner = runner.replaceAll(/\s+/g, " ")
  const exactCommand = [
    'cargoWorkspaceCommand( "test", "--locked", "--offline", "--release", "--package", gate.packageName,',
    '...featureArguments, "--test", gate.testTarget, gate.testName, "--", "--ignored", "--exact", "--nocapture", "--test-threads=1", )',
  ].join(" ")
  if (!compactRunner.includes(exactCommand)) {
    throw new Error("bounded Cargo gates must remain locked, offline and exact")
  }
  const compactExecutable = executable.replaceAll(/\s+/g, " ")
  const resultIndex = compactExecutable.indexOf("const result = await runBoundedCargoGate")
  const nonzeroIndex = compactExecutable.indexOf("if (result.exitCode !== 0) return result.exitCode", resultIndex)
  const evidenceIndex = compactExecutable.indexOf("family.validate(gate.name", nonzeroIndex)
  const successIndex = compactExecutable.indexOf("return 0", evidenceIndex)
  if (resultIndex < 0 || nonzeroIndex < resultIndex || evidenceIndex < nonzeroIndex || successIndex < evidenceIndex) {
    throw new Error("bounded gate Cargo result and acceptance-evidence flow drifted")
  }
  const diagnosticIndex = compactExecutable.indexOf("reportFailedGate(family, gate,", resultIndex)
  if (diagnosticIndex < resultIndex || nonzeroIndex < diagnosticIndex) {
    throw new Error("bounded gate must name a failing Cargo gate before relaying its exit code")
  }
  if (typeScriptExecutableSha256(executable) !== BOUNDED_GATE_EXECUTABLE_SHA256) {
    throw new Error("bounded gate executable control-flow digest drifted")
  }
}

interface SprintGateTable {
  readonly path: string
  readonly label: string
  readonly digest: string
  readonly required: readonly string[]
  /** Gate targets in the exact order the sprint must run them. */
  readonly orderedTargets: readonly string[]
  readonly featureLines: number
}

const S105_JOURNAL_GATE_TABLE: SprintGateTable = {
  path: "scripts/s105-journal-test.ts",
  label: "S105 journal",
  digest: S105_JOURNAL_TEST_EXECUTABLE_SHA256,
  required: [
    'const CRASH_PARENT_GATE = "ABDO_JOURNAL_CRASH_10K_PARENT_GATE"',
    'const MIGRATION_PARENT_GATE = "ABDO_JOURNAL_MIGRATION_PARENT_GATE"',
    'const RESTORE_PARENT_GATE = "ABDO_JOURNAL_RESTORE_100K_PARENT_GATE"',
    "const JOURNAL_PARENT_GATES = [CRASH_PARENT_GATE, MIGRATION_PARENT_GATE, RESTORE_PARENT_GATE] as const",
    'packageName: "abdo-journal"',
    'testTarget: "recovery_10k"',
    'testName: "crash_injection_ten_thousand_process_deaths"',
    'testTarget: "migration_atomicity"',
    'testName: "migration_interruption_is_atomic"',
    'testTarget: "restore_100k"',
    'testName: "restores_hundred_thousand_events_within_two_seconds"',
    'features: "test-hooks"',
    "const MIGRATION_GATE_TIMEOUT_MS = 5 * 60_000",
    "const RESTORE_GATE_TIMEOUT_MS = 5 * 60_000",
    "const CRASH_GATE_TIMEOUT_MS = 31 * 60_000",
    'label: "S105"',
    "export async function runS105JournalGate(",
    'name: "migration"',
    'name: "restore"',
    'name: "crash10k"',
    "S105_RESTORE_100K events=(\\d+) snapshot=(\\d+) tail=(\\d+)",
    "S105_RECOVERY_10K injections=(\\d+) lanes=(\\d+) phase_counts=",
    "S105_MIGRATION_ATOMICITY points=",
  ],
  orderedTargets: ['testTarget: "migration_atomicity"', 'testTarget: "restore_100k"', 'testTarget: "recovery_10k"'],
  featureLines: 3,
}

const S106_REDUCER_GATE_TABLE: SprintGateTable = {
  path: "scripts/s106-reducer-test.ts",
  label: "S106 reducer",
  digest: S106_REDUCER_TEST_EXECUTABLE_SHA256,
  required: [
    'const DETERMINISM_PARENT_GATE = "ABDO_REDUCER_DETERMINISM_PARENT_GATE"',
    'const TRANSITIONS_PARENT_GATE = "ABDO_REDUCER_TRANSITIONS_1M_PARENT_GATE"',
    "const REDUCER_PARENT_GATES = [DETERMINISM_PARENT_GATE, TRANSITIONS_PARENT_GATE] as const",
    'packageName: "abdo-kernel"',
    'testTarget: "determinism_1k"',
    'testName: "folding_one_trace_one_thousand_times_yields_one_fingerprint"',
    'testTarget: "transitions_1m"',
    'testName: "one_million_transitions_commit_no_illegitimate_effect"',
    'label: "S106"',
    "export async function runS106ReducerGate(",
    'name: "determinism"',
    'name: "transitions1m"',
    "S106_DETERMINISM replays=(\\d+) events=(\\d+) proposals=(\\d+) effects=(\\d+) fingerprint=([0-9a-f]{64})",
    "S106_TRANSITIONS_1M transitions=(\\d+) accepted=(\\d+) rejected=(\\d+) effects=(\\d+)",
    "Number(match[1]) !== 1_000",
    "transitions !== 1_000_000 || accepted + rejected !== transitions",
    "if (rejected < 1 || accepted < 1 || effects < 1)",
    "if (effects > accepted)",
  ],
  orderedTargets: ['testTarget: "determinism_1k"', 'testTarget: "transitions_1m"'],
  featureLines: 0,
}

const S107_SUPERVISOR_GATE_TABLE: SprintGateTable = {
  path: "scripts/s107-supervisor-test.ts",
  label: "S107 supervisor",
  digest: S107_SUPERVISOR_TEST_EXECUTABLE_SHA256,
  required: [
    'const CRASH_PARENT_GATE = "ABDO_RUNTIME_CRASH_BOUNDARIES_PARENT_GATE"',
    "const SUPERVISOR_PARENT_GATES = [CRASH_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "crash_boundaries"',
    'testTarget: "no_blind_retry"',
    'testName: "a_crash_at_every_boundary_never_dispatches_twice"',
    'testName: "an_unknown_outcome_can_never_be_turned_back_into_a_dispatch"',
    'features: "test-hooks"',
    'label: "S107"',
    "export async function runS107SupervisorGate(",
    'name: "crashBoundaries"',
    'name: "noBlindRetry"',
    "S107_CRASH_BOUNDARIES boundaries=(\\d+) distinct_states=(\\d+) resumable=(\\d+) unknown=(\\d+)",
    "if (distinctStates !== boundaries)",
    "not all distinguishable",
    "S107_NO_BLIND_RETRY dispatches=(\\d+) refusals=(\\d+) phases=(\\d+)",
    "if (boundaries < 7 || resumable + unknown + awaiting !== boundaries)",
    "if (unknown < 1 || resumable < 1 || awaiting < 1)",
    "if (Number(match[6]) !== 1)",
  ],
  orderedTargets: ['name: "crashBoundaries"', 'name: "noBlindRetry"'],
  featureLines: 2,
}

const S108_RECONCILE_GATE_TABLE: SprintGateTable = {
  path: "scripts/s108-reconcile-test.ts",
  label: "S108 reconcile",
  digest: S108_RECONCILE_TEST_EXECUTABLE_SHA256,
  required: [
    'const RECONCILE_PARENT_GATE = "ABDO_RUNTIME_RECONCILE_PARENT_GATE"',
    "const RECONCILE_PARENT_GATES = [RECONCILE_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "reconcile_sweep"',
    'testName: "a_mixed_population_reconciles_once_and_never_dispatches"',
    'features: "test-hooks"',
    'label: "S108"',
    "export async function runS108ReconcileGate(",
    'name: "sweep"',
    "S108_RECONCILE_SWEEP effects=(\\d+) unconfirmed=(\\d+) examined=(\\d+) evidenced=(\\d+)",
    "if (evidenced < 1 || compensated < 1 || escalated < 1)",
    "if (Number(match[8]) !== 0)",
    "blind retry must be zero",
    "if (Number(match[9]) !== 1)",
    "if (outstanding < escalated)",
  ],
  orderedTargets: ['name: "sweep"'],
  featureLines: 1,
}

const S109_SESSION_GATE_TABLE: SprintGateTable = {
  path: "scripts/s109-session-test.ts",
  label: "S109 session",
  digest: S109_SESSION_TEST_EXECUTABLE_SHA256,
  required: [
    'const SESSION_PARENT_GATE = "ABDO_RUNTIME_SESSION_PARENT_GATE"',
    "const SESSION_PARENT_GATES = [SESSION_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "session_steps"',
    'testName: "sessions_step_deterministically_with_one_writer_each"',
    'features: "test-hooks"',
    'label: "S109"',
    "export async function runS109SessionGate(",
    'name: "steps"',
    "S109_SESSION_STEPS sessions=(\\d+) turns=(\\d+) steps=(\\d+) rounds=(\\d+) snapshots=(\\d+)",
    "if (rounds < 1)",
    "if (snapshots < 1 || distinct !== snapshots)",
    "if (stagedChanges < 1)",
    "if (Number(match[8]) !== 0)",
    "reports a session with two writers",
    "if (Number(match[9]) !== 0)",
    "applied inside a live step",
  ],
  orderedTargets: ['name: "steps"'],
  featureLines: 1,
}

const S110_CONTROL_GATE_TABLE: SprintGateTable = {
  path: "scripts/s110-control-test.ts",
  label: "S110 control",
  digest: S110_CONTROL_TEST_EXECUTABLE_SHA256,
  required: [
    'const CONTROL_PARENT_GATE = "ABDO_RUNTIME_CONTROL_PARENT_GATE"',
    "const CONTROL_PARENT_GATES = [CONTROL_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "control_throughput"',
    'testName: "routing_loses_nothing_and_cancellation_stays_inside_its_budget"',
    'features: "test-hooks"',
    'label: "S110"',
    "export async function runS110ControlGate(",
    'name: "throughput"',
    "const REQUIRED_PER_SECOND = 500",
    "const CANCEL_P95_CEILING_US = 100_000",
    "S110_CONTROL offered=(\\d+) accepted=(\\d+) refused=(\\d+) displaced=(\\d+) lost=(\\d+)",
    "if (offered < 1_000 || accepted + refused !== offered)",
    "if (refused < 1)",
    "never exercised backpressure",
    "if (Number(match[5]) !== 0)",
    "reports lost messages",
    "if (highWater > capacity || capacity < 1)",
  ],
  orderedTargets: ['name: "throughput"'],
  featureLines: 1,
}

const S111_SCHEDULE_GATE_TABLE: SprintGateTable = {
  path: "scripts/s111-schedule-test.ts",
  label: "S111 schedule",
  digest: S111_SCHEDULE_TEST_EXECUTABLE_SHA256,
  required: [
    'const SCHEDULE_PARENT_GATE = "ABDO_RUNTIME_SCHEDULE_PARENT_GATE"',
    "const SCHEDULE_PARENT_GATES = [SCHEDULE_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "schedule_100k"',
    'testName: "a_hundred_thousand_decisions_never_overlap_a_write"',
    'features: "test-hooks"',
    'label: "S111"',
    "export async function runS111ScheduleGate(",
    'name: "decisions"',
    "const REQUIRED_DECISIONS = 100_000",
    "S111_SCHEDULE demands=(\\d+) admitted=(\\d+) batches=(\\d+) widest=(\\d+)",
    "if (checkedPairs < demands)",
    "for zero conflicts to mean anything",
    "if (conflicting !== 0)",
    "if (parallelBatches < 1 || widest < 2)",
    "if (serialized < 1)",
    "if (lanes < 2 || slowestFirstService > lanes)",
  ],
  orderedTargets: ['name: "decisions"'],
  featureLines: 1,
}

const S112_BUDGET_GATE_TABLE: SprintGateTable = {
  path: "scripts/s112-budget-test.ts",
  label: "S112 budget",
  digest: S112_BUDGET_TEST_EXECUTABLE_SHA256,
  required: [
    'const BUDGET_PARENT_GATE = "ABDO_RUNTIME_BUDGET_PARENT_GATE"',
    "const BUDGET_PARENT_GATES = [BUDGET_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "budget_fencing"',
    'testName: "stale_holders_never_mutate_and_budgets_stop_before_dispatch"',
    'features: "test-hooks"',
    'label: "S112"',
    "export async function runS112BudgetGate(",
    'name: "fencing"',
    "S112_BUDGET_FENCING scopes=(\\d+) rounds=(\\d+) revocations=(\\d+) stale_attempts=(\\d+)",
    "if (revocations < 1 || staleAttempts < 1)",
    "zero stale mutations is vacuous",
    "if (staleMutations !== 0)",
    "if (actionRefusals < 1 || tokenRefusals < 1)",
    "if (cleared < 1 || chargedActions !== cleared)",
  ],
  orderedTargets: ['name: "fencing"'],
  featureLines: 1,
}

const S113_AUTHORITY_GATE_TABLE: SprintGateTable = {
  path: "scripts/s113-authority-test.ts",
  label: "S113 authority",
  digest: S113_AUTHORITY_TEST_EXECUTABLE_SHA256,
  required: [
    'const AUTHORITY_PARENT_GATE = "ABDO_AUTHORITY_PARENT_GATE"',
    "const AUTHORITY_PARENT_GATES = [AUTHORITY_PARENT_GATE] as const",
    'packageName: "abdo-authority"',
    'testTarget: "authority_sweep"',
    'testName: "no_capability_crosses_a_scope_and_no_receipt_outlives_its_boot"',
    'label: "S113"',
    "export async function runS113AuthorityGate(",
    'name: "capabilities"',
    "S113_AUTHORITY scopes=(\\d+) capabilities=(\\d+) own_use=(\\d+) cross_attempts=(\\d+)",
    "if (Number(match[1]) < 2 || crossAttempts < capabilities)",
    "for zero to mean anything",
    "if (Number(match[5]) !== 0)",
    "crossing a scope boundary",
    '[7, "a restart"]',
    '[8, "a recycled PID"]',
    '[9, "another authority\'s key"]',
    '[10, "an altered receipt"]',
    "if (Number(match[11]) !== 0)",
  ],
  orderedTargets: ['name: "capabilities"'],
  featureLines: 0,
}

const S142_BRIDGE_GATE_TABLE: SprintGateTable = {
  path: "scripts/s142-bridge-test.ts",
  label: "S142 bridge",
  digest: S142_BRIDGE_TEST_EXECUTABLE_SHA256,
  required: [
    'const BRIDGE_PARENT_GATE = "ABDO_BRIDGE_PARENT_GATE"',
    "const BRIDGE_PARENT_GATES = [BRIDGE_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'buildPackage: "abdo-kernel-bin"',
    'testTarget: "bridge_gate"',
    'testName: "the_bridge_carries_one_effect_and_recovers_a_kill_as_an_unknown_outcome"',
    'features: "effectful-dispatch"',
    'label: "S142"',
    "export async function runS142BridgeGate(",
    'name: "bridge"',
    "S142_BRIDGE phases=(\\d+) verified=(\\d+) outcome_matched=(\\d+) malformations=(\\d+) refusals=(\\d+) killed_phases=(\\d+) replayed_phases=(\\d+)",
    "if (field(1) !== 7)",
    "does not show all seven phases in the ledger",
    "if (malformations < 4)",
    "if (field(5) !== malformations)",
    "if (field(6) !== 4)",
    "if (field(7) !== 4)",
    "advancing the ledger it may only read",
    "export async function verifyBridgeClient(",
    'if (refused.kind !== "backpressure")',
    'if (answered.kind !== "unreachable")',
    "the host's death was reported without a reason",
  ],
  orderedTargets: ['name: "bridge"'],
  featureLines: 1,
}

const S119_SURFACE_GATE_TABLE: SprintGateTable = {
  path: "scripts/s119-surface-test.ts",
  label: "S119 surfaces",
  digest: S119_SURFACE_TEST_EXECUTABLE_SHA256,
  required: [
    'const SURFACE_PARENT_GATE = "ABDO_SURFACE_PARENT_GATE"',
    "const SURFACE_PARENT_GATES = [SURFACE_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "surface_gate"',
    'testName: "a_surface_that_moved_admits_nothing_that_was_decided_before_it_did"',
    'label: "S119"',
    "export async function runS119SurfaceGate(",
    'name: "surfaces"',
    "S119_SURFACE surfaces=(\\d+) fresh_admitted=(\\d+) stale_attempts=(\\d+)",
    "if (field(2) !== surfaces)",
    "if (attempts < surfaces)",
    "for zero to mean anything",
    "if (field(4) !== 0)",
    '[5, "a navigation"]',
    '[6, "a window generation"]',
    '[7, "a view generation"]',
    '[8, "a withdrawn surface"]',
    "if (field(10) < 1)",
  ],
  orderedTargets: ['name: "surfaces"'],
  featureLines: 0,
}

const S118_SECRET_GATE_TABLE: SprintGateTable = {
  path: "scripts/s118-secret-test.ts",
  label: "S118 secrets",
  digest: S118_SECRET_TEST_EXECUTABLE_SHA256,
  required: [
    'const SECRET_PARENT_GATE = "ABDO_SECRET_PARENT_GATE"',
    "const SECRET_PARENT_GATES = [SECRET_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "secret_gate"',
    'testName: "no_decoy_secret_survives_a_full_lifecycle_and_revocation_is_one_number"',
    'label: "S118"',
    "export async function runS118SecretGate(",
    'name: "secrets"',
    "S118_SECRETS canaries=(\\d+) planted_found=(\\d+) journal_bytes=(\\d+)",
    "if (field(2) !== 1)",
    "so its zeroes mean nothing",
    "if (cleared < Math.floor(effects / 3))",
    "if (field(9) !== 0)",
    "if (field(10) !== 0)",
    "if (field(12) !== field(11) + 1)",
    "if (field(13) !== 0)",
    '[15, "the wrong consumer"]',
    '[16, "the wrong scope"]',
    '[17, "an expired lease"]',
    '[18, "a handle that was never issued"]',
  ],
  orderedTargets: ['name: "secrets"'],
  featureLines: 0,
}

const S117_WORKER_GATE_TABLE: SprintGateTable = {
  path: "scripts/s117-inventory-test.ts",
  label: "S117 worker",
  digest: S117_WORKER_TEST_EXECUTABLE_SHA256,
  required: [
    'const WORKER_PARENT_GATE = "ABDO_WORKER_PARENT_GATE"',
    "const WORKER_PARENT_GATES = [WORKER_PARENT_GATE] as const",
    'packageName: "abdo-tool-worker"',
    'testTarget: "worker_gate"',
    'testName: "worker_uses_the_canonical_catalog_and_fails_closed"',
    'label: "S117"',
    "export async function runS117WorkerGate(",
    'name: "worker"',
    "S117_WORKER specs=(\\d+) admitted=(\\d+) classes=(\\d+) partial=(\\d+) unavailable=(\\d+)",
    "if (field(3) !== 5)",
    "if (field(4) !== admitted || field(5) !== 0)",
    "if (field(6) !== 1)",
    "if (field(7) !== specs - admitted)",
    "if (field(8) < 2)",
    "export async function verifyToolInventory(",
    "report.implementations !== 6",
    "if (report.duplicated !== 0)",
  ],
  orderedTargets: ['name: "worker"'],
  featureLines: 0,
}

const S116_DISCLOSURE_GATE_TABLE: SprintGateTable = {
  path: "scripts/s116-disclosure-test.ts",
  label: "S116 disclosure",
  digest: S116_DISCLOSURE_TEST_EXECUTABLE_SHA256,
  required: [
    'const DISCLOSURE_PARENT_GATE = "ABDO_DISCLOSURE_PARENT_GATE"',
    "const DISCLOSURE_PARENT_GATES = [DISCLOSURE_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "disclosure_gate"',
    'testName: "a_snapshot_holds_still_while_a_step_sees_a_fraction_of_the_catalog"',
    'label: "S116"',
    "export async function runS116DisclosureGate(",
    'name: "disclosure"',
    "const REQUIRED_SAVING_PERMILLE = 600",
    "const REQUIRED_HIT_PERMILLE = 990",
    "S116_DISCLOSURE tools=(\\d+) snapshot=(\\d+) arrivals=(\\d+) late_visible=(\\d+)",
    "if (field(3) < 1)",
    "so a still snapshot proves nothing",
    "if (field(4) !== 0)",
    "if (field(5) !== tools)",
    "if (saved < REQUIRED_SAVING_PERMILLE)",
    "if (budget >= ceiling)",
    "if (medianRank * 4 >= budget)",
    "if (misses < 1)",
    "if (hitRate < REQUIRED_HIT_PERMILLE)",
  ],
  orderedTargets: ['name: "disclosure"'],
  featureLines: 0,
}

const S115_BROKER_GATE_TABLE: SprintGateTable = {
  path: "scripts/s115-broker-test.ts",
  label: "S115 broker",
  digest: S115_BROKER_TEST_EXECUTABLE_SHA256,
  required: [
    'const BROKER_PARENT_GATE = "ABDO_BROKER_PARENT_GATE"',
    "const BROKER_PARENT_GATES = [BROKER_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "broker_gate"',
    'testName: "ten_thousand_tools_resolve_fast_and_every_one_attests_what_was_enforced"',
    'label: "S115"',
    "export async function runS115BrokerGate(",
    'name: "broker"',
    "const P99_LOOKUP_BUDGET_NS = 100_000",
    "S115_BROKER tools=(\\d+) registered=(\\d+) catalog=(\\d+)",
    "if (tools < 10_000)",
    "if (worldChanging < 1 || withRecovery < 1 || withRecovery >= worldChanging)",
    '[6, "fully enforced"]',
    '[7, "partially enforced"]',
    '[8, "not enforceable"]',
    "if (field(6) + field(7) + field(8) !== registered)",
    '[10, "a schema offered with no handler"]',
    '[12, "irreversible work offered to a host that could not confine it"]',
    "if (p99 > P99_LOOKUP_BUDGET_NS)",
  ],
  orderedTargets: ['name: "broker"'],
  featureLines: 0,
}

const S114_POLICY_GATE_TABLE: SprintGateTable = {
  path: "scripts/s114-policy-test.ts",
  label: "S114 policy",
  digest: S114_POLICY_TEST_EXECUTABLE_SHA256,
  required: [
    'const POLICY_PARENT_GATE = "ABDO_POLICY_PARENT_GATE"',
    "const POLICY_PARENT_GATES = [POLICY_PARENT_GATE] as const",
    'packageName: "abdo-runtime"',
    'testTarget: "policy_gate"',
    'testName: "nothing_widens_its_own_authority_and_every_question_is_answered_in_the_ledger"',
    'label: "S114"',
    "export async function runS114PolicyGate(",
    'name: "policy"',
    "S114_POLICY effects=(\\d+) allowed=(\\d+) denied=(\\d+) asked=(\\d+) approved=(\\d+)",
    "if (allowed < 1 || denied < 1 || approved < 1)",
    '[6, "an operator who never answered"]',
    '[7, "an answer to a different question"]',
    '[8, "an answer that had already run out"]',
    '[10, "an operator who said no"]',
    "if (wideningAttempts < 4)",
    "for zero to mean anything",
    "if (widened !== 0)",
    '[11, "an approval presented after it expired"]',
    '[12, "an approval presented a second time"]',
    '[13, "an approval carried to different work"]',
    "if (refusedWidenings !== wideningAttempts)",
    "if (field(18) !== 0)",
    "if (field(20) !== allowed + approved)",
    "if (field(21) !== 0)",
  ],
  orderedTargets: ['name: "policy"'],
  featureLines: 0,
}

/**
 * Pin one sprint gate table: its markers, its exact targets and names, the
 * order it runs them in, and the digest of its control flow.
 */
function assertSprintGateTable(sources: readonly BoundarySource[], table: SprintGateTable) {
  const harness = requiredSource(sources, table.path)
  const executable = canonicalTypeScriptExecutable(table.path, harness)
  for (const required of table.required) {
    if (!harness.includes(required)) throw new Error(`${table.label} exact-gate harness shape drifted`)
  }
  let previousGateIndex = -1
  for (const target of table.orderedTargets) {
    const index = harness.indexOf(target)
    if (index <= previousGateIndex) throw new Error(`${table.label} gates must run in their declared order`)
    previousGateIndex = index
  }
  const featureLines = harness.match(/^\s+features: "[a-z-]+",$/gm)?.length ?? 0
  if (featureLines !== table.featureLines) {
    throw new Error(`${table.label} exact gates enable an unexpected feature set`)
  }
  if (typeScriptExecutableSha256(executable) !== table.digest) {
    throw new Error(`${table.label} executable control-flow digest drifted`)
  }
}

export async function verifyNoRetiredProbeConsumers() {
  const sources: BoundarySource[] = []
  const cargoConfigurationPaths: string[] = []
  await walkExecutableRepository(REPOSITORY_DIR, "", sources, cargoConfigurationPaths)
  assertNoCargoConfigurationPaths(cargoConfigurationPaths)
  assertNoRetiredProbeConsumers(sources)
  return { scannedFiles: sources.length, matches: 0, cargoConfigurationFiles: 0 }
}

export function assertNoCargoConfigurationPaths(paths: readonly string[]) {
  const configurations = paths.filter((path) => /(?:^|\/)\.cargo\/config[^/]*$/i.test(path.replaceAll("\\", "/")))
  if (configurations.length > 0) {
    throw new Error(`repository Cargo configuration can inject the S104 gate: ${configurations.join(", ")}`)
  }
}

export function assertNoRetiredProbeConsumers(sources: readonly BoundarySource[]) {
  if (sources.length < 250)
    throw new Error(`retired probe consumer guard scanned only ${sources.length} executable files`)
  const pathMappings = collectTypeScriptPathMappings(sources)
  const offenders = sources.filter((entry) => {
    if (entry.path === "scripts/s101-gate.ts") return false
    if (/\bKernelBoundaryClient\b|\babdo-kernel-(?:probe|stall-fixture)\b/.test(entry.source)) return true
    let specifiers: readonly string[] = []
    if (STATIC_MODULE_EXTENSIONS.has(extname(entry.path).toLowerCase())) {
      try {
        specifiers = extractStaticModuleSpecifiers(entry.source, extname(entry.path).toLowerCase())
      } catch (error) {
        throw new Error(
          `retired probe consumer lexical scan failed in ${entry.path}: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    for (const specifier of specifiers) {
      const normalized = specifier.replaceAll("\\", "/")
      if (RETIRED_PROBE_MODULE.test(normalized)) return true
      if (normalized.startsWith(".")) {
        const resolvedModule = relative(
          REPOSITORY_DIR,
          resolve(REPOSITORY_DIR, dirname(entry.path), normalized),
        ).replaceAll("\\", "/")
        if (RETIRED_PROBE_MODULE.test(resolvedModule)) return true
      }
      for (const mapping of pathMappings) {
        const wildcard = matchTypeScriptPathAlias(mapping.pattern, normalized)
        if (wildcard === undefined) continue
        for (const target of mapping.targets) {
          const substituted = target.replaceAll("*", wildcard).replaceAll("\\", "/")
          const resolvedTarget = relative(
            REPOSITORY_DIR,
            resolve(REPOSITORY_DIR, mapping.baseDirectory, substituted),
          ).replaceAll("\\", "/")
          if (RETIRED_PROBE_MODULE.test(substituted) || RETIRED_PROBE_MODULE.test(resolvedTarget)) return true
        }
      }
    }
    return false
  })
  if (offenders.length > 0) {
    throw new Error(`retired S101 probe has executable consumers: ${offenders.map((entry) => entry.path).join(", ")}`)
  }
}

function assertPackageManifest(sources: readonly BoundarySource[]) {
  const packageJson = requireRecord(JSON.parse(requiredSource(sources, "package.json")), "package.json")
  if (packageJson.name !== "@abdo/kernel" || packageJson.private !== true || packageJson.type !== "module") {
    throw new Error("kernel package identity drifted")
  }
  if (
    packageJson.description !==
    "Pinned Rust contracts, single-writer SQLite journal, and the engine-side control and approval clients"
  ) {
    throw new Error("kernel package description drifted")
  }
  const exportsValue = requireRecord(packageJson.exports, "package exports")
  if (
    JSON.stringify(exportsValue) !==
    JSON.stringify({
      ".": "./src/index.ts",
      "./contracts": "./src/contracts.ts",
      "./control": "./src/control.ts",
      "./approval": "./src/approval.ts",
      "./catalog": "./src/catalog.ts",
      "./host": "./src/host.ts",
    })
  ) {
    throw new Error("kernel contract export surface drifted")
  }
  if (packageJson.bin !== undefined || packageJson.workspaces !== undefined) {
    throw new Error("kernel package must not expose a JavaScript CLI or nested package workspace")
  }
  const dependencies =
    packageJson.dependencies === undefined ? {} : requireRecord(packageJson.dependencies, "dependencies")
  if (Object.keys(dependencies).length !== 0) throw new Error("kernel runtime dependencies must remain empty")
  const devDependencies = requireRecord(packageJson.devDependencies, "devDependencies")
  const expectedDevDependencies = ["@tsconfig/bun", "@types/bun", "@typescript/native-preview"].toSorted()
  if (JSON.stringify(Object.keys(devDependencies).toSorted()) !== JSON.stringify(expectedDevDependencies)) {
    throw new Error("kernel development dependency allowlist drifted")
  }
  const scripts = requireRecord(packageJson.scripts, "package scripts")
  const expectedScripts = {
    "contracts:check": "bun scripts/contracts.ts --check",
    "contracts:write": "bun scripts/contracts.ts --write",
    guard: "bun scripts/guard.ts",
    "journal:test": "bun scripts/s105-journal-test.ts",
    "rust:test": "bun scripts/rust-test.ts",
    test: "bun scripts/kernel-test.ts",
    typecheck: "tsgo --noEmit",
  }
  if (JSON.stringify(scripts) !== JSON.stringify(expectedScripts))
    throw new Error("kernel package scripts allowlist drifted")
}

function assertTypeScriptSource(entry: BoundarySource) {
  let masked: ReturnType<typeof maskTypeScriptStringsAndComments>
  try {
    masked = maskTypeScriptStringsAndComments(entry.source)
  } catch (error) {
    throw new Error(
      `TypeScript lexical guard failed in ${entry.path}: ${error instanceof Error ? error.message : error}`,
    )
  }
  const executableCode = `${masked.code}\n${extractTemplateExpressions(entry.source).join("\n")}`
  if (TYPESCRIPT_DYNAMIC_CAPABILITY.test(executableCode)) {
    throw new Error(`dynamic code capability in ${entry.path}`)
  }
  if (TYPESCRIPT_NETWORK_OR_PROCESS_CAPABILITY.test(executableCode)) {
    throw new Error(`network or unapproved process capability in ${entry.path}`)
  }
  if (TYPESCRIPT_AMBIENT_CAPABILITY_ESCAPE.test(executableCode)) {
    throw new Error(`ambient global capability escape in ${entry.path}`)
  }
  const imports = extractImportSpecifiers(masked)
  const allowedImports = [...(IMPORT_ALLOWLIST[entry.path] ?? [])].toSorted()
  if (JSON.stringify(imports.toSorted()) !== JSON.stringify(allowedImports)) {
    throw new Error(`TypeScript import allowlist drifted in ${entry.path}: ${JSON.stringify(imports)}`)
  }
  const bunMembers = [...executableCode.matchAll(/\bBun\s*\.\s*([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]!)
    .toSorted()
  const allowedBunMembers = [...(BUN_MEMBER_ALLOWLIST[entry.path] ?? [])].toSorted()
  if (JSON.stringify(bunMembers) !== JSON.stringify(allowedBunMembers)) {
    throw new Error(`Bun capability allowlist drifted in ${entry.path}: ${JSON.stringify(bunMembers)}`)
  }
  const bareBunCount = executableCode.match(/\bBun\b/g)?.length ?? 0
  if (bareBunCount !== bunMembers.length) throw new Error(`indirect Bun capability reference in ${entry.path}`)
}

function extractTemplateExpressions(source: string) {
  const expressions: string[] = []
  for (const match of source.matchAll(/\$\{([\s\S]*?)\}/g)) expressions.push(match[1]!)
  return expressions
}

function extractImportSpecifiers(masked: { readonly code: string; readonly literals: readonly string[] }) {
  const values: string[] = []
  const fromPattern =
    /^\s*(?:import|export)\s+(?:type\s+)?(?:\{[\s\S]*?\}|\*\s+as\s+[A-Za-z_$][\w$]*|\*)\s+from\s+__ABDO_STRING_(\d+)__\s*$/gm
  const sideEffectPattern = /^\s*import\s+__ABDO_STRING_(\d+)__\s*$/gm
  for (const match of masked.code.matchAll(fromPattern)) values.push(masked.literals[Number(match[1])]!)
  for (const match of masked.code.matchAll(sideEffectPattern)) values.push(masked.literals[Number(match[1])]!)
  return values
}

function extractStaticModuleSpecifiers(source: string, extension = ".ts") {
  const withoutShebang = source.replace(/^#![^\r\n]*(?:\r?\n|$)/, "")
  const scanner =
    extension === ".tsx"
      ? TSX_MODULE_SCANNER
      : extension === ".jsx"
        ? JSX_MODULE_SCANNER
        : extension === ".ts"
          ? TYPESCRIPT_MODULE_SCANNER
          : JAVASCRIPT_MODULE_SCANNER
  return scanner.scanImports(withoutShebang).map((entry) => entry.path)
}

function canonicalTypeScriptExecutable(path: string, source: string) {
  try {
    return TYPESCRIPT_MODULE_SCANNER.transformSync(source.replace(/^#![^\r\n]*(?:\r?\n|$)/, ""))
  } catch (error) {
    throw new Error(
      `S105 cannot canonicalize executable TypeScript in ${path}: ${error instanceof Error ? error.message : error}`,
    )
  }
}

function typeScriptExecutableSha256(executable: string) {
  return new Bun.CryptoHasher("sha256").update(executable).digest("hex")
}

interface TypeScriptPathMapping {
  readonly pattern: string
  readonly targets: readonly string[]
  readonly baseDirectory: string
}

interface TypeScriptConfigIdentity {
  readonly path: string
  readonly extendedConfigs: readonly string[]
  readonly mappings: readonly TypeScriptPathMapping[]
}

function collectTypeScriptPathMappings(sources: readonly BoundarySource[]) {
  const configs = new Map<string, TypeScriptConfigIdentity>()
  for (const entry of sources.filter((source) => TYPESCRIPT_CONFIG_FILE.test(source.path))) {
    let document: unknown
    try {
      document = Bun.JSONC.parse(entry.source)
    } catch {
      throw new Error(`retired probe consumer guard could not parse ${entry.path}`)
    }
    if (!isRecord(document)) throw new Error(`retired probe consumer guard expected an object in ${entry.path}`)
    const extendedConfigs =
      typeof document.extends === "string"
        ? [document.extends]
        : Array.isArray(document.extends) && document.extends.every((value) => typeof value === "string")
          ? document.extends
          : document.extends === undefined
            ? []
            : (() => {
                throw new Error(`retired probe consumer guard found invalid extends in ${entry.path}`)
              })()
    const mappings: TypeScriptPathMapping[] = []
    if (isRecord(document.compilerOptions)) {
      const compilerOptions = document.compilerOptions
      const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : "."
      const baseDirectory = resolve(REPOSITORY_DIR, dirname(entry.path), baseUrl)
      if (compilerOptions.paths !== undefined && !isRecord(compilerOptions.paths)) {
        throw new Error(`retired probe consumer guard found invalid paths in ${entry.path}`)
      }
      for (const [pattern, value] of Object.entries(isRecord(compilerOptions.paths) ? compilerOptions.paths : {})) {
        if (!Array.isArray(value) || !value.every((target) => typeof target === "string")) {
          throw new Error(`retired probe consumer guard found an invalid paths mapping in ${entry.path}`)
        }
        mappings.push({ pattern, targets: value, baseDirectory })
      }
    }
    configs.set(entry.path.replaceAll("\\", "/"), { path: entry.path, extendedConfigs, mappings })
  }

  const memo = new Map<string, readonly TypeScriptPathMapping[]>()
  const visit = (path: string, ancestors: ReadonlySet<string>): readonly TypeScriptPathMapping[] => {
    const cached = memo.get(path)
    if (cached) return cached
    if (ancestors.has(path)) throw new Error(`retired probe consumer guard found a tsconfig extends cycle at ${path}`)
    const config = configs.get(path)
    if (!config) return []
    const nextAncestors = new Set(ancestors).add(path)
    const inherited = config.extendedConfigs.flatMap((specifier) => {
      const base = resolveExtendedTypeScriptConfig(config.path, specifier, configs)
      return base ? visit(base, nextAncestors) : []
    })
    const combined = [...inherited, ...config.mappings]
    memo.set(path, combined)
    return combined
  }
  const mappings = [...configs.keys()].flatMap((path) => visit(path, new Set()))
  const unique = new Map<string, TypeScriptPathMapping>()
  for (const mapping of mappings) {
    unique.set(JSON.stringify([mapping.pattern, mapping.targets, mapping.baseDirectory]), mapping)
  }
  return [...unique.values()]
}

function resolveExtendedTypeScriptConfig(
  configPath: string,
  specifier: string,
  configs: ReadonlyMap<string, TypeScriptConfigIdentity>,
) {
  const normalized = specifier.replaceAll("\\", "/")
  if (!normalized.startsWith(".")) return undefined
  const absolute = resolve(REPOSITORY_DIR, dirname(configPath), normalized)
  const candidates = [absolute, `${absolute}.json`, join(absolute, "tsconfig.json")].map((candidate) =>
    relative(REPOSITORY_DIR, candidate).replaceAll("\\", "/"),
  )
  const match = candidates.find((candidate) => configs.has(candidate))
  if (!match) throw new Error(`retired probe consumer guard cannot resolve ${specifier} from ${configPath}`)
  return match
}

function matchTypeScriptPathAlias(pattern: string, specifier: string) {
  const wildcard = pattern.indexOf("*")
  if (wildcard === -1) return pattern === specifier ? "" : undefined
  if (pattern.indexOf("*", wildcard + 1) !== -1) return undefined
  const prefix = pattern.slice(0, wildcard)
  const suffix = pattern.slice(wildcard + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function assertBuiltinOnlyRustImports(path: string, source: string) {
  const allowedRoots = new Set([...RUST_BUILTIN_IMPORT_ROOTS, ...CONTRACT_LOCAL_IMPORT_ROOTS])
  if (path.includes("/src/bin/") || path.includes("/tests/")) allowedRoots.add("abdo_contracts")
  const roots = /\buse\s+(?:::)?([A-Za-z_][A-Za-z0-9_]*)(?=\s*(?:::|;|\{))/g
  for (const match of source.matchAll(roots)) {
    const root = match[1]!
    if (!allowedRoots.has(root)) throw new Error(`external Rust import root ${root} in ${path}`)
  }
}

function requiredSource(sources: readonly BoundarySource[], path: string) {
  const source = sources.find((entry) => entry.path === path)?.source
  if (source === undefined) throw new Error(`kernel guard did not scan ${path}`)
  return source
}

async function walkPackage(absoluteDirectory: string, relativeDirectory: string, files: string[]) {
  const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`kernel package may not contain symlinks: ${relativePath}`)
    if (entry.isDirectory()) {
      if (relativeDirectory === "" && IGNORED_PACKAGE_DIRECTORIES.has(entry.name)) continue
      await walkPackage(join(absoluteDirectory, entry.name), relativePath, files)
      continue
    }
    if (!entry.isFile()) throw new Error(`unsupported kernel package entry: ${relativePath}`)
    files.push(relativePath)
  }
}

async function walkExecutableRepository(
  absoluteDirectory: string,
  relativeDirectory: string,
  sources: BoundarySource[],
  cargoConfigurationPaths: string[],
) {
  const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (relativePath === "packages/kernel" || relativePath.startsWith("packages/kernel/")) continue
    if (entry.isSymbolicLink()) {
      if (IGNORED_REPOSITORY_DIRECTORIES.has(entry.name)) continue
      throw new Error(`retired probe consumer scan refuses an uninspected symlink: ${relativePath}`)
    }
    if (entry.isDirectory()) {
      if (IGNORED_REPOSITORY_DIRECTORIES.has(entry.name)) continue
      await walkExecutableRepository(
        join(absoluteDirectory, entry.name),
        relativePath,
        sources,
        cargoConfigurationPaths,
      )
      continue
    }
    if (!entry.isFile()) continue
    if (/(?:^|\/)\.cargo\/config[^/]*$/i.test(relativePath)) cargoConfigurationPaths.push(relativePath)
    if (
      !REPOSITORY_SOURCE_EXTENSIONS.has(extname(entry.name)) &&
      !REPOSITORY_CONFIG_FILES.has(basename(entry.name)) &&
      !TYPESCRIPT_CONFIG_FILE.test(relativePath)
    )
      continue
    sources.push({ path: relativePath, source: await Bun.file(join(absoluteDirectory, entry.name)).text() })
  }
}

function normalizedPackagePath(absolutePath: string) {
  const packagePath = relative(KERNEL_PACKAGE_DIR, resolve(absolutePath)).replaceAll("\\", "/")
  if (
    packagePath === ".." ||
    packagePath.startsWith("../") ||
    resolve(KERNEL_PACKAGE_DIR, packagePath) !== resolve(absolutePath)
  ) {
    throw new Error(`cargo target source escapes the kernel package: ${absolutePath}`)
  }
  return packagePath
}

function maskTypeScriptStringsAndComments(source: string) {
  const literals: string[] = []
  let code = ""
  let index = 0
  while (index < source.length) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      code += "\n"
      continue
    }
    if (character === "/" && next === "*") {
      index += 2
      while (index + 1 < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1
      if (index + 1 >= source.length) throw new Error("unterminated TypeScript block comment")
      index += 2
      code += " "
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character
      let literal = ""
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          literal += source[index]
          index += 1
          if (index >= source.length) break
        }
        literal += source[index]
        index += 1
      }
      if (source[index] !== quote) throw new Error("unterminated TypeScript string")
      index += 1
      const literalIndex = literals.push(literal) - 1
      code += ` __ABDO_STRING_${literalIndex}__ `
      continue
    }
    code += character
    index += 1
  }
  return { code, literals }
}

function stripRustCfgTestModules(source: string) {
  const pattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/g
  let result = source
  while (true) {
    pattern.lastIndex = 0
    const match = pattern.exec(result)
    if (!match) return result
    const openBrace = result.lastIndexOf("{", match.index + match[0].length)
    const closeBrace = findMatchingRustBrace(result, openBrace)
    const removed = result.slice(match.index, closeBrace + 1)
    result = `${result.slice(0, match.index)}${"\n".repeat(removed.match(/\n/g)?.length ?? 0)}${result.slice(closeBrace + 1)}`
  }
}

function findMatchingRustBrace(source: string, openBrace: number) {
  let depth = 0
  let index = openBrace
  while (index < source.length) {
    const next = skipRustComment(source, index)
    if (next !== index) {
      index = next
      continue
    }
    const literal = rustStringLiteralAt(source, index)
    if (literal) {
      index = literal.end
      continue
    }
    const characterEnd = rustCharacterLiteralEnd(source, index)
    if (characterEnd !== index) {
      index = characterEnd
      continue
    }
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  throw new Error("unterminated cfg(test) Rust module")
}

function extractDecodedRustStringLiterals(source: string) {
  const values: string[] = []
  let index = 0
  while (index < source.length) {
    const next = skipRustComment(source, index)
    if (next !== index) {
      index = next
      continue
    }
    const literal = rustStringLiteralAt(source, index)
    if (literal) {
      values.push(literal.value)
      index = literal.end
      continue
    }
    const characterEnd = rustCharacterLiteralEnd(source, index)
    index = characterEnd === index ? index + 1 : characterEnd
  }
  return values
}

function skipRustComment(source: string, index: number) {
  if (source[index] !== "/") return index
  if (source[index + 1] === "/") {
    const newline = source.indexOf("\n", index + 2)
    return newline === -1 ? source.length : newline + 1
  }
  if (source[index + 1] !== "*") return index
  let depth = 1
  let cursor = index + 2
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      depth += 1
      cursor += 2
    } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
      depth -= 1
      cursor += 2
    } else cursor += 1
  }
  if (depth !== 0) throw new Error("unterminated Rust block comment")
  return cursor
}

function rustStringLiteralAt(source: string, index: number) {
  const raw = source.slice(index).match(/^(?:b)?r(#{0,16})\x22/)
  if (raw) {
    const contentStart = index + raw[0].length
    const terminator = `"${raw[1]!}`
    const contentEnd = source.indexOf(terminator, contentStart)
    if (contentEnd === -1) throw new Error("unterminated Rust raw string")
    return { end: contentEnd + terminator.length, value: source.slice(contentStart, contentEnd) }
  }
  const prefixLength = source[index] === "b" && source[index + 1] === '"' ? 1 : 0
  if (source[index + prefixLength] !== '"') return undefined
  const contentStart = index + prefixLength + 1
  let cursor = contentStart
  while (cursor < source.length && source[cursor] !== '"') {
    if (source[cursor] === "\\") cursor += 1
    cursor += 1
  }
  if (source[cursor] !== '"') throw new Error("unterminated Rust string")
  return { end: cursor + 1, value: decodeRustStringEscapes(source.slice(contentStart, cursor)) }
}

function rustCharacterLiteralEnd(source: string, index: number) {
  if (source[index] !== "'") return index
  let cursor = index + 1
  if (source[cursor] === "\\") cursor += 2
  else cursor += 1
  return source[cursor] === "'" ? cursor + 1 : index
}

function decodeRustStringEscapes(value: string) {
  let decoded = ""
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character !== "\\") {
      decoded += character
      continue
    }
    const escape = value[++index]
    if (escape === undefined) throw new Error("trailing Rust string escape")
    const simple: Readonly<Record<string, string>> = {
      "0": "\0",
      "\\": "\\",
      '"': '"',
      "'": "'",
      n: "\n",
      r: "\r",
      t: "\t",
    }
    if (Object.hasOwn(simple, escape)) {
      decoded += simple[escape]!
      continue
    }
    if (escape === "x") {
      const hex = value.slice(index + 1, index + 3)
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error("invalid Rust hexadecimal string escape")
      decoded += String.fromCharCode(Number.parseInt(hex, 16))
      index += 2
      continue
    }
    if (escape === "u") {
      const match = /^\{([0-9A-Fa-f_]{1,7})\}/.exec(value.slice(index + 1))
      if (!match) throw new Error("invalid Rust Unicode string escape")
      const digits = match[1]!.replaceAll("_", "")
      const codePoint = Number.parseInt(digits, 16)
      if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
        throw new Error("Rust Unicode string escape is outside the scalar range")
      }
      decoded += String.fromCodePoint(codePoint)
      index += match[0].length
      continue
    }
    if (escape === "\n" || (escape === "\r" && value[index + 1] === "\n")) {
      if (escape === "\r") index += 1
      while (/\s/.test(value[index + 1] ?? "")) index += 1
      continue
    }
    throw new Error(`unsupported Rust string escape \\${escape}`)
  }
  return decoded
}

function maskRustNonCode(source: string) {
  let output = ""
  let index = 0
  while (index < source.length) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      output += "\n"
      continue
    }
    if (character === "/" && next === "*") {
      index += 2
      let depth = 1
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1
          index += 2
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1
          index += 2
        } else index += 1
      }
      if (depth !== 0) throw new Error("unterminated Rust block comment")
      output += " "
      continue
    }
    if (character === "r") {
      const raw = source.slice(index).match(/^r(#{0,16})\x22/)
      if (raw) {
        const terminator = `"${raw[1]!}`
        index += raw[0].length
        const end = source.indexOf(terminator, index)
        if (end === -1) throw new Error("unterminated Rust raw string")
        index = end + terminator.length
        output += " "
        continue
      }
    }
    const characterLiteralEnd = character === "'" ? source.indexOf("'", index + 1) : -1
    const isCharacterLiteral = character === "'" && characterLiteralEnd > index + 1 && characterLiteralEnd <= index + 5
    if (character === '"' || isCharacterLiteral) {
      const quote = character
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1
        index += 1
      }
      if (source[index] !== quote) throw new Error("unterminated Rust literal")
      index += 1
      output += " "
      continue
    }
    output += character
    index += 1
  }
  return output
}

function parseTomlRecord(source: string, name: string) {
  try {
    return requireRecord(Bun.TOML.parse(source), name)
  } catch (error) {
    throw new Error(`${name} is not valid TOML: ${error instanceof Error ? error.message : error}`)
  }
}

function assertExactSemantic(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(canonicalValue(actual)) !== JSON.stringify(canonicalValue(expected))) throw new Error(message)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

function requireStringArray(value: unknown, name: string) {
  return requireArray(value, name).map((item) => requireString(item, name))
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

if (import.meta.main) {
  const result = await verifyBoundaryGuards()
  console.log(
    `S104 kernel guard passed: ${result.scannedFiles} exact package files; one dependency-free Cargo package; zero dependency edges; ${result.s104ContractsBoundary.rustFiles.length} guarded Rust sources; ${result.externalConsumerScan.scannedFiles} external executable/config files; retired probe consumers 0`,
  )
}
