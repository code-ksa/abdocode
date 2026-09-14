//! Raw Win32 declarations. std only, no crates.
//!
//! Everything here is transcribed from the documented signatures. It is kept in
//! one file so the FFI surface is auditable in a single read: if an API is not
//! declared here, this helper cannot call it.
// Win32 names are kept EXACTLY as documented. Renaming them to Rust style would
// make every declaration here something the reader has to translate back before
// they can check it against the API reference, which is the one thing this file
// must make easy.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code)]

use std::ffi::c_void;

pub type HANDLE = *mut c_void;
pub type PSID = *mut c_void;
pub type BOOL = i32;
pub type DWORD = u32;
pub type HRESULT = i32;

pub const TRUE: BOOL = 1;
pub const FALSE: BOOL = 0;
pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

// CreateProcessW flags
pub const CREATE_SUSPENDED: DWORD = 0x0000_0004;
pub const EXTENDED_STARTUPINFO_PRESENT: DWORD = 0x0008_0000;
pub const CREATE_NO_WINDOW: DWORD = 0x0800_0000;
/// No console at all. **NOT USED — MEASURED TO BREAK POWERSHELL.**
///
/// It was used briefly to stop the conhost leak described on
/// `reap_console_hosts`, and it worked for `cmd.exe`. But `powershell.exe`
/// launched with it **exits immediately with code 0 and produces no output**:
/// `Start-Sleep -Seconds 5` returned in 127 ms having done nothing. Silently.
/// Every PowerShell-based test then "passed its spawn and produced nothing",
/// which is the worst possible failure shape — a sandbox that appears to run
/// commands and does not.
///
/// Kept as a named constant so the next person who reaches for it finds this
/// note instead of rediscovering it.
pub const DETACHED_PROCESS: DWORD = 0x0000_0008;

pub const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;

#[repr(C)]
pub struct PROCESSENTRY32W {
    pub dwSize: DWORD,
    pub cntUsage: DWORD,
    pub th32ProcessID: DWORD,
    pub th32DefaultHeapID: usize,
    pub th32ModuleID: DWORD,
    pub cntThreads: DWORD,
    pub th32ParentProcessID: DWORD,
    pub pcPriClassBase: i32,
    pub dwFlags: DWORD,
    pub szExeFile: [u16; 260],
}

#[link(name = "kernel32")]
extern "system" {
    pub fn CreateToolhelp32Snapshot(flags: DWORD, pid: DWORD) -> HANDLE;
    pub fn Process32FirstW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn Process32NextW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn TerminateProcess(h: HANDLE, code: DWORD) -> BOOL;
}

/// Kill the `conhost.exe` that was hosting OUR child's console.
///
/// THE LEAK THIS FIXES COST A USER 2.2 GB. With `CREATE_NO_WINDOW` a console is
/// still allocated and hosted by a `conhost.exe` that runs OUTSIDE the
/// AppContainer. When the contained child exits, that host is left behind —
/// exactly one orphan per run, never reaped. Ten runs produced ten orphans; a
/// full suite produced hundreds, and they are not free: ~2 MB each plus a
/// Windows Terminal window.
///
/// The alternative (`DETACHED_PROCESS`) breaks PowerShell, so the console is
/// allocated and then cleaned up deliberately.
///
/// SAFETY OF THE MATCH: only processes named `conhost.exe` whose PARENT is the
/// pid we just started and waited on are touched. The child has already exited,
/// so its pid could in principle be reused — hence the caller passes it
/// immediately after `WaitForSingleObject`, before the window in which reuse is
/// realistic, and a wrong match could only ever hit another console host.
pub fn reap_console_hosts(child_pid: DWORD) -> u32 {
    const PROCESS_TERMINATE: DWORD = 0x0001;
    let mut killed = 0u32;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return 0;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            if e.th32ParentProcessID == child_pid {
                let name = from_wide_ptr(e.szExeFile.as_ptr()).to_ascii_lowercase();
                if name == "conhost.exe" {
                    let h = OpenProcess(PROCESS_TERMINATE, FALSE, e.th32ProcessID);
                    if !h.is_null() {
                        if TerminateProcess(h, 0) != 0 {
                            killed += 1;
                        }
                        CloseHandle(h);
                    }
                }
            }
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    killed
}
pub const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x0000_0400;
pub const CREATE_BREAKAWAY_FROM_JOB: DWORD = 0x0100_0000;

