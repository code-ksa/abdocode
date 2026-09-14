//! `abdo-kernel`: the kernel, reachable.
//!
//! # Why this exists
//!
//! The kernel was finished and nobody called it. `@abdo/kernel` was consumed by
//! one TypeScript file, for its generated types only; no process ever asked the
//! supervisor for anything. This binary is the door: it opens the journal once,
//! holds the trusted pieces, and speaks contract frames on standard input and
//! standard output.
//!
//! The public binary is a thin wrapper around this runtime-owned host, so the
//! executable depends only on `abdo-runtime` and cannot grow a second kernel.
//!
//! # What separates it from the tool worker
//!
//! The bounded worker answers one frame and exits. This one lives:
//! it reads a frame and replies with a frame until standard input closes. The
//! consequence is that the bounded read is per frame rather than per process —
//! a process-lifetime bound on a loop is not a bound.
//!
//! # What it will not do
//!
//! It performs one effect: reading an object it was told about before the
//! engine spoke. There is no path in [`EffectRequest`], so naming a file is not
//! something a caller can do; naming a binding this host already holds is. The
//! difference is the whole security property, and it is a property of the
//! message rather than of a check somebody remembered to write.
//!
//! It holds no [`abdo_runtime::Vault`]. A read needs no secret, and a vault
//! held but never consulted is a field that makes a host look more careful than
//! it is.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    DispatchOutcome, Dispatcher, EffectSupervisor, Gatekeeper, KernelAuthority, NoOperator,
    NoSandbox, Recovered, RuntimeError, Settlement, ToolCatalog, ToolLease, Verification,
};
use abdo_authority::{
    Authority, BootIdentity, Capability, CapabilityId, CapabilityRequest, ProcessIdentity,
    SealingKey,
};
use abdo_contracts::{
    decode_frame, decode_frame_header, encode_frame, label_digest, Digest, EffectClass,
    EffectDeclined, EffectOutcome, EffectRequest, EffectUnresolved, EffectVerified, EventId,
    FilesystemHandle, IntentId, ReadEffect, ResourceLimits, Scope, TargetRef, ToolId, ToolSpec,
    FRAME_HEADER_LEN,
};
use abdo_journal::{ChainHash, Journal, StreamId};
use abdo_kernel::EffectIntent;
use abdo_policy::{Policy, Risk};
use sha2::{Digest as _, Sha256};

/// The one operation this host will discharge.
///
/// Derived here rather than accepted from the caller. An engine that could name
/// its own operation digest would be naming the rule policy judges it by, and
/// the risk band assigned to an unknown operation is a band nobody assigned.
const READ_OBJECT: &[u8] = b"read-bound-object";

/// Domain separation for the digest of what was read.
const READ_CONTENT_DOMAIN: &[u8] = b"ABDO/KERNEL-HOST/READ-OBJECT/1\0";

/// The stream every effect this host discharges is anchored to.
const HOST_STREAM: u128 = 0x5142;

/// The one tool in the catalog.
const READ_TOOL: u128 = 1;

/// How much of an object this host will read, and hold in memory, at once.
const READ_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

/// Exit status for a host that was asked to stop after committing a dispatch
/// and reached the end of its input instead of being killed.
///
/// It is a failure, and deliberately so: the caller asked for a process that
/// would be killed mid-effect, and one that shut down tidily did not answer the
/// question that was asked of it.
const NOT_KILLED_EXIT_CODE: u8 = 75;

