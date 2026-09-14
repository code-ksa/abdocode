//! P5c2 — the TRUSTED PER-RUN JOB KEEPER.
//!
//! ## The correction this file is
//!
//! P5c established (finding 21, by measurement) that a named job's NAME is
//! removed from the object namespace the moment its handle count reaches zero.
//! Assigned processes keep the OBJECT alive; nothing keeps the NAME. So a host
//! that died with a child still running left a tree that `OpenJobObjectW` could
//! no longer find — unreachable by the only route recovery has.
//!
//! P5c resolved that by duplicating a rights-reduced job handle INTO THE
//! LAUNCHED TARGET. That resolution was unsound, and the 431/0 suite did not
//! catch it because every target in it was COOPERATIVE. A handle in the target's
//! own table is a handle the target may close:
//!
//!   1. `CloseHandle` on the inherited value. The target can sweep its own
//!      handle table, or simply guess — handle values are small integers.
//!   2. The first child exits while a grandchild it spawned with
//!      `bInheritHandles = FALSE` keeps running. The handle count reaches zero
//!      with the tree still alive.
//!   3. Descendants spawned without inheritance never receive it at all.
//!
//! Each of those restores exactly the state finding 21 exists to prevent: a LIVE
//! TREE whose NAME is unreachable. A keep-alive whose continued existence
//! depends on the good behaviour of the program being contained is not a
//! keep-alive; it is a request.
//!
//! So the holder is a process the target cannot reach: trusted, outside the
//! AppContainer, outside the job, spawned per run, and given the job handle by
//! INHERITANCE THROUGH AN EXPLICIT HANDLE LIST rather than by name. **The target
//! is given no job handle at all** — it cannot close what it does not possess.
//!
//! ## What the keeper deliberately is not
//!
//! It is not model-facing: nothing it does is reachable from a tool call, it
//! reads no workspace path, it holds no secret, it opens no socket, and it takes
//! no input after its command line except two inherited event handles it can
//! only wait on. It cannot terminate the job — `JOB_RIGHTS_KEEPER` is query +
//! synchronise, and the recovery helper gets terminate rights through the job's
//! protected DACL instead. Its entire authority is TO EXIST.
//!
//! That matters because it is the one component of an isolated run that
//! deliberately OUTLIVES the run's own host.
//!
//! ## The two silent-exit holes this state machine closes
//!
//! A keeper that exits early is worse than no keeper: it re-creates finding 21
//! while the recorded evidence says a keeper was installed. Two moments are
//! dangerous and both are handled explicitly rather than by a timer.
//!
//!   * **Empty before arm.** The keeper starts before the target exists, so an
//!     empty job at startup is NORMAL and must not be read as "the tree ended".
//!     Nothing exits on emptiness until the arm handshake has happened.
//!   * **The host dies mid-launch.** The host can die between assigning the
//!     target and arming the keeper, which leaves a SUSPENDED target inside the
//!     job — a live tree. The keeper detects the host's death itself (by pid AND
//!     creation time) and SELF-ARMS if the job has any member, because a member
//!     that exists must stay reachable whether or not anyone got to say so.
//!     Only a job that is BOTH unarmed and empty with a dead host is nothing,
//!     and only then does the keeper exit.
//!
//! And once armed there is no timeout at all. An unreadable job is an UNKNOWN
//! state, and the response to unknown is to stay alive and say so — never to
//! exit, because exiting turns "I cannot tell" into "the tree is gone".

use crate::job;
use crate::json;
use crate::win::*;
use std::ffi::c_void;
use std::io::Write;

/// How often the keeper asks the OS about the job. Fast enough that a recovery
/// helper waiting for the keeper to exit is not left hanging, slow enough to be
/// free: this process is idle for the whole life of the run.
const POLL_MS: u64 = 100;

/// What the keeper was told to hold, all of it verified before it says ready.
pub struct KeeperArgs {
    pub job_handle: HANDLE,
    pub arm_handle: HANDLE,
    pub shutdown_handle: HANDLE,
    /// P5c2-FINAL. The read end of the host's command pipe. The ONLY input the
    /// keeper accepts after its command line, and it carries exactly one kind of
    /// message: the authorisation to resume the target.
    pub command_handle: HANDLE,
    /// P5c2-FINAL. A handle to the HOST process — `SYNCHRONIZE |
    /// PROCESS_QUERY_LIMITED_INFORMATION` and nothing more.
    ///
    /// Inherited at spawn, because the host obviously exists then; the target's
    /// thread cannot be, which is why that one arrives later by
    /// `DuplicateHandle`. This handle is what makes the liveness gate
    /// immediately before `ResumeThread` possible at all.
    pub host_process: HANDLE,
    /// The one-shot nonce this keeper was started with. An authorisation that
    /// does not carry it was not written for this keeper instance.
    pub auth_nonce: String,
    pub job_name: String,
    pub run_id: String,
    pub operation_id: String,
    pub fencing_token: u64,
    pub expect_session_id: DWORD,
    pub host_pid: DWORD,
    /// Decimal FILETIME digits. A pid alone is not an identity.
    pub host_start: u64,
    /// P5c2-FINAL. Abort the KEEPER at an exact point, so the race matrix can be
    /// measured against a real half-finished world rather than a simulated one.
    ///
    /// The windows that matter now live INSIDE this process — between reading
    /// the authorisation, checking the host is still alive, calling
    /// `ResumeThread`, and confirming it — and none of them are reachable from
    /// the host's own crash points.
    pub crash_at: Option<String>,
}

/// Die HERE, the way a killed process dies.
///
/// `abort`, not `exit`: no unwinding, no destructors, no flush. A clean exit
/// would close this process's handles in an orderly way, and the entire point of
/// a crash point is to leave the world exactly as `taskkill /F` would — which
/// for a keeper means its job handle closing without anything else happening.
fn keeper_crash_if(point: &Option<String>, here: &str) {
    if point.as_deref() == Some(here) {
        std::process::abort();
    }
}