pub const STARTF_USESTDHANDLES: DWORD = 0x0000_0100;

/// `ProcThreadAttributeSecurityCapabilities (9) | PROC_THREAD_ATTRIBUTE_INPUT`.
pub const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;

/// `ProcThreadAttributeHandleList (2) | PROC_THREAD_ATTRIBUTE_INPUT`.
///
/// P5c2 §2. `bInheritHandles = TRUE` on its own inherits EVERY handle in this
/// process that happens to be marked inheritable — a set that grows every time
/// someone adds a pipe, and that the callee never gets to see. With this
/// attribute the inherited set is EXACTLY the array we pass and nothing else,
/// which is the only form in which "the target receives no job handle" is a
/// property of the code rather than a property of the current handle table.
///
/// Two rules the API enforces and that the call sites must respect:
///   * every handle in the list must itself be inheritable, or `CreateProcessW`
///     fails with `ERROR_INVALID_PARAMETER`;
///   * any handle named in `STARTUPINFO` (`hStdOutput`, `hStdError`,
///     `hStdInput`) must ALSO appear in the list, or the child gets a closed
///     std handle.
pub const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;

// Job objects
pub const JobObjectBasicProcessIdList: i32 = 3;
pub const JobObjectExtendedLimitInformation: i32 = 9;
pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x0000_2000;
pub const JOB_OBJECT_LIMIT_BREAKAWAY_OK: DWORD = 0x0000_0800;
pub const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: DWORD = 0x0000_1000;

// ---------------------------------------------------------------- P5c: job rights
//
// SPELLED OUT ONE MASK AT A TIME, because the whole point of the named job is
// that its descriptor is EXPLICIT. `JOB_OBJECT_ALL_ACCESS` would be one constant
// and would silently include `WRITE_DAC`/`WRITE_OWNER` — the two rights that let
// a holder rewrite the very descriptor this design relies on.
pub const JOB_OBJECT_ASSIGN_PROCESS: DWORD = 0x0001;
pub const JOB_OBJECT_SET_ATTRIBUTES: DWORD = 0x0002;
pub const JOB_OBJECT_QUERY: DWORD = 0x0004;
pub const JOB_OBJECT_TERMINATE: DWORD = 0x0008;
pub const READ_CONTROL: DWORD = 0x0002_0000;
pub const SYNCHRONIZE: DWORD = 0x0010_0000;

/// What the CREATING helper needs: assign the child, set the limits, read the
/// members back, terminate on the normal path, read the descriptor for evidence.
/// Deliberately NOT `WRITE_DAC`, `WRITE_OWNER` or `DELETE`.
pub const JOB_RIGHTS_CREATOR: DWORD = JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | READ_CONTROL | SYNCHRONIZE;

/// The ONLY right the keeper is given on the target's primary thread.
///
/// P5c2-FINAL. `ResumeThread` moved OUT of the host and INTO the keeper, so that
/// the target cannot be running in a moment when its keeper is already dead. The
/// host creates the thread suspended and never resumes it; the keeper is handed
/// exactly this one right on exactly that one thread, by `DuplicateHandle` with
/// an explicit mask rather than `DUPLICATE_SAME_ACCESS`.
///
/// What is absent is the point. Not `THREAD_TERMINATE`, not
/// `THREAD_SET_CONTEXT` (which would let the keeper rewrite the target's
/// registers and redirect execution), not `THREAD_GET_CONTEXT`, not
/// `THREAD_SET_INFORMATION`. The keeper can start the thread and nothing else —
/// it cannot read it, steer it, or stop it.
pub const THREAD_SUSPEND_RESUME: DWORD = 0x0002;

