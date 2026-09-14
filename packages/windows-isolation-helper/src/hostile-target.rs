//! P5c2 §5 — A DELIBERATELY HOSTILE TARGET.
//!
//! ## Why this binary exists
//!
//! P5c's 431/0 suite was green while the design had a hole in it, and the reason
//! is worth stating plainly: **every target in that suite was cooperative.**
//! `cmd.exe /c ping` does not sweep its handle table, does not call
//! `CloseHandle` on values it did not open, and does not orphan a grandchild on
//! purpose. So the suite measured the keep-alive under exactly the conditions
//! that could never break it, and reported the result as proof.
//!
//! This program is the missing adversary. It does what an untrusted target
//! actually gets to do, and the tests assert that the isolation holds anyway.
//!
//! ## What it does, in order
//!
//!  1. **Spawns a grandchild with `bInheritHandles = FALSE`.** The grandchild
//!     inherits nothing at all, so under P5c it never received the keep-alive.
//!  2. **Tries `DuplicateHandle` on guessed values.** A handle is a small
//!     integer; guessing is cheap. Any success is reported so the test can see
//!     what was reachable.
//!  3. **Hunts and closes handles.** Sweeps the low handle-value space and calls
//!     `CloseHandle` on everything it finds. Under P5c this would have found and
//!     closed the inherited job handle, dropping its own job's name while its
//!     tree kept running. Under P5c2 there is no job handle in this process to
//!     find — which is what the test asserts, by the name surviving.
//!  4. **Exits, leaving the grandchild running.** This is the exact sequence
//!     that dropped a job's name in P5c: the only holder of the handle was this
//!     process, and it is gone while its tree is not.
//!
//! ## Why the spawn comes FIRST, and what it cost to learn
//!
//! The sweep used to run first, and it took the process down with an access
//! violation before it could spawn anything — MEASURED, exit code 0xC0000005.
//! Closing every handle in sight includes the ones the Win32 subsystem itself
//! relies on (the CSRSS port above all), and `CreateProcessW` cannot survive
//! losing them.
//!
//! That is not a limit on the adversary, it is the adversary's own ordering
//! constraint: a real one that wants to leave an orphan behind must create it
//! while its process is still functional. Doing the destructive part LAST is
//! strictly more hostile, not less — the handle table is still burned before the
//! process exits, which is the moment that matters for the job's name.
//!
//! It reports what it managed to do on stdout as JSONL, so a test asserts on
//! MEASUREMENTS rather than on the absence of a crash.
//!
//! ## It is not part of the trusted surface
//!
//! Built from `src/` so `build.ps1`'s source hash covers it, and its own binary
//! hash is recorded in the manifest as an explicitly TEST-ONLY artefact that the
//! production verifier does not accept as the helper. Nothing in the helper's
//! launch path can reach it; it is named only by the tests that run it as a
//! target, which is precisely the position an untrusted program occupies.

// The Win32 structs are declared with their documented field names, exactly as
// `src/win.rs` does, so a reader can compare them against the SDK line by line.
#![allow(non_snake_case)]

use std::ffi::c_void;
use std::io::Write;

type HANDLE = *mut c_void;
type DWORD = u32;
type BOOL = i32;

