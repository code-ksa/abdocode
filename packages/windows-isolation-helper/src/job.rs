//! P5c — a NAMED, protected job object, and the whole-tree termination that
//! only a name makes possible.
//!
//! ## Why this file exists
//!
//! Finding 17 of the sprint: `cmd_run` created its job with
//! `CreateJobObjectW(null, null)`. An anonymous job has no name, its handle is
//! stack-local to the helper invocation that made it, and `bInheritHandle` is
//! FALSE. So when a host died with a child still running, **no later process
//! could ever obtain a handle to that job** — the tree was unreachable by
//! construction, and `assessLiveness` had no honest answer but "defer".
//!
//! Naming the job is what makes an orphaned tree reachable. It also creates two
//! new hazards that did not exist while the job was anonymous, and most of this
//! file is about them:
//!
//!  1. **A name is a rendezvous an attacker can reach first.** `CreateJobObjectW`
//!     on an existing name RETURNS THE EXISTING JOB and sets
//!     `ERROR_ALREADY_EXISTS`. Treating that as success would put our child
//!     inside somebody else's job — a job they hold a handle to, whose limits
//!     they chose, and which they may terminate. So a collision is a REFUSAL,
//!     never an adoption.
//!  2. **A named object has a descriptor, and the default one is not ours.**
//!     `CreateJobObjectW(null, …)` gives the object a default DACL derived from
//!     the creator's token. This file passes an EXPLICIT protected descriptor
//!     instead and then READS IT BACK, because the descriptor that decides who
//!     may terminate this job is the one the OS stored, not the one we asked
//!     for.
//!
//! ## The lifetime that makes recovery work
//!
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is deliberately NOT set on the named
//! job. A kernel job object stays alive while processes are assigned to it, so
//! after a helper dies the name still resolves and a later helper can open it.
//! With KILL_ON_JOB_CLOSE the tree would die with the helper — which would make
//! the crash tests pass while destroying the very property being built, namely
//! that a surviving tree stays REACHABLE and can be terminated deliberately,
//! with evidence, by an owner that proves it owns it.
//!
//! The normal path still terminates and confirms explicitly before it exits; it
//! does not lean on handle-close semantics to clean up after it.

use crate::json;
use crate::win::*;
use std::ffi::c_void;

/// Every name this helper will create or open starts here. A name that does not
/// is not ours and is never touched.
pub const JOB_NAME_PREFIX: &str = "Local\\Abdo-IsolatedRun-";

/// `Local\` puts the object in the CALLER'S SESSION namespace
/// (`\Sessions\<n>\BaseNamedObjects\`), not the machine-wide `Global\` one. That
/// is deliberate: a job that only exists inside one session cannot be opened,
/// squatted or terminated from another session, and there is no reason for this
/// object to be visible machine-wide.
const LOCAL_PREFIX: &str = "Local\\";

/// Object names are bounded; a name that gets near the limit is a bug in the
/// caller, not something to truncate silently (truncation would COLLAPSE two
/// distinct runs onto one name, which is the one failure this design cannot
/// tolerate).
const MAX_JOB_NAME: usize = 200;