/// The second, and last, right the keeper needs on that thread.
///
/// MEASURED: with `THREAD_SUSPEND_RESUME` alone, `GetProcessIdOfThread` fails
/// with ACCESS_DENIED, so the keeper could not check that the thread it was told
/// to start actually belongs to the process it was told about. The first build
/// of this path refused every legitimate resume for exactly that reason.
///
/// The choice was between dropping the ownership check and granting this. The
/// check is the thing that stops a trusted process from starting an arbitrary
/// thread on somebody's say-so, so it stays, and the right that makes it
/// possible is granted — the NARROW one. `THREAD_QUERY_INFORMATION` would also
/// work and is wider; the LIMITED form answers "which process owns this thread"
/// and little else, which is precisely the question being asked.
///
/// Still absent, and still the point: no `THREAD_TERMINATE`, no
/// `THREAD_SET_CONTEXT`, no `THREAD_GET_CONTEXT`, no `THREAD_SET_INFORMATION`.
/// The keeper can identify the thread and start it. It cannot read it, steer it
/// or stop it.
pub const THREAD_QUERY_LIMITED_INFORMATION: DWORD = 0x0800;

/// The complete mask the keeper receives on the target's primary thread.
pub const THREAD_RIGHTS_KEEPER: DWORD = THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION;

pub const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

/// What the keeper is given ON THE HOST'S OWN PROCESS, and nothing more.
///
/// P5c2-FINAL. The keeper must be able to answer one question immediately before
/// it resumes anything: is the process that authorised this still alive?
/// `SYNCHRONIZE` makes the handle waitable — a process handle is SIGNALLED once
/// the process has exited, which is the exact and cheapest form of that
/// question — and the LIMITED query right lets it read back pid and creation
/// time to confirm the handle addresses the host it was told about.
///
/// Absent, and the point: no `PROCESS_TERMINATE`, no `PROCESS_VM_READ`, no
/// `PROCESS_VM_WRITE`, no `PROCESS_DUP_HANDLE`. The keeper can observe whether
/// its host is alive. It cannot read it, write it, or kill it.
pub const PROCESS_RIGHTS_KEEPER_ON_HOST: DWORD = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;

/// What the TRUSTED PER-RUN KEEPER is given, and nothing more.
///
/// ## What this replaced, and why (P5c2)
///
/// MEASURED in P5c (finding 21): a named job's NAME is removed from the object
/// namespace when its last HANDLE closes. Processes assigned to the job keep the
/// OBJECT alive but not its name, so after the creating helper died
/// `OpenJobObjectW` returned ERROR_FILE_NOT_FOUND while the tree was provably
/// still running — the orphan was unreachable by the only route this design has.
///
/// P5c's answer was to duplicate this mask into the LAUNCHED TARGET. That answer
/// was wrong, and it was wrong in the one way that matters: **the target owned
/// the handle.** A handle in the target's table is a handle the target may
/// close, and the object manager drops the name on the last close. So the
/// keep-alive was contingent on the good behaviour of the untrusted program it
/// was supposed to contain. Three concrete escapes, none of them exotic:
///
///   1. `CloseHandle` on the inherited value — the target can simply sweep its
///      own handle table and close what it finds;
///   2. the first child exits while a grandchild it spawned with
///      `bInheritHandles = FALSE` keeps running, so the handle count reaches
///      zero with the tree still alive;
///   3. descendants spawned without inheritance never hold it at all.
///
/// Each leaves a LIVE TREE whose NAME is unreachable — the exact state finding
/// 21 exists to prevent, restored by the fix for it.
///
/// The holder is therefore a trusted per-run process OUTSIDE the AppContainer
/// and OUTSIDE the job, and the target is given no job handle at all. See
/// `src/keeper.rs`.
///
/// `JOB_OBJECT_SET_ATTRIBUTES` is ABSENT and that absence is still the security
/// property: with it a holder could set `JOB_OBJECT_LIMIT_BREAKAWAY_OK` on the
/// job and then spawn a process that leaves it entirely. Terminate and assign
/// are withheld as needless authority — the keeper's whole job is to EXIST, and
/// the recovery helper gets terminate rights through the job's protected DACL
/// rather than through anything the keeper hands it. Query is what lets the
/// keeper answer "is this job empty yet?" from the OS instead of a timer.
pub const JOB_RIGHTS_KEEPER: DWORD = JOB_OBJECT_QUERY | SYNCHRONIZE;