pub fn run_host() -> std::process::ExitCode {
    match run() {
        Ok(status) => status,
        Err(reason) => {
            eprintln!("abdo-kernel: {reason}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<std::process::ExitCode, String> {
    let options = Options::parse()?;
    let mut journal = Journal::open(&options.journal).map_err(|error| format!("{error:?}"))?;

    let operation = label_digest(READ_OBJECT);
    let supervisor = EffectSupervisor::new();

    // Policy assigns the band. This host knows one operation and calls it what
    // it is: an observation that changes nothing.
    let mut policy = Policy::new();
    policy.classify(operation, Risk::R0);
    let mut gatekeeper = Gatekeeper::new(policy);

    let mut catalog = ToolCatalog::new();
    catalog.install_handler(operation);
    let sandbox = NoSandbox::new(
        label_digest(b"bare-process"),
        label_digest(b"no-confinement"),
    );
    catalog
        .register(read_tool_spec(operation), &sandbox)
        .map_err(|error| format!("the read tool was not admitted to the catalog: {error:?}"))?;
    let tool_id = ToolId::try_from_u128(READ_TOOL).map_err(str::to_owned)?;
    let lease = catalog
        .lookup(tool_id)
        .ok_or_else(|| "the catalog lost the tool it just admitted".to_owned())?;

    // One authority, holding one real grant per binding. The host is the trust
    // root here, and it says so by sealing the grants itself rather than by
    // handing the supervisor a port that answers yes.
    let mut authority = Authority::new(
        BootIdentity {
            boot_id: abdo_contracts::BootId::try_from_u128(1).map_err(str::to_owned)?,
            run_id: abdo_contracts::RunId::try_from_u128(1).map_err(str::to_owned)?,
        },
        ProcessIdentity::new(std::process::id(), 0),
        SealingKey::from_bytes(options.sealing_key),
    );
    let mut bindings = Vec::with_capacity(options.bindings.len());
    for (index, binding) in options.bindings.iter().enumerate() {
        let capability = authority
            .grant(CapabilityRequest {
                id: CapabilityId::try_from_u128(index as u128 + 1).map_err(str::to_owned)?,
                scope: Scope::Workspace(Box::new(abdo_contracts::WorkspaceScope)),
                target: TargetRef::Filesystem(Box::new(abdo_contracts::FilesystemTargetRef {
                    object: binding.handle,
                })),
                operation_digest: operation,
                issued_at_ms: 0,
                expires_at_ms: u64::MAX,
            })
            .map_err(|error| format!("a binding could not be granted: {error:?}"))?;
        bindings.push(Granted {
            handle: binding.handle,
            path: binding.path.clone(),
            capability,
        });
    }

    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let request = match read_request(&mut input)? {
            Some(request) => request,
            // Standard input closed. Nothing is owed and nothing is in flight.
            None => return Ok(std::process::ExitCode::SUCCESS),
        };
        let outcome = discharge(
            &mut journal,
            &supervisor,
            &mut gatekeeper,
            &authority,
            &bindings,
            &lease,
            operation,
            options.stop_after_commit,
            &request,
        )?;
        let Some(outcome) = outcome else {
            // The dispatch is durably committed and this process was asked to
            // go no further. It waits to be killed rather than exiting, because
            // the state under test is a kernel that died with an effect in
            // flight, and a tidy exit is a different state wearing its name.
            eprintln!("abdo-kernel: halted after committing a dispatch");
            let flushed = std::io::stderr().flush();
            if flushed.is_err() {
                return Err("the halt announcement could not be flushed".to_owned());
            }
            let mut drain = Vec::new();
            let _ = input.read_to_end(&mut drain);
            return Ok(std::process::ExitCode::from(NOT_KILLED_EXIT_CODE));
        };
        let frame = encode_frame(&outcome).map_err(|error| format!("{error}"))?;
        output
            .write_all(&frame)
            .and_then(|()| output.flush())
            .map_err(|error| format!("the outcome frame could not be written: {error}"))?;
    }
}

/// What the host was told about one object it may read.
#[derive(Clone, Debug)]
struct Binding {
    handle: FilesystemHandle,
    path: PathBuf,
}

/// A binding with the capability that was sealed for it.
#[derive(Debug)]
struct Granted {
    handle: FilesystemHandle,
    path: PathBuf,
    capability: Capability,
}

#[derive(Debug)]
struct Options {
    journal: PathBuf,
    bindings: Vec<Binding>,
    stop_after_commit: bool,
    sealing_key: [u8; 32],
}

impl Options {
    fn parse() -> Result<Self, String> {
        let mut journal: Option<PathBuf> = None;
        let mut bindings = Vec::new();
        let mut stop_after_commit = false;
        let mut sealing_key = [0_u8; 32];
        let mut sealed = false;

        let mut arguments = std::env::args_os().skip(1);
        while let Some(argument) = arguments.next() {
            let name = argument
                .into_string()
                .map_err(|_| "an argument was not valid text".to_owned())?;
            match name.as_str() {
                "--journal" => {
                    let value = next_value(&mut arguments, "--journal")?;
                    journal = Some(PathBuf::from(value));
                }
                "--bind" => {
                    bindings.push(parse_binding(&next_value(&mut arguments, "--bind")?)?);
                }
                "--sealing-key" => {
                    sealing_key =
                        parse_digest_bytes(&next_value(&mut arguments, "--sealing-key")?)?;
                    sealed = true;
                }
                // Commit the dispatch, durably, and stop there.
                //
                // Not a debugging convenience. That gap is the one state a
                // crash can land in that nothing outside the process can
                // otherwise reach, and it is the entire reason reconciliation
                // exists. A gate that could not stop there would be proving
                // recovery against a boundary it had simulated.
                "--stop-after-commit" => stop_after_commit = true,
                other => return Err(format!("unknown argument {other}")),
            }
        }

        let journal = journal.ok_or_else(|| "--journal is required".to_owned())?;
        if bindings.is_empty() {
            return Err("a host with no bindings can discharge nothing".to_owned());
        }
        if !sealed {
            return Err("--sealing-key is required".to_owned());
        }
        Ok(Self {
            journal,
            bindings,
            stop_after_commit,
            sealing_key,
        })
    }
}

fn next_value(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<String, String> {
    arguments
        .next()
        .ok_or_else(|| format!("{name} needs a value"))?
        .into_string()
        .map_err(|_| format!("the value of {name} was not valid text"))
}

/// `<64 hex characters>=<path>`.
///
/// Split at a fixed offset rather than at the first `=`, because a path may
/// contain one and a handle may not.
fn parse_binding(value: &str) -> Result<Binding, String> {
    let (handle, remainder) = value
        .split_at_checked(64)
        .ok_or_else(|| "a binding starts with a 64-character handle".to_owned())?;
    let path = remainder
        .strip_prefix('=')
        .ok_or_else(|| "a binding is <handle>=<path>".to_owned())?;
    if path.is_empty() {
        return Err("a binding needs a path".to_owned());
    }
    Ok(Binding {
        handle: FilesystemHandle::from_bytes(parse_digest_bytes(handle)?),
        path: PathBuf::from(path),
    })
}

fn parse_digest_bytes(text: &str) -> Result<[u8; 32], String> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return Err("a 32-byte value is 64 hex characters".to_owned());
    }
    let mut value = [0_u8; 32];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let high = hex_digit(pair[0])?;
        let low = hex_digit(pair[1])?;
        value[index] = (high << 4) | low;
    }
    Ok(value)
}

