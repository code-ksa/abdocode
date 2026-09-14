# abdo-winiso — CL-16A2-C measurement helper

A **spike instrument**, not a production component. It exists to answer one
question with evidence:

> Can Windows run a process with **no network at all**, for that run only,
> without administrator rights, without a firewall rule, without a proxy, and
> without leaving anything behind on the machine?

It is deliberately **not wired** to `shell.ts`, to `launchControlledProcess`, to
any package manager, or to any provider subprocess. Wiring it is a separate
integration slice that happens only if this one produces Outcome A.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

`cargo +stable-x86_64-pc-windows-gnu build --release --locked --offline`

- **No crates.** Every Win32 call is declared by hand in `src/win.rs` against
  std. A dependency would mean a build-time network fetch and a supply chain
  this slice has not measured.
- **No `build.rs`.** Nothing executes at build time.
- **windows-gnu, not msvc.** CL-11.5A measured that `link.exe` on this machine's
  PATH is GNU coreutils' `link` shipped by Git, not the MSVC linker. The gnu
  toolchain brings its own.

`build.ps1` writes `helper-manifest.json` with `helperSourceHash`,
`helperBinaryHash`, `rustToolchainIdentity`, `rustcVersion`,
`helperProtocolVersion` and `supportedOSBuild` — the identities a future
integration would have to re-verify before trusting the binary.

## Protocol

One JSON object on stdout, always, including on failure. The child's own output
is a **string field**, escaped — a program that prints JSON cannot forge a field
(`json.rs` has the test).

```
abdo-winiso version
abdo-winiso probe
abdo-winiso derive-sid     --name <name>
abdo-winiso create-profile --name <name>
abdo-winiso delete-profile --name <name>
abdo-winiso run --name <name> [--mode appcontainer|plain] [--sid-source create|derive]
                [--no-job] [--keep-profile] [--timeout-ms N] [--cwd DIR]
                -- <program> [args...]
```

### Rules the protocol enforces

- **Zero capabilities, with no flag to add any.** There is no `--capability`
  option and no way to pass a raw SID or capability structure. Granting
  `internetClient` would make the network tests pass and prove nothing, so the
  ability to do it is absent rather than merely unused.
- **Separated argv.** Everything after `--` is an argument. The single string
  `CreateProcessW` requires is built by `cmdline::quote_arg` under the
  `CommandLineToArgvW` rules. No caller text is concatenated into a shell
  command, and the helper never invokes `cmd.exe /c`.
- **Validated input.** The profile name — the only caller string that reaches a
  security API — must be 1..=64 characters of `[A-Za-z0-9._-]`: no separators,
  no wildcards. Timeouts are bounded to 600 s.
- **Suspended, assigned, resumed.** The child is created `CREATE_SUSPENDED`,
  placed in the Job Object, and only then resumed, so it cannot spawn a
  grandchild before the job is attached.
- **Bounded capture.** 1 MiB per stream, with a `truncated` flag. Both pipes are
  drained on their own threads and keep draining past the cap, because stopping
  the read would block the child on a full pipe.
- **`--mode plain` is the control.** The same helper, the same pipes, the same
  job — only the AppContainer is absent. A vector that fails in `plain` proves
  nothing about the AppContainer.