/// What a LATER helper needs to reclaim an orphaned tree — the MINIMUM the brief
/// specifies: query the member list, terminate, wait, and read the descriptor
/// back to prove it is the job we recorded. It cannot assign a process and it
/// cannot change the limits.
pub const JOB_RIGHTS_TERMINATOR: DWORD = JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | READ_CONTROL | SYNCHRONIZE;

/// `QueryInformationJobObject(JobObjectBasicProcessIdList)` returns a variable
/// number of trailing pids. The struct is declared with the fixed header only
/// and the list is read out of the raw buffer, so the length can never be a
/// compile-time assumption about how many processes a job may hold.
#[repr(C)]
pub struct JOBOBJECT_BASIC_PROCESS_ID_LIST_HEADER {
    pub NumberOfAssignedProcesses: DWORD,
    pub NumberOfProcessIdsInList: DWORD,
}

pub const SE_KERNEL_OBJECT: i32 = 6;
pub const OWNER_SECURITY_INFORMATION: DWORD = 0x0000_0001;
pub const GROUP_SECURITY_INFORMATION: DWORD = 0x0000_0002;
pub const DACL_SECURITY_INFORMATION_: DWORD = 0x0000_0004;

pub const ERROR_FILE_NOT_FOUND: DWORD = 2;
pub const ERROR_ACCESS_DENIED: DWORD = 5;
pub const ERROR_INVALID_HANDLE: DWORD = 6;
pub const ERROR_MORE_DATA: DWORD = 234;

pub const WAIT_OBJECT_0: DWORD = 0;
pub const WAIT_TIMEOUT: DWORD = 258;
pub const INFINITE: DWORD = 0xFFFF_FFFF;

// Token / elevation
pub const TOKEN_QUERY: DWORD = 0x0008;
/// TOKEN_INFORMATION_CLASS members used by the suspended-create probe.
pub const TokenIsAppContainer: i32 = 29;
pub const TokenAppContainerSid: i32 = 31;
pub const TOKEN_DUPLICATE: DWORD = 0x0002;
pub const TokenElevation: i32 = 20;
/// The STANDARD-USER token UAC links to an elevated one. Launching with it is
/// the documented way to obtain a genuinely non-elevated, medium-integrity
/// process — which section 8 requires before any result counts as a no-admin
/// proof. `runas /trustlevel:0x20000` was measured first and does NOT do this:
/// it produces a SAFER-restricted token that still reports elevated.
pub const TokenLinkedToken: i32 = 19;
pub const TokenIntegrityLevel: i32 = 25;
pub const TOKEN_ALL_ACCESS: DWORD = 0x000F_01FF;
pub const SecurityImpersonation: i32 = 2;
pub const TokenPrimary: i32 = 1;

pub const ERROR_ALREADY_EXISTS: DWORD = 183;
/// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)` — what CreateAppContainerProfile
/// returns when a profile with that name is already on the machine.
pub const HRESULT_ALREADY_EXISTS: HRESULT = 0x8007_00B7u32 as HRESULT;

#[repr(C)]
pub struct SECURITY_ATTRIBUTES {
    pub nLength: DWORD,
    pub lpSecurityDescriptor: *mut c_void,
    pub bInheritHandle: BOOL,
}

#[repr(C)]
pub struct SID_AND_ATTRIBUTES {
    pub Sid: PSID,
    pub Attributes: DWORD,
}

#[repr(C)]
pub struct SECURITY_CAPABILITIES {
    pub AppContainerSid: PSID,
    pub Capabilities: *mut SID_AND_ATTRIBUTES,
    pub CapabilityCount: DWORD,
    pub Reserved: DWORD,
}

#[repr(C)]
pub struct STARTUPINFOW {
    pub cb: DWORD,
    pub lpReserved: *mut u16,
    pub lpDesktop: *mut u16,
    pub lpTitle: *mut u16,
    pub dwX: DWORD,
    pub dwY: DWORD,
    pub dwXSize: DWORD,
    pub dwYSize: DWORD,
    pub dwXCountChars: DWORD,
    pub dwYCountChars: DWORD,
    pub dwFillAttribute: DWORD,
    pub dwFlags: DWORD,
    pub wShowWindow: u16,
    pub cbReserved2: u16,
    pub lpReserved2: *mut u8,
    pub hStdInput: HANDLE,
    pub hStdOutput: HANDLE,
    pub hStdError: HANDLE,
}

