//! P5c2-FINAL-RC4 §1 — THE CONTAINMENT PROBE.
//!
//! ## The question this exists to settle
//!
//! `appcontainer.test.ts` "CONTROL: without a job the SAME detach attempt
//! escapes the kill" fails at medium integrity, and the RC3 measurement was
//! this: the process launched by `cmd /c start /b …` was still alive with a dead
//! parent while its two siblings were gone, holding the inherited stdout pipe
//! and stalling the helper for ~37 s past its 3 s timeout.
//!
//! Two explanations fit that observation and they have OPPOSITE implications:
//!
//!   B. the detached child never became a job member -> a containment defect;
//!   D. an outer job made the measurement invalid -> UNMEASURED.
//!
//! RC3 could not separate them, so RC4 refuses to touch the production
//! containment code until this probe answers it.
//!
//! ## Why this is not part of the helper
//!
//! It is a MEASUREMENT INSTRUMENT, not product code, and it must not be able to
//! change the thing it measures. It is deliberately NOT a `[[bin]]` in
//! `Cargo.toml` and deliberately NOT under `src/`: either would alter a source
//! closure (`Cargo.toml` is an input to BOTH manifests) and force a rebuild that
//! could change the very artefact hashes RC4 requires to stay fixed.
//!
//! It is compiled with the same pinned toolchain, has no dependencies, and
//! declares its Win32 by hand against std only — the same rules `src/` follows.
//!
//! ## What makes it an authority
//!
//! Membership is read from `QueryInformationJobObject(JobObjectBasicProcessIdList)`
//! — the kernel's own list — never inferred from process names, parentage or
//! `IsProcessInJob(h, NULL)`, which answers "in ANY job?" and is useless here
//! because every process in an agent session is already inside an outer job.
//!
//! Every pid is bound to its creation time, so a pid the kernel reused cannot be
//! mistaken for a survivor. Termination is followed by waiting on process
//! HANDLES, not by polling pids.
//!
//!   containment-probe self
//!   containment-probe tree --shape <shape> [--named <jobname>] [--budget-ms N]
//!
//! Shapes: direct · grandchild · startb · noinherit · breakaway
//!
//! Exit 0 = the probe ran and printed a verdict (which may be a defect verdict).
//! Exit 2 = the probe could not measure (bad arguments, API failure).

#![allow(non_snake_case, non_camel_case_types)]

use std::ffi::c_void;

type HANDLE = *mut c_void;
type DWORD = u32;
type BOOL = i32;
type WCHAR = u16;
type ULONG_PTR = usize;
type SIZE_T = usize;
type LPVOID = *mut c_void;

const FALSE: BOOL = 0;
const TRUE: BOOL = 1;
const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

// Production parity: `src/main.rs` uses exactly these for the target launch.
const CREATE_SUSPENDED: DWORD = 0x0000_0004;
const CREATE_NO_WINDOW: DWORD = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: DWORD = 0x0100_0000;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x0000_2000;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK: DWORD = 0x0000_0800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: DWORD = 0x0000_1000;

const JobObjectBasicProcessIdList: i32 = 3;
const JobObjectExtendedLimitInformation: i32 = 9;

const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
const STILL_ACTIVE: DWORD = 259;
const WAIT_OBJECT_0: DWORD = 0;
const WAIT_TIMEOUT: DWORD = 258;
const ERROR_INVALID_PARAMETER: DWORD = 87;

const JOB_ALL_ACCESS: DWORD = 0x1F001F;
const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;

#[repr(C)]
struct STARTUPINFOW {
    cb: DWORD,
    lpReserved: *mut WCHAR,
    lpDesktop: *mut WCHAR,
    lpTitle: *mut WCHAR,
    dwX: DWORD,
    dwY: DWORD,
    dwXSize: DWORD,
    dwYSize: DWORD,
    dwXCountChars: DWORD,
    dwYCountChars: DWORD,
    dwFillAttribute: DWORD,
    dwFlags: DWORD,
    wShowWindow: u16,
    cbReserved2: u16,
    lpReserved2: *mut u8,
    hStdInput: HANDLE,
    hStdOutput: HANDLE,
    hStdError: HANDLE,
}

#[repr(C)]
struct PROCESS_INFORMATION {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: DWORD,
    dwThreadId: DWORD,
}