/// One line of JSONL on stdout, flushed.
///
/// The keeper's stdout is an inherited pipe whose read end the host holds. After
/// the host exits nobody is reading, so this stays DELIBERATELY SPARSE — at most
/// four lines for a whole run — and every non-terminal report is emitted once,
/// behind a latch. A pipe that filled would block the keeper forever, which is
/// at least the safe direction (the name stays alive), but it is not a state
/// worth risking for chatter.
fn say(obj: json::Obj) {
    let mut out = std::io::stdout();
    let _ = out.write_all(obj.finish().as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Refuse, loudly, and exit non-zero WITHOUT holding anything.
///
/// A keeper that could not verify what it was given must not linger: the host is
/// still waiting for `keeper.ready` and has not yet created the target, so
/// exiting here costs nothing and leaves nothing. This is the one path on which
/// early exit is correct.
fn refuse(stage: &str, detail: &str, code: DWORD) -> ! {
    say(json::Obj::new()
        .str("event", "keeper.refused")
        .bool("ok", false)
        .str("stage", stage)
        .str("detail", detail)
        .num("errorCode", code as i64));
    std::process::exit(2);
}

/// Is the object behind this handle really a job, and really OURS?
///
/// The handle arrived by inheritance and its VALUE arrived on a command line, so
/// the two could disagree — a caller could name any number. Asking the object a
/// job-only question is what turns a number into a proven object reference:
/// `QueryInformationJobObject(JobObjectBasicProcessIdList)` fails on a handle
/// that is not a job, and fails on a job handle without `JOB_OBJECT_QUERY`.
///
/// This is also the check that would catch the inheritance not having happened
/// at all, which is exactly the failure a handle-list bug produces.
fn prove_job_handle(h: HANDLE) -> Result<u32, DWORD> {
    if h.is_null() || h == INVALID_HANDLE_VALUE {
        return Err(ERROR_INVALID_HANDLE);
    }
    job::job_process_ids(h).map(|(assigned, _)| assigned)
}

/// Is an inherited event handle real? `WaitForSingleObject` with a zero timeout
/// returns `WAIT_FAILED` (0xFFFFFFFF) on a handle that is not waitable, and
/// answers immediately on one that is.
fn prove_event_handle(h: HANDLE) -> bool {
    if h.is_null() || h == INVALID_HANDLE_VALUE {
        return false;
    }
    let r = unsafe { WaitForSingleObject(h, 0) };
    r == WAIT_OBJECT_0 || r == WAIT_TIMEOUT
}

fn signalled(h: HANDLE) -> bool {
    unsafe { WaitForSingleObject(h, 0) == WAIT_OBJECT_0 }
}

/// Is the host that spawned us still the same live process?
///
/// pid AND creation time, because Windows reuses pids aggressively and a keeper
/// that self-armed on the strength of a recycled pid would be reasoning about a
/// stranger. `identity_unknown` (an open we could not perform) is NOT death — it
/// returns "still there" so the keeper keeps waiting rather than acting on a
/// blind spot.
fn host_still_alive(pid: DWORD, start: u64) -> bool {
    if pid == 0 {
        return false;
    }
    let f = job::inspect_pid(pid);
    if f.identity_unknown {
        return true;
    }
    f.alive && f.start_time == start
}

/// How long the keeper waits for the host to authorise the resume.
///
/// Generous, because everything between arming and authorising is the host
/// doing verification work. On expiry the keeper does NOT exit — a target may
/// already be suspended inside the job, and dropping its name would be the
/// original defect wearing a timeout.
const RESUME_AUTH_BUDGET_MS: u64 = 60_000;

/// Wait for the host's authorisation, bounded, without ever blocking on a read.
///
/// Parsed by `authmsg::parse`, which refuses anything it does not positively
/// recognise — oversize, control characters raw or escaped, nesting, trailing
/// data, duplicate keys, unknown keys, missing keys, shape changes. The reason
/// for a refusal travels back so a rejected authorisation names what was wrong
/// instead of sending the reader to a bisect.
fn await_resume_authorization(cmd: HANDLE, budget_ms: u64) -> Result<crate::authmsg::ResumeAuthorization, String> {
    let line = read_keeper_line(cmd, budget_ms).ok_or_else(|| "no authorisation arrived within the budget".to_string())?;
    crate::authmsg::parse(&line)
}

/// Everything that must be true before a trusted process starts somebody's code.
///
/// The keeper is not a rubber stamp for the host. It holds the job, so it is the
/// one component that can check the authorisation against the object it is
/// actually keeping — and a host that has been confused, fenced out, or replaced
/// is exactly the case where that difference matters.
fn verify_and_resume(a: &KeeperArgs, auth: &crate::authmsg::ResumeAuthorization, my_pid: DWORD) -> Result<DWORD, (&'static str, String)> {
    // 0. THE PROTOCOL, AND THE ONE-SHOT NONCE.
    //
    //    The nonce is handed to the keeper on its command line at spawn, so a
    //    message that does not carry it was not written for THIS keeper
    //    instance. Combined with the one-shot latch in the caller, that is what
    //    makes a replay — the same authorisation presented twice, or an
    //    authorisation captured from an earlier run — a refusal rather than a
    //    second resume.
    if auth.protocol_version != crate::PROTOCOL_VERSION {
        return Err((
            "keeper_resume_protocol_mismatch",
            format!("the authorisation is protocol {}, this keeper speaks {}", auth.protocol_version, crate::PROTOCOL_VERSION),
        ));
    }
    if auth.auth_nonce != a.auth_nonce {
        return Err(("keeper_resume_nonce_mismatch", "the authorisation nonce is not the one this keeper was started with".to_string()));
    }
    // 1. THE IDENTITY MUST BE THE ONE THIS KEEPER WAS BOUND TO AT STARTUP.
    //    A keeper started for run A cannot be talked into resuming run B's
    //    target, and a stale owner cannot present a lower fencing token.
    //
    //    The job travels as a HASH, not a name: the keeper already knows the
    //    name it is holding, and hashing removes the only backslash-bearing
    //    field from the wire — the field whose escaping defect started this.
    let expected_job_hash = crate::authmsg::job_name_hash(&a.job_name);
    if auth.job_name_hash != expected_job_hash {
        return Err(("keeper_resume_job_mismatch", "the authorisation names a different job than the one this keeper holds".to_string()));
    }
    if auth.run_id != a.run_id || auth.operation_id != a.operation_id || auth.fencing_token != a.fencing_token {
        return Err((
            "keeper_resume_identity_mismatch",
            format!(
                "authorised as run {:?}/op {:?}/token {}, bound to run {:?}/op {:?}/token {}",
                auth.run_id, auth.operation_id, auth.fencing_token, a.run_id, a.operation_id, a.fencing_token
            ),
        ));
    }
    if auth.session_id != a.expect_session_id {
        return Err((
            "keeper_resume_session_mismatch",
            format!("the authorisation is for session {}, this keeper runs in {}", auth.session_id, a.expect_session_id),
        ));
    }
    // 2. THE TARGET MUST BE A MEMBER OF THE JOB THIS KEEPER HOLDS.
    //    Asked of the OS through the keeper's own job handle, not inferred from
    //    the host's message. This is the check that makes the keeper's holding
    //    and its resuming the same object.
    let (_, members) = job::job_process_ids(a.job_handle).map_err(|e| ("keeper_resume_job_unreadable", format!("the job could not be queried (error {})", e)))?;
    if !members.contains(&auth.target_pid) {
        return Err(("keeper_resume_target_not_in_job", format!("pid {} is not a member of the job this keeper holds", auth.target_pid)));
    }
    // 3. THE PID MUST BE THE PROCESS THE HOST MEANT. A pid alone is not an
    //    identity; the creation time is what makes it one.
    let facts = job::inspect_pid(auth.target_pid);
    if facts.identity_unknown {
        return Err(("keeper_resume_target_unidentifiable", format!("pid {} could not be identified (open error {})", auth.target_pid, facts.open_error)));
    }
    if !facts.alive {
        return Err(("keeper_resume_target_gone", format!("pid {} is no longer running", auth.target_pid)));
    }
    if facts.start_time != auth.target_start {
        return Err((
            "keeper_resume_pid_reuse_refused",
            format!("pid {} was created at {}, not the authorised {}", auth.target_pid, facts.start_time, auth.target_start),
        ));
    }
    // 3b. THE IMAGE THE KERNEL ACTUALLY MAPPED, read by the KEEPER.
    //     The host checked this too, before it authorised. Checking it again
    //     here is not redundancy for its own sake: the host's check and the
    //     resume are separated by a message, and this is the only reading taken
    //     by the process that performs the resume.
    if !auth.target_image.is_empty() && !facts.image.is_empty() && !crate::images_equal(&facts.image, &auth.target_image) {
        return Err((
            "keeper_resume_image_mismatch",
            format!("the kernel mapped {:?}, not the authorised {:?}", facts.image, auth.target_image),
        ));
    }
    // 3c. AND ITS CONTAINER. An AppContainer target whose token carries a
    //     different SID than the one the ACLs were written for must not start.
    if !auth.app_container_sid.is_empty() && !facts.app_container_sid.eq_ignore_ascii_case(&auth.app_container_sid) {
        return Err((
            "keeper_resume_appcontainer_mismatch",
            format!("the token's AppContainer SID is {:?}, not the authorised {:?}", facts.app_container_sid, auth.app_container_sid),
        ));
    }
    // 4. THE THREAD MUST BELONG TO THAT PROCESS.
    //    Without this the keeper would start whatever thread the handle happened
    //    to address — a trusted process resuming an arbitrary thread on somebody
    //    else's say-so, which is a worse primitive than the one this phase
    //    removed.
    let thread = auth.thread_handle as usize as HANDLE;
    if thread.is_null() || thread == INVALID_HANDLE_VALUE {
        return Err(("keeper_resume_thread_handle_invalid", "no usable thread handle was duplicated into the keeper".to_string()));
    }
    let owner = unsafe { GetProcessIdOfThread(thread) };
    if owner == 0 {
        return Err(("keeper_resume_thread_unreadable", format!("the thread's owning process could not be read (error {})", unsafe { GetLastError() })));
    }
    if owner != auth.target_pid {
        return Err(("keeper_resume_thread_foreign", format!("the thread belongs to pid {}, not the authorised {}", owner, auth.target_pid)));
    }
    if auth.target_thread_id != 0 && unsafe { GetThreadId(thread) } != auth.target_thread_id {
        return Err(("keeper_resume_thread_id_mismatch", "the duplicated handle does not address the authorised primary thread".to_string()));
    }
    // 5. AND THE KEEPER MUST NOT BE RESUMING ITSELF.
    if owner == my_pid {
        return Err(("keeper_resume_self_refused", "the authorised thread belongs to the keeper itself".to_string()));
    }

    // ---- 6. THE HOST-LIVENESS GATE, IMMEDIATELY BEFORE THE CALL.
    //
    // ## The window this closes
    //
    // Everything above is a check on the authorisation. None of it says the
    // process that WROTE the authorisation is still alive. So this was
    // reachable: the host writes `resume_authorized`, the host dies, the keeper
    // reads a message that is entirely valid, and starts untrusted code with no
    // host left to observe it. The target would be running outside the
    // lifecycle that is supposed to bound it — briefly, but running.
    //
    // "Briefly" is not a defence. The whole isolation contract is a statement
    // about the interval in which the target executes, and an interval that
    // begins with nobody watching has no upper bound on what happens in it.
    //
    // The handle is INHERITED at spawn with `SYNCHRONIZE |
    // PROCESS_QUERY_LIMITED_INFORMATION` and nothing else, so the keeper can
    // ask whether the host is alive and wait on it — and can neither read its
    // memory nor terminate it.
    //
    // THIS CHECK IS DELIBERATELY LAST. Every microsecond between it and
    // `ResumeThread` is window, so nothing else is allowed to sit in between.
    if a.host_process.is_null() {
        return Err(("keeper_resume_host_handle_missing", "no host process handle was inherited, so host liveness cannot be established".to_string()));
    }
    // SIGNALLED means EXITED for a process handle. This is the cheap check and
    // it is exact.
    if unsafe { WaitForSingleObject(a.host_process, 0) } == WAIT_OBJECT_0 {
        return Err(("resume_host_not_alive", format!("the host process (pid {}) has exited; the target was not resumed", a.host_pid)));
    }
    // AND ITS IDENTITY HAS NOT DRIFTED. The handle cannot be recycled onto a
    // different process, but reading pid and creation time back through it costs
    // nothing and catches a caller that passed a handle to something else.
    let host_facts = job::inspect_pid(a.host_pid);
    if !host_facts.alive || host_facts.start_time != a.host_start {
        return Err((
            "resume_host_not_alive",
            format!(
                "the host (pid {}, started {}) is not the live process that authorised this resume (alive={}, started {})",
                a.host_pid, a.host_start, host_facts.alive, host_facts.start_time
            ),
        ));
    }

    let rc = unsafe { ResumeThread(thread) };
    if rc == u32::MAX {
        return Err(("keeper_resume_failed", format!("ResumeThread failed (error {})", unsafe { GetLastError() })));
    }
    Ok(rc)
}

pub fn run(a: KeeperArgs) -> ! {
    // ---- 1. identity, before anything is held or reported.

    // The SESSION first. `Local\` names resolve per session, so a keeper running
    // in a different session than the one the run recorded would be keeping a
    // name that is not the name anybody wrote down.
    let session_id = job::current_session_id().unwrap_or(u32::MAX);
    if session_id != a.expect_session_id {
        refuse("keeper_session_mismatch", "the keeper runs in a different session than the run recorded", 0);
    }

    // THE NAME MUST BE DERIVABLE FROM THE EVIDENCE. Same rule the terminate verb
    // enforces: recompute the prefix from the runId / operationId / fencingToken
    // we were handed and require the name to start with it. A keeper cannot be
    // pointed at one run's job while carrying another run's identity, and a
    // stale owner cannot spell a name minted under a higher fencing token.
    if !job::is_valid_job_name(&a.job_name) {
        refuse("keeper_job_name_invalid", "the job name is not one this helper will act on", 0);
    }
    let host_sid = match crate::root::host_user_sid() {
        Some(s) => s,
        None => refuse("keeper_host_sid_unknown", "the host SID could not be read, so the name cannot be proved", 0),
    };
    let expected_prefix = job::job_name_prefix_for(&host_sid, &a.run_id, &a.operation_id, a.fencing_token);
    if !a.job_name.starts_with(&expected_prefix) {
        refuse("keeper_identity_unproven", "the job name does not derive from the run identity presented with it", 0);
    }

    // ---- 2. the handles, proved by USE rather than by their values.
    let members_at_ready = match prove_job_handle(a.job_handle) {
        Ok(n) => n,
        Err(e) => refuse("keeper_job_handle_unusable", "the inherited job handle is not a queryable job object", e),
    };
    if !prove_event_handle(a.arm_handle) {
        refuse("keeper_arm_handle_unusable", "the inherited arm event handle is not waitable", 0);
    }
    if !prove_event_handle(a.shutdown_handle) {
        refuse("keeper_shutdown_handle_unusable", "the inherited shutdown event handle is not waitable", 0);
    }
    // P5c2-FINAL. The command pipe, proved by ASKING IT A PIPE-ONLY QUESTION.
    // `PeekNamedPipe` fails on a handle that is not a pipe, so a wrong value on
    // the command line is a refusal here rather than a keeper that later cannot
    // hear its own resume authorisation and silently leaves a target suspended.
    {
        let mut avail: DWORD = 0;
        if a.command_handle.is_null()
            || a.command_handle == INVALID_HANDLE_VALUE
            || unsafe { PeekNamedPipe(a.command_handle, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) } == 0
        {
            refuse("keeper_command_handle_unusable", "the inherited command pipe handle is not a readable pipe", unsafe { GetLastError() });
        }
    }

    // ---- 3. the keeper's own position, which is the whole point of it.
    //
    // OUTSIDE THE JOB. A keeper inside the job would be terminated along with
    // the tree it is supposed to outlive — and worse, it would be terminated by
    // the very recovery that then waits for it to confirm the job is empty.
    let mut in_our_job: BOOL = 0;
    let mut in_any_job: BOOL = 0;
    unsafe {
        IsProcessInJob(GetCurrentProcess(), a.job_handle, &mut in_our_job);
        IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_any_job);
    }
    if in_our_job != 0 {
        refuse("keeper_inside_job", "the keeper is a member of the job it is supposed to outlive", 0);
    }
    // OUTSIDE THE APPCONTAINER. Asked of this process's own token rather than
    // assumed from how it was launched.
    let (is_ac, ac_sid) = crate::token_appcontainer(unsafe { GetCurrentProcess() });
    if is_ac {
        refuse("keeper_is_appcontainer", "the keeper runs under an AppContainer token; it must be outside the container", 0);
    }

    let my_pid = unsafe { GetCurrentProcessId() };
    let my_start = crate::process_start_time(unsafe { GetCurrentProcess() });

    // ---- 4. READY. The host records this durably before it creates the target,
    // so a keeper that never got here means no target was ever launched.
    keeper_crash_if(&a.crash_at, "keeper_spawned_before_ready");
    say(json::Obj::new()
        .str("event", "keeper.ready")
        .bool("ok", true)
        .num("pid", my_pid as i64)
        // A STRING: a FILETIME is ~1.3e17 and a JSON number loses its low digits
        // above 2^53, which would turn "pid + creation time" into a check that
        // reports every live process as a different one.
        .str("startTime", &my_start.to_string())
        .str("jobName", &a.job_name)
        .num("sessionId", session_id as i64)
        .str("runId", &a.run_id)
        .str("operationId", &a.operation_id)
        .str("fencingToken", &a.fencing_token.to_string())
        .num("membersAtReady", members_at_ready as i64)
        .bool("insideJob", false)
        .bool("insideAnyJob", in_any_job != 0)
        .bool("isAppContainer", false)
        .str("appContainerSid", &ac_sid));

    // ---- 5. wait to be armed.
    //
    // NO TIMEOUT, and no exit on an empty job — see the header. The three ways
    // out of this loop are all conclusions, not deadlines.
    let mut self_armed = false;
    loop {
        if signalled(a.arm_handle) {
            break;
        }
        // THE FENCED SHUTDOWN. Only meaningful here, before a target was ever
        // assigned: it is the host saying "the launch failed, nothing was put in
        // this job". Possession of the inherited handle is the authentication —
        // there is no name for a bystander to open. After arming it is ignored
        // (see the hold loop), because by then a real tree depends on this name.
        if signalled(a.shutdown_handle) {
            match prove_job_handle(a.job_handle) {
                // Honouring a shutdown while the job HAS members would be the
                // silent-exit hole wearing a permission slip. The request is
                // refused and the keeper carries on holding.
                Ok(n) if n > 0 => {
                    self_armed = true;
                    break;
                }
                Ok(_) => {
                    say(json::Obj::new().str("event", "keeper.exit_shutdown_before_arm").bool("ok", true).num("pid", my_pid as i64).num("members", 0));
                    std::process::exit(0);
                }
                // Unreadable job + shutdown request => unknown, so hold.
                Err(_) => {
                    self_armed = true;
                    break;
                }
            }
        }
        if !host_still_alive(a.host_pid, a.host_start) {
            match prove_job_handle(a.job_handle) {
                // A MEMBER EXISTS AND NOBODY IS LEFT TO ARM US. The host died
                // between assigning the target and arming — the target is in the
                // job, suspended or running, and it is exactly the orphan this
                // whole design exists to keep reachable.
                Ok(n) if n > 0 => {
                    self_armed = true;
                    break;
                }
                // Dead host, empty job, never armed: nothing was ever assigned
                // and there is nothing to keep. The only clean early exit.
                Ok(_) => {
                    say(json::Obj::new().str("event", "keeper.exit_unarmed_empty").bool("ok", true).num("pid", my_pid as i64).str("why", "the host died before any process was assigned to the job"));
                    std::process::exit(0);
                }
                Err(e) => {
                    // Dead host and an unreadable job is the definition of not
                    // knowing. Hold, and let recovery decide with more evidence
                    // than this process has.
                    say(json::Obj::new().str("event", "keeper.job_unreadable").bool("ok", false).num("pid", my_pid as i64).num("errorCode", e as i64).str("action", "holding"));
                    self_armed = true;
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }

    say(json::Obj::new()
        .str("event", if self_armed { "keeper.self_armed" } else { "keeper.armed" })
        .bool("ok", true)
        .num("pid", my_pid as i64)
        .str("jobName", &a.job_name));

    // ---- 5b. P5c2-FINAL: THE RESUME, which only this process may perform.
    //
    // ## Why the authority moved here
    //
    // Until now the host called `ResumeThread`. That left a window with no name
    // for it: the host arms the keeper, the keeper acknowledges, the keeper is
    // killed, and the host — which has no idea — resumes the target anyway. The
    // result is a RUNNING target whose job name was dropped the moment the
    // keeper died. Every guarantee this phase is built on is a guarantee about
    // the interval in which the target is running, and the host cannot enforce
    // one about an interval it does not observe.
    //
    // Moving the call here collapses the window to nothing. The thread cannot
    // start unless the process that keeps its job reachable is alive to start
    // it, because that process is the one making the call.
    //
    // The host still decides WHETHER to authorise; the keeper decides whether
    // the authorisation describes the world it is actually holding.
    // ONE SHOT, and it is the loop's absence that enforces it.
    //
    // The command pipe is read EXACTLY ONCE and acted on at most once. A replay
    // of the same bytes, a duplicate authorisation, or a fresh message from a
    // restarted stale host all land in a pipe nothing reads again. There is no
    // "seen this nonce" set to get wrong, because there is no second read.
    let mut resumed_pid: DWORD = 0;
    match await_resume_authorization(a.command_handle, RESUME_AUTH_BUDGET_MS) {
        // MALFORMED IS A REFUSAL, NOT A RETRY. The parser's reason travels with
        // it so a rejected authorisation names what was wrong.
        Err(why) => {
            say(json::Obj::new()
                .str("event", "keeper.resume_refused")
                .bool("ok", false)
                .num("pid", my_pid as i64)
                .str("stage", "keeper_resume_message_rejected")
                .str("detail", &why));
        }
        Ok(auth) => {
            // The authorisation is parsed and valid, but nothing has been
            // checked against the live world and nothing has been started.
            keeper_crash_if(&a.crash_at, "keeper_parsed_authorization_before_liveness");
            match verify_and_resume(&a, &auth, my_pid) {
            Ok(rc) => {
                resumed_pid = auth.target_pid;
                // RESUMED, BUT NOT YET CONFIRMED. The target is running and
                // the host has not been told - the state a host must never
                // read as "it never started".
                keeper_crash_if(&a.crash_at, "keeper_resumed_before_confirm");
                say(json::Obj::new()
                    .str("event", "keeper.resume_confirmed")
                    .bool("ok", true)
                    .num("pid", my_pid as i64)
                    .num("targetPid", auth.target_pid as i64)
                    .str("targetStartTime", &auth.target_start.to_string())
                    // ResumeThread returns the PREVIOUS suspend count. One means
                    // it was suspended exactly once and is now running; anything
                    // else is reported rather than flattened, because "we called
                    // resume" is not "it is running".
                    .num("previousSuspendCount", rc as i64)
                    .str("jobName", &a.job_name));
            }
            Err((stage, detail)) => {
                // REFUSED, AND THE TARGET IS LEFT SUSPENDED. Not terminated: the
                // keeper holds `THREAD_SUSPEND_RESUME` and nothing else, so it
                // CANNOT terminate anything — which is the point. It reports,
                // keeps holding the job's name, and lets the host (or recovery)
                // act with the rights this process deliberately does not have.
                say(json::Obj::new()
                    .str("event", "keeper.resume_refused")
                    .bool("ok", false)
                    .num("pid", my_pid as i64)
                    .str("stage", stage)
                    .str("detail", &detail)
                    .num("targetPid", auth.target_pid as i64));
            }
            }
        }
    }
    let _ = resumed_pid;

    // ---- 6. HOLD. Exit only on an OS-confirmed empty job.
    //
    // The shutdown event is deliberately NOT consulted from here on. Once a
    // target is in the job, the name has to outlive anything the host says,
    // including the host's own death — that is the property.
    let mut reported_unreadable = false;
    loop {
        match prove_job_handle(a.job_handle) {
            Ok(0) => {
                // THE OS SAID EMPTY. Not a timer, not the target's exit code,
                // not the host's opinion: the job's own member list. This is the
                // signal a recovery helper waits for before it believes a tree
                // is gone.
                say(json::Obj::new().str("event", "keeper.exit_job_empty").bool("ok", true).num("pid", my_pid as i64).num("members", 0));
                std::process::exit(0);
            }
            Ok(_) => {}
            Err(e) => {
                // UNKNOWN, AND UNKNOWN IS NOT EMPTY. Reported once, then held
                // forever. A keeper that exited here would delete the name of a
                // job it had just failed to read, which is the precise shape of
                // the false proof this package refuses.
                if !reported_unreadable {
                    reported_unreadable = true;
                    say(json::Obj::new()
                        .str("event", "keeper.job_unreadable")
                        .bool("ok", false)
                        .num("pid", my_pid as i64)
                        .num("errorCode", e as i64)
                        .str("action", "holding")
                        .str("why", "an unreadable job is an unknown state; exiting would drop the name"));
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }
}

/// Everything the host needs to spawn ONE keeper and prove it started.
pub struct KeeperLaunch {
    pub process: HANDLE,
    pub thread: HANDLE,
    pub pid: DWORD,
    pub start_time: u64,
    pub arm_event: HANDLE,
    pub shutdown_event: HANDLE,
    /// The read end of the keeper's stdout. The host reads `keeper.ready`,
    /// the arm acknowledgement and `keeper.resume_confirmed` from it.
    pub stdout_read: HANDLE,
    /// P5c2-FINAL. The WRITE end of the keeper's command pipe. The host sends
    /// exactly one message on it: the resume authorisation.
    pub command_write: HANDLE,
}

pub enum KeeperSpawn {
    Started(KeeperLaunch),
    Failed(&'static str, DWORD),
}

/// An inheritable auto-created event, unnamed.
fn make_event() -> HANDLE {
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    // MANUAL RESET, initially clear. Manual because the keeper polls it and a
    // signal must stay observed; an auto-reset event would be consumed by
    // whichever wait happened to see it first.
    unsafe { CreateEventW(&sa, TRUE, FALSE, std::ptr::null()) }
}

/// Spawn the trusted keeper for one run, passing EXACTLY four handles.
///
/// ## The inheritance is explicit, and that is the security property
///
/// `bInheritHandles = TRUE` alone inherits every handle in this process that
/// happens to be marked inheritable. At this point in the launch that set
/// includes the target's stdout/stderr pipe write ends and its NUL stdin — none
/// of which the keeper has any business holding, and all of which would silently
/// join the set the day someone adds another pipe.
///
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` makes the inherited set exactly this
/// array: the job handle, the two event handles, and the keeper's own stdout.
/// Anything not named here does not cross, which is what makes
/// "no unrelated handle reaches the keeper" a testable claim rather than an
/// inventory of the handle table at one moment.
///
/// The JOB HANDLE PASSED IS A REDUCED DUPLICATE, never the creator's own: the
/// keeper gets `JOB_RIGHTS_KEEPER` (query + synchronise) and cannot assign,
/// terminate, or change the limits of the job it holds.
#[allow(clippy::too_many_arguments)]
pub fn spawn_keeper(
    helper_exe: &str,
    job: HANDLE,
    name: &str,
    run_id: &str,
    operation_id: &str,
    fencing_token: u64,
    session_id: DWORD,
    auth_nonce: &str,
    keeper_crash_at: &Option<String>,
) -> KeeperSpawn {
    let arm = make_event();
    let shutdown = make_event();
    if arm.is_null() || shutdown.is_null() {
        let e = unsafe { GetLastError() };
        unsafe {
            if !arm.is_null() {
                CloseHandle(arm);
            }
            if !shutdown.is_null() {
                CloseHandle(shutdown);
            }
        }
        return KeeperSpawn::Failed("keeper_event_uncreatable", e);
    }

    // The keeper's stdout pipe. Only the WRITE end is inheritable; the read end
    // stays ours, exactly as the target's pipes are handled.
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let (mut rd, mut wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    // P5c2-FINAL: the COMMAND pipe, host -> keeper. Mirror image of the stdout
    // pipe: only the READ end is inheritable, and the host keeps the write end.
    let (mut cmd_rd, mut cmd_wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    unsafe {
        const HANDLE_FLAG_INHERIT: DWORD = 1;
        if CreatePipe(&mut rd, &mut wr, &sa, 0) == 0 {
            let e = GetLastError();
            CloseHandle(arm);
            CloseHandle(shutdown);
            return KeeperSpawn::Failed("keeper_pipe_uncreatable", e);
        }
        SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
        if CreatePipe(&mut cmd_rd, &mut cmd_wr, &sa, 0) == 0 {
            let e = GetLastError();
            CloseHandle(arm);
            CloseHandle(shutdown);
            CloseHandle(rd);
            CloseHandle(wr);
            return KeeperSpawn::Failed("keeper_command_pipe_uncreatable", e);
        }
        // The WRITE end stays ours and must NOT cross, or the keeper would hold
        // a writer to its own command channel and never see EOF on our death.
        SetHandleInformation(cmd_wr, HANDLE_FLAG_INHERIT, 0);
    }

    // THE REDUCED JOB HANDLE. `DUPLICATE_SAME_ACCESS` is deliberately not used:
    // the mask is the control, and it is narrower than the creator's.
    let mut job_dup: HANDLE = std::ptr::null_mut();
    let dup_ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            job,
            GetCurrentProcess(),
            &mut job_dup,
            JOB_RIGHTS_KEEPER,
            TRUE, // inheritable — and named in the handle list below
            0,
        )
    };
    if dup_ok == 0 {
        let e = unsafe { GetLastError() };
        unsafe {
            CloseHandle(arm);
            CloseHandle(shutdown);
            CloseHandle(rd);
            CloseHandle(wr);
        }
        return KeeperSpawn::Failed("keeper_job_handle_unduplicatable", e);
    }

    // THE HOST'S OWN PROCESS, reduced to observation only.
    //
    // P5c2-FINAL. This is what lets the keeper answer "is the process that
    // authorised this still alive?" in the instant before it resumes anything.
    // Inherited at spawn because the host plainly exists then, unlike the target
    // thread — which is why that one arrives later by `DuplicateHandle`.
    let mut host_dup: HANDLE = std::ptr::null_mut();
    let host_ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentProcess(),
            GetCurrentProcess(),
            &mut host_dup,
            PROCESS_RIGHTS_KEEPER_ON_HOST,
            TRUE, // inheritable — and named in the handle list below
            0,    // NOT DUPLICATE_SAME_ACCESS: observation only
        )
    };
    if host_ok == 0 {
        let e = unsafe { GetLastError() };
        unsafe {
            CloseHandle(job_dup);
            CloseHandle(arm);
            CloseHandle(shutdown);
            CloseHandle(rd);
            CloseHandle(wr);
            CloseHandle(cmd_rd);
            CloseHandle(cmd_wr);
        }
        return KeeperSpawn::Failed("keeper_host_handle_unduplicatable", e);
    }

    // EXACTLY these, and the array must outlive `CreateProcessW`:
    // `UpdateProcThreadAttribute` stores the POINTER, it does not copy.
    //
    // FIVE handles, named one at a time: the reduced job handle, the two event
    // handles, the keeper's stdout write end, and the command pipe's READ end.
    // The target's primary-thread handle is deliberately NOT here — it cannot
    // be, because the target does not exist yet, and it must not be, because the
    // keeper is started before anything is in the job precisely so the name is
    // held from the first member onwards. That handle is duplicated in later,
    // with `THREAD_SUSPEND_RESUME` and nothing else.
    let mut handle_list: Vec<HANDLE> = vec![job_dup, arm, shutdown, wr, cmd_rd, host_dup];
    let mut attr_buf: Vec<u8> = Vec::new();
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as DWORD;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdOutput = wr;
    si.StartupInfo.hStdError = wr;
    // NO STDIN. The keeper takes no input after its command line; a null stdin
    // is one fewer channel into a process whose whole purpose is to be
    // unreachable by the thing it contains.
    si.StartupInfo.hStdInput = std::ptr::null_mut();

    let cleanup = |job_dup: HANDLE, arm: HANDLE, shutdown: HANDLE, rd: HANDLE, wr: HANDLE, cmd_rd: HANDLE, cmd_wr: HANDLE, host_dup: HANDLE| unsafe {
        CloseHandle(job_dup);
        CloseHandle(arm);
        CloseHandle(shutdown);
        CloseHandle(rd);
        CloseHandle(wr);
        CloseHandle(cmd_rd);
        CloseHandle(cmd_wr);
        CloseHandle(host_dup);
    };

    unsafe {
        let mut size: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        attr_buf.resize(size, 0);
        let list = attr_buf.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            let e = GetLastError();
            cleanup(job_dup, arm, shutdown, rd, wr, cmd_rd, cmd_wr, host_dup);
            return KeeperSpawn::Failed("keeper_attribute_list_uninitialisable", e);
        }
        if UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handle_list.as_mut_ptr() as *mut c_void,
            std::mem::size_of::<HANDLE>() * handle_list.len(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            let e = GetLastError();
            DeleteProcThreadAttributeList(list);
            cleanup(job_dup, arm, shutdown, rd, wr, cmd_rd, cmd_wr, host_dup);
            return KeeperSpawn::Failed("keeper_handle_list_unattachable", e);
        }
        si.lpAttributeList = list;
    }

    let host_pid = unsafe { GetCurrentProcessId() };
    let host_start = crate::process_start_time(unsafe { GetCurrentProcess() });
    let argv: Vec<String> = vec![
        helper_exe.to_string(),
        "job-keeper".to_string(),
        "--job-handle".to_string(),
        (job_dup as usize).to_string(),
        "--arm-handle".to_string(),
        (arm as usize).to_string(),
        "--shutdown-handle".to_string(),
        (shutdown as usize).to_string(),
        "--command-handle".to_string(),
        (cmd_rd as usize).to_string(),
        "--host-process-handle".to_string(),
        (host_dup as usize).to_string(),
        "--auth-nonce".to_string(),
        auth_nonce.to_string(),
        "--job-name".to_string(),
        name.to_string(),
        "--run-id".to_string(),
        run_id.to_string(),
        "--operation-id".to_string(),
        operation_id.to_string(),
        "--fencing-token".to_string(),
        fencing_token.to_string(),
        "--expect-session-id".to_string(),
        session_id.to_string(),
        "--host-pid".to_string(),
        host_pid.to_string(),
        "--host-start".to_string(),
        host_start.to_string(),
    ];
    // An inherited handle keeps the SAME NUMERIC VALUE in the child, which is
    // what makes passing it on the command line meaningful. The keeper does not
    // take our word for it: it proves each value by USING it (`prove_job_handle`
    // asks a job-only question), so a wrong number is a refusal and never a
    // keeper holding something else.
    // The keeper's own crash points, forwarded only when one was asked for.
    // `--crash-at` is a §8 measurement flag, never a production path.
    let argv = if let Some(point) = keeper_crash_at.as_ref().filter(|p| p.starts_with("keeper_")) {
        let mut v = argv;
        v.push("--crash-at".to_string());
        v.push(point.clone());
        v
    } else {
        argv
    };

    let exe_w = wide(helper_exe);
    let mut cmdline_w = wide(&crate::cmdline::build_command_line(&argv));
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // CREATE_BREAKAWAY_FROM_JOB is NOT set and must not be: this helper is not
    // in the target's job, and asking to break away from whatever job the HOST
    // may be in would fail on a job without BREAKAWAY_OK and take the launch
    // with it.
    //
    // CREATE_SUSPENDED is not used either — the keeper verifies itself and
    // reports; there is nothing to inspect before it runs.
    let created = unsafe {
        CreateProcessW(
            exe_w.as_ptr(),
            cmdline_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            TRUE, // inherit — but ONLY the four handles named in the list above
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        )
    };
    let create_err = unsafe { GetLastError() };
    unsafe {
        DeleteProcThreadAttributeList(si.lpAttributeList);
        // OUR copies of the ends the keeper now owns. The write end above all:
        // while this process holds it, the read end never sees EOF and a host
        // waiting for the keeper's death would wait forever.
        CloseHandle(wr);
        CloseHandle(job_dup);
        // OUR copy of the command pipe's READ end. The keeper owns it now; if
        // this process kept one, the keeper would never see EOF when we die.
        CloseHandle(cmd_rd);
    }
    // `handle_list` had to stay alive across `CreateProcessW`; say so to the
    // compiler rather than relying on drop order.
    drop(handle_list);

    if created == 0 {
        unsafe {
            CloseHandle(arm);
            CloseHandle(shutdown);
            CloseHandle(rd);
            CloseHandle(cmd_wr);
        }
        return KeeperSpawn::Failed("keeper_process_uncreatable", create_err);
    }

    KeeperSpawn::Started(KeeperLaunch {
        process: pi.hProcess,
        thread: pi.hThread,
        pid: pi.dwProcessId,
        start_time: crate::process_start_time(pi.hProcess),
        arm_event: arm,
        shutdown_event: shutdown,
        stdout_read: rd,
        command_write: cmd_wr,
    })
}

/// Read ONE JSON line from the keeper's stdout, bounded — and the bound is real.
///
/// Returns `None` on timeout, on EOF, or on a line too long to be one of ours.
/// All three mean "the keeper did not say what it was supposed to say", and the
/// caller turns every one of them into a refusal rather than a guess.
///
/// ## Why this peeks instead of just reading
///
/// The first version checked the elapsed budget and then did a BLOCKING
/// `ReadFile`. That bound could never fire: a keeper that was alive but silent
/// left the read blocked forever, and the clock was never consulted again. The
/// host would hang until something OUTSIDE it — the `Bun.spawnSync` timeout on
/// the TypeScript side — killed the process.
///
/// A timeout enforced by somebody else is not a timeout this function provides,
/// and stating one in the signature while relying on an external killer is the
/// same species of defect as reporting `treeGone` for a name that merely stopped
/// resolving: an API that claims a guarantee its implementation does not make.
///
/// So `ReadFile` is only ever called on bytes `PeekNamedPipe` has already
/// confirmed are buffered, which means it cannot block, which means the sleep
/// and the budget check below actually run.
///
/// Byte at a time, deliberately: this is called twice per launch (`keeper.ready`
/// then the arm acknowledgement), and a bulk read could swallow part of the
/// second line into the first call's buffer and lose it. The volume is a few
/// hundred bytes per run.
pub fn read_keeper_line(rd: HANDLE, budget_ms: u64) -> Option<String> {
    let started = std::time::Instant::now();
    let mut acc: Vec<u8> = Vec::with_capacity(1024);
    // Bytes known to be buffered, so they can be consumed without peeking again.
    let mut pending: DWORD = 0;
    loop {
        if pending == 0 {
            let mut avail: DWORD = 0;
            let ok = unsafe { PeekNamedPipe(rd, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) };
            if ok == 0 {
                // ERROR_BROKEN_PIPE: every write end is closed. The keeper
                // exited without reporting, which is a refusal upstream.
                return None;
            }
            if avail == 0 {
                if started.elapsed().as_millis() as u64 >= budget_ms {
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
            pending = avail;
        }
        let mut byte: u8 = 0;
        let mut got: DWORD = 0;
        // CANNOT BLOCK: the byte is already in the pipe's buffer.
        let ok = unsafe { ReadFile(rd, &mut byte, 1, &mut got, std::ptr::null_mut()) };
        if ok == 0 || got == 0 {
            return None;
        }
        pending -= 1;
        if byte == b'\n' {
            return String::from_utf8(acc).ok();
        }
        if byte != b'\r' {
            acc.push(byte);
        }
        if acc.len() > 8192 {
            return None;
        }
    }
}

/// Arm the keeper and WAIT FOR IT TO SAY SO.
///
/// An explicit handshake rather than a bare `SetEvent`, because the ordering the
/// brief specifies is only real if the host knows the keeper reached the holding
/// state before the target is resumed. `SetEvent` returning true says a bit was
/// flipped, not that anybody read it.
pub fn arm_keeper(k: &KeeperLaunch, budget_ms: u64) -> Result<String, (&'static str, String)> {
    if unsafe { SetEvent(k.arm_event) } == 0 {
        return Err(("keeper_arm_signal_failed", format!("SetEvent on the arm event failed (error {})", unsafe { GetLastError() })));
    }
    match read_keeper_line(k.stdout_read, budget_ms) {
        Some(line) if line.contains("\"keeper.armed\"") || line.contains("\"keeper.self_armed\"") => Ok(line),
        // WHATEVER THE KEEPER ACTUALLY SAID travels with the failure. A stage
        // name on its own sends the reader to the source; the keeper's own line
        // names the check that failed.
        Some(line) => Err(("keeper_arm_unacknowledged", line)),
        None => Err(("keeper_arm_no_response", String::new())),
    }
}

/// AUTHORISE the keeper to resume the target, and wait for it to confirm it did.
///
/// P5c2-FINAL. The host does not call `ResumeThread` any more, in any mode. It
/// duplicates the target's primary thread into the keeper with
/// `THREAD_SUSPEND_RESUME` and nothing else, says which process that thread must
/// belong to, and lets the keeper decide.
///
/// The window this closes has no other fix. While the host held the call, the
/// sequence "arm the keeper, keeper acknowledges, keeper is killed, host resumes
/// anyway" produced a RUNNING target whose job name had already been dropped —
/// and the host had no way to know, because the acknowledgement it acted on was
/// already stale when it arrived. No amount of re-checking closes that: any check
/// the host performs is separated from the resume it guards by a gap the keeper
/// can die in. Making the keeper itself the caller removes the gap rather than
/// narrowing it.
///
/// Returns the keeper's confirmation line, or the stage that failed.
#[allow(clippy::too_many_arguments)]
pub fn authorize_resume(
    k: &KeeperLaunch,
    thread: HANDLE,
    target_pid: DWORD,
    target_start: u64,
    target_image: &str,
    app_container_sid: &str,
    name: &str,
    run_id: &str,
    operation_id: &str,
    fencing_token: u64,
    session_id: DWORD,
    nonce: &str,
    budget_ms: u64,
) -> Result<String, (&'static str, String)> {
    // THE MINIMUM RIGHT, ON EXACTLY ONE THREAD.
    //
    // NOT `DUPLICATE_SAME_ACCESS`: the host holds a full-access thread handle
    // from `CreateProcessW`, and passing that on would hand the keeper the
    // ability to rewrite the target's registers (`THREAD_SET_CONTEXT`) or kill
    // it. The keeper's authority is to START the thread and nothing else.
    let mut dup: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            thread,
            k.process,
            &mut dup,
            THREAD_RIGHTS_KEEPER,
            FALSE, // NOT inheritable: nothing the keeper spawns should ever get it
            0,
        )
    };
    if ok == 0 {
        return Err(("keeper_resume_thread_undeliverable", format!("DuplicateHandle into the keeper failed (error {})", unsafe {{ GetLastError() }})));
    }
    // The handle VALUE is meaningful only inside the keeper's process, which is
    // where `DuplicateHandle` just created it. A value from anywhere else
    // addresses nothing there, and the keeper proves the object anyway by asking
    // which process the thread belongs to.
    //
    // BUILT BY THE ONE WRITER, so the strict reader has exactly one thing to
    // agree with. The job travels as a HASH rather than a name — that removes
    // the only backslash-bearing field from the wire, and the escaping defect
    // that this parser was rewritten for cannot recur on it.
    let msg = crate::authmsg::build(&crate::authmsg::ResumeAuthorization {
        protocol_version: crate::PROTOCOL_VERSION,
        auth_nonce: nonce.to_string(),
        run_id: run_id.to_string(),
        operation_id: operation_id.to_string(),
        fencing_token,
        job_name_hash: crate::authmsg::job_name_hash(name),
        session_id,
        target_pid,
        target_start,
        target_thread_id: unsafe { GetThreadId(thread) },
        thread_handle: dup as usize as u64,
        target_image: target_image.to_string(),
        app_container_sid: app_container_sid.to_string(),
    });
    let line = format!("{}\n", msg);
    let mut written: DWORD = 0;
    let wrote = unsafe { WriteFile(k.command_write, line.as_ptr(), line.len() as DWORD, &mut written, std::ptr::null_mut()) };
    if wrote == 0 || written as usize != line.len() {
        return Err(("keeper_resume_authorization_unsent", format!("wrote {} of {} bytes to the keeper command pipe", written, line.len())));
    }
    match read_keeper_line(k.stdout_read, budget_ms) {
        Some(l) if l.contains("\"keeper.resume_confirmed\"") => Ok(l),
        // A REFUSAL IS NOT A TIMEOUT, and the two must not be flattened: a
        // refusal means the keeper looked and disagreed, which is evidence.
        // THE KEEPER'S OWN REASON TRAVELS WITH THE REFUSAL. Discarding it once
        // cost a debugging round: the host reported `keeper_resume_refused` with
        // no detail while the keeper had said precisely which check failed.
        Some(l) if l.contains("\"keeper.resume_refused\"") => Err(("keeper_resume_refused", l)),
        Some(l) => Err(("keeper_resume_unacknowledged", l)),
        None => Err(("keeper_resume_no_response", String::new())),
    }
}

/// Is the keeper still the same live process?
///
/// P5c2-FINAL. Used by the host while it waits on a RESUMED target: if the
/// keeper dies mid-run the job's name has been dropped, and the host — which
/// still holds its own job handle — is the last thing that can end the tree
/// deliberately rather than leaving it unreachable.
pub fn keeper_still_alive(k: &KeeperLaunch) -> bool {
    let mut code: DWORD = 0;
    if unsafe { GetExitCodeProcess(k.process, &mut code) } == 0 {
        // Unreadable is not dead. Reporting it as dead would make the host
        // terminate a healthy run's tree.
        return true;
    }
    code == 259 // STILL_ACTIVE
}

/// Ask an UNARMED keeper to stand down, for a launch that failed before any
/// process was assigned. The keeper refuses if the job turns out to have members.
pub fn shutdown_keeper(k: &KeeperLaunch) {
    unsafe {
        SetEvent(k.shutdown_event);
    }
}

/// The shutdown event of the keeper this process started, if any.
///
/// A `usize` rather than a `HANDLE` because a raw pointer is not `Send` and this
/// is reached from the process-wide exit path. The value is only ever handed
/// back to `SetEvent`.
static SHUTDOWN_EVENT: std::sync::Mutex<Option<usize>> = std::sync::Mutex::new(None);

/// Arrange for `emit` to release the keeper however this process exits.
///
/// THE LAUNCH HAS A DOZEN REFUSAL PATHS and every one of them ends in `emit`.
/// Signalling from there rather than at each `refuse_named` call site means a
/// refusal added later cannot forget to do it — the failure mode being avoided
/// is a keeper left holding an empty job forever because one branch was missed.
///
/// UNCONDITIONAL IS SAFE, and that is a property of the keeper's state machine
/// rather than of the caller's care:
///
///   * unarmed with an EMPTY job — nothing was ever assigned, so it exits;
///   * unarmed with a LIVE member — it SELF-ARMS and keeps holding, because a
///     member that exists must stay reachable whatever the host says;
///   * armed — ignored entirely; the hold loop never consults this event.
///
/// So the success path may signal it too, and does.
pub fn register_shutdown(k: &KeeperLaunch) {
    if let Ok(mut g) = SHUTDOWN_EVENT.lock() {
        *g = Some(k.shutdown_event as usize);
    }
}

/// Called from `emit`, on every exit of the host process.
pub fn release_registered_shutdown() {
    if let Some(h) = SHUTDOWN_EVENT.lock().ok().and_then(|g| *g) {
        unsafe {
            SetEvent(h as HANDLE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The message round-trip and escaping tests that used to live here moved to
    // `src/authmsg.rs` with the parser itself. They were written against a
    // hand-rolled `field()` reader that no longer exists; keeping a copy here
    // would test nothing and would drift from the reader that is actually used.

    /// A pipe whose write end is HELD OPEN and never written to.
    ///
    /// This is the "keeper alive but silent" case, and it is the one the first
    /// version of `read_keeper_line` could not survive: peek reports zero bytes
    /// available forever, and the write end being open means there is no EOF to
    /// break the loop either. The only thing that can end it is the budget.
    #[test]
    fn a_silent_keeper_hits_the_budget_instead_of_hanging_forever() {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: FALSE,
        };
        let (mut rd, mut wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        assert_ne!(unsafe { CreatePipe(&mut rd, &mut wr, &sa, 0) }, 0, "the pipe must exist for this to measure anything");

        let started = std::time::Instant::now();
        let got = read_keeper_line(rd, 300);
        let elapsed = started.elapsed().as_millis();

        assert!(got.is_none(), "a silent keeper must not produce a line");
        // IT RETURNED AT ALL. Before the fix this call never came back, and the
        // test would have hung rather than failed.
        assert!(elapsed >= 250, "it must have actually waited for its budget, waited {}ms", elapsed);
        assert!(elapsed < 5_000, "the budget must BOUND the wait, took {}ms", elapsed);

        unsafe {
            CloseHandle(rd);
            CloseHandle(wr);
        }
    }

    /// The other way a keeper fails to report: it exits. Every write end closes,
    /// peek fails with ERROR_BROKEN_PIPE, and that is EOF — which must come back
    /// immediately rather than burning the whole budget.
    #[test]
    fn a_keeper_that_exits_without_reporting_is_eof_not_a_timeout() {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: FALSE,
        };
        let (mut rd, mut wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        assert_ne!(unsafe { CreatePipe(&mut rd, &mut wr, &sa, 0) }, 0);
        unsafe { CloseHandle(wr) }; // the keeper died

        let started = std::time::Instant::now();
        let got = read_keeper_line(rd, 10_000);
        let elapsed = started.elapsed().as_millis();

        assert!(got.is_none());
        assert!(elapsed < 1_000, "EOF must be immediate, not a budget expiry; took {}ms", elapsed);
        unsafe { CloseHandle(rd) };
    }

    /// And the normal path still works: a complete line is returned without its
    /// terminator, and a `\r\n` ending does not leave a stray carriage return
    /// that would break the caller's `contains` checks.
    #[test]
    fn a_reported_line_comes_back_whole() {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: FALSE,
        };
        let (mut rd, mut wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        assert_ne!(unsafe { CreatePipe(&mut rd, &mut wr, &sa, 0) }, 0);
        let payload = b"{\"event\":\"keeper.ready\"}\r\n{\"event\":\"keeper.armed\"}\n";
        let mut written: DWORD = 0;
        assert_ne!(unsafe { WriteFile(wr, payload.as_ptr(), payload.len() as DWORD, &mut written, std::ptr::null_mut()) }, 0);

        let first = read_keeper_line(rd, 5_000).expect("the first line");
        assert_eq!(first, "{\"event\":\"keeper.ready\"}");
        // THE SECOND LINE SURVIVED THE FIRST READ. Reading a byte at a time is
        // what guarantees this: a bulk read would have swallowed the arm
        // acknowledgement into the ready call's buffer and lost it.
        let second = read_keeper_line(rd, 5_000).expect("the second line");
        assert_eq!(second, "{\"event\":\"keeper.armed\"}");

        unsafe {
            CloseHandle(rd);
            CloseHandle(wr);
        }
    }
}

/// Close the host's copies of the keeper's handles.
///
/// The keeper OUTLIVES this, deliberately: closing our handles to it does not
/// touch the job handle it holds, which is the whole arrangement. What this
/// prevents is the host's exit being blocked, and the keeper's own process
/// object lingering as a zombie in our table.
pub fn release_keeper(k: &KeeperLaunch) {
    unsafe {
        CloseHandle(k.thread);
        CloseHandle(k.process);
        CloseHandle(k.arm_event);
        CloseHandle(k.shutdown_event);
        CloseHandle(k.stdout_read);
        CloseHandle(k.command_write);
    }
}