#[repr(C)]
pub struct STARTUPINFOEXW {
    pub StartupInfo: STARTUPINFOW,
    pub lpAttributeList: *mut c_void,
}

#[repr(C)]
pub struct PROCESS_INFORMATION {
    pub hProcess: HANDLE,
    pub hThread: HANDLE,
    pub dwProcessId: DWORD,
    pub dwThreadId: DWORD,
}

#[repr(C)]
pub struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    pub PerProcessUserTimeLimit: i64,
    pub PerJobUserTimeLimit: i64,
    pub LimitFlags: DWORD,
    pub MinimumWorkingSetSize: usize,
    pub MaximumWorkingSetSize: usize,
    pub ActiveProcessLimit: DWORD,
    pub Affinity: usize,
    pub PriorityClass: DWORD,
    pub SchedulingClass: DWORD,
}

#[repr(C)]
pub struct IO_COUNTERS {
    pub ReadOperationCount: u64,
    pub WriteOperationCount: u64,
    pub OtherOperationCount: u64,
    pub ReadTransferCount: u64,
    pub WriteTransferCount: u64,
    pub OtherTransferCount: u64,
}

#[repr(C)]
pub struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    pub BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    pub IoInfo: IO_COUNTERS,
    pub ProcessMemoryLimit: usize,
    pub JobMemoryLimit: usize,
    pub PeakProcessMemoryUsed: usize,
    pub PeakJobMemoryUsed: usize,
}

#[repr(C)]
pub struct TOKEN_ELEVATION {
    pub TokenIsElevated: DWORD,
}

#[repr(C)]
pub struct OSVERSIONINFOW {
    pub dwOSVersionInfoSize: DWORD,
    pub dwMajorVersion: DWORD,
    pub dwMinorVersion: DWORD,
    pub dwBuildNumber: DWORD,
    pub dwPlatformId: DWORD,
    pub szCSDVersion: [u16; 128],
}