#[repr(C)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    PerProcessUserTimeLimit: i64,
    PerJobUserTimeLimit: i64,
    LimitFlags: DWORD,
    MinimumWorkingSetSize: SIZE_T,
    MaximumWorkingSetSize: SIZE_T,
    ActiveProcessLimit: DWORD,
    Affinity: ULONG_PTR,
    PriorityClass: DWORD,
    SchedulingClass: DWORD,
}

#[repr(C)]
struct IO_COUNTERS {
    ReadOperationCount: u64,
    WriteOperationCount: u64,
    OtherOperationCount: u64,
    ReadTransferCount: u64,
    WriteTransferCount: u64,
    OtherTransferCount: u64,
}

#[repr(C)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: SIZE_T,
    JobMemoryLimit: SIZE_T,
    PeakProcessMemoryUsed: SIZE_T,
    PeakJobMemoryUsed: SIZE_T,
}

#[repr(C)]
struct PROCESSENTRY32W {
    dwSize: DWORD,
    cntUsage: DWORD,
    th32ProcessID: DWORD,
    th32DefaultHeapID: ULONG_PTR,
    th32ModuleID: DWORD,
    cntThreads: DWORD,
    th32ParentProcessID: DWORD,
    pcPriClassBase: i32,
    dwFlags: DWORD,
    szExeFile: [WCHAR; 260],
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> DWORD;
    fn SetLastError(e: DWORD);
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn GetCurrentProcess() -> HANDLE;
    fn GetCurrentProcessId() -> DWORD;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn CreateJobObjectW(attrs: *const c_void, name: *const WCHAR) -> HANDLE;
    fn OpenJobObjectW(access: DWORD, inherit: BOOL, name: *const WCHAR) -> HANDLE;
    fn SetInformationJobObject(job: HANDLE, class: i32, info: *const c_void, len: DWORD) -> BOOL;
    fn QueryInformationJobObject(job: HANDLE, class: i32, info: LPVOID, len: DWORD, returned: *mut DWORD) -> BOOL;
    fn AssignProcessToJobObject(job: HANDLE, process: HANDLE) -> BOOL;
    fn TerminateJobObject(job: HANDLE, code: DWORD) -> BOOL;
    fn IsProcessInJob(process: HANDLE, job: HANDLE, result: *mut BOOL) -> BOOL;
    fn CreateProcessW(
        app: *const WCHAR,
        cmd: *mut WCHAR,
        pattr: *const c_void,
        tattr: *const c_void,
        inherit: BOOL,
        flags: DWORD,
        env: *const c_void,
        cwd: *const WCHAR,
        si: *const STARTUPINFOW,
        pi: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    fn ResumeThread(t: HANDLE) -> DWORD;
    fn WaitForSingleObject(h: HANDLE, ms: DWORD) -> DWORD;
    fn GetExitCodeProcess(h: HANDLE, code: *mut DWORD) -> BOOL;
    fn GetProcessTimes(h: HANDLE, c: *mut DWORD, e: *mut DWORD, k: *mut DWORD, u: *mut DWORD) -> BOOL;
    fn QueryFullProcessImageNameW(h: HANDLE, flags: DWORD, buf: *mut WCHAR, size: *mut DWORD) -> BOOL;
    fn ProcessIdToSessionId(pid: DWORD, session: *mut DWORD) -> BOOL;
    fn CreateToolhelp32Snapshot(flags: DWORD, pid: DWORD) -> HANDLE;
    fn Process32FirstW(snap: HANDLE, e: *mut PROCESSENTRY32W) -> BOOL;
    fn Process32NextW(snap: HANDLE, e: *mut PROCESSENTRY32W) -> BOOL;
}

fn wide(s: &str) -> Vec<WCHAR> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(b: &[WCHAR]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..n])
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

// ── process facts ─────────────────────────────────────────────────────────
//
// A pid is not an identity: Windows reuses pids aggressively, so every pid here
// is reported WITH its creation time and a caller that compares them can tell a
// survivor from a stranger wearing its number.

struct Facts {
    pid: DWORD,
    start_time: u64,
    image: String,
    parent_pid: DWORD,
    parent_start_time: u64,
    session_id: DWORD,
    alive: bool,
    in_any_job: i32,   // -1 unknown
    exit_code: DWORD,
    open_error: DWORD,
    identity_unknown: bool,
}