/// Is this a well-formed name that this helper is willing to act on?
///
/// Enforced HERE, in the helper, rather than trusted from the caller. The
/// helper is the thing holding the privilege; a validation that only runs on
/// the calling side is a comment.
///
/// The rules implement the brief's "no raw paths or backslashes after the
/// `Local\` prefix": a second backslash would let a caller walk out of the
/// session namespace (`Local\..\..\Global\x`) or name a nested object
/// directory, and both would defeat the session scoping above.
pub fn is_valid_job_name(name: &str) -> bool {
    if !name.starts_with(JOB_NAME_PREFIX) || name.len() > MAX_JOB_NAME {
        return false;
    }
    // THE PREFIX ALONE IS NOT A NAME. Without something after it there is no
    // run-specific component at all, so every run would contend for one object.
    // The terminate verb rejects it downstream anyway (its identity check needs
    // a nonce beyond the derived prefix), but a name that cannot be legitimate
    // should never be created in the first place.
    if name.len() <= JOB_NAME_PREFIX.len() {
        return false;
    }
    let tail = &name[LOCAL_PREFIX.len()..];
    // EXACTLY ONE backslash in the whole string — the one in `Local\`.
    if tail.contains('\\') || tail.is_empty() {
        return false;
    }
    // A closed charset. No dots (no `..`), no slashes, no colons, no spaces, no
    // characters that are meaningful to the object manager.
    tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The host SID, folded to a fixed-width hex token safe for an object name.
///
/// A SID contains hyphens and would otherwise be indistinguishable from the
/// name's own separators; hashing also keeps the name bounded. Sixteen hex
/// characters (64 bits) is not a secret — the name is not a capability, the
/// DESCRIPTOR is — it only has to make two different users' names differ.
pub fn host_sid_hash(host_sid: &str) -> String {
    crate::sha256::sha256_hex(host_sid.to_lowercase().as_bytes())[..16].to_string()
}

/// Everything in a job's name except its nonce.
///
/// THE SHARED DERIVATION RULE, and the reason the terminate verb can prove an
/// identity it was merely told. A caller hands over a `jobName` plus the runId /
/// operationId / fencingToken it claims that job belongs to; recomputing this
/// prefix from the claim and requiring the name to start with it means a caller
/// cannot present run A's name with run B's evidence, and a STALE owner cannot
/// name a job minted under a higher fencing token — its own token is baked into
/// the string it would have to produce.
///
/// The host SID hash comes from THIS process's token, so a name derived for a
/// different user is refused here rather than opened.
pub fn job_name_prefix_for(host_sid: &str, run_id: &str, operation_id: &str, fencing_token: u64) -> String {
    format!("{}{}-{}-{}-{}-", JOB_NAME_PREFIX, host_sid_hash(host_sid), run_id, operation_id, fencing_token)
}

/// The rights the host SID is granted on the job, as an SDDL hex mask.
fn creator_mask_hex() -> String {
    format!("0x{:x}", JOB_RIGHTS_CREATOR)
}

/// The ONLY descriptor this helper will put on a job it creates.
///
/// `O:`/`G:` set the owner explicitly instead of accepting the token default,
/// and `D:P` PROTECTS the DACL so nothing is inherited from the object
/// directory. One ACE, for one SID, with one mask.
///
/// What is absent is the point, and it is absent BY CONSTRUCTION rather than by
/// filtering: no `WD` (Everyone), no `AU` (Authenticated Users), no `BU`
/// (Builtin Users), no `AC`/`S-1-15-2-*` (AppContainer), no `SY`/`BA`
/// (SYSTEM/Administrators). SYSTEM and Administrators are omitted because
/// nothing measured needs them — the creating helper and the reclaiming helper
/// both run as the host user — and the brief admits them only "when measured and
/// necessary".
pub fn protected_job_sddl(host_sid: &str) -> String {
    format!("O:{0}G:{0}D:P(A;;{1};;;{0})", host_sid, creator_mask_hex())
}

/// Principals that must never appear in a job descriptor of ours, in both the
/// SDDL alias form and the raw-SID form Windows may render instead.
const FORBIDDEN_TRUSTEES: &[&str] = &["WD", "AU", "BU", "AC", "S-1-1-0", "S-1-5-11", "S-1-5-32-545"];

/// The DACL section of an SDDL string: its flags, and its ACEs.
///
/// Scans at PAREN DEPTH ZERO so a `D:` appearing inside an ACE (a conditional
/// ACE, an unusual trustee) cannot be mistaken for the start of the DACL.
fn dacl_section(sddl: &str) -> Option<(String, Vec<String>)> {
    let b: Vec<char> = sddl.chars().collect();
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    for i in 0..b.len() {
        match b[i] {
            '(' => depth += 1,
            ')' => depth -= 1,
            'D' if depth == 0 && i + 1 < b.len() && b[i + 1] == ':' => {
                start = Some(i + 2);
                break;
            }
            _ => {}
        }
    }
    let s = start?;
    // Flags run until the first ACE, or until the next top-level section.
    let mut flags = String::new();
    let mut i = s;
    while i < b.len() && b[i] != '(' {
        // `S:` (SACL) would end the DACL section without any ACE.
        if b[i] == 'S' && i + 1 < b.len() && b[i + 1] == ':' {
            break;
        }
        flags.push(b[i]);
        i += 1;
    }
    let mut aces: Vec<String> = Vec::new();
    let mut depth2 = 0i32;
    let mut cur = String::new();
    while i < b.len() {
        match b[i] {
            '(' => {
                depth2 += 1;
                if depth2 == 1 {
                    cur.clear();
                    i += 1;
                    continue;
                }
            }
            ')' => {
                depth2 -= 1;
                if depth2 == 0 {
                    aces.push(cur.clone());
                    i += 1;
                    continue;
                }
            }
            'S' if depth2 == 0 && i + 1 < b.len() && b[i + 1] == ':' => break,
            _ => {}
        }
        if depth2 >= 1 {
            cur.push(b[i]);
        }
        i += 1;
    }
    Some((flags, aces))
}

/// Does this OBSERVED descriptor say what the job's descriptor must say?
///
/// STRUCTURAL, never a string or hash comparison against what was requested.
/// MEASURED ELSEWHERE IN THIS PACKAGE (`execution-root.ts`, the root's DACL):
/// Windows rewrites a requested `D:P(...)` as `D:PAI(...)` by adding the
/// auto-inherit flag itself, so an equality check against the request always
/// fails and would make every job we correctly created look tampered with.
pub fn is_protected_owner_only_job_dacl(sddl: &str, host_sid: &str) -> Result<(), String> {
    let (flags, aces) = match dacl_section(sddl) {
        Some(v) => v,
        None => return Err("the descriptor has no DACL section".into()),
    };
    if !flags.contains('P') {
        return Err(format!("the DACL is not protected (flags {:?}); it can inherit ACEs from the object directory", flags));
    }
    if aces.len() != 1 {
        return Err(format!("expected exactly one ACE, found {}: {:?}", aces.len(), aces));
    }
    // ace_type;ace_flags;rights;object_guid;inherit_object_guid;account_sid
    let p: Vec<&str> = aces[0].split(';').collect();
    if p.len() < 6 {
        return Err(format!("the ACE is not in the six-field SDDL form: {:?}", aces[0]));
    }
    if p[0] != "A" {
        return Err(format!("the ACE is {:?}, not an allow ACE", p[0]));
    }
    if !p[1].is_empty() {
        return Err(format!("the ACE carries flags {:?}; a job ACE inherits nothing and must carry none", p[1]));
    }
    let trustee = p[5].trim();
    if !trustee.eq_ignore_ascii_case(host_sid) {
        return Err(format!("the ACE grants {:?}, not the host SID {:?}", trustee, host_sid));
    }
    for bad in FORBIDDEN_TRUSTEES {
        if trustee.eq_ignore_ascii_case(bad) {
            return Err(format!("the ACE grants the forbidden principal {:?}", trustee));
        }
    }
    // The mask, compared NUMERICALLY. SDDL may render it as hex or as letter
    // abbreviations, so a string compare is not a mask compare.
    let got = parse_sddl_mask(p[2]).ok_or_else(|| format!("the ACE mask {:?} could not be parsed", p[2]))?;
    if got != JOB_RIGHTS_CREATOR {
        return Err(format!("the ACE mask is 0x{:x}, expected 0x{:x}", got, JOB_RIGHTS_CREATOR));
    }
    Ok(())
}

/// An SDDL rights field as a numeric mask. Handles the hex form Windows writes
/// back for a numeric request, and the generic letter pairs it may substitute.
fn parse_sddl_mask(s: &str) -> Option<DWORD> {
    let t = s.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return DWORD::from_str_radix(hex, 16).ok();
    }
    if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
        return t.parse::<DWORD>().ok();
    }
    // Letter pairs. Only the ones that can appear on a job object are decoded;
    // an unknown pair returns None so it becomes a refusal, not a guess.
    let mut mask: DWORD = 0;
    let b: Vec<char> = t.chars().collect();
    let mut i = 0;
    while i + 1 < b.len() {
        let pair: String = b[i..i + 2].iter().collect();
        mask |= match pair.as_str() {
            "RC" => READ_CONTROL,
            "SD" => 0x0001_0000, // DELETE
            "WD" => 0x0004_0000, // WRITE_DAC
            "WO" => 0x0008_0000, // WRITE_OWNER
            _ => return None,
        };
        i += 2;
    }
    if i != b.len() {
        return None;
    }
    Some(mask)
}