#[repr(C)]
struct STARTUPINFOW {
    cb: DWORD,
    lpReserved: *mut u16,
    lpDesktop: *mut u16,
    lpTitle: *mut u16,
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
struct PROCESSENTRY32W {
    dwSize: DWORD,
    cntUsage: DWORD,
    th32ProcessID: DWORD,
    th32DefaultHeapID: usize,
    th32ModuleID: DWORD,
    cntThreads: DWORD,
    th32ParentProcessID: DWORD,
    pcPriClassBase: i32,
    dwFlags: DWORD,
    szExeFile: [u16; 260],
}

extern "system" {
    fn QueryFullProcessImageNameW(h: HANDLE, flags: DWORD, buf: *mut u16, size: *mut DWORD) -> BOOL;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn GetCurrentProcess() -> HANDLE;
    fn GetCurrentProcessId() -> DWORD;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn CreateToolhelp32Snapshot(flags: DWORD, pid: DWORD) -> HANDLE;
    fn Process32FirstW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    fn Process32NextW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    fn DuplicateHandle(src: HANDLE, h: HANDLE, dst: HANDLE, out: *mut HANDLE, access: DWORD, inherit: BOOL, opts: DWORD) -> BOOL;
    fn CreateProcessW(
        app: *const u16,
        cmd: *mut u16,
        pa: *const c_void,
        ta: *const c_void,
        inherit: BOOL,
        flags: DWORD,
        env: *mut c_void,
        cwd: *const u16,
        si: *mut STARTUPINFOW,
        pi: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    fn IsProcessInJob(proc_: HANDLE, job: HANDLE, result: *mut BOOL) -> BOOL;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn say(s: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(s.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn arg(flag: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == flag).and_then(|i| a.get(i + 1).cloned())
}

/// Can this process open that one with these rights?
///
/// A SUCCESS is the finding, not the failure. Each of these masks is a complete
/// escape if granted: `PROCESS_TERMINATE` kills the keeper and drops the job's
/// name; `PROCESS_DUP_HANDLE` steals the job handle out of it; `PROCESS_VM_WRITE`
/// rewrites its memory; `PROCESS_CREATE_THREAD` runs code inside a process that
/// sits outside the AppContainer entirely.
/// The image behind a pid, read AT THE MOMENT it was found openable.
///
/// The process the sweep can reach is short-lived, and asking the OS about it
/// afterwards returns "already gone" - which names nothing. A measurement taken
/// after the thing measured has disappeared is not a measurement.
fn image_of(pid: DWORD) -> String {
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return String::new();
        }
        let mut buf = vec![0u16; 512];
        let mut len: DWORD = buf.len() as DWORD;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

fn can_open(pid: DWORD, access: DWORD) -> bool {
    let h = unsafe { OpenProcess(access, 0, pid) };
    if h.is_null() {
        return false;
    }
    unsafe { CloseHandle(h) };
    true
}

/// Find the keeper WITHOUT being told which one it is.
///
/// The pid is discovered from inside the container rather than passed on the
/// command line, because a pid the HOST chose would not answer the question
/// being asked. What matters is what the TARGET can find and reach on its own.
fn find_keeper_pid() -> DWORD {
    const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;
    let mut found: DWORD = 0;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap as isize == -1 {
            return 0;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let end = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..end]).to_ascii_lowercase();
            if name == "abdo-winiso.exe" {
                found = e.th32ProcessID;
                // Not breaking: the LAST match is more likely to be the keeper
                // than the first, and any of them being openable is the finding.
            }
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    found
}

fn main() {
    let me = unsafe { GetCurrentProcessId() };

    // ---- 0. P5c2-FINAL. CAN THIS TARGET REACH ITS OWN KEEPER?
    //
    // Reported as measurements rather than asserted here, so the test decides
    // what the answers must be. Every `true` below would be a complete escape.
    if std::env::args().any(|a| a == "--probe-keeper") {
        const PROCESS_TERMINATE: DWORD = 0x0001;
        const PROCESS_CREATE_THREAD: DWORD = 0x0002;
        const PROCESS_VM_WRITE: DWORD = 0x0020;
        const PROCESS_DUP_HANDLE: DWORD = 0x0040;
        const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
        let keeper = find_keeper_pid();

        // ---- THE BRUTE-FORCE SWEEP, because enumeration is not the only route.
        //
        // MEASURED: inside an AppContainer with zero capabilities,
        // `CreateToolhelp32Snapshot` fails outright, so `find_keeper_pid`
        // returns 0 and a probe that stopped there would report four denials
        // about a process it never located — proving nothing.
        //
        // A real attacker does not need the snapshot. Pids are small multiples
        // of four, so it can simply try them all. This sweeps the whole space
        // and counts how many processes OTHER THAN ITSELF it can open with each
        // dangerous right. Zero is the claim; the count is the evidence.
        let mut n_term = 0u32;
        let mut n_thread = 0u32;
        let mut n_write = 0u32;
        let mut n_dup = 0u32;
        let mut n_query = 0u32;
        // WHICH ones, not just how many. A count on its own turns "the container
        // holds" into "the container mostly holds" and gives the reader nothing
        // to check.
        let mut term_pids: Vec<String> = Vec::new();
        let mut pid: DWORD = 4;
        while pid < 65_536 {
            if pid != me {
                if can_open(pid, PROCESS_TERMINATE) {
                    n_term += 1;
                    if term_pids.len() < 16 {
                        let img = image_of(pid).replace(std::path::MAIN_SEPARATOR, "/");
                        term_pids.push(format!("{}:{}", pid, img));
                    }
                }
                if can_open(pid, PROCESS_CREATE_THREAD) {
                    n_thread += 1;
                }
                if can_open(pid, PROCESS_VM_WRITE) {
                    n_write += 1;
                }
                if can_open(pid, PROCESS_DUP_HANDLE) {
                    n_dup += 1;
                }
                if can_open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                    n_query += 1;
                }
            }
            pid += 4;
        }

        say(&format!(
            "{{\"event\":\"hostile.keeper_probe\",\"pid\":{},\"keeperPid\":{},\"snapshotOk\":{},\"terminate\":{},\"createThread\":{},\"vmWrite\":{},\"dupHandle\":{},\"queryLimited\":{},\"sweepTerminate\":{},\"sweepCreateThread\":{},\"sweepVmWrite\":{},\"sweepDupHandle\":{},\"sweepQueryLimited\":{},\"sweepTerminatePids\":[{}]}}",
            me,
            keeper,
            keeper != 0,
            can_open(keeper, PROCESS_TERMINATE),
            can_open(keeper, PROCESS_CREATE_THREAD),
            can_open(keeper, PROCESS_VM_WRITE),
            can_open(keeper, PROCESS_DUP_HANDLE),
            can_open(keeper, PROCESS_QUERY_LIMITED_INFORMATION),
            n_term,
            n_thread,
            n_write,
            n_dup,
            n_query,
            term_pids.iter().map(|p| format!("\"{}\"", p)).collect::<Vec<_>>().join(","),
        ));
    }

    // AM I IN A JOB AT ALL? Asked with a NULL job handle, which answers "in ANY
    // job" — this process has no handle to its own job to ask about, and that is
    // the property under test.
    let mut in_any: BOOL = 0;
    unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_any) };