#[link(name = "kernel32")]
extern "system" {
    pub fn GetLastError() -> DWORD;
    /// Cleared before a call whose SUCCESS path also sets a last-error value —
    /// `CreateJobObjectW` reports an existing object through `ERROR_ALREADY_EXISTS`
    /// while still returning a handle, so a stale value would be read as a
    /// collision that never happened.
    pub fn SetLastError(code: DWORD);
    pub fn CloseHandle(h: HANDLE) -> BOOL;
    pub fn CreatePipe(hRead: *mut HANDLE, hWrite: *mut HANDLE, sa: *const SECURITY_ATTRIBUTES, size: DWORD) -> BOOL;
    pub fn SetHandleInformation(h: HANDLE, mask: DWORD, flags: DWORD) -> BOOL;
    pub fn ReadFile(h: HANDLE, buf: *mut u8, len: DWORD, read: *mut DWORD, ov: *mut c_void) -> BOOL;
    /// How many bytes can be read from a pipe WITHOUT blocking.
    ///
    /// P5c2. `ReadFile` on a pipe blocks until data arrives, so a bounded wait
    /// built out of "check the clock, then read" has a bound that never fires:
    /// once the read blocks, the clock is never consulted again. This is what
    /// makes the budget real — the read only happens on bytes already known to
    /// be there. It also reports EOF (`ERROR_BROKEN_PIPE`) as a failed call,
    /// which is how the host learns the keeper exited without reporting.
    pub fn PeekNamedPipe(h: HANDLE, buf: *mut u8, len: DWORD, read: *mut DWORD, total_avail: *mut DWORD, left: *mut DWORD) -> BOOL;
    /// Used only by `keeper.rs`'s unit tests, to put bytes into a pipe the test
    /// owns both ends of. The helper itself never writes to a pipe by handle —
    /// the keeper writes to its own stdout.
    pub fn WriteFile(h: HANDLE, buf: *const u8, len: DWORD, written: *mut DWORD, ov: *mut c_void) -> BOOL;
    /// P5c2-FINAL. Which process does this THREAD belong to?
    ///
    /// The keeper is handed a thread handle and told which process it resumes.
    /// This is what turns that claim into a check: a keeper that resumed a
    /// thread without confirming its owner would be a trusted process starting
    /// an arbitrary thread on somebody's say-so, which is a worse primitive than
    /// the one this whole phase removed.
    pub fn GetProcessIdOfThread(t: HANDLE) -> DWORD;
    /// Which THREAD is this, so the duplicated handle can be checked against the
    /// primary thread id the authorisation names.
    pub fn GetThreadId(t: HANDLE) -> DWORD;
    pub fn InitializeProcThreadAttributeList(list: *mut c_void, count: DWORD, flags: DWORD, size: *mut usize) -> BOOL;
    pub fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: DWORD,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        prev: *mut c_void,
        ret: *mut usize,
    ) -> BOOL;
    pub fn DeleteProcThreadAttributeList(list: *mut c_void);
    pub fn CreateProcessW(
        app: *const u16,
        cmd: *mut u16,
        procAttrs: *const SECURITY_ATTRIBUTES,
        threadAttrs: *const SECURITY_ATTRIBUTES,
        inherit: BOOL,
        flags: DWORD,
        env: *mut c_void,
        cwd: *const u16,
        si: *mut STARTUPINFOEXW,
        pi: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    pub fn CreateJobObjectW(sa: *const SECURITY_ATTRIBUTES, name: *const u16) -> HANDLE;
    /// P5c. The call that makes an orphaned tree reachable at all: a job created
    /// with `CreateJobObjectW(null, null)` has no name, so its handle dying with
    /// its creator ends every route to it (finding 17).
    pub fn OpenJobObjectW(access: DWORD, inherit: BOOL, name: *const u16) -> HANDLE;
    pub fn QueryInformationJobObject(job: HANDLE, class: i32, info: *mut c_void, len: DWORD, returned: *mut DWORD) -> BOOL;
    /// The session a pid lives in. `Local\` names resolve per session, so the
    /// session is part of the job's identity and not a detail.
    pub fn ProcessIdToSessionId(pid: DWORD, session: *mut DWORD) -> BOOL;
    /// P5c. Places a handle into ANOTHER process's handle table.
    ///
    /// Used for exactly one thing: giving the launched child a rights-reduced
    /// handle to its own job, so the job's NAME survives the helper that
    /// created it. `DUPLICATE_SAME_ACCESS` is never passed — the reduced mask
    /// is the entire security control, because an already-open handle is not
    /// re-checked against the object's DACL.
    pub fn DuplicateHandle(
        src_proc: HANDLE,
        src: HANDLE,
        dst_proc: HANDLE,
        dst: *mut HANDLE,
        access: DWORD,
        inherit: BOOL,
        options: DWORD,
    ) -> BOOL;
    /// The image a process is ACTUALLY running, asked of the kernel rather than
    /// inferred from what we passed to CreateProcess. IFEO, a registered
    /// debugger or an image substitution all show up here and nowhere else.
    pub fn QueryFullProcessImageNameW(h: HANDLE, flags: DWORD, buf: *mut u16, size: *mut DWORD) -> BOOL;
    pub fn SetInformationJobObject(job: HANDLE, class: i32, info: *const c_void, len: DWORD) -> BOOL;
    pub fn AssignProcessToJobObject(job: HANDLE, proc_: HANDLE) -> BOOL;
    pub fn TerminateJobObject(job: HANDLE, code: DWORD) -> BOOL;
    pub fn IsProcessInJob(proc_: HANDLE, job: HANDLE, result: *mut BOOL) -> BOOL;
    pub fn ResumeThread(t: HANDLE) -> DWORD;
    pub fn WaitForSingleObject(h: HANDLE, ms: DWORD) -> DWORD;
    /// P5c2: the arm / fenced-shutdown handshake with the keeper.
    ///
    /// UNNAMED, deliberately. A named event would be a rendezvous in the object
    /// namespace that anything in the session could open and signal, which would
    /// let a bystander arm or shut down a keeper it has no relationship with.
    /// These are reachable only by being INHERITED, so possession of the handle
    /// IS the authentication — there is no name to guess and no descriptor to
    /// get wrong.
    pub fn CreateEventW(sa: *const SECURITY_ATTRIBUTES, manual_reset: BOOL, initial: BOOL, name: *const u16) -> HANDLE;
    pub fn SetEvent(h: HANDLE) -> BOOL;
    pub fn GetExitCodeProcess(h: HANDLE, code: *mut DWORD) -> BOOL;
    pub fn GetCurrentProcess() -> HANDLE;
    pub fn GetCurrentProcessId() -> DWORD;
    pub fn LocalFree(p: *mut c_void) -> *mut c_void;
    pub fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    pub fn MoveFileExW(from: *const u16, to: *const u16, flags: DWORD) -> BOOL;
    pub fn GetProcessTimes(h: HANDLE, creation: *mut DWORD, exit: *mut DWORD, kernel: *mut DWORD, user: *mut DWORD) -> BOOL;
    pub fn LoadLibraryW(name: *const u16) -> HANDLE;
    pub fn GetProcAddress(module: HANDLE, name: *const u8) -> *mut c_void;
    pub fn FreeLibrary(module: HANDLE) -> BOOL;
}