/// The session this process runs in. `Local\` names resolve per session, so the
/// session is part of a named job's identity, not an incidental detail.
pub fn current_session_id() -> Option<DWORD> {
    unsafe {
        let mut s: DWORD = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut s) == 0 {
            return None;
        }
        Some(s)
    }
}

pub enum JobCreate {
    Created(HANDLE),
    /// The name is ALREADY TAKEN. Nothing was assigned, adopted or terminated.
    ///
    /// `opened` records WHICH of the two collision shapes occurred, because
    /// they are not the same event and the distinction is evidence:
    ///
    ///  - `true`  — `ERROR_ALREADY_EXISTS`. `CreateJobObjectW` opened the
    ///    EXISTING job and handed us a handle to somebody else's object. The
    ///    handle has already been closed by the time this is returned.
    ///  - `false` — `ERROR_ACCESS_DENIED`. MEASURED, and it is the case that
    ///    actually happens against one of OUR jobs: when the name exists,
    ///    `CreateJobObjectW` tries to open it with `JOB_OBJECT_ALL_ACCESS`, and
    ///    the protected descriptor this file writes grants neither `WRITE_DAC`
    ///    nor `WRITE_OWNER` nor `DELETE` — so the open is denied and no handle
    ///    is ever produced. Strictly the safer of the two, and it only reads as
    ///    a permission problem if you do not know the descriptor is ours.
    Collision { opened: bool },
    /// The name is occupied by a kernel object that is not a job.
    TypeConflict(DWORD),
    Failed(&'static str, DWORD),
}

/// Create the named job with an EXPLICIT protected descriptor.
///
/// The descriptor is built from SDDL and passed in `SECURITY_ATTRIBUTES`; the
/// default job DACL is never relied on.
pub fn create_protected_named_job(name: &str, host_sid: &str) -> JobCreate {
    if !is_valid_job_name(name) {
        return JobCreate::Failed("job_name_invalid", 0);
    }
    let sddl = protected_job_sddl(host_sid);
    let wsddl = crate::win::wide(&sddl);
    let mut psd: *mut c_void = std::ptr::null_mut();
    let mut sd_len: u32 = 0;
    unsafe {
        if crate::acl::ConvertStringSecurityDescriptorToSecurityDescriptorW(wsddl.as_ptr(), crate::acl::SDDL_REVISION_1, &mut psd, &mut sd_len) == 0 {
            return JobCreate::Failed("job_security_descriptor_unbuildable", GetLastError());
        }
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
        lpSecurityDescriptor: psd,
        // NOT inheritable. A child must never receive a handle to the job that
        // contains it — that is a handle to its own cage.
        bInheritHandle: FALSE,
    };
    let wname = crate::win::wide(name);
    let job = unsafe {
        // CLEARED FIRST. `CreateJobObjectW` sets ERROR_ALREADY_EXISTS on the
        // collision path but does not promise to clear the thread's last error
        // on the fresh-creation path, so reading a stale value would report a
        // collision that did not happen.
        SetLastError(0);
        CreateJobObjectW(&sa, wname.as_ptr())
    };
    let err = unsafe { GetLastError() };
    unsafe { LocalFree(psd) };

    if job.is_null() {
        // A name held by a DIFFERENT kernel object type fails here rather than
        // colliding: the object manager finds the name, sees the type mismatch,
        // and refuses.
        if err == ERROR_INVALID_HANDLE {
            return JobCreate::TypeConflict(err);
        }
        // THE NAME IS TAKEN BY A JOB WE MAY NOT FULLY OPEN — measured, and the
        // normal outcome when the existing job carries our own protected
        // descriptor. Treated as the collision it is rather than as a generic
        // failure, so recovery and the tests see one reason code for one event.
        if err == ERROR_ACCESS_DENIED {
            return JobCreate::Collision { opened: false };
        }
        return JobCreate::Failed("CreateJobObjectW", err);
    }
    if err == ERROR_ALREADY_EXISTS {
        // THE HANDLE WE HOLD IS SOMEBODY ELSE'S JOB. Close it and stop.
        //
        // Not terminated: we have proved nothing about whose it is, and
        // terminating an unknown job is exactly the "kill by name" behaviour
        // this whole design refuses. Not adopted: assigning our child into a job
        // another process created would put it under limits we did not choose
        // and a handle we do not control.
        unsafe { CloseHandle(job) };
        return JobCreate::Collision { opened: true };
    }
    JobCreate::Created(job)
}

/// Open a job THIS helper did not create, by exact name, with the minimum
/// rights the caller needs.
pub fn open_named_job(name: &str, access: DWORD) -> Result<HANDLE, DWORD> {
    if !is_valid_job_name(name) {
        return Err(0);
    }
    let wname = crate::win::wide(name);
    let h = unsafe { OpenJobObjectW(access, FALSE, wname.as_ptr()) };
    if h.is_null() {
        return Err(unsafe { GetLastError() });
    }
    Ok(h)
}

/// The job's assigned-process list, straight from the kernel.
///
/// `TerminateJobObject`'s return code says a call was made, not that a tree
/// died. This is the query that turns "we asked" into "there is nothing left",
/// and it is why `JOB_OBJECT_QUERY` is in the terminator's rights.
pub fn job_process_ids(job: HANDLE) -> Result<(DWORD, Vec<DWORD>), DWORD> {
    // A `Vec<u64>` rather than a `Vec<u8>`: the trailing `ProcessIdList` is an
    // array of `ULONG_PTR`, and reading it out of a byte buffer would be an
    // unaligned pointer read.
    let mut cap: usize = 64;
    loop {
        let words = 1 + cap; // one 8-byte header (two DWORDs) + cap ids
        let mut buf: Vec<u64> = vec![0; words];
        let bytes = words * 8;
        let mut returned: DWORD = 0;
        let ok = unsafe {
            SetLastError(0);
            QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf.as_mut_ptr() as *mut c_void, bytes as DWORD, &mut returned)
        };
        let err = unsafe { GetLastError() };
        let hdr = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST_HEADER) };
        let assigned = hdr.NumberOfAssignedProcesses;
        let in_list = hdr.NumberOfProcessIdsInList;

        // A partial answer is reported as failure with ERROR_MORE_DATA, and the
        // header still carries the true assigned count — so the buffer is grown
        // from a MEASUREMENT rather than doubled blindly.
        if ok == 0 {
            if err == ERROR_MORE_DATA && (assigned as usize) > cap && cap < 65_536 {
                cap = (assigned as usize) + 64;
                continue;
            }
            return Err(err);
        }
        if (in_list as usize) < (assigned as usize) && cap < 65_536 {
            cap = (assigned as usize) + 64;
            continue;
        }
        let base = unsafe { buf.as_ptr().add(1) };
        let mut pids = Vec::with_capacity(in_list as usize);
        for i in 0..in_list as usize {
            pids.push(unsafe { *base.add(i) } as DWORD);
        }
        return Ok((assigned, pids));
    }
}