    // ---- 1. A GRANDCHILD THAT INHERITS NOTHING, created FIRST.
    //
    // `bInheritHandles = FALSE`, so it receives no handle of ours by any route.
    // Under P5c this was the second escape: the grandchild never held the
    // keep-alive, so when this process exited the job's handle count reached
    // zero and the name was dropped with the tree still running.
    //
    // It stays in the job regardless — no breakaway flag is set on it, and the
    // job has neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK — which is what lets
    // the test find it as a member afterwards.
    //
    // FIRST, because the sweep below destroys this process's ability to create
    // one. See the header.
    let seconds = arg("--grandchild-seconds").unwrap_or_else(|| "60".to_string());
    let cmdline = format!("C:\\Windows\\System32\\ping.exe -n {} 127.0.0.1", seconds);
    let mut cmd_w = wide(&cmdline);
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    const CREATE_NO_WINDOW: DWORD = 0x0800_0000;
    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmd_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // NO HANDLE INHERITANCE. The point of the whole exercise.
            CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        )
    };
    let grandchild = if ok != 0 { pi.dwProcessId } else { 0 };
    unsafe {
        if ok != 0 {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }
    say(&format!(
        "{{\"event\":\"hostile.spawned\",\"pid\":{},\"grandchildPid\":{},\"inheritHandles\":false}}",
        me, grandchild
    ));

    // ---- 2 + 3. SWEEP THE HANDLE TABLE.
    //
    // Handle values are multiples of four and start low, so a few thousand
    // covers everything a freshly created process owns. Every one is probed with
    // `DuplicateHandle` first (so the test can see what was REACHABLE, not just
    // what was closeable) and then closed.
    //
    // The std handles are skipped by value so this program can still report what
    // it did; a real adversary would not care, and closing them would only blind
    // the measurement.
    let keep: [usize; 3] = [
        unsafe { std::mem::transmute::<_, usize>(std_handle(-10)) },
        unsafe { std::mem::transmute::<_, usize>(std_handle(-11)) },
        unsafe { std::mem::transmute::<_, usize>(std_handle(-12)) },
    ];
    let mut duplicated = 0u32;
    let mut closed = 0u32;
    let mut v: usize = 4;
    while v <= 8192 {
        if !keep.contains(&v) {
            let h = v as HANDLE;
            let mut dup: HANDLE = std::ptr::null_mut();
            // DUPLICATE_SAME_ACCESS (2). A success proves the value addressed a
            // real object this process could reach.
            if unsafe { DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &mut dup, 0, 0, 2) } != 0 {
                duplicated += 1;
                unsafe { CloseHandle(dup) };
            }
            if unsafe { CloseHandle(h) } != 0 {
                closed += 1;
            }
        }
        v += 4;
    }
    say(&format!(
        "{{\"event\":\"hostile.swept\",\"pid\":{},\"inAnyJob\":{},\"handlesDuplicated\":{},\"handlesClosed\":{}}}",
        me,
        in_any != 0,
        duplicated,
        closed
    ));

    // ---- 4. LINGER, so the HOST can die first.
    //
    // Nothing about the adversary needs this; the test harness does, and the
    // reason is worth recording because it cost a debugging round.
    //
    // On the normal path the helper WAITS for its target and then terminates the
    // whole job. A target that exits in milliseconds therefore gets its own
    // grandchild reaped by its own host a moment later — which is correct
    // behaviour and completely hides the case under test. The orphan scenario
    // only exists when the HOST dies first, so the target has to still be there
    // while that happens.
    //
    // Deliberately AFTER the sweep: by the time the host is killed this process
    // has already burned its handle table, so nothing here holds the job's name
    // open even for the moment it is still alive.
    let linger: u64 = arg("--linger-seconds").and_then(|s| s.parse().ok()).unwrap_or(0);
    if linger > 0 {
        std::thread::sleep(std::time::Duration::from_secs(linger));
    }

    // ---- 5. EXIT, LEAVING THE GRANDCHILD RUNNING.
    //
    // Never waited on, deliberately. The tree outlives this process, and under
    // P5c the job's NAME did not.
    //
    // `exit` rather than a return: the sweep above has closed handles the CRT
    // would touch on a normal shutdown, and a crash there would look like a bug
    // in the test rather than the deliberate self-destruction it is.
    std::process::exit(0);
}

extern "system" {
    fn GetStdHandle(which: i32) -> HANDLE;
}

fn std_handle(which: i32) -> HANDLE {
    unsafe { GetStdHandle(which) }
}