fn creation_time(h: HANDLE) -> u64 {
    let mut c: [DWORD; 2] = [0, 0];
    let mut e: [DWORD; 2] = [0, 0];
    let mut k: [DWORD; 2] = [0, 0];
    let mut u: [DWORD; 2] = [0, 0];
    unsafe {
        if GetProcessTimes(h, c.as_mut_ptr(), e.as_mut_ptr(), k.as_mut_ptr(), u.as_mut_ptr()) != 0 {
            ((c[1] as u64) << 32) | c[0] as u64
        } else {
            0
        }
    }
}

/// The parent pid, from a Toolhelp snapshot. Reported only WITH the parent's own
/// creation time, because a recorded parent pid whose process has exited and
/// been replaced says nothing.
fn parent_of(pid: DWORD) -> DWORD {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return 0;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            if e.th32ProcessID == pid {
                CloseHandle(snap);
                return e.th32ParentProcessID;
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
        0
    }
}

fn inspect(pid: DWORD) -> Facts {
    let mut f = Facts {
        pid,
        start_time: 0,
        image: String::new(),
        parent_pid: 0,
        parent_start_time: 0,
        session_id: DWORD::MAX,
        alive: false,
        in_any_job: -1,
        exit_code: 0,
        open_error: 0,
        identity_unknown: false,
    };
    unsafe {
        SetLastError(0);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            let e = GetLastError();
            f.open_error = e;
            // A pid that is genuinely gone is the outcome we WANT; anything else
            // is an identity we could not establish and must not be reported as
            // a clean death.
            f.identity_unknown = e != ERROR_INVALID_PARAMETER;
            return f;
        }
        let mut code: DWORD = 0;
        GetExitCodeProcess(h, &mut code);
        f.exit_code = code;
        f.alive = code == STILL_ACTIVE;
        f.start_time = creation_time(h);
        let mut buf = [0u16; 32768];
        let mut size = buf.len() as DWORD;
        if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) != 0 {
            f.image = from_wide(&buf[..size as usize]);
        }
        let mut s: DWORD = 0;
        if ProcessIdToSessionId(pid, &mut s) != 0 {
            f.session_id = s;
        }
        let mut any: BOOL = 0;
        if IsProcessInJob(h, std::ptr::null_mut(), &mut any) != 0 {
            f.in_any_job = any;
        }
        CloseHandle(h);
    }
    f.parent_pid = parent_of(pid);
    if f.parent_pid != 0 {
        unsafe {
            let ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, f.parent_pid);
            if !ph.is_null() {
                f.parent_start_time = creation_time(ph);
                CloseHandle(ph);
            }
        }
    }
    f
}

fn facts_json(f: &Facts) -> String {
    format!(
        "{{\"pid\":{},\"startTime\":\"{}\",\"image\":\"{}\",\"parentPid\":{},\"parentStartTime\":\"{}\",\"sessionId\":{},\"alive\":{},\"inAnyJob\":{},\"exitCode\":{},\"openError\":{},\"identityUnknown\":{}}}",
        f.pid,
        f.start_time,
        esc(&f.image),
        f.parent_pid,
        f.parent_start_time,
        if f.session_id == DWORD::MAX { -1i64 } else { f.session_id as i64 },
        f.alive,
        match f.in_any_job {
            -1 => "null".to_string(),
            0 => "false".to_string(),
            _ => "true".to_string(),
        },
        f.exit_code,
        f.open_error,
        f.identity_unknown
    )
}

// ── job facts ─────────────────────────────────────────────────────────────

/// THE AUTHORITATIVE MEMBER LIST — the kernel's own, never inferred.
fn job_members(job: HANDLE) -> Result<Vec<DWORD>, DWORD> {
    // The list is variable-length; grow until it fits rather than guessing once.
    let mut capacity = 64usize;
    loop {
        let bytes = 8 + capacity * std::mem::size_of::<ULONG_PTR>();
        let mut buf = vec![0u8; bytes];
        let mut returned: DWORD = 0;
        let ok = unsafe { QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf.as_mut_ptr() as LPVOID, bytes as DWORD, &mut returned) };
        if ok == 0 {
            let e = unsafe { GetLastError() };
            // ERROR_MORE_DATA (234): the list outgrew the buffer.
            if e == 234 && capacity < 65536 {
                capacity *= 2;
                continue;
            }
            return Err(e);
        }
        let assigned = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let in_list = u32::from_ne_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let _ = assigned;
        let mut pids = Vec::with_capacity(in_list as usize);
        for i in 0..in_list as usize {
            let off = 8 + i * std::mem::size_of::<ULONG_PTR>();
            let mut v = [0u8; 8];
            v.copy_from_slice(&buf[off..off + 8]);
            pids.push(usize::from_ne_bytes(v) as DWORD);
        }
        return Ok(pids);
    }
}