fn hex_digit(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("a handle is lower or upper case hexadecimal".to_owned()),
    }
}

/// The contract of the one tool this host can run.
fn read_tool_spec(operation: Digest) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(READ_TOOL).expect("the tool id constant is non-zero"),
        name_digest: label_digest(b"read-object"),
        input_schema_digest: label_digest(b"bound-object-handle"),
        output_schema_digest: label_digest(b"content-digest"),
        // A read observes and changes nothing, so it carries no recovery: there
        // is nothing to undo.
        effect: EffectClass::Read(Box::new(ReadEffect)),
        resources: ResourceLimits {
            wall_ms: 30_000,
            memory_bytes: 64 * 1024 * 1024,
            output_bytes: READ_OUTPUT_BYTES,
            open_handles: 4,
        },
        postcondition_digest: label_digest(b"content-digest-holds"),
        handler_digest: operation,
    }
}

/// Read one frame, bounded before it is read rather than after.
///
/// The header is fixed width, so the declared length is known before a single
/// payload byte is taken from the pipe. A read that allocated first and checked
/// afterwards would be a memory budget the other end controls.
fn read_request(input: &mut impl Read) -> Result<Option<EffectRequest>, String> {
    let mut header = [0_u8; FRAME_HEADER_LEN];
    if !read_exact_or_eof(input, &mut header)? {
        return Ok(None);
    }
    let parsed = decode_frame_header(&header).map_err(|error| format!("{error}"))?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + parsed.payload_length);
    frame.extend_from_slice(&header);
    frame.resize(FRAME_HEADER_LEN + parsed.payload_length, 0);
    if !read_exact_or_eof(input, &mut frame[FRAME_HEADER_LEN..])? {
        return Err("a frame ended in the middle of its payload".to_owned());
    }
    // Refused, not guessed. A host that repaired a malformed request would be
    // deciding what the caller meant.
    decode_frame::<EffectRequest>(&frame)
        .map(Some)
        .map_err(|error| format!("{error}"))
}

