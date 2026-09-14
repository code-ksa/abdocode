# CL-16A2-C/D - the ONE build command for abdo-winiso.
#
# WHAT THIS BUILD ACTUALLY GUARANTEES, stated precisely (P5c2-FINAL-RC2 sec 3).
#
# NOTE ON THE MISSING SECTION SIGN: this line once read "section 3" as a single
# non-ASCII glyph, and that alone failed `harness-invariants.test.ts` in the RC2
# round. The ASCII rule below is not stylistic - PowerShell 5.1 once could not
# PARSE this file because of one such character - and it applies to comments too.
#
#   - The source inputs are HASHED: every file cargo compiled into this binary,
#     taken from cargo's own dep-info, plus Cargo.toml and Cargo.lock.
#   - The resulting artefact is PINNED by SHA-256 in the manifest.
#   - The manifest therefore verifies THE EXACT ARTEFACT THAT WAS BUILT.
#   - Byte-for-byte reproducibility is NOT CURRENTLY PROVEN.
#
# This header used to say "Reproducible by construction", reasoning from a pinned
# toolchain, --offline, an empty locked dependency graph and no build.rs. Those
# inputs are all real, but the conclusion was never measured and is FALSE as
# stated: three `cargo clean` + build cycles over a byte-identical source tree
# produced three different binaries (97852080..., 0e022302..., 84928007...) at an
# identical 1,019,904 bytes. Something non-deterministic is embedded; a PE
# TimeDateStamp is the usual cause.
#
# The distinction matters for what a verifier may conclude. `helperBinaryHash`
# pins THIS artefact, not "whatever any build of this source would produce", so
# provenance CANNOT be confirmed by rebuilding and comparing hashes. The trust
# decision is unchanged and does not depend on reproducibility: binary hash,
# source hash, protocol version and manifest identity.
#
# Making the build bit-reproducible is tracked as independent release debt after
# Mega Sprint 1. It is deliberately NOT attempted here.
#
# WHY windows-gnu AND NOT msvc: CL-11.5A measured that link.exe on this machine's
# PATH is GNU coreutils' link shipped by Git, not the MSVC linker, so an msvc
# build fails at link time for a reason unrelated to this code. The gnu
# toolchain brings its own linker.
#
# THE SOURCE SET IS ASKED OF CARGO, NEVER GLOBBED. This script used to hash
# `src/*.rs` wholesale. `src/hostile-target.rs` is a SEPARATE [[bin]] (the
# deliberately hostile test target) and cannot change a single byte of
# abdo-winiso.exe, but it sat in the recorded inputs anyway. Editing it made the
# staleness guard below declare the trusted binary out of date; cargo then
# (correctly) refused to relink a binary nothing in its graph had touched, so the
# build could not be repaired except by `cargo clean --release`. That is a
# manifest which is not reproducible, and it blocked a whole measured round.
#
# The authority is now `target/release/abdo-winiso.d`, the dep-info cargo itself
# writes: the exact closure of files that were compiled INTO this binary. Add a
# module to main.rs and it appears; add an unrelated [[bin]] and it does not.
# Files under src/ that the closure excludes are recorded as such rather than
# dropped silently, because a hash that quietly stops covering a file is the
# failure this whole package exists to refuse.
#
# THIS SCRIPT IS DELIBERATELY PLAIN ASCII. An earlier version contained an
# em-dash and a '<' inside a double-quoted string; Windows PowerShell 5.1 failed
# to PARSE the file, printed the error text of the very guard it never reached,
# and left the previous binary in place. A build script that cannot run must not
# look like a build script that passed.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$toolchain = "stable-x86_64-pc-windows-gnu"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$rustc = Join-Path $env:USERPROFILE ".cargo\bin\rustc.exe"
$bin = "target/release/abdo-winiso.exe"
$depInfo = "target/release/abdo-winiso.d"
$fixtureBin = "target/release/abdo-hostile-target.exe"
$fixtureDepInfo = "target/release/abdo-hostile-target.d"

function Sha256File([string]$p) {
  $stream = [System.IO.File]::OpenRead($p)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "") }
    finally { $sha.Dispose() }
  }
  finally { $stream.Dispose() }
}