/// Wait until the job holds NO assigned processes, or the budget runs out.
///
/// Returns `(empty, remaining)`.
///
/// **The job handle's signalled state is NOT a general "everything exited"
/// signal.** A job object becomes signalled only when its end-of-job TIME LIMIT
/// expires, and this job sets no time limit — so `WaitForSingleObject` on it
/// would block for the whole budget and then report a timeout on a job that
/// emptied immediately. The authoritative answer is the member list, so that is
/// what is polled. `SYNCHRONIZE` is still held because it costs nothing and a
/// future limit would make the wait meaningful.
pub fn drain_job(job: HANDLE, budget_ms: u64) -> (bool, u32) {
    let started = std::time::Instant::now();
    let mut last: u32 = u32::MAX;
    loop {
        match job_process_ids(job) {
            Ok((assigned, _)) => {
                last = assigned;
                if assigned == 0 {
                    return (true, 0);
                }
            }
            // The job is unreadable. Reporting "empty" here would turn a lost
            // handle into a proof of termination, which is the one lie this
            // function must not tell.
            Err(_) => return (false, last),
        }
        if started.elapsed().as_millis() as u64 >= budget_ms {
            return (false, last);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// What we can prove about one process, without trusting its pid alone.
pub struct ProcFacts {
    pub pid: DWORD,
    /// Decimal FILETIME digits. Empty when it could not be read.
    pub start_time: u64,
    pub image: String,
    pub app_container_sid: String,
    pub is_app_container: bool,
    pub alive: bool,
    /// The identity could not be established — NOT the same as "it exited".
    pub identity_unknown: bool,
    pub open_error: DWORD,
}

const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
const PROCESS_QUERY_INFORMATION: DWORD = 0x0400;
const STILL_ACTIVE: DWORD = 259;
const ERROR_INVALID_PARAMETER: DWORD = 87;

/// Measure one process. A pid on its own is not an identity — Windows reuses
/// them aggressively — so the creation time is read and reported with it.
pub fn inspect_pid(pid: DWORD) -> ProcFacts {
    let mut f = ProcFacts {
        pid,
        start_time: 0,
        image: String::new(),
        app_container_sid: String::new(),
        is_app_container: false,
        alive: false,
        identity_unknown: false,
        open_error: 0,
    };
    unsafe {
        // The wider right first, because `OpenProcessToken` needs
        // PROCESS_QUERY_INFORMATION; fall back to the limited right so a
        // process we can still identify is not reported as unknown.
        SetLastError(0);
        let mut h = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid);
        let mut can_token = true;
        if h.is_null() {
            can_token = false;
            SetLastError(0);
            h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        }
        if h.is_null() {
            let e = GetLastError();
            f.open_error = e;
            // A pid that no longer exists is GONE, which is the outcome we want
            // and not an unknown. Anything else — ACCESS_DENIED above all — is
            // an identity we could not establish, and it must DEFER rather than
            // let a termination be reported as verified.
            f.identity_unknown = e != ERROR_INVALID_PARAMETER;
            return f;
        }
        let mut code: DWORD = 0;
        GetExitCodeProcess(h, &mut code);
        f.alive = code == STILL_ACTIVE;
        let mut c: [DWORD; 2] = [0, 0];
        let mut e: [DWORD; 2] = [0, 0];
        let mut k: [DWORD; 2] = [0, 0];
        let mut u: [DWORD; 2] = [0, 0];
        if GetProcessTimes(h, c.as_mut_ptr(), e.as_mut_ptr(), k.as_mut_ptr(), u.as_mut_ptr()) != 0 {
            f.start_time = ((c[1] as u64) << 32) | c[0] as u64;
        } else {
            f.identity_unknown = true;
        }
        f.image = crate::actual_process_image(h);
        if can_token {
            let (is_ac, sid) = crate::token_appcontainer(h);
            f.is_app_container = is_ac;
            f.app_container_sid = sid;
        }
        CloseHandle(h);
    }
    f
}

pub fn proc_facts_json(f: &ProcFacts) -> json::Obj {
    json::Obj::new()
        .num("pid", f.pid as i64)
        // A STRING: a FILETIME is ~1.3e17 and a JSON number loses its low digits
        // at 2^53, which turns "pid + creation time" into a check that reports
        // every live process as dead.
        .str("startTime", &f.start_time.to_string())
        .str("image", &f.image)
        .str("appContainerSid", &f.app_container_sid)
        .bool("isAppContainer", f.is_app_container)
        .bool("alive", f.alive)
        .bool("identityUnknown", f.identity_unknown)
        .num("openError", f.open_error as i64)
}