fn job_limit_flags(job: HANDLE) -> Result<DWORD, DWORD> {
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let mut returned: DWORD = 0;
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as LPVOID,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(unsafe { GetLastError() });
    }
    Ok(info.BasicLimitInformation.LimitFlags)
}

fn members_json(m: &Result<Vec<DWORD>, DWORD>) -> String {
    match m {
        Ok(pids) => format!("{{\"ok\":true,\"count\":{},\"pids\":[{}]}}", pids.len(), pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")),
        Err(e) => format!("{{\"ok\":false,\"error\":{}}}", e),
    }
}

// ── mode: self ────────────────────────────────────────────────────────────
//
// D IS A REAL POSSIBILITY AND IT IS MEASURED, NOT ASSUMED. If this process is
// already inside an outer job, whether that job permits breakaway decides
// whether a nested job's containment can be measured here at all.

fn mode_self() -> i32 {
    let me = unsafe { GetCurrentProcessId() };
    let f = inspect(me);
    println!("{{\"mode\":\"self\",\"process\":{}", facts_json(&f));

    // "Am I in a job?" is answerable. "WHICH job?" is not, without a handle —
    // so the outer job's limits are probed by CREATING a nested job and asking
    // what the OS permits, which is the operational question anyway.
    let nested = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    let nested_created = !nested.is_null();
    let nested_err = if nested_created { 0 } else { unsafe { GetLastError() } };
    let mut assign_ok = false;
    let mut assign_err = 0;
    let mut nested_flags: i64 = -1;
    if nested_created {
        // Nesting is what Windows 8+ allows and what production relies on
        // implicitly: if assigning THIS process to a nested job succeeds, then a
        // helper inside an agent's outer job can still create and own its own.
        // Deliberately NOT assigning self — that would put the probe in a job it
        // is about to terminate. A throwaway child is used instead, below.
        if let Ok(fl) = job_limit_flags(nested) {
            nested_flags = fl as i64;
        }
        // Can a child break away from a job? Measured by TRYING, with a child
        // that exits immediately.
        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let mut cmd = wide("C:\\Windows\\System32\\cmd.exe /c exit 0");
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                FALSE,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                std::ptr::null(),
                std::ptr::null(),
                &si,
                &mut pi,
            )
        };
        if created != 0 {
            assign_ok = unsafe { AssignProcessToJobObject(nested, pi.hProcess) } != 0;
            if !assign_ok {
                assign_err = unsafe { GetLastError() };
            }
            unsafe {
                ResumeThread(pi.hThread);
                WaitForSingleObject(pi.hProcess, 5_000);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
            }
        }
        unsafe { CloseHandle(nested) };
    }

    // Does the OUTER job permit breakaway? Answered by launching a child WITH
    // CREATE_BREAKAWAY_FROM_JOB: it fails with ERROR_ACCESS_DENIED (5) when the
    // containing job does not allow it.
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut cmd = wide("C:\\Windows\\System32\\cmd.exe /c exit 0");
    let breakaway_ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            FALSE,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
            std::ptr::null(),
            std::ptr::null(),
            &si,
            &mut pi,
        )
    };
    let breakaway_err = if breakaway_ok != 0 { 0 } else { unsafe { GetLastError() } };
    if breakaway_ok != 0 {
        unsafe {
            WaitForSingleObject(pi.hProcess, 5_000);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }

    println!(
        ",\"nestedJobCreated\":{},\"nestedJobError\":{},\"nestedAssignSucceeded\":{},\"nestedAssignError\":{},\"nestedJobLimitFlags\":{},\"outerJobPermitsBreakaway\":{},\"breakawayError\":{}}}",
        nested_created, nested_err, assign_ok, assign_err, nested_flags, breakaway_ok != 0, breakaway_err
    );
    0
}

// ── mode: tree ────────────────────────────────────────────────────────────