# WHAT THE BINARY WAS BEFORE. A build that cannot replace a locked exe still
# looks fine if you only read a message, and the measurement that follows then
# runs the PREVIOUS code. That happened: a run printed a success line while cargo
# had failed with "failed to remove file", and the results described a binary
# that no longer existed in source.
$beforeHash = if (Test-Path -LiteralPath $bin) { Sha256File $bin } else { "" }

# ---------------------------------------------------------------- 1. THE BUILD
#
# The trusted artefact is built BY NAME. `--bin abdo-winiso` keeps the hostile
# test fixture out of this command entirely, so a failure here can only ever be
# about the binary whose identity this manifest is going to vouch for.
#
# --offline is the load-bearing flag: the build must not be able to fetch.
& $cargo "+$toolchain" build --release --locked --offline --bin abdo-winiso
if ($LASTEXITCODE -ne 0) {
  throw "BUILD FAILED: cargo exited $LASTEXITCODE building abdo-winiso. The binary on disk is NOT this source."
}
if (-not (Test-Path -LiteralPath $bin)) { throw "BUILD FAILED: expected $bin to exist after the build" }

# The hostile target is a TEST FIXTURE and is built as a second, separate step so
# that it is obvious it is not part of the trusted artefact. Its hash is recorded
# below under its own key; nothing in the launch path can reach it.
& $cargo "+$toolchain" build --release --locked --offline --bin abdo-hostile-target
if ($LASTEXITCODE -ne 0) {
  throw "BUILD FAILED: cargo exited $LASTEXITCODE building the abdo-hostile-target test fixture."
}

# ------------------------------------------- 2. THE EFFECTIVE SOURCE SET, FROM CARGO
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\')