/// Fill the buffer, or report a clean end of input before the first byte.
fn read_exact_or_eof(input: &mut impl Read, buffer: &mut [u8]) -> Result<bool, String> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = input
            .read(&mut buffer[filled..])
            .map_err(|error| format!("standard input could not be read: {error}"))?;
        if read == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err("standard input ended inside a frame".to_owned());
        }
        filled += read;
    }
    Ok(true)
}

/// Take one request through the lifecycle.
///
/// `Ok(None)` means the dispatch is committed and this process was told to go
/// no further.
#[allow(clippy::too_many_arguments)]
fn discharge(
    journal: &mut Journal,
    supervisor: &EffectSupervisor,
    gatekeeper: &mut Gatekeeper,
    authority: &Authority,
    bindings: &[Granted],
    lease: &ToolLease,
    operation: Digest,
    stop_after_commit: bool,
    request: &EffectRequest,
) -> Result<Option<EffectOutcome>, String> {
    let intent_id = request.intent_id;

    // The ledger is asked first, and its answer is obeyed. A host that started
    // from the request rather than from the record would dispatch a second time
    // after every crash, which is the one thing the barrier exists to prevent.
    // Resuming or starting. The ledger decides which, and it is the only thing
    // that may.
    let resuming = match supervisor
        .recover(journal, intent_id)
        .map_err(|error| format!("{error:?}"))?
    {
        Recovered::Fresh => false,
        Recovered::UnknownOutcome => {
            return Ok(Some(unresolved(intent_id, b"unknown-outcome")));
        }
        Recovered::AwaitingVerification { .. } => {
            return Ok(Some(unresolved(intent_id, b"awaiting-verification")));
        }
        // Durable, and nothing observable happened. The ledger's own word for
        // this is that continuing is SAFE, and `crash_boundaries` proves it
        // reaches the adapter exactly once.
        //
        // This used to answer `already-in-progress` and write nothing, and
        // nothing anywhere else acted on the verdict either — so an effect that
        // crashed between authorisation and dispatch was authorised, never
        // dispatched, never refused, never reconciled, and reported in progress
        // to everyone who asked, forever. S134's hour cycle stopped on one
        // inside a minute.
        //
        // The contrast with `UnknownOutcome` is the whole distinction: a kill
        // AFTER dispatch leaves a question that cannot be answered, and handing
        // it to reconciliation is right. A kill before it leaves a question
        // whose answer is known — nothing happened — and answering "in
        // progress" to a question you can answer is not caution.
        Recovered::Resumable { .. } => true,
        Recovered::AwaitingApproval => {
            return Ok(Some(declined(intent_id, b"awaiting-approval")));
        }
        Recovered::Refused => return Ok(Some(declined(intent_id, b"already-refused"))),
        // A person owes an answer. Recovery keeps reporting it unfinished, and
        // so does this: an escalation nobody answered is not a refusal.
        Recovered::Escalated => {
            return Ok(Some(unresolved(intent_id, b"escalated")));
        }
        Recovered::Reconciled => return Ok(Some(declined(intent_id, b"already-reconciled"))),
        Recovered::Complete => return Ok(Some(declined(intent_id, b"already-complete"))),
    };

    if request.operation_digest != operation {
        return Ok(Some(declined(intent_id, b"unknown-operation")));
    }
    let Some(binding) = bound(bindings, &request.target) else {
        return Ok(Some(declined(intent_id, b"unbound-target")));
    };

    let intent = EffectIntent {
        intent_id,
        proposal_id: request.proposal_id,
        cause_event: request.cause_event_id,
        scope: request.scope.clone(),
        target: request.target.clone(),
        operation_digest: request.operation_digest,
        admitted_at_ms: request.requested_at_ms,
        expires_at_ms: request.expires_at_ms,
    };
    let stream = StreamId::try_from_u128(HOST_STREAM).map_err(str::to_owned)?;
    let cause = cause_hash(request.cause_event_id);

    // The token is held across the clearance rather than rebuilt after it.
    // There is no public constructor for one, which is what makes "no mutation
    // before a durable prepare" a fact about the type rather than a rule.
    // The same three doors either way. Resuming re-enters them rather than
    // being let in through a side entrance built for recovery: policy and
    // authority are asked AGAIN, because a rule or a capability can change
    // while a host is down, and only the WRITE forgives a phase that is
    // already durable.
    let prepared = if resuming {
        supervisor.resume_prepare(journal, &intent, stream, cause, now_ms()?)
    } else {
        supervisor.prepare(journal, &intent, stream, cause, now_ms()?)
    }
    .map_err(|error| format!("{error:?}"))?;
    let clearance = if resuming {
        gatekeeper.resume_clear(
            journal,
            &intent,
            request.args_digest,
            stream,
            cause,
            &NoOperator,
            now_ms()?,
        )
    } else {
        gatekeeper.clear(
            journal,
            &intent,
            request.args_digest,
            stream,
            cause,
            &NoOperator,
            now_ms()?,
        )
    }
    .map_err(|error| format!("{error:?}"))?;
    if !clearance.is_cleared() {
        return Ok(Some(declined(intent_id, b"refused-by-policy")));
    }

    let port = KernelAuthority::new(authority, request.scope.clone(), &binding.capability);
    let authorize = if resuming {
        EffectSupervisor::resume_authorize
    } else {
        EffectSupervisor::authorize
    };
    let authorized = match authorize(supervisor, journal, prepared, &intent, &port, now_ms()?) {
        Ok(authorized) => authorized,
        Err(RuntimeError::Denied { .. }) => {
            return Ok(Some(declined(intent_id, b"refused-by-authority")));
        }
        Err(error) => return Err(format!("{error:?}")),
    };

    if stop_after_commit {
        supervisor
            .commit_dispatch(journal, authorized, &intent, now_ms()?)
            .map_err(|error| format!("{error:?}"))?;
        return Ok(None);
    }

    let mut adapter = ReadObject {
        path: binding.path.as_path(),
        limit: lease.resources().output_bytes,
    };
    // The guarded entry point, on purpose. Committing and invoking by hand here
    // would be a second copy of the `effectful-dispatch` gate, and a gate with
    // two implementations is shut in one of them.
    let outcome = match supervisor.dispatch(journal, authorized, &intent, &mut adapter, now_ms()?) {
        Ok(outcome) => outcome,
        Err(RuntimeError::DispatchDisabled { .. }) => {
            return Ok(Some(declined(intent_id, b"dispatch-disabled")));
        }
        // Somebody else got there first.
        //
        // This is the whole reason resumption needs no lease of its own. Two
        // hosts may both find the effect resumable and both walk the
        // pre-dispatch doors, because those writes forgive what is already
        // durable. `Dispatching` does not: it is written FRESH, and
        // `UNIQUE (intent_id, phase_tag)` is a barrier the database holds, not
        // a check in code that a crash can skip. Exactly one racer crosses it
        // and the other is told so here.
        //
        // A lease layered on top would be a second answer to a question the
        // schema already answers, and the two would disagree the first time
        // either was tuned.
        Err(RuntimeError::AlreadyRecorded { .. }) => {
            return Ok(Some(declined(intent_id, b"already-in-progress")));
        }
        Err(error) => return Err(format!("{error:?}")),
    };
    let settled = match outcome {
        DispatchOutcome::Settled(settled) => settled,
        // The adapter could not say what happened. The kernel does not supply
        // an outcome on its behalf, and it does not send the request again.
        DispatchOutcome::Unknown { .. } => {
            return Ok(Some(unresolved(intent_id, b"adapter-reported-nothing")));
        }
    };

    // Verification re-reads the object and compares. Checking the bytes the
    // adapter returned against a digest computed from those same bytes would
    // agree with itself no matter what happened on disk.
    let settlement = settled.settlement();
    let Some(observed) = read_object_digest(binding.path.as_path(), lease.resources().output_bytes)
    else {
        return Ok(Some(unresolved(intent_id, b"postcondition-unreadable")));
    };
    if observed != settlement.outcome_digest {
        return Ok(Some(unresolved(intent_id, b"postcondition-unmet")));
    }
    let verified_at_ms = now_ms()?;
    let verified = supervisor
        .verify(
            journal,
            settled,
            Verification {
                postcondition_digest: observed,
                verified_at_ms,
            },
        )
        .map_err(|error| format!("{error:?}"))?;

    Ok(Some(EffectOutcome::Verified(Box::new(EffectVerified {
        intent_id,
        outcome_digest: verified.settlement().outcome_digest,
        postcondition_digest: verified.verification().postcondition_digest,
        settled_at_ms: verified.settlement().settled_at_ms,
        verified_at_ms: verified.verification().verified_at_ms,
    }))))
}