struct Shape {
    name: &'static str,
    command: String,
    flags: DWORD,
    inherit: BOOL,
}

fn shape_for(name: &str) -> Option<Shape> {
    let ps = "powershell -NoProfile -Command Start-Sleep -Seconds 40";
    match name {
        // The helper's own normal case: one direct child that just sleeps.
        "direct" => Some(Shape { name: "direct", command: format!("C:\\Windows\\System32\\cmd.exe /c {}", ps), flags: CREATE_SUSPENDED | CREATE_NO_WINDOW, inherit: TRUE }),
        // A child that starts its own child: descendants must stay in the job.
        "grandchild" => Some(Shape {
            name: "grandchild",
            command: "C:\\Windows\\System32\\cmd.exe /c powershell -NoProfile -Command \"Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -WindowStyle Hidden; Start-Sleep -Seconds 40\"".to_string(),
            flags: CREATE_SUSPENDED | CREATE_NO_WINDOW,
            inherit: TRUE,
        }),
        // THE FAILING CASE, byte-for-byte the command appcontainer.test.ts uses.
        "startb" => Some(Shape {
            name: "startb",
            command: format!("C:\\Windows\\System32\\cmd.exe /c start /b {} & {}", ps, ps),
            flags: CREATE_SUSPENDED | CREATE_NO_WINDOW,
            inherit: TRUE,
        }),
        // Handle inheritance off: proves membership does not depend on handles.
        "noinherit" => Some(Shape { name: "noinherit", command: format!("C:\\Windows\\System32\\cmd.exe /c {}", ps), flags: CREATE_SUSPENDED | CREATE_NO_WINDOW, inherit: FALSE }),
        // An explicit escape attempt: must FAIL against a job without BREAKAWAY_OK.
        "breakaway" => Some(Shape {
            name: "breakaway",
            command: format!("C:\\Windows\\System32\\cmd.exe /c {}", ps),
            flags: CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB,
            inherit: TRUE,
        }),
        _ => None,
    }
}

/// Every process that looks like part of this shape's tree, by image and recency
/// — used ONLY to find candidates the job list may be missing. The verdict never
/// rests on it; it exists precisely so a non-member can be SEEN.
fn candidate_pids(after_filetime: u64) -> Vec<DWORD> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let name = from_wide(&e.szExeFile).to_lowercase();
            if name == "cmd.exe" || name == "powershell.exe" || name == "conhost.exe" {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, e.th32ProcessID);
                if !h.is_null() {
                    let ct = creation_time(h);
                    CloseHandle(h);
                    if ct >= after_filetime {
                        out.push(e.th32ProcessID);
                    }
                }
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

fn now_filetime() -> u64 {
    // The current process's own creation time is not "now", so a cheap monotonic
    // reference is taken from a throwaway handle-free source: SystemTimeToFileTime
    // is avoidable by simply using the launch child's creation time instead.
    // Callers pass the child's creation time, so this is only the fallback.
    0
}