# The closure is computed by a FUNCTION because there are now TWO artefacts that
# need one: the trusted helper, and the hostile test fixture the authoritative
# security tests execute. RC3 section 2: the fixture used to have only a binary
# hash recorded, so editing hostile-target.rs invalidated NOTHING - the field moved
# only if somebody happened to rebuild, and no gate ever checked it. A test that
# proves a target cannot escape its cage is worth exactly as much as the identity
# of the target binary, so the fixture gets a record of the same shape.
function SourceClosure([string]$depInfoPath, [string]$binaryPath, [string]$label) {
  if (-not (Test-Path -LiteralPath $depInfoPath)) {
    throw "BUILD FAILED: cargo wrote no dep-info at $depInfoPath. The $label manifest must not GUESS what the binary was built from."
  }
  $binFull = (Resolve-Path -LiteralPath $binaryPath).Path
  $deps = New-Object System.Collections.Generic.List[string]
  foreach ($line in (Get-Content -LiteralPath $depInfoPath)) {
    $sep = $line.IndexOf(": ")
    if ($sep -lt 1) { continue }
    # Only the rule whose target IS this binary. The file can carry other rules.
    if ($line.Substring(0, $sep) -ne $binFull) { continue }
    # GNU make dep-info escapes a literal space in a path as "\ " and nothing else.
    foreach ($p in ($line.Substring($sep + 2) -split '(?<!\\) ')) {
      $q = $p.Replace('\ ', ' ').Trim()
      if ($q -ne "") { [void]$deps.Add($q) }
    }
  }
  if ($deps.Count -eq 0) {
    throw "BUILD FAILED: no dependency rule for $binFull in $depInfoPath. An empty source closure would make the $label manifest vacuous."
  }
  # EVERY PATH IS PROVED, not assumed. If the split above ever mangles a path (a
  # directory with a space, a dep-info format change), this is a loud failure
  # instead of a source input that silently stops being hashed.
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($d in $deps) {
    if (-not (Test-Path -LiteralPath $d -PathType Leaf)) {
      throw "BUILD FAILED: cargo dep-info names a source that is not a readable file: '$d'. The $label source closure could not be parsed."
    }
    $full = (Resolve-Path -LiteralPath $d).Path
    if (-not $full.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "BUILD FAILED: dep-info names '$full', which is outside this package. The manifest only describes sources it owns."
    }
    [void]$out.Add($full.Substring($root.Length + 1).Replace('\', '/'))
  }
  return $out
}

# A source hash over a set of inputs, in a fixed order. Shared by both artefacts so
# neither can drift into a different hashing convention from the other.
function SourceSetHash($inputList) {
  $acc = ""
  foreach ($f in $inputList) { $acc += "$f`n$(Sha256File $f)`n" }
  $t = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($t, $acc)
  $h = Sha256File $t
  Remove-Item -LiteralPath $t
  return $h
}

$deps = SourceClosure $depInfo $bin "helper"

# Inputs that change compilation without appearing in dep-info. Only the ones
# that actually exist are recorded, so the list never claims to cover a file that
# is not there.
#
# KNOWN LIMITATION, recorded rather than implied: this looks for cargo
# configuration RELATIVE TO THIS PACKAGE only. Cargo also reads config from
# ancestor directories and from $CARGO_HOME, so a change there could alter the
# build without altering `helperSourceHash`. The pinned `rustToolchainIdentity`,
# `rustcVersion` and `--locked --offline` constrain the build in practice;
# widening the search is separate work with its own failure modes.
$configInputs = @("Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain.toml", "rust-toolchain", ".cargo/config.toml", ".cargo/config")
$present = @($configInputs | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
$inputs = @(@($present) + @($deps) | Sort-Object -Unique)

# NOTHING IS DROPPED QUIETLY. Anything under src/ that the closure excludes is
# named in the manifest with its own hash, so "not covered" is a recorded fact a
# reader can check rather than an absence they have to notice.
$allSrc = @(Get-ChildItem src -Filter *.rs | Sort-Object Name | ForEach-Object { "src/$($_.Name)" })
$excluded = @($allSrc | Where-Object { $inputs -notcontains $_ })
$excludedRecord = [ordered]@{}
foreach ($e in $excluded) { $excludedRecord[$e] = Sha256File $e }

# Source hash over every input that can change behaviour, in a fixed order.
$sourceHash = SourceSetHash $inputs

# ------------------------------- 2b. THE HOSTILE TEST FIXTURE, PINNED SEPARATELY
#
# RC3 section 2. `abdo-hostile-target.exe` is NOT a trusted artefact and nothing in
# the launch path can reach it, but the authoritative security tests EXECUTE it:
# "a target inside an AppContainer cannot open its own keeper" is a claim about
# that specific program. So it gets its own full record - path, bytes, binary hash,
# source closure, source hash, toolchain - rather than being forced into the
# helper's manifest as a false dependency.
#
# The consequence that matters: editing `src/hostile-target.rs` changes
# `hostileTargetSourceHash` and, after a rebuild, `hostileTargetBinaryHash`, EVEN
# THOUGH `abdo-winiso.exe` is untouched. Under the old scheme it changed nothing a
# gate could see.
if (-not (Test-Path -LiteralPath $fixtureBin)) {
  throw "BUILD FAILED: expected the test fixture $fixtureBin to exist after its build step."
}
$fixtureDeps = SourceClosure $fixtureDepInfo $fixtureBin "hostile-target"
$fixtureInputs = @(@($present) + @($fixtureDeps) | Sort-Object -Unique)
$fixtureSourceHash = SourceSetHash $fixtureInputs
$fixtureBinTime = (Get-Item -LiteralPath $fixtureBin).LastWriteTimeUtc
$fixtureNewestSource = ($fixtureInputs | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object | Select-Object -Last 1)
if ($fixtureBinTime -lt $fixtureNewestSource) {
  $n = ($fixtureInputs | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Select-Object -Last 1)
  throw "BUILD FAILED: $fixtureBin is older than its newest source ($n). The fixture the security tests execute would not be this source."
}

# ------------------------------------------------------------- 3. THE STALENESS GUARD
#
# STALENESS IS A FAILURE, NOT A WARNING. If the artefact predates an input that
# went INTO it, cargo did not manage to rewrite it (a running helper or server
# holding the file is the usual cause) and every measurement taken afterwards
# would describe the wrong code. Because the set is now the real closure, this
# also catches an effective source edited WHILE the build ran, and it can no
# longer be tripped by a file belonging to a different binary.
$binTime = (Get-Item -LiteralPath $bin).LastWriteTimeUtc
$newestSource = ($inputs | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object | Select-Object -Last 1)
if ($binTime -lt $newestSource) {
  $newestName = ($inputs | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Select-Object -Last 1)
  $msg = "BUILD FAILED: {0} is older than its newest source ({1}). binary={2:o} source={3:o}. " -f $bin, $newestName, $binTime, $newestSource
  $msg += "The old binary is still in place, most likely because a helper or server process is holding it. "
  $msg += "Stop them and rebuild. Do NOT measure with this."
  throw $msg
}
$afterHash = Sha256File $bin

$rustcVersion = (& $rustc "+$toolchain" -vV) -join "`n"

# ---------------------------------------------------------------- 4. THE MANIFEST
#
# THE PROTOCOL VERSION IS READ FROM THE SOURCE, NEVER RETYPED HERE.
#
# It used to be the literal 2 on the line below. When the helper moved to 3 the
# manifest kept saying 2, so the manifest described a binary that did not exist
# and seven identity tests failed for a reason unrelated to what they test. A
# constant duplicated in two files is a constant that will disagree with itself;
# the only safe copy is the one derived from the original.
$protoMatch = [regex]::Match((Get-Content "src/main.rs" -Raw), 'PROTOCOL_VERSION:\s*u32\s*=\s*(\d+)')
if (-not $protoMatch.Success) {
  throw "BUILD FAILED: could not read PROTOCOL_VERSION from src/main.rs. The manifest must not guess it."
}
$protocolVersion = [int]$protoMatch.Groups[1].Value

$manifest = [ordered]@{
  helperProtocolVersion = $protocolVersion
  helperSourceHash      = $sourceHash
  helperSourceInputs    = $inputs
  # Provenance of the line above, so a reader never has to guess whether the set
  # was measured or globbed.
  helperSourceInputsFrom = "cargo dep-info: $depInfo"
  # Under src/ but provably not compiled into this binary, with hashes so the
  # claim is checkable.
  helperSourceExcluded  = $excludedRecord
  helperBinaryHash      = $afterHash
  helperBinaryWasHash   = $beforeHash
  helperBinaryBytes     = (Get-Item -LiteralPath $bin).Length
  helperBinaryUtc       = $binTime.ToString("o")
  newestSourceUtc       = $newestSource.ToString("o")
  # NOT A TRUSTED ARTEFACT. Recorded so a round can show which fixture it ran.
  # THE HOSTILE TEST FIXTURE, as its own artefact record (RC3 section 2). Kept
  # under distinct `hostileTarget*` keys so no reader can mistake it for part of
  # the trusted helper closure, and so a change to its source invalidates ITS
  # record without touching the helper's.
  hostileTargetBinaryPath   = $fixtureBin
  hostileTargetBinaryHash   = Sha256File $fixtureBin
  hostileTargetBytes        = (Get-Item -LiteralPath $fixtureBin).Length
  hostileTargetBinaryUtc    = $fixtureBinTime.ToString("o")
  hostileTargetSourceHash   = $fixtureSourceHash
  hostileTargetSourceInputs = $fixtureInputs
  hostileTargetSourceInputsFrom = "cargo dep-info: $fixtureDepInfo"
  hostileTargetToolchain    = $toolchain
  hostileTargetBuildCommand = "cargo +$toolchain build --release --locked --offline --bin abdo-hostile-target"
  rustToolchainIdentity = $toolchain
  rustcVersion          = $rustcVersion
  buildCommand          = "cargo +$toolchain build --release --locked --offline --bin abdo-winiso"
  supportedOSBuild      = [System.Environment]::OSVersion.Version.ToString()
  builtAtUtc            = (Get-Date).ToUniversalTime().ToString("o")
}
$json = $manifest | ConvertTo-Json -Depth 5
# WriteAllText, not Out-File: Windows PowerShell 5.1's -Encoding utf8 emits a
# BOM and JSON.parse rejects it.
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "helper-manifest.json"), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Output $json
Write-Output "BUILD VERIFIED: binary rebuilt, manifest regenerated, and newer than every source it was built from"