fn bound<'a>(bindings: &'a [Granted], target: &TargetRef) -> Option<&'a Granted> {
    let TargetRef::Filesystem(filesystem) = target else {
        return None;
    };
    bindings
        .iter()
        .find(|binding| binding.handle == filesystem.object)
}

fn declined(intent_id: IntentId, reason: &[u8]) -> EffectOutcome {
    EffectOutcome::Declined(Box::new(EffectDeclined {
        intent_id,
        reason_digest: label_digest(reason),
        at_ms: now_ms().unwrap_or(1),
    }))
}

fn unresolved(intent_id: IntentId, reason: &[u8]) -> EffectOutcome {
    EffectOutcome::Unresolved(Box::new(EffectUnresolved {
        intent_id,
        reason_digest: label_digest(reason),
        at_ms: now_ms().unwrap_or(1),
    }))
}

fn cause_hash(event_id: EventId) -> ChainHash {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&event_id.get().to_be_bytes());
    bytes[31] = 0xc5;
    ChainHash::from_bytes(bytes)
}

/// The host's clock, read in one place.
///
/// A host reads the clock; the library it links must not. Keeping the single
/// call site here is what makes that difference checkable rather than stated.
fn now_ms() -> Result<u64, String> {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "the system clock is before the Unix epoch".to_owned())?;
    u64::try_from(since_epoch.as_millis())
        .map_err(|_| "the system clock is beyond what a millisecond counter holds".to_owned())
}

/// The adapter: reads a bound object and reports what it read.
#[derive(Debug)]
struct ReadObject<'a> {
    path: &'a Path,
    limit: u64,
}

impl Dispatcher for ReadObject<'_> {
    fn dispatch(&mut self, _intent_id: IntentId, _operation_digest: Digest) -> Option<Settlement> {
        let outcome_digest = read_object_digest(self.path, self.limit)?;
        let settled_at_ms = now_ms().ok()?;
        Some(Settlement {
            outcome_digest,
            settled_at_ms,
        })
    }
}

/// Read at most `limit` bytes of an object and digest them.
///
/// Bounded before the read, like every other read in this kernel: the length of
/// a file is not this process's to trust.
fn read_object_digest(path: &Path, limit: u64) -> Option<Digest> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(READ_CONTENT_DOMAIN);
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(&bytes);
    Some(Digest::from_bytes(hasher.finalize().into()))
}