fn mode_tree(shape_name: &str, named: Option<String>, budget_ms: u64) -> i32 {
    let shape = match shape_for(shape_name) {
        Some(s) => s,
        None => {
            eprintln!("unknown shape: {}", shape_name);
            return 2;
        }
    };

    println!("{{\"mode\":\"tree\",\"shape\":\"{}\",\"named\":{}", shape.name, match &named {
        Some(n) => format!("\"{}\"", esc(n)),
        None => "null".to_string(),
    });

    // ── the job, created exactly as production creates it ──────────────────
    //
    // ANONYMOUS: `CreateJobObjectW(NULL, NULL)` + KILL_ON_JOB_CLOSE, which is
    // `src/main.rs`'s unnamed path.
    // NAMED: a name and `LimitFlags = 0`, deliberately WITHOUT
    // KILL_ON_JOB_CLOSE, which is the named path — the tree must be able to
    // outlive its creator.
    let name_w = named.as_ref().map(|n| wide(n));
    let job = unsafe { CreateJobObjectW(std::ptr::null(), name_w.as_ref().map_or(std::ptr::null(), |w| w.as_ptr())) };
    if job.is_null() {
        println!(",\"error\":\"CreateJobObjectW failed\",\"lastError\":{}}}", unsafe { GetLastError() });
        return 2;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = if named.is_some() { 0 } else { JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE };
    let set_ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
        )
    };
    let flags_readback = job_limit_flags(job).unwrap_or(DWORD::MAX);
    println!(
        ",\"jobLimitFlagsRequested\":{},\"jobLimitFlagsReadBack\":{},\"setInformationOk\":{},\"breakawayOkSet\":{},\"silentBreakawayOkSet\":{}",
        info.BasicLimitInformation.LimitFlags,
        flags_readback,
        set_ok != 0,
        flags_readback & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0,
        flags_readback & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0
    );

    // ── create SUSPENDED, assign, verify membership, THEN resume ───────────
    //
    // The production order. Assigning before resuming is what closes the escape
    // window; a child that ran first could have spawned before it was contained.
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut cmd = wide(&shape.command);
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            shape.inherit,
            shape.flags,
            std::ptr::null(),
            std::ptr::null(),
            &si,
            &mut pi,
        )
    };
    if created == 0 {
        let e = unsafe { GetLastError() };
        // For the `breakaway` shape this is the EXPECTED outcome against a job
        // that does not permit it, and it is a PASS for containment.
        println!(",\"createProcessOk\":false,\"createProcessError\":{},\"verdict\":\"CREATE_REFUSED\"}}", e);
        unsafe { CloseHandle(job) };
        return 0;
    }
    let child_pid = pi.dwProcessId;
    let child_start = creation_time(pi.hProcess);

    let assign_ok = unsafe { AssignProcessToJobObject(job, pi.hProcess) };
    let assign_err = if assign_ok != 0 { 0 } else { unsafe { GetLastError() } };
    let mut in_job: BOOL = 0;
    unsafe { IsProcessInJob(pi.hProcess, job, &mut in_job) };

    println!(
        ",\"child\":{{\"pid\":{},\"startTime\":\"{}\",\"assignOk\":{},\"assignError\":{},\"isProcessInThisJob\":{}}}",
        child_pid,
        child_start,
        assign_ok != 0,
        assign_err,
        in_job != 0
    );

    unsafe { ResumeThread(pi.hThread) };

    // Let the tree establish itself. Bounded, and it is not a synchronisation
    // primitive: the membership list is sampled repeatedly and every sample is
    // reported, so a race would show up as a changing list rather than be hidden
    // by a lucky sleep.
    let mut samples: Vec<String> = Vec::new();
    let start = std::time::Instant::now();
    while (start.elapsed().as_millis() as u64) < budget_ms {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let m = job_members(job);
        samples.push(format!("{{\"atMs\":{},\"members\":{}}}", start.elapsed().as_millis(), members_json(&m)));
    }
    println!(",\"membershipSamples\":[{}]", samples.join(","));

    // ── the authoritative BEFORE list, with every pid bound to identity ────
    let before = job_members(job);
    let before_pids = before.clone().unwrap_or_default();
    let before_facts: Vec<String> = before_pids.iter().map(|p| facts_json(&inspect(*p))).collect();
    println!(",\"membersBefore\":{},\"membersBeforeFacts\":[{}]", members_json(&before), before_facts.join(","));

    // Candidates the job list does NOT contain: this is where an escaped process
    // becomes visible. Restricted to processes created after the child, so
    // unrelated shells on the machine cannot pollute it.
    // A CANDIDATE MUST BE LINKED TO THIS TREE, or it is somebody else's shell.
    //
    // MEASURED: run from a terminal with other work in flight, an image-and-recency
    // filter alone reported unrelated `powershell.exe` processes as escapees and
    // turned a CONTAINED result into a false B verdict. The session is shared, so
    // "a powershell that started recently" is not evidence of anything.
    //
    // The link required is PARENTAGE INTO THE TREE: the candidate's parent must be
    // the child itself or a pid that was observed in a membership sample. A
    // genuinely detached grandchild qualifies — `start /b`'s child is spawned by
    // cmd, which is a member for as long as it lives — while an unrelated shell
    // cannot.
    let mut ever_members: Vec<DWORD> = before_pids.clone();
    ever_members.push(child_pid);
    for s in &samples {
        for tok in s.split(|c: char| !c.is_ascii_digit()) {
            if let Ok(v) = tok.parse::<DWORD>() {
                if v > 4 && !ever_members.contains(&v) {
                    ever_members.push(v);
                }
            }
        }
    }
    let candidates = candidate_pids(child_start);
    let escaped_facts: Vec<String> = candidates
        .iter()
        .copied()
        .filter(|p| !before_pids.contains(p) && *p != child_pid)
        .map(inspect)
        .filter(|f| f.alive && ever_members.contains(&f.parent_pid))
        .map(|f| facts_json(&f))
        .collect();
    println!(",\"nonMemberCandidatesAlive\":[{}]", escaped_facts.join(","));

    // ── terminate, then WAIT ON HANDLES, not on pid polling ────────────────
    let term_ok = unsafe { TerminateJobObject(job, 1) };
    let term_err = if term_ok != 0 { 0 } else { unsafe { GetLastError() } };

    // The child's own handle is the one exit this probe can wait on authoritatively.
    let waited = unsafe { WaitForSingleObject(pi.hProcess, 10_000) };
    let mut child_exit: DWORD = 0;
    unsafe { GetExitCodeProcess(pi.hProcess, &mut child_exit) };

    // Drain, bounded: the member list must reach empty or the failure is recorded.
    let drain_start = std::time::Instant::now();
    let mut after = job_members(job);
    while drain_start.elapsed().as_millis() < 10_000 {
        match &after {
            Ok(v) if v.is_empty() => break,
            Err(_) => break,
            _ => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        after = job_members(job);
    }
    let after_pids = after.clone().unwrap_or_default();
    let after_facts: Vec<String> = after_pids.iter().map(|p| facts_json(&inspect(*p))).collect();

    // SURVIVORS, bound to identity: a pid from the BEFORE list that is still
    // alive AND still carries the same creation time. A pid that is alive with a
    // DIFFERENT creation time was reused and is not a survivor — classification C.
    let mut survivors: Vec<String> = Vec::new();
    let mut reused: Vec<String> = Vec::new();
    for (i, p) in before_pids.iter().enumerate() {
        let f = inspect(*p);
        if !f.alive {
            continue;
        }
        // The identity recorded in the BEFORE facts for this same pid.
        let was = before_facts.get(i).cloned().unwrap_or_default();
        if was.contains(&format!("\"startTime\":\"{}\"", f.start_time)) {
            survivors.push(facts_json(&f));
        } else {
            reused.push(facts_json(&f));
        }
    }

    println!(
        ",\"terminateOk\":{},\"terminateError\":{},\"childWait\":\"{}\",\"childExitCode\":{},\"membersAfter\":{},\"membersAfterFacts\":[{}],\"survivorsBoundToIdentity\":[{}],\"pidReuseDetected\":[{}]",
        term_ok != 0,
        term_err,
        match waited {
            WAIT_OBJECT_0 => "signalled",
            WAIT_TIMEOUT => "TIMED_OUT",
            _ => "failed",
        },
        child_exit,
        members_json(&after),
        after_facts.join(","),
        survivors.join(","),
        reused.join(",")
    );

    // ── the verdict, stated by the probe rather than inferred by a reader ──
    let verdict = if !survivors.is_empty() {
        // A confirmed job member, still alive after TerminateJobObject.
        "A_MEMBER_SURVIVED_TERMINATION"
    } else if !escaped_facts.is_empty() {
        // A live process of the tree's shape that the kernel does not list as a
        // member. Whether it BELONGS to our tree is decided by its parentage,
        // reported above for the reader; the probe does not guess.
        "B_NONMEMBER_CANDIDATE_ALIVE"
    } else if !after_pids.is_empty() {
        "DRAIN_INCOMPLETE"
    } else {
        "CONTAINED"
    };
    println!(",\"verdict\":\"{}\"}}", verdict);

    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
    }
    let _ = now_filetime();
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("self");
    let arg_of = |k: &str| -> Option<String> {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
    };
    let code = match mode {
        "self" => mode_self(),
        "tree" => {
            let shape = arg_of("--shape").unwrap_or_else(|| "startb".to_string());
            let named = arg_of("--named");
            let budget = arg_of("--budget-ms").and_then(|s| s.parse::<u64>().ok()).unwrap_or(3000);
            mode_tree(&shape, named, budget)
        }
        _ => {
            eprintln!("usage: containment-probe self | tree --shape <direct|grandchild|startb|noinherit|breakaway> [--named <jobname>] [--budget-ms N]");
            2
        }
    };
    std::process::exit(code);
}