/// Is an export present on this OS build? DYNAMIC LOOKUP ONLY — nothing is
/// called, nothing depends on it, and a missing export is reported rather than
/// silently falling back to another mechanism.
pub fn export_present(dll: &str, symbol: &str) -> bool {
    unsafe {
        let w = wide(dll);
        let m = LoadLibraryW(w.as_ptr());
        if m.is_null() {
            return false;
        }
        let mut name: Vec<u8> = symbol.as_bytes().to_vec();
        name.push(0);
        let p = GetProcAddress(m, name.as_ptr());
        FreeLibrary(m);
        !p.is_null()
    }
}

#[link(name = "advapi32")]
extern "system" {
    /// `RtlGenRandom`, whose exported name really is `SystemFunction036`.
    ///
    /// The OS CSPRNG, reached without adding a crate or a new DLL — advapi32 is
    /// already linked for the token and SID calls. Used for the one-shot resume
    /// authorisation nonce. Returns a `BOOLEAN` (one byte), not a `BOOL`, and a
    /// caller that declares it as `BOOL` reads three bytes of adjacent stack.
    #[link_name = "SystemFunction036"]
    pub fn RtlGenRandom(buf: *mut u8, len: DWORD) -> u8;
    pub fn OpenProcessToken(proc_: HANDLE, access: DWORD, token: *mut HANDLE) -> BOOL;
    pub fn GetTokenInformation(token: HANDLE, class: i32, info: *mut c_void, len: DWORD, ret: *mut DWORD) -> BOOL;
    pub fn ConvertSidToStringSidW(sid: PSID, out: *mut *mut u16) -> BOOL;
    pub fn DuplicateTokenEx(
        existing: HANDLE,
        access: DWORD,
        sa: *const SECURITY_ATTRIBUTES,
        impersonationLevel: i32,
        tokenType: i32,
        new: *mut HANDLE,
    ) -> BOOL;
    pub fn CreateProcessWithTokenW(
        token: HANDLE,
        logonFlags: DWORD,
        app: *const u16,
        cmd: *mut u16,
        flags: DWORD,
        env: *mut c_void,
        cwd: *const u16,
        si: *mut STARTUPINFOW,
        pi: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    pub fn FreeSid(sid: PSID) -> *mut c_void;
    pub fn IsValidSid(sid: PSID) -> BOOL;
}

#[link(name = "userenv")]
extern "system" {
    pub fn CreateAppContainerProfile(
        name: *const u16,
        display: *const u16,
        description: *const u16,
        capabilities: *mut SID_AND_ATTRIBUTES,
        count: DWORD,
        sid: *mut PSID,
    ) -> HRESULT;
    pub fn DeleteAppContainerProfile(name: *const u16) -> HRESULT;
    pub fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut PSID) -> HRESULT;
}

#[link(name = "ntdll")]
extern "system" {
    pub fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
}

/// UTF-16, NUL-terminated — what every `*W` entry point wants.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide_ptr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

pub fn sid_to_string(sid: PSID) -> String {
    if sid.is_null() {
        return String::new();
    }
    unsafe {
        let mut out: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut out) == 0 {
            return String::new();
        }
        let s = from_wide_ptr(out);
        LocalFree(out as *mut c_void);
        s
    }
}

/// Elevation is a MEASURED fact, not an assumption. §8 requires every result to
/// be produced by a non-elevated process; the helper reports its own state so a
/// run from an elevated shell cannot be mistaken for a no-admin proof.
pub fn is_elevated() -> Option<bool> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut ret: DWORD = 0;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elev as *mut _ as *mut c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as DWORD,
            &mut ret,
        );
        CloseHandle(token);
        if ok == 0 {
            None
        } else {
            Some(elev.TokenIsElevated != 0)
        }
    }
}

/// The token's integrity RID (0x2000 medium, 0x3000 high). Reported alongside
/// `elevated` so "non-elevated" is two independent facts, not one flag.
pub fn integrity_rid() -> Option<u32> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut needed: DWORD = 0;
        GetTokenInformation(token, TokenIntegrityLevel, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(token, TokenIntegrityLevel, buf.as_mut_ptr() as *mut c_void, needed, &mut needed);
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label }, and the level is
        // the SID's last sub-authority.
        let label = &*(buf.as_ptr() as *const SID_AND_ATTRIBUTES);
        let sid = label.Sid as *const u8;
        if sid.is_null() {
            return None;
        }
        let count = *sid.add(1) as usize; // SID.SubAuthorityCount
        if count == 0 {
            return None;
        }
        let sub = sid.add(8) as *const u32; // SubAuthority[0]
        Some(*sub.add(count - 1))
    }
}

/// Duplicate of the STANDARD-USER token linked to this elevated one.
///
/// Returns the failing STAGE and its Win32 error on the way out, because "no
/// linked token" and "the duplicate was denied" are different findings and a
/// bare `None` would have collapsed them into one.
pub fn linked_token() -> Result<HANDLE, (&'static str, DWORD)> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) == 0 {
            return Err(("OpenProcessToken", GetLastError()));
        }
        let mut linked: HANDLE = std::ptr::null_mut();
        let mut ret: DWORD = 0;
        let ok = GetTokenInformation(
            token,
            TokenLinkedToken,
            &mut linked as *mut _ as *mut c_void,
            std::mem::size_of::<HANDLE>() as DWORD,
            &mut ret,
        );
        let get_err = GetLastError();
        CloseHandle(token);
        if ok == 0 || linked.is_null() {
            return Err(("GetTokenInformation:TokenLinkedToken", get_err));
        }
        // MEASURED: `TokenLinkedToken` hands back an IMPERSONATION token, and
        // CreateProcessWithTokenW rejects it with 1346
        // (ERROR_BAD_IMPERSONATION_LEVEL). It has to be duplicated into a PRIMARY
        // token first.
        let mut primary: HANDLE = std::ptr::null_mut();
        // MAXIMUM_ALLOWED, not TOKEN_ALL_ACCESS: MEASURED, asking for
        // TOKEN_ALL_ACCESS on the linked handle fails with 1346. The handle
        // GetTokenInformation returns carries a limited granted access, and
        // asking for everything is refused rather than trimmed.
        const MAXIMUM_ALLOWED: DWORD = 0x0200_0000;
        let dup = DuplicateTokenEx(linked, MAXIMUM_ALLOWED, std::ptr::null(), SecurityImpersonation, TokenPrimary, &mut primary);
        let dup_err = GetLastError();
        CloseHandle(linked);
        if dup == 0 || primary.is_null() {
            Err(("DuplicateTokenEx", dup_err))
        } else {
            Ok(primary)
        }
    }
}

pub fn os_build() -> (u32, u32, u32) {
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as DWORD;
        if RtlGetVersion(&mut info) != 0 {
            return (0, 0, 0);
        }
        (info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)
    }
}
