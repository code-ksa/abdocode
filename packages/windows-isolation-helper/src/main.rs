//! abdo-winiso — CL-16A2-C spike.
//!
//! Runs one process inside a Windows AppContainer with **zero capabilities**,
//! contained by a Job Object, and reports what happened as one JSON object.
//!
//! This is a MEASUREMENT INSTRUMENT, not a production launcher. It is not wired
//! to `shell.ts`, to the production `launchControlledProcess`, to any package
//! manager, or to any provider subprocess. Its job is to answer, with evidence,
//! whether Windows can give a per-run network denial without administrator
//! rights, without a firewall rule, without a proxy, and without changing
//! anything about the machine that outlives the run.
//!
//! DESIGN RULES
//!
//!  - **Zero capabilities, no flag to add any.** There is no `--capability`
//!    option and no way for a caller to pass a raw SID or a capability
//!    structure. Granting `internetClient` would make the network tests pass and
//!    prove nothing, so the ability to do it is absent rather than merely unused.
//!  - **Separated argv.** Everything after `--` is passed as arguments. The
//!    single string `CreateProcessW` requires is built by `cmdline::quote_arg`
//!    under the CommandLineToArgvW rules; no caller text is ever concatenated
//!    into a shell command.
//!  - **The child's output is DATA.** It is escaped into the JSON envelope, so a
//!    program that prints JSON cannot forge a field.
//!  - **Suspended, then assigned, then resumed.** A process created running
//!    could spawn a child before `AssignProcessToJobObject` lands; that window
//!    is closed by construction.
//!  - **std only, no crates, no build.rs, no network at build time.**
mod acl;
mod authmsg;
mod cmdline;
mod job;
mod keeper;
mod probe;
mod root;
mod json;
mod ops;
mod sha256;
mod win;

use std::ffi::c_void;
use std::io::Write;
use win::*;

/// v4 (CL-16A3-B2) replaces the coarse rx|modify grant with a `+`-separated list
/// profile, inspect/grant/restore ACL, launch-in-profile, inspect-process.
pub const PROTOCOL_VERSION: u32 = 10;
/// Per stream. Section 7 requires large output to be bounded, not unbounded.
const MAX_CAPTURE_BYTES: usize = 1 << 20;

/// Where the JSON result goes. A de-elevated child cannot inherit our pipes
/// (`CreateProcessWithTokenW` does not inherit handles), so it writes its result
/// to a file the parent named. Always stdout as well, so an interactive run is
/// unchanged.
static OUT_PATH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn emit(obj: json::Obj) -> ! {
    // P5c2. THE SINGLE EXIT OF THIS PROCESS, so it is where the trusted keeper
    // is released. A launch that started a keeper and then refused for any of a
    // dozen reasons must not leave it holding an empty job; putting the signal
    // here rather than at each refusal means a branch added later cannot forget.
    // Safe unconditionally — the keeper honours a shutdown only while unarmed
    // with a provably empty job. See `keeper::register_shutdown`.
    keeper::release_registered_shutdown();
    let s = obj.raw("protocolVersion", &PROTOCOL_VERSION.to_string()).finish();
    let mut out = std::io::stdout();
    let _ = out.write_all(s.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
    if let Some(p) = OUT_PATH.lock().ok().and_then(|g| g.clone()) {
        let _ = std::fs::write(&p, s.as_bytes());
    }
    std::process::exit(0)
}

fn fail(stage: &str, msg: &str, code: u32) -> ! {
    emit(json::Obj::new().bool("ok", false).str("stage", stage).str("error", msg).num("errorCode", code as i64))
}

fn base(command: &str) -> json::Obj {
    let (maj, min, build) = os_build();
    let o = json::Obj::new()
        .str("schema", "abdo-winiso/1")
        .str("command", command)
        .str("osBuild", &format!("{}.{}.{}", maj, min, build))
        .num("osBuildNumber", build as i64);
    // EVERY result carries the privilege context that produced it. Section 8
    // says a measurement taken from an elevated shell is not a no-admin proof,
    // so the proof travels with the measurement instead of with a claim about
    // how it was run.
    let o = match is_elevated() {
        Some(e) => o.bool("elevated", e),
        None => o.null("elevated"),
    };
    // P5c. THE SESSION TRAVELS WITH EVERY RESULT. `Local\` object names resolve
    // per session, so a caller that records a job name without recording which
    // session it belongs to has recorded a name that may mean a different
    // object tomorrow. Putting it in the envelope means no caller has to
    // remember to ask.
    let o = match job::current_session_id() {
        Some(s) => o.num("sessionId", s as i64),
        None => o.null("sessionId"),
    };
    match integrity_rid() {
        // 0x2000 medium (a normal user), 0x3000 high (elevated).
        Some(r) => o.num("integrityRid", r as i64).str("integrity", if r >= 0x3000 { "high" } else if r >= 0x2000 { "medium" } else { "low" }),
        None => o.null("integrityRid"),
    }
}

// ------------------------------------------------------------------ arguments

struct RunArgs {
    name: String,
    mode: String,       // "appcontainer" | "plain"
    sid_source: String, // "create" | "derive"
    job: bool,
    keep_profile: bool,
    timeout_ms: u32,
    cwd: Option<String>,
    argv: Vec<String>,
    /// CL-16A2-D §8. Abort the helper at an exact point so recovery can be
    /// tested against a real half-finished world rather than a simulated one.
    crash_at: Option<String>,
    /// `run` owns the profile's whole life; `launch-in-profile` owns none of it.
    /// Separating them is what makes each stage individually recoverable.
    manage_profile: bool,
    /// CL-16A3 MEGA-1: measure whether this AppContainer could execute an image,
    /// WITHOUT ever running its code. The primary thread is never resumed on any
    /// path when this is set.
    probe_only: bool,
    /// P5c. The EXACT object name the caller has already recorded durably. Empty
    /// means the old anonymous job (still used by `run`, the measurement verb).
    ///
    /// The helper never derives this and never falls back to deriving it: a name
    /// that recovery did not write down is a name recovery cannot reach, and a
    /// derived one would silently re-point at a different run's job.
    job_name: String,
    /// The session the caller believes it is in. `Local\` resolves per session,
    /// so a mismatch means the name the caller recorded is NOT the name this
    /// process would create.
    expect_session_id: Option<DWORD>,
    /// Where the job's evidence is written BEFORE the target process is created.
    job_evidence_out: String,
    /// P5c2. The identity the trusted keeper is bound to, and which it uses to
    /// PROVE the job name it was handed. Required whenever `job_name` is set.
    run_id: String,
    operation_id: String,
    fencing_token: u64,
}

fn crash_if(point: &Option<String>, here: &str) {
    if point.as_deref() == Some(here) {
        // abort(), not exit(): no unwinding, no destructors, no flush — as close
        // to a real kill as a process can do to itself.
        std::process::abort();
    }
}

fn parse_run(args: &[String]) -> RunArgs {
    let mut r = RunArgs {
        name: String::new(),
        mode: "appcontainer".into(),
        sid_source: "create".into(),
        job: true,
        keep_profile: false,
        timeout_ms: 30_000,
        cwd: None,
        argv: vec![],
        crash_at: None,
        manage_profile: true,
        probe_only: false,
        job_name: String::new(),
        expect_session_id: None,
        job_evidence_out: String::new(),
        run_id: String::new(),
        operation_id: String::new(),
        fencing_token: 0,
    };
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                r.argv = args[i + 1..].to_vec();
                break;
            }
            "--name" => {
                i += 1;
                r.name = args.get(i).cloned().unwrap_or_default();
            }
            "--mode" => {
                i += 1;
                r.mode = args.get(i).cloned().unwrap_or_default();
            }
            "--sid-source" => {
                i += 1;
                r.sid_source = args.get(i).cloned().unwrap_or_default();
            }
            "--timeout-ms" => {
                i += 1;
                match args.get(i).and_then(|s| cmdline::parse_timeout(s)) {
                    Some(v) => r.timeout_ms = v,
                    None => fail("args", "--timeout-ms must be 1..=600000", 0),
                }
            }
            "--cwd" => {
                i += 1;
                r.cwd = args.get(i).cloned();
            }
            "--crash-at" => {
                i += 1;
                r.crash_at = args.get(i).cloned();
            }
            "--job-name" => {
                i += 1;
                r.job_name = args.get(i).cloned().unwrap_or_default();
            }
            "--expect-session-id" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse::<DWORD>().ok()) {
                    Some(v) => r.expect_session_id = Some(v),
                    None => fail("args", "--expect-session-id must be a non-negative integer", 0),
                }
            }
            "--job-evidence-out" => {
                i += 1;
                r.job_evidence_out = args.get(i).cloned().unwrap_or_default();
            }
            // P5c2. The run identity the KEEPER is bound to. Not used to derive
            // the job name — the caller records that name durably and passes it
            // whole — but passed on to the keeper so it can recompute the name's
            // prefix and refuse to hold a job that does not derive from the
            // identity presented with it.
            "--run-id" => {
                i += 1;
                r.run_id = args.get(i).cloned().unwrap_or_default();
            }
            "--operation-id" => {
                i += 1;
                r.operation_id = args.get(i).cloned().unwrap_or_default();
            }
            "--fencing-token" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse::<u64>().ok()) {
                    Some(v) => r.fencing_token = v,
                    None => fail("args", "--fencing-token must be a non-negative integer", 0),
                }
            }
            "--no-manage-profile" => r.manage_profile = false,
            "--probe-only" => r.probe_only = true,
            "--no-job" => r.job = false,
            "--keep-profile" => r.keep_profile = true,
            other => fail("args", &format!("unknown option {}", other), 0),
        }
        i += 1;
    }
    if r.mode != "appcontainer" && r.mode != "plain" {
        fail("args", "--mode must be appcontainer|plain", 0);
    }
    if r.sid_source != "create" && r.sid_source != "derive" {
        fail("args", "--sid-source must be create|derive", 0);
    }
    if r.argv.is_empty() {
        fail("args", "nothing to run: pass the program after --", 0);
    }
    if r.mode == "appcontainer" && !cmdline::is_valid_profile_name(&r.name) {
        fail("args", "--name must be 1..=64 chars of [A-Za-z0-9._-]", 0);
    }
    // OWNERSHIP IS ENFORCED ON CREATION, not only on deletion.
    //
    // `ensure-profile` and `delete-profile` checked the prefix; `run` did not,
    // so it could create a container Abdo does not own. Nothing would then
    // delete it if the run died: recovery's orphan sweep only looks for names
    // carrying the marker. A resource the cleanup system cannot see is exactly
    // the orphan this slice exists to prevent.
    // P5c. VALIDATED IN THE HELPER, not merely by whoever called it. The helper
    // holds the privilege; a name check that only runs on the calling side is a
    // comment. `is_valid_job_name` also forbids a second backslash, so a caller
    // cannot walk out of the session namespace it asked for.
    if !r.job_name.is_empty() && !job::is_valid_job_name(&r.job_name) {
        fail(
            "args",
            &format!("--job-name must be '{}<id>' with only [A-Za-z0-9_-] after the prefix and no further backslash", job::JOB_NAME_PREFIX),
            0,
        );
    }
    if !r.job_name.is_empty() && !r.job {
        fail("args", "--job-name and --no-job contradict each other", 0);
    }
    if !r.job_evidence_out.is_empty() && r.job_name.is_empty() {
        fail("args", "--job-evidence-out is only meaningful with --job-name", 0);
    }
    // P5c2. A NAMED JOB NOW IMPLIES A KEEPER, and a keeper that cannot be bound
    // to a run identity cannot prove the name it was told to hold derives from
    // it. Required here rather than defaulted, because a default would let the
    // keeper hold a job under an identity nobody chose.
    if !r.job_name.is_empty() && (r.run_id.is_empty() || r.operation_id.is_empty()) {
        fail("args", "--job-name requires --run-id and --operation-id: the keeper proves the name derives from them", 0);
    }
    if r.mode == "appcontainer" && r.manage_profile && !ops::is_owned(&r.name) {
        fail(
            "ownership",
            &format!("--name must start with '{}': a profile Abdo does not mark is one recovery can never reclaim", ops::OWNERSHIP_PREFIX),
            0,
        );
    }
    r
}

// ------------------------------------------------------------------- the spawn

/// A HANDLE crossing into a reader thread. Windows handles are process-wide
/// values; the wrapper exists because a raw pointer is not `Send`.
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

fn read_pipe(h: SendHandle) -> (Vec<u8>, bool) {
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        let mut read: DWORD = 0;
        let ok = unsafe { ReadFile(h.0, buf.as_mut_ptr(), buf.len() as DWORD, &mut read, std::ptr::null_mut()) };
        if ok == 0 || read == 0 {
            break; // the write end closed: the child and its children are done
        }
        if out.len() < MAX_CAPTURE_BYTES {
            let room = MAX_CAPTURE_BYTES - out.len();
            let take = (read as usize).min(room);
            out.extend_from_slice(&buf[..take]);
            if take < read as usize {
                truncated = true;
            }
        } else {
            truncated = true;
        }
        // Draining continues past the cap: stopping the read would block the
        // child on a full pipe, which is the deadlock section 7 asks about.
    }
    unsafe { CloseHandle(h.0) };
    (out, truncated)
}

/// Is this a NATIVE PE image? Extension AND header, because either alone lies.
///
/// The probe creates a real process, so it must never be pointed at a script:
/// `cmd.exe /c foo.bat` would execute the interpreter, and the whole guarantee of
/// this verb is that no code runs. A script is REFUSED, never wrapped.
fn native_pe_verdict(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    for bad in [".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".vbe", ".wsf", ".wsh", ".msi", ".lnk"] {
        if lower.ends_with(bad) {
            return Some("probe_target_not_native_pe");
        }
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Some("probe_target_unreadable"),
    };
    if bytes.len() < 0x40 || bytes[0] != b'M' || bytes[1] != b'Z' {
        return Some("probe_target_not_native_pe");
    }
    let e_lfanew = u32::from_le_bytes([bytes[0x3c], bytes[0x3d], bytes[0x3e], bytes[0x3f]]) as usize;
    if e_lfanew + 4 > bytes.len() || &bytes[e_lfanew..e_lfanew + 4] != [0x50u8, 0x45, 0x00, 0x00] {
        return Some("probe_target_not_native_pe");
    }
    None
}

/// The image the kernel says a process is running. IFEO, a registered debugger
/// and image substitution are invisible to the argv we passed and visible here.
fn actual_process_image(h: HANDLE) -> String {
    let mut buf = vec![0u16; 32_768];
    let mut n: DWORD = buf.len() as DWORD;
    unsafe {
        if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut n) == 0 {
            return String::new();
        }
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// The AppContainer facts of a process token: is it one, and which SID.
/// A process's creation time as a raw FILETIME.
///
/// Half of a process IDENTITY: Windows reuses pids aggressively, so "is pid N
/// alive?" cheerfully answers about whatever unrelated process now holds that
/// number — and that answer would be used here to decide whether to terminate a
/// tree.
fn process_start_time(h: HANDLE) -> u64 {
    let mut ct: [DWORD; 2] = [0, 0];
    let mut xt: [DWORD; 2] = [0, 0];
    let mut kt: [DWORD; 2] = [0, 0];
    let mut ut: [DWORD; 2] = [0, 0];
    unsafe {
        if GetProcessTimes(h, ct.as_mut_ptr(), xt.as_mut_ptr(), kt.as_mut_ptr(), ut.as_mut_ptr()) != 0 {
            ((ct[1] as u64) << 32) | ct[0] as u64
        } else {
            0
        }
    }
}

/// Both sides of an image-path comparison, folded the same way.
///
/// Case is folded because Windows paths are case-insensitive, and the `\??\` /
/// `\\?\` prefixes are stripped because the kernel and the caller do not spell
/// the same file the same way.
///
/// FORWARD SLASHES ARE FOLDED TO BACKSLASHES, and that is not a weakening of the
/// check. MEASURED: launching `C:/Windows/System32/cmd.exe` — which
/// `CreateProcessW` accepts, both separators being legal on Windows — made the
/// kernel report `C:\Windows\System32\cmd.exe`, and the identity gate refused
/// its own correct launch. The comparison must be between FILES, and two
/// spellings of one path are one file; what the gate is here to catch is the
/// kernel mapping a DIFFERENT image (IFEO, a registered debugger, a
/// substitution), which no amount of separator folding can hide.
/// Do these two spellings name the same FILE?
///
/// Finding 27: the comparison must fold separators, because the kernel reports
/// backslashes while a caller may legitimately pass forward slashes and
/// `CreateProcessW` accepts both. What it must still catch is a DIFFERENT image
/// - IFEO, a registered debugger, a substitution - and no separator folding
/// hides that.
pub fn images_equal(a: &str, b: &str) -> bool {
    normalise_image(a) == normalise_image(b)
}

fn normalise_image(p: &str) -> String {
    let s = p.to_lowercase().replace('/', "\\");
    let s = s.strip_prefix("\\??\\").unwrap_or(&s).to_string();
    let s = s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string();
    s.trim_start_matches("\\?\\").to_string()
}

fn token_appcontainer(h: HANDLE) -> (bool, String) {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(h, TOKEN_QUERY, &mut token) == 0 {
            return (false, String::new());
        }
        let mut is_ac: DWORD = 0;
        let mut ret: DWORD = 0;
        GetTokenInformation(token, TokenIsAppContainer, &mut is_ac as *mut DWORD as *mut c_void, 4, &mut ret);
        let mut need: DWORD = 0;
        GetTokenInformation(token, TokenAppContainerSid, std::ptr::null_mut(), 0, &mut need);
        let mut sid = String::new();
        if need > 0 {
            let mut buf = vec![0u8; need as usize];
            if GetTokenInformation(token, TokenAppContainerSid, buf.as_mut_ptr() as *mut c_void, need, &mut need) != 0 {
                // TOKEN_APPCONTAINER_INFORMATION is a single PSID pointer.
                let psid = *(buf.as_ptr() as *const PSID);
                if !psid.is_null() {
                    sid = sid_to_string(psid);
                }
            }
        }
        CloseHandle(token);
        (is_ac != 0, sid)
    }
}

fn cmd_run(args: &[String]) -> ! {
    let a = parse_run(args);
    // THE PE GATE, before anything is created. A probe must never be pointed at
    // a script: running one means running an interpreter, and the guarantee of
    // `--probe-only` is that no code runs at all. Scripts are REFUSED here, never
    // wrapped or staged around.
    if a.probe_only {
        if a.argv.is_empty() {
            fail("args", "--probe-only needs an executable after --", 0);
        }
        if let Some(reason) = native_pe_verdict(&a.argv[0]) {
            emit(base("run").bool("ok", false).bool("probeOnly", true).bool("resumed", false).str("stage", reason).str("error", reason).str("path", &a.argv[0]));
        }
    }
    let started = std::time::Instant::now();
    let mut o = base("run")
        .str("mode", &a.mode)
        .str("sidSource", &a.sid_source)
        .bool("job", a.job)
        .str("appContainerName", &a.name);

    // ---- 1. the AppContainer SID
    let mut sid: PSID = std::ptr::null_mut();
    let mut profile_created = false;
    let mut profile_existed = false;
    if a.mode == "appcontainer" {
        let wname = wide(&a.name);
        let wdisp = wide(&a.name);
        let wdesc = wide("Abdo CL-16A2-C measurement container");
        if !a.manage_profile {
            // `launch-in-profile`: the profile is somebody else's resource. The
            // SID is DERIVED, nothing is created, and nothing will be deleted.
            let hr = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut sid) };
            if hr < 0 {
                fail("DeriveAppContainerSidFromAppContainerName", "could not derive a SID", hr as u32);
            }
        } else if a.sid_source == "create" {
            // ZERO capabilities: null array, count 0. Not a variable.
            let hr = unsafe { CreateAppContainerProfile(wname.as_ptr(), wdisp.as_ptr(), wdesc.as_ptr(), std::ptr::null_mut(), 0, &mut sid) };
            if hr == HRESULT_ALREADY_EXISTS {
                profile_existed = true;
                let hr2 = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut sid) };
                if hr2 < 0 {
                    fail("DeriveAppContainerSidFromAppContainerName", "profile exists but its SID could not be derived", hr2 as u32);
                }
            } else if hr < 0 {
                fail("CreateAppContainerProfile", "could not create the profile", hr as u32);
            } else {
                profile_created = true;
            }
        } else {
            let hr = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut sid) };
            if hr < 0 {
                fail("DeriveAppContainerSidFromAppContainerName", "could not derive a SID", hr as u32);
            }
        }
        o = o.str("sid", &sid_to_string(sid)).bool("profileCreated", profile_created).bool("profileExisted", profile_existed);
    } else {
        o = o.null("sid").bool("profileCreated", false).bool("profileExisted", false);
    }

    // ---- 2. pipes
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let (mut out_r, mut out_w): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    let (mut err_r, mut err_w): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    unsafe {
        if CreatePipe(&mut out_r, &mut out_w, &sa, 0) == 0 || CreatePipe(&mut err_r, &mut err_w, &sa, 0) == 0 {
            fail("CreatePipe", "could not create the output pipes", GetLastError());
        }
        // Only the WRITE ends are inherited; the read ends stay ours.
        const HANDLE_FLAG_INHERIT: DWORD = 1;
        SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
    }

    // ---- 3. the attribute list carrying SECURITY_CAPABILITIES
    let mut caps = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let mut attr_buf: Vec<u8> = Vec::new();
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as DWORD;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdOutput = out_w;
    si.StartupInfo.hStdError = err_w;
    // A real, inheritable NUL handle rather than INVALID_HANDLE_VALUE: with no
    // console to fall back on, a child that reads stdin must get EOF instead of
    // an invalid handle.
    let nul = wide("NUL");
    let nul_h = unsafe {
        acl::CreateFileW(
            nul.as_ptr(),
            0x8000_0000, // GENERIC_READ
            0x0000_0003, // FILE_SHARE_READ | FILE_SHARE_WRITE
            &sa,
            3, // OPEN_EXISTING
            0,
            std::ptr::null_mut(),
        )
    };
    si.StartupInfo.hStdInput = nul_h;

    // CREATE_NO_WINDOW: a console is allocated but never shown. `DETACHED_PROCESS`
    // would avoid the console entirely — and silently breaks PowerShell (see the
    // constant). The console host it leaves behind is reaped explicitly after the
    // child exits, via `reap_console_hosts`.
    //
    // EXTENDED_STARTUPINFO_PRESENT IS NOW UNCONDITIONAL. It used to be set only
    // for AppContainer launches, because SECURITY_CAPABILITIES was the only
    // attribute; the target's inherited handle set is an attribute too, and it
    // matters on every mode.
    let flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;

    // ---- 3b. P5c2 §2: THE TARGET'S INHERITED HANDLES, NAMED ONE BY ONE.
    //
    // `CreateProcessW` below passes `bInheritHandles = TRUE`. On its own that
    // inherits EVERY handle in this process that happens to be marked
    // inheritable — a set nobody enumerates, that no call site declares, and
    // that silently grows the next time someone adds a pipe. Microsoft's own
    // guidance is to state the list explicitly, and here it is load-bearing:
    // the whole P5c2 correction is that THE TARGET MUST RECEIVE NO JOB HANDLE,
    // and "must not" is only a property of the code if the inherited set is
    // enumerated rather than inherited by default.
    //
    // Exactly three handles cross, and all three are the target's own std
    // streams. The keeper's job handle and its two event handles are created
    // later and are never named here, so they cannot reach the target even
    // though they are inheritable — which is what makes the negative test
    // (an unrelated inheritable sentinel handle that must NOT appear in the
    // child) a real measurement rather than a restatement.
    let mut target_handles: Vec<HANDLE> = vec![out_w, err_w];
    if nul_h != INVALID_HANDLE_VALUE && !nul_h.is_null() {
        // A handle named in STARTUPINFO must also be in the list or the child
        // receives a closed std handle; an INVALID one in the list makes
        // CreateProcessW fail outright with ERROR_INVALID_PARAMETER.
        target_handles.push(nul_h);
    }
    let attr_count: DWORD = if a.mode == "appcontainer" { 2 } else { 1 };
    unsafe {
        let mut size: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), attr_count, 0, &mut size);
        attr_buf.resize(size, 0);
        let list = attr_buf.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(list, attr_count, 0, &mut size) == 0 {
            fail("InitializeProcThreadAttributeList", "could not initialise the attribute list", GetLastError());
        }
        if a.mode == "appcontainer"
            && UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &mut caps as *mut _ as *mut c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) == 0
        {
            fail("UpdateProcThreadAttribute", "could not attach SECURITY_CAPABILITIES", GetLastError());
        }
        // The array must outlive `CreateProcessW`: this stores the POINTER, it
        // does not copy. `target_handles` is declared above and dropped after.
        if UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            target_handles.as_mut_ptr() as *mut c_void,
            std::mem::size_of::<HANDLE>() * target_handles.len(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            fail("UpdateProcThreadAttribute", "could not restrict the target's inherited handle list", GetLastError());
        }
        si.lpAttributeList = list;
    }

    // ---- 4. the job, created BEFORE the process so nothing runs unassigned
    let mut job: HANDLE = std::ptr::null_mut();
    // P5c2. The trusted keeper for THIS run, once it has proved itself. `None`
    // on every unnamed path: `run` without `--job-name` and `probe-exec-access`
    // use an anonymous KILL_ON_JOB_CLOSE job that has no name to keep alive.
    let mut keeper_state: Option<keeper::KeeperLaunch> = None;
    // The nonce this run's keeper was started with, needed again at the resume.
    let mut keeper_nonce = String::new();
    let named = !a.job_name.is_empty();
    let session_id = job::current_session_id().unwrap_or(u32::MAX);
    if named {
        o = o.str("jobName", &a.job_name).num("sessionId", session_id as i64);
        // SESSION FIRST, before the object is created. `Local\` resolves inside
        // the caller's session, so if this helper is not in the session the
        // caller recorded, the name it would create is NOT the name that was
        // written down — and the job recovery later opens would be a different
        // object with the same spelling.
        if let Some(expected) = a.expect_session_id {
            if expected != session_id {
                refuse_named(
                    o.num("expectedSessionId", expected as i64),
                    &a,
                    profile_created,
                    "named_job_session_mismatch",
                    "this helper runs in a different session than the one the caller recorded",
                    0,
                );
            }
        }
        let host_sid = match root::host_user_sid() {
            Some(s) => s,
            None => refuse_named(o.clone(), &a, profile_created, "named_job_host_sid_unknown", "the host SID could not be read, so no descriptor can be built", 0),
        };
        match job::create_protected_named_job(&a.job_name, &host_sid) {
            // THE COLLISION RULE. `CreateJobObjectW` returns the EXISTING job
            // and sets ERROR_ALREADY_EXISTS, so "it worked" and "somebody else
            // owns this name" are the same return value. The handle has already
            // been closed inside `create_protected_named_job`; nothing was
            // assigned, nothing adopted, nothing terminated.
            job::JobCreate::Collision { opened } => refuse_named(
                o.clone().bool("collisionHandleReturned", opened),
                &a,
                profile_created,
                "named_job_collision",
                if opened {
                    "a job with this exact name already existed and the OS returned a handle to it; the handle was closed and no process was created"
                } else {
                    "a job with this exact name already existed and would not open with the access CreateJobObjectW requests; no handle was obtained and no process was created"
                },
                if opened { ERROR_ALREADY_EXISTS } else { ERROR_ACCESS_DENIED },
            ),
            job::JobCreate::TypeConflict(e) => refuse_named(
                o.clone(),
                &a,
                profile_created,
                "named_job_name_type_conflict",
                "the name is held by a kernel object that is not a job",
                e,
            ),
            job::JobCreate::Failed(stage, e) => refuse_named(o.clone(), &a, profile_created, stage, "the named job could not be created", e),
            job::JobCreate::Created(h) => job = h,
        }

        // Limits, set EXPLICITLY to zero rather than left at the default.
        //
        // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is deliberately ABSENT: it would
        // kill the tree when this helper exits, which is precisely the state
        // P5c has to survive — a dead host with a live child, whose job is
        // still openable by name. Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK
        // is set either, so children and grandchildren cannot leave the job.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = 0;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
            )
        } == 0
        {
            let e = unsafe { GetLastError() };
            unsafe { CloseHandle(job) };
            refuse_named(o.clone(), &a, profile_created, "named_job_limits_unset", "the job's limits could not be configured", e);
        }

        // INSPECT THE JOB WE ACTUALLY GOT, before anything is put in it.
        //
        // The descriptor that decides who may terminate this job is the one the
        // OS stored, not the one we asked for, so it is READ BACK and checked
        // STRUCTURALLY. Windows rewrites `D:P(...)` as `D:PAI(...)`, so a hash
        // comparison against the request would fail on every correctly-created
        // job — measured elsewhere in this package on the execution root.
        let observed_sddl = match acl::read_kernel_object_sddl(job) {
            Ok(s) => s,
            Err(e) => {
                unsafe { CloseHandle(job) };
                refuse_named(o.clone(), &a, profile_created, "named_job_descriptor_unreadable", "the job's own descriptor could not be read back", e);
            }
        };
        if let Err(why) = job::is_protected_owner_only_job_dacl(&observed_sddl, &host_sid) {
            unsafe { CloseHandle(job) };
            refuse_named(o.clone(), &a, profile_created, "named_job_descriptor_mismatch", &why, 0);
        }
        // A job we just created must be EMPTY. Anything else means the name did
        // not belong to us despite the create succeeding.
        let (assigned_now, pids_now) = match job::job_process_ids(job) {
            Ok(v) => v,
            Err(e) => {
                unsafe { CloseHandle(job) };
                refuse_named(o.clone(), &a, profile_created, "named_job_unqueryable", "the job's process list could not be read", e);
            }
        };
        if assigned_now != 0 || !pids_now.is_empty() {
            unsafe { CloseHandle(job) };
            refuse_named(
                o.clone(),
                &a,
                profile_created,
                "named_job_not_empty",
                "a freshly created job already had processes assigned to it",
                0,
            );
        }

        let sddl_hash = sha256::sha256_hex(observed_sddl.as_bytes());
        let limits_hash = sha256::sha256_hex(format!("limitFlags=0x{:x}", info.BasicLimitInformation.LimitFlags).as_bytes());
        o = o
            .str("jobSecurityDescriptor", &observed_sddl)
            .str("jobSecurityDescriptorHash", &sddl_hash)
            .str("jobLimitsHash", &limits_hash)
            .num("jobLimitFlags", info.BasicLimitInformation.LimitFlags as i64)
            .str("hostSid", &host_sid);

        // THE DURABLE `job.created` EVIDENCE, written HERE — after the job is
        // created and verified, and BEFORE any process exists. A crash between
        // this line and the spawn therefore leaves evidence of a job with no
        // members, which is exactly what it would be.
        write_evidence_line(
            &a.job_evidence_out,
            json::Obj::new()
                .str("event", "job.created")
                .str("jobName", &a.job_name)
                .num("sessionId", session_id as i64)
                .str("securityDescriptor", &observed_sddl)
                .str("securityDescriptorHash", &sddl_hash)
                .str("limitsHash", &limits_hash)
                .num("limitFlags", info.BasicLimitInformation.LimitFlags as i64)
                .str("hostSid", &host_sid)
                .str("helperBinaryHash", &sha256::own_binary_hash())
                .num("helperProtocolVersion", PROTOCOL_VERSION as i64),
        );
        crash_if(&a.crash_at, "after_named_job_created");

        // ---- 4b. THE TRUSTED KEEPER, started before the target exists.
        //
        // P5c2. The job's NAME dies with its last handle (finding 21), and P5c
        // kept it alive by handing a reduced handle to the TARGET — a handle the
        // target owns, and may therefore close. See `src/keeper.rs` for the
        // three ways an uncooperative target defeated that.
        //
        // The holder is now a trusted process outside the AppContainer and
        // outside the job. It is started HERE, before the target is created, for
        // an ordering reason: if the keeper cannot be started or cannot prove
        // itself, the launch is refused while the world still contains nothing
        // but an empty job. There is no window in which a target runs unkept.
        let self_exe = match std::env::current_exe() {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => {
                unsafe { CloseHandle(job) };
                refuse_named(o.clone(), &a, profile_created, "keeper_helper_path_unknown", "this helper could not identify its own image, so it cannot start a keeper", 0);
            }
        };
        // THE ONE-SHOT AUTHORISATION NONCE, minted here and handed to the keeper
        // on its command line. An authorisation that does not carry it was not
        // written for this keeper instance, which is what makes a captured or
        // replayed message a refusal rather than a second resume.
        //
        // 128 bits from the OS CSPRNG. Not a secret in the usual sense — the
        // command pipe is already unreachable to anything but this process — but
        // it costs nothing and it means the binding does not rest on pipe
        // possession alone.
        keeper_nonce = sha256::random_hex_16();
        let auth_nonce = keeper_nonce.clone();
        let launched_keeper = match keeper::spawn_keeper(&self_exe, job, &a.job_name, &a.run_id, &a.operation_id, a.fencing_token, session_id, &auth_nonce, &a.crash_at) {
            keeper::KeeperSpawn::Started(k) => k,
            keeper::KeeperSpawn::Failed(stage, e) => {
                unsafe { CloseHandle(job) };
                refuse_named(o.clone(), &a, profile_created, stage, "the trusted job keeper could not be started; no process was created", e);
            }
        };
        // ITS OWN REPORT, not our assumption that it started. The keeper proves
        // its inherited handles by USING them and proves it is outside the job
        // and outside the container by asking its own token — and only then says
        // ready. A keeper that refused, died, or said anything else is a refusal
        // here, because the alternative is a target whose name has no keeper.
        let ready_line = match keeper::read_keeper_line(launched_keeper.stdout_read, 30_000) {
            Some(l) => l,
            None => {
                keeper::shutdown_keeper(&launched_keeper);
                keeper::release_keeper(&launched_keeper);
                unsafe { CloseHandle(job) };
                refuse_named(o.clone(), &a, profile_created, "keeper_no_ready_report", "the trusted job keeper never reported ready; no process was created", 0);
            }
        };
        if !ready_line.contains("\"keeper.ready\"") {
            keeper::shutdown_keeper(&launched_keeper);
            keeper::release_keeper(&launched_keeper);
            unsafe { CloseHandle(job) };
            refuse_named(
                o.clone().str("keeperReport", &ready_line),
                &a,
                profile_created,
                "keeper_refused",
                "the trusted job keeper refused to hold this job; no process was created",
                0,
            );
        }
        // THE HOST VERIFIES THE KEEPER'S IDENTITY INDEPENDENTLY, rather than
        // believing the pid in the report. A pid alone is not an identity, so the
        // creation time is read from the process handle CreateProcess gave us —
        // a handle that cannot have been recycled underneath us — and that pair
        // is what gets recorded durably.
        let keeper_facts = job::inspect_pid(launched_keeper.pid);
        if !keeper_facts.alive || keeper_facts.start_time != launched_keeper.start_time {
            keeper::shutdown_keeper(&launched_keeper);
            keeper::release_keeper(&launched_keeper);
            unsafe { CloseHandle(job) };
            refuse_named(o.clone(), &a, profile_created, "keeper_identity_unstable", "the keeper's pid and creation time did not agree a moment after it reported ready", 0);
        }
        // FROM HERE ON EVERY EXIT PATH MUST TELL THE KEEPER. `emit` is the single
        // exit of this process, so the shutdown event is registered there rather
        // than repeated at each of the refusals below — and it is safe to send
        // unconditionally, because the keeper honours it ONLY while unarmed with
        // an empty job. A shutdown that arrives with a live member self-arms it
        // instead.
        keeper::register_shutdown(&launched_keeper);
        keeper_state = Some(launched_keeper);

        write_evidence_line(
            &a.job_evidence_out,
            json::Obj::new()
                .str("event", "keeper.ready")
                .str("jobName", &a.job_name)
                .num("sessionId", session_id as i64)
                .num("keeperPid", keeper_facts.pid as i64)
                // Decimal digits in a STRING: a FILETIME exceeds 2^53 and a
                // client that parses it as a number can never ask about that
                // process again.
                .str("keeperStartTime", &keeper_facts.start_time.to_string())
                .str("keeperImage", &keeper_facts.image)
                .str("runId", &a.run_id)
                .str("operationId", &a.operation_id)
                .str("fencingToken", &a.fencing_token.to_string())
                .str("helperBinaryHash", &sha256::own_binary_hash())
                .num("helperProtocolVersion", PROTOCOL_VERSION as i64),
        );
        o = o.num("keeperPid", keeper_facts.pid as i64).str("keeperStartTime", &keeper_facts.start_time.to_string()).bool("keeperReady", true);
        crash_if(&a.crash_at, "after_keeper_ready");
    } else if a.job {
        // The ANONYMOUS job, unchanged: `run` and `probe-exec-access` are
        // measurement verbs whose job never has to outlive the invocation, and
        // KILL_ON_JOB_CLOSE is the right cleanup for them.
        unsafe {
            job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                fail("CreateJobObjectW", "could not create the job object", GetLastError());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
            ) == 0
            {
                fail("SetInformationJobObject", "could not set KILL_ON_JOB_CLOSE", GetLastError());
            }
        }
    }

    // ---- 5. create SUSPENDED
    let exe = wide(&a.argv[0]);
    let mut cmdline_w = wide(&cmdline::build_command_line(&a.argv));
    let cwd_w = a.cwd.as_ref().map(|c| wide(c));
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            exe.as_ptr(),
            cmdline_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            TRUE,
            flags,
            std::ptr::null_mut(),
            cwd_w.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
            &mut si,
            &mut pi,
        )
    };
    let create_err = unsafe { GetLastError() };
    unsafe {
        if !si.lpAttributeList.is_null() {
            DeleteProcThreadAttributeList(si.lpAttributeList);
        }
        CloseHandle(out_w);
        CloseHandle(err_w);
        if nul_h != INVALID_HANDLE_VALUE {
            CloseHandle(nul_h);
        }
    }
    if created == 0 {
        unsafe {
            CloseHandle(out_r);
            CloseHandle(err_r);
            if !job.is_null() {
                CloseHandle(job);
            }
        }
        let (deleted, del_hr) = cleanup_profile(&a, profile_created);
        emit(
            o.bool("ok", false)
                .str("stage", "CreateProcessW")
                .str("error", "the process could not be created")
                .num("errorCode", create_err as i64)
                .null("exitCode")
                .bool("profileDeleted", deleted)
                .num("profileDeleteHresult", del_hr as i64),
        );
    }

    // ---- 6. assign, THEN resume. The escape window is never open.
    //
    // P5c reorders this on the named path so that the sequence the brief
    // specifies is the sequence the machine performs:
    //
    //     create suspended -> verify image/token/AppContainer SID
    //       -> assign to the EXACT named job -> verify membership
    //         -> record process.created -> ResumeThread
    //
    // The identity checks used to exist only on the `--probe-only` branch, so
    // the REAL launch resumed a process whose token had never been read back.
    // Everything below runs while the primary thread is still suspended.
    let child_image = actual_process_image(pi.hProcess);
    let (child_is_ac, child_token_sid) = token_appcontainer(pi.hProcess);
    let child_start = process_start_time(pi.hProcess);
    if named {
        let expected_sid = sid_to_string(sid);
        let image_matches = !child_image.is_empty() && normalise_image(&child_image) == normalise_image(&a.argv[0]);
        let sid_matches = !child_token_sid.is_empty() && child_token_sid.eq_ignore_ascii_case(&expected_sid);
        // KILL BEFORE JUDGING, so no branch can return while a suspended
        // process of unverified identity is still on the machine.
        let bad = if !image_matches {
            // IFEO, a registered debugger or an image substitution never appear
            // in the argv we passed; they appear here, in what the kernel says
            // it actually mapped.
            Some(("named_job_process_image_mismatch", format!("the kernel mapped {:?}, not {:?}", child_image, a.argv[0])))
        } else if a.mode == "appcontainer" && !child_is_ac {
            Some(("named_job_process_not_appcontainer", "the created process's token is not an AppContainer token".to_string()))
        } else if a.mode == "appcontainer" && !sid_matches {
            Some((
                "named_job_process_sid_mismatch",
                format!("the token's AppContainer SID is {:?}, not the {:?} the grants were made for", child_token_sid, expected_sid),
            ))
        } else {
            None
        };
        if let Some((code, detail)) = bad {
            unsafe {
                TerminateJobObject(job, 1);
                TerminateProcess(pi.hProcess, 1);
                WaitForSingleObject(pi.hProcess, 10_000);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(job);
                CloseHandle(out_r);
                CloseHandle(err_r);
            }
            refuse_named(
                o.clone().str("actualImagePath", &child_image).str("tokenAppContainerSid", &child_token_sid).bool("isAppContainer", child_is_ac),
                &a,
                profile_created,
                code,
                &detail,
                0,
            );
        }
    }

    let mut assigned = false;
    let mut assign_err = 0u32;
    if a.job {
        unsafe {
            if AssignProcessToJobObject(job, pi.hProcess) == 0 {
                assign_err = GetLastError();
            } else {
                assigned = true;
            }
        }
    }
    // MEMBERSHIP, asked of the OS rather than inferred from the call above.
    //
    // The NULL handle is NOT passed here any more. `IsProcessInJob(h, NULL, …)`
    // answers "is this process in ANY job?", a different question that read as
    // this one whenever `--no-job` was used — and `backend.ts` derives
    // `childCreatedInContainer` from the answer.
    let mut in_job: BOOL = 0;
    let mut in_any_job: BOOL = 0;
    unsafe {
        if !job.is_null() {
            IsProcessInJob(pi.hProcess, job, &mut in_job);
        }
        IsProcessInJob(pi.hProcess, std::ptr::null_mut(), &mut in_any_job);
    }
    if named && (!assigned || in_job == 0) {
        // A process that is NOT in the job is a process no later helper can
        // ever reach. Rather than resume it and lose it, it is terminated here.
        unsafe {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 10_000);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            TerminateJobObject(job, 1);
            CloseHandle(job);
            CloseHandle(out_r);
            CloseHandle(err_r);
        }
        refuse_named(
            o.clone().bool("assignedToJobAttempted", assigned),
            &a,
            profile_created,
            "named_job_assignment_unproven",
            "the created process could not be proved to be a member of the named job",
            assign_err,
        );
    }
    // ---- 6b. ARM THE KEEPER, and wait for it to say it is holding.
    //
    // THE NAME HAS TO OUTLIVE THIS HELPER, and a name alone does not: a
    // temporary kernel object's name is removed when its handle count reaches
    // zero (P5c finding 21, measured). Something must hold a handle.
    //
    // P5c handed that handle to the TARGET. P5c2 does not, and this is the line
    // where the difference lives — there is no `DuplicateHandle` into
    // `pi.hProcess` any more, in any mode. The holder is the trusted keeper
    // started before this process existed, which the target cannot name, cannot
    // open and cannot close.
    //
    // ARMED HERE, and not one step earlier: the keeper must not begin treating
    // an empty job as "the tree ended" until a member has actually been proved
    // into it. Everything above — image, token, AppContainer SID, assignment,
    // membership answered by the OS — has already passed, and the primary thread
    // is still suspended.
    //
    // The handshake is explicit. `SetEvent` returning true says a bit was
    // flipped; the keeper's acknowledgement says it reached the holding state.
    // Only the second one is worth recording, and a launch that cannot get it
    // refuses rather than resuming a target whose name has no proven keeper.
    let mut keeper_armed = false;
    let mut keeper_arm_detail = String::new();
    if named {
        if let Some(k) = keeper_state.as_ref() {
            match keeper::arm_keeper(k, 30_000) {
                Ok(line) => {
                    keeper_armed = true;
                    keeper_arm_detail = line;
                }
                Err((stage, detail)) => {
                    // The target is created, assigned and SUSPENDED — it has
                    // never run. Terminating it here costs nothing and is the
                    // only honest option: resuming it would put a live tree
                    // behind a name with no proven holder, which is exactly the
                    // state this phase exists to prevent.
                    unsafe {
                        TerminateProcess(pi.hProcess, 1);
                        WaitForSingleObject(pi.hProcess, 10_000);
                        TerminateJobObject(job, 1);
                        CloseHandle(pi.hThread);
                        CloseHandle(pi.hProcess);
                        CloseHandle(job);
                        CloseHandle(out_r);
                        CloseHandle(err_r);
                    }
                    refuse_named(
                        o.clone().num("keeperPid", k.pid as i64).str("keeperArmReport", &detail),
                        &a,
                        profile_created,
                        stage,
                        "the trusted job keeper did not acknowledge arming; the suspended target was terminated rather than resumed",
                        0,
                    );
                }
            }
        }
    }
    if named {
        write_evidence_line(
            &a.job_evidence_out,
            json::Obj::new()
                .str("event", "process.created")
                .bool("keeperArmed", keeper_armed)
                .num("keeperPid", keeper_state.as_ref().map(|k| k.pid as i64).unwrap_or(0))
                .str("keeperStartTime", &keeper_state.as_ref().map(|k| k.start_time.to_string()).unwrap_or_default())
                .str("jobName", &a.job_name)
                .num("sessionId", session_id as i64)
                .num("pid", pi.dwProcessId as i64)
                // Decimal digits in a STRING: a FILETIME exceeds 2^53 and a
                // client that parses it as a number can never ask about that
                // process again.
                .str("startTime", &child_start.to_string())
                .str("actualImagePath", &child_image)
                .str("tokenAppContainerSid", &child_token_sid)
                .bool("isAppContainer", child_is_ac)
                .bool("assignedToJob", assigned)
                .bool("isProcessInJob", in_job != 0),
        );
        o = o
            .str("actualImagePath", &child_image)
            .str("tokenAppContainerSid", &child_token_sid)
            .bool("isAppContainer", child_is_ac)
            // P5c2. `childKeepAliveHandle` is GONE rather than reported false.
            // A field that always said false would read as a keep-alive that
            // failed; the truth is that the target is now given no job handle at
            // all, and the name is kept by the process named here instead.
            .bool("keeperArmed", keeper_armed)
            .str("keeperArmReport", &keeper_arm_detail);
    }
    // §8 crash points, at the two moments the world is most half-finished: a
    // suspended process that exists but has never run, and one that is in the
    // job but not yet resumed.
    crash_if(&a.crash_at, "after_process_create_suspended");
    crash_if(&a.crash_at, "after_assign_job_before_resume");
    // RESUME, AND SAY WHETHER IT WORKED. ResumeThread returns the thread's
    // previous suspend count, or (DWORD)-1 on failure. The production launcher
    // refuses to record `isolation.applied` unless every stage is OBSERVED, and
    // "resumed" cannot be honestly derived from the outcome: a child that timed
    // out looks identical whether it was never resumed or resumed and then hung.
    // ---- 6b. THE SUSPENDED-CREATE PROBE. Everything below happens while the
    // primary thread is STILL SUSPENDED, and this path never reaches
    // `ResumeThread` on any branch — that is the entire guarantee of the verb.
    //
    // It exists because the previous way of answering "can this container run
    // this image?" was to RUN IT, which executes the target's code before
    // `run.launch_requested`, outside the observation lifecycle and outside
    // process-tree containment. A measurement that can cause damage is not a
    // measurement.
    if a.probe_only {
        let pid = pi.dwProcessId;
        // THE IMAGE THE KERNEL IS ACTUALLY RUNNING, the token, and the creation
        // time — all captured above, before the process was assigned to
        // anything, and reused here rather than measured a second time. IFEO, a
        // registered debugger or an image substitution never show up in the
        // argv we passed; they show up in these.
        let start_time = child_start;
        let actual_image = child_image.clone();
        let (is_ac, token_sid) = (child_is_ac, child_token_sid.clone());

        // KILL FIRST, JUDGE AFTER. The verdict is computed from facts already
        // captured, so no branch can return while a suspended process is still
        // on the machine. Terminating the JOB reaches a tree, not just a child.
        unsafe {
            if !job.is_null() {
                TerminateJobObject(job, 1);
            }
            TerminateProcess(pi.hProcess, 1);
        }
        let waited = unsafe { WaitForSingleObject(pi.hProcess, 10_000) };
        let mut code: DWORD = 0;
        unsafe { GetExitCodeProcess(pi.hProcess, &mut code) };
        // OS-CONFIRMED EXIT: not "we called terminate", but the process object
        // signalled and its exit code is no longer STILL_ACTIVE (259).
        let exited = waited == 0 && code != 259;

        let expected_sid = sid_to_string(sid);
        let image_matches = !actual_image.is_empty() && normalise_image(&actual_image) == normalise_image(&a.argv[0]);
        let sid_matches = !token_sid.is_empty() && token_sid.eq_ignore_ascii_case(&expected_sid);
        let mismatch = !is_ac || !sid_matches || !image_matches;

        unsafe {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            if !job.is_null() {
                CloseHandle(job);
            }
        }
        let (deleted, del_hr) = cleanup_profile(&a, profile_created);
        emit(
            o.bool("ok", !mismatch && exited)
                .bool("probeOnly", true)
                .bool("resumed", false)
                .bool("isAppContainer", is_ac)
                .str("tokenAppContainerSid", &token_sid)
                .str("expectedAppContainerSid", &expected_sid)
                .str("actualImagePath", &actual_image)
                .bool("imageMatches", image_matches)
                .bool("sidMatches", sid_matches)
                .bool("processExited", exited)
                .num("pid", pid as i64)
                .str("startTime", &start_time.to_string())
                .num("exitCode", code as i64)
                .bool("profileDeleted", deleted)
                .num("profileDeleteHresult", del_hr as i64)
                .str("stage", if mismatch { "probe_process_identity_mismatch" } else { "probe_complete" })
                .str("error", if mismatch { "probe_process_identity_mismatch" } else { "" }),
        );
    }

    // ---- 6c. P5c2-FINAL. THE RESUME, PERFORMED BY THE KEEPER.
    //
    // The host does not call `ResumeThread` on the named path, and that absence
    // is the security property. While it did, this sequence was reachable and
    // unfixable from here: arm the keeper, the keeper acknowledges, the keeper
    // is killed, and the host — holding a stale acknowledgement — resumes the
    // target anyway. The result is a RUNNING target whose job name was dropped
    // before it ever started, which is the state finding 21 exists to prevent,
    // reached through the door P5c2 had just closed.
    //
    // No re-check here could fix it: any check the host makes is separated from
    // the resume it guards by a window the keeper can die in. Making the keeper
    // the CALLER removes the window instead of narrowing it — the thread cannot
    // start unless the process that keeps its job reachable is alive to start
    // it, because that process is the one starting it.
    //
    // The host still decides WHETHER to authorise. The keeper decides whether
    // the authorisation describes the world it is actually holding: same job,
    // same run identity, target a proven member, pid and creation time matching,
    // and the thread genuinely belonging to that pid.
    let mut resume_rc: DWORD = 0;
    let resumed;
    let mut resume_confirmation = String::new();
    if named {
        crash_if(&a.crash_at, "after_verified_before_resume_authorization");
        let k = keeper_state.as_ref().expect("a named launch always has a keeper by this point");
        match keeper::authorize_resume(
            k,
            pi.hThread,
            pi.dwProcessId,
            child_start,
            &child_image,
            &child_token_sid,
            &a.job_name,
            &a.run_id,
            &a.operation_id,
            a.fencing_token,
            session_id,
            &keeper_nonce,
            60_000,
        ) {
            Ok(line) => {
                resumed = true;
                resume_confirmation = line;
            }
            Err((stage, detail)) => {
                // THE TARGET HAS NEVER RUN. It was created suspended and only
                // the keeper can start it, so a refusal here means the code
                // inside it has not executed a single instruction. Terminating
                // is therefore free of consequence, and leaving it suspended
                // would be residue with no owner.
                unsafe {
                    TerminateProcess(pi.hProcess, 1);
                    WaitForSingleObject(pi.hProcess, 10_000);
                    TerminateJobObject(job, 1);
                    let _ = job::drain_job(job, 10_000);
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                    CloseHandle(job);
                    CloseHandle(out_r);
                    CloseHandle(err_r);
                }
                refuse_named(
                    o.clone().num("keeperPid", k.pid as i64).bool("keeperAlive", keeper::keeper_still_alive(k)).str("keeperResumeReport", &detail),
                    &a,
                    profile_created,
                    stage,
                    "the trusted keeper did not confirm the resume; the target was terminated from a suspended state and never ran",
                    0,
                );
            }
        }
        crash_if(&a.crash_at, "after_resume_confirmed_before_process_started");
    } else {
        // The UNNAMED paths — `run` without `--job-name`, and the
        // `probe-exec-access` machinery — keep the old behaviour. They use an
        // anonymous KILL_ON_JOB_CLOSE job that has no name to keep alive and no
        // keeper to keep it, so there is no window to close.
        resume_rc = unsafe { ResumeThread(pi.hThread) };
        resumed = resume_rc != u32::MAX;
    }
    crash_if(&a.crash_at, "after_resume");

    // ---- 7. drain both pipes concurrently; a single-threaded read deadlocks
    //
    // THE RESULTS COME BACK OVER CHANNELS, not only from `join()`, and that is
    // load-bearing rather than stylistic: `JoinHandle::join` cannot be given a
    // deadline, and section 8 below has to be able to give up on a drain that a
    // descendant is holding open. See the run-deadline comment there.
    let ho = SendHandle(out_r);
    let he = SendHandle(err_r);
    let (tx_out, rx_out) = std::sync::mpsc::channel::<(Vec<u8>, bool)>();
    let (tx_err, rx_err) = std::sync::mpsc::channel::<(Vec<u8>, bool)>();
    let t_out = std::thread::spawn(move || {
        let _ = tx_out.send(read_pipe(ho));
    });
    let t_err = std::thread::spawn(move || {
        let _ = tx_err.send(read_pipe(he));
    });
    let run_started = std::time::Instant::now();

    // P5c2-FINAL. WAIT ON THE TARGET, BUT WATCH THE KEEPER TOO.
    //
    // A keeper that dies mid-run takes the job's NAME with it — the object
    // manager drops a temporary object's name at handle count zero — while the
    // tree carries on running. From that instant the tree is unreachable to
    // anyone but this process, which still holds its own job handle.
    //
    // So this is the last moment the tree can be ended DELIBERATELY, with
    // evidence, rather than left for a recovery that will correctly refuse to
    // claim anything about a name that no longer resolves. A plain
    // `WaitForSingleObject` on the target would sleep straight through it.
    //
    // The unnamed paths keep the simple wait: no name, no keeper, nothing to
    // watch.
    let mut keeper_died_mid_run = false;
    let timed_out;
    if named && keeper_state.is_some() {
        let k = keeper_state.as_ref().expect("checked");
        let started_wait = std::time::Instant::now();
        loop {
            // The target first: a run that finished normally is finished, even
            // if the keeper is in the middle of its own exit.
            if unsafe { WaitForSingleObject(pi.hProcess, 100) } == WAIT_OBJECT_0 {
                timed_out = false;
                break;
            }
            if !keeper::keeper_still_alive(k) {
                keeper_died_mid_run = true;
                timed_out = false;
                unsafe {
                    TerminateJobObject(job, 1);
                    WaitForSingleObject(pi.hProcess, 5_000);
                }
                break;
            }
            if started_wait.elapsed().as_millis() as u64 >= a.timeout_ms as u64 {
                timed_out = true;
                unsafe {
                    TerminateJobObject(job, 1);
                    WaitForSingleObject(pi.hProcess, 5_000);
                }
                break;
            }
        }
    } else {
        let wait = unsafe { WaitForSingleObject(pi.hProcess, a.timeout_ms) };
        timed_out = wait == WAIT_TIMEOUT;
        if timed_out && !job.is_null() {
            // Terminating the JOB is what reaches a grandchild. Without a job there
            // is only the direct child to kill, which is exactly the gap the job
            // exists to close — and `--no-job` measures it rather than assuming it.
            unsafe { TerminateJobObject(job, 1) };
            unsafe { WaitForSingleObject(pi.hProcess, 5_000) };
        }
    }
    // ---- 7b. THE RUN'S TIMEOUT MUST BOUND THE RUN, NOT JUST ITS FIRST PROCESS.
    //
    // P5c2-FINAL-RC4 §1. MEASURED DEFECT, and it is the one a hostile target
    // reaches for: `--timeout-ms 3000` produced a run of `durationMs 40547` with
    // `timedOut: false` and no kill issued at all.
    //
    // The sequence, measured through the real harness with the CONTROL test's
    // exact argument vector:
    //
    //   1. the initial process (`cmd.exe`) exits almost at once — in AppContainer
    //      mode it cannot reach the working directory, prints "The current
    //      directory is invalid." and fails its synchronous command;
    //   2. so `WaitForSingleObject` returns WAIT_OBJECT_0, NOT WAIT_TIMEOUT, and
    //      the whole kill path above is skipped;
    //   3. but a `start /b` grandchild is still alive holding the inherited
    //      stdout/stderr pipe;
    //   4. and the drain below used to be a plain `join()` with NO DEADLINE, so
    //      the helper waited out that grandchild's full lifetime.
    //
    // Containment itself was never at fault — the native probe in
    // `diagnostics/containment-probe.rs` proves the grandchild IS a job member
    // and IS reaped by `TerminateJobObject` — so the tree could always have been
    // ended here. Nothing was watching the clock.
    //
    // The remaining budget is what the caller asked for minus what has already
    // been spent. When it runs out the JOB IS TERMINATED, which closes every
    // write end and lets both readers finish, and the run says so rather than
    // reporting a quiet overrun as a normal completion.
    let budget = std::time::Duration::from_millis(a.timeout_ms as u64);
    let remaining = || budget.checked_sub(run_started.elapsed()).unwrap_or(std::time::Duration::ZERO);

    let mut drain_timed_out = false;
    let first = rx_out.recv_timeout(remaining());
    let second = if first.is_ok() { rx_err.recv_timeout(remaining()) } else { Err(std::sync::mpsc::RecvTimeoutError::Timeout) };

    let (stdout_bytes, out_trunc, stderr_bytes, err_trunc) = if let (Ok(o), Ok(e)) = (first, second) {
        (o.0, o.1, e.0, e.1)
    } else {
        // THE DESCENDANTS ARE STILL WRITING. End the tree deliberately — the same
        // action the timeout path takes — then collect what was read. A bounded
        // second wait, because with every writer gone `ReadFile` returns at once;
        // if it somehow does not, an empty capture is reported rather than hanging.
        drain_timed_out = true;
        if !job.is_null() {
            unsafe {
                TerminateJobObject(job, 1);
                WaitForSingleObject(pi.hProcess, 5_000);
            }
        }
        let grace = std::time::Duration::from_millis(5_000);
        let o = rx_out.recv_timeout(grace).unwrap_or((Vec::new(), false));
        let e = rx_err.recv_timeout(grace).unwrap_or((Vec::new(), false));
        (o.0, o.1, e.0, e.1)
    };
    // The threads are joined for their own sake; both have sent by now, and a
    // reader still blocked on a pipe nobody writes to cannot hold up the result.
    let _ = t_out.join();
    let _ = t_err.join();

    // THE RUN timed out, whoever consumed the budget. `timedOut` keeps meaning
    // "this run exceeded `--timeout-ms`", which is what every caller reads it as;
    // `drainTimedOut` says the overrun came from descendants holding the pipes
    // after the initial process had already exited, so the two causes stay
    // distinguishable instead of being merged into one ambiguous flag.
    let timed_out = timed_out || drain_timed_out;

    let mut code: DWORD = 0;
    unsafe { GetExitCodeProcess(pi.hProcess, &mut code) };
    // The child's CREATION TIME, reported so the journal can store a process
    // IDENTITY rather than a bare pid. Windows reuses pids aggressively, and a
    // recovery that asks "is pid N alive?" gets a true answer about the wrong
    // process — which makes a dead run look alive and its resources
    // untouchable. MEASURED: this happened during a full-suite run.
    let start_time = process_start_time(pi.hProcess);

    // THE NAMED JOB HAS NO KILL_ON_JOB_CLOSE, so closing the handle reaps
    // nothing. On the normal path the tree is terminated DELIBERATELY here and
    // the emptiness is CONFIRMED by re-querying the member list — the same
    // proof `terminate-process-tree` uses, because "we called terminate" is not
    // evidence in either place.
    //
    // Leaning on handle-close semantics would have been shorter and would have
    // made the tests pass, at the price of the property P5c exists for: a job
    // that survives its creator so a later helper can reach it.
    let mut job_members_after: u32 = 0;
    let mut job_drained = true;
    if named && !job.is_null() {
        unsafe { TerminateJobObject(job, 1) };
        let (empty, remaining) = job::drain_job(job, 10_000);
        job_drained = empty;
        job_members_after = remaining;
    }
    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if !job.is_null() {
            // For the ANONYMOUS job this is where KILL_ON_JOB_CLOSE fires for
            // any straggler. For the named job the tree is already gone, proved
            // above.
            CloseHandle(job);
        }
        if !sid.is_null() {
            FreeSid(sid);
        }
    }
    // P5c2. THE KEEPER IS REAPED ON THE NORMAL PATH, and it is waited for rather
    // than assumed.
    //
    // Nothing signals the keeper to stop: it exits on its own when the job's
    // member list comes back empty, which the terminate-and-drain above has just
    // made true. But "it will exit shortly" is not a state a run may report as
    // finished — the keeper runs the same image as this helper, so a keeper still
    // alive at exit is a helper process in the residue census, and it would read
    // as a leak rather than as the last millisecond of a correct shutdown.
    //
    // Bounded, and the bound is reported rather than swallowed. A keeper that
    // outlasts it has not been killed here: it is holding a job it could not
    // prove empty, and that is exactly when it is supposed to stay alive.
    let mut keeper_exited = true;
    let mut keeper_pid_out: i64 = 0;
    if let Some(k) = keeper_state.as_ref() {
        keeper_pid_out = k.pid as i64;
        keeper_exited = unsafe { WaitForSingleObject(k.process, 10_000) } == WAIT_OBJECT_0;
        keeper::release_keeper(k);
    }
    // The console host is NOT a job member — it is started by the OS outside the
    // AppContainer — so closing the job does not take it with it. Reaped here by
    // parent pid, immediately after the child was waited on.
    let reaped = reap_console_hosts(pi.dwProcessId);
    crash_if(&a.crash_at, "after_process_exit");
    let (deleted, del_hr) = cleanup_profile(&a, profile_created);
    crash_if(&a.crash_at, "after_profile_delete_before_report");

    emit(
        // P5c2-FINAL: a keeper that died mid-run makes this run NOT ok, whatever
        // the target's exit code says. The tree was terminated by this host
        // because its name had already been dropped, and a run whose isolation
        // stopped holding partway through is not a run that completed.
        o.bool("ok", !timed_out && code == 0 && !keeper_died_mid_run)
            .num("pid", pi.dwProcessId as i64)
            // A STRING, DELIBERATELY. A Windows FILETIME is ~1.3e17, well past
            // JavaScript's 2^53 safe-integer limit, so a JSON number loses its
            // low digits the instant a client parses it. Measured: a live
            // process asked about with the round-tripped value answers
            // `alive:false`, because the creation time no longer matches. That
            // turns "pid + creation time is the process identity" into a check
            // that reports every tracked process as dead, and recovery then
            // reclaims the profile and ACLs of a container that is still
            // running. Emitting decimal digits keeps the value exact.
            .str("startTime", &start_time.to_string())
            .num("consoleHostsReaped", reaped as i64)
            .bool("timedOut", timed_out)
            // RC4 §1: the overrun came from descendants holding the pipes open
            // after the initial process had already exited, not from the initial
            // process outliving its budget. Both set `timedOut`; only this tells
            // them apart, and a run that reports it had its job terminated.
            .bool("drainTimedOut", drain_timed_out)
            .num("exitCode", code as i64)
            .bool("assignedToJob", assigned)
            .bool("resumed", resumed)
            .num("assignError", assign_err as i64)
            .bool("isProcessInJob", in_job != 0)
            // A DIFFERENT QUESTION, reported separately rather than folded into
            // the one above: with `--no-job` there is no job of ours to be in,
            // and "in some job" was previously reported as if it were "in ours".
            .bool("isProcessInAnyJob", in_any_job != 0)
            .bool("jobDrained", job_drained)
            .num("jobMembersAfter", job_members_after as i64)
            .num("keeperPidReaped", keeper_pid_out)
            .bool("keeperExited", keeper_exited)
            // P5c2-FINAL. `ok` below already excludes this run — a keeper that
            // died mid-run means the tree was terminated by this host rather
            // than finishing, and the exit code reflects a kill. Reported as its
            // own field so the reason is not left to be inferred from an exit
            // code that looks like any other termination.
            .bool("keeperDiedMidRun", keeper_died_mid_run)
            .bool("resumedByKeeper", named)
            .num("resumePreviousSuspendCount", resume_rc as i64)
            .str("keeperResumeReport", &resume_confirmation)
            .str("stdout", &String::from_utf8_lossy(&stdout_bytes))
            .str("stderr", &String::from_utf8_lossy(&stderr_bytes))
            .bool("stdoutTruncated", out_trunc)
            .bool("stderrTruncated", err_trunc)
            .bool("profileDeleted", deleted)
            .num("profileDeleteHresult", del_hr as i64)
            .num("durationMs", started.elapsed().as_millis() as i64),
    )
}

/// P5c. A refusal on the named-job path.
///
/// It still tidies up a profile THIS invocation created, because a refusal that
/// leaves residue is the failure it was trying to prevent. It NEVER touches the
/// job: on the collision path the job belongs to somebody else, and on the
/// others there is nothing to touch.
fn refuse_named(o: json::Obj, a: &RunArgs, created: bool, code: &str, detail: &str, err: DWORD) -> ! {
    let (deleted, del_hr) = cleanup_profile(a, created);
    emit(
        o.bool("ok", false)
            .str("stage", code)
            .str("error", code)
            .str("detail", detail)
            .num("errorCode", err as i64)
            .bool("assignedToJob", false)
            .bool("isProcessInJob", false)
            .bool("resumed", false)
            .null("pid")
            .null("exitCode")
            .bool("profileDeleted", deleted)
            .num("profileDeleteHresult", del_hr as i64),
    )
}

/// Append one JSON line of durable evidence, flushed before returning.
///
/// JSONL rather than one object, because the ORDER of the two facts is the
/// property being recorded: the job existed and was verified BEFORE any process
/// did. A single object rewritten twice would lose exactly that.
///
/// A failure here is deliberately NOT fatal to the launch: the caller has
/// already recorded the job's NAME durably before this process started, and the
/// name is what recovery needs to reach the tree. This file adds detail, not the
/// safety property.
fn write_evidence_line(path: &str, obj: json::Obj) {
    if path.is_empty() {
        return;
    }
    let line = format!("{}\n", obj.finish());
    let mut f = match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let _ = f.write_all(line.as_bytes());
    let _ = f.flush();
    // The bytes must be ON DISK, not in a buffer a killed process never drains.
    let _ = f.sync_all();
}

/// Delete a profile THIS run created. A profile that already existed is left
/// alone: removing another run's container is exactly the concurrency hazard
/// section 5 warns about.
fn cleanup_profile(a: &RunArgs, created: bool) -> (bool, i32) {
    // The ownership check is repeated here even though `parse_run` already made
    // it impossible to get this far with an unmarked name. Deletion is the
    // irreversible direction; it does not rely on a caller upstream having been
    // careful.
    if a.mode != "appcontainer" || !created || a.keep_profile || !ops::is_owned(&a.name) {
        return (false, 0);
    }
    let wname = wide(&a.name);
    let hr = unsafe { DeleteAppContainerProfile(wname.as_ptr()) };
    (hr >= 0, hr)
}

// ---------------------------------------------------------------- sub-commands

/// P5c — `terminate-process-tree`: end an orphaned run's WHOLE tree, and prove
/// it ended.
///
/// This is the verb finding 17 said could not exist while the job was anonymous.
/// It accepts ONLY durable expected evidence — nothing is derived, nothing is
/// guessed, and there is no fallback name. If the caller cannot prove which job
/// it means, the answer is a refusal, not a best effort.
///
/// It is deliberately NOT "kill the processes of run X". There is no process
/// name matching, no `taskkill /IM`, no image-path sweep and no bare-pid kill:
/// every one of those can hit an unrelated process that happens to look similar,
/// and the whole point of the job is that MEMBERSHIP is the authorisation.
fn cmd_terminate_tree(args: &[String]) -> ! {
    let job_name = opt(args, "--job-name");
    let run_id = opt(args, "--run-id");
    let operation_id = opt(args, "--operation-id");
    let fencing = opt(args, "--fencing-token");
    let expect_session = opt(args, "--expect-session-id");
    let expect_pid: DWORD = opt(args, "--expect-initial-pid").parse().unwrap_or(0);
    let expect_start = opt(args, "--expect-initial-start").parse::<u64>().ok();
    let expect_ac_sid = opt(args, "--expect-appcontainer-sid");
    let expect_root = opt(args, "--expect-root-path");
    let expect_marker = opt(args, "--expect-marker-hash");
    let budget_ms: u64 = opt(args, "--timeout-ms").parse().unwrap_or(15_000).min(600_000);

    let o = base("terminate-process-tree").str("jobName", &job_name).str("runId", &run_id).str("operationId", &operation_id);
    let refuse = |o: json::Obj, code: &str, detail: &str, err: DWORD| -> ! {
        emit(o.bool("ok", false).bool("terminated", false).str("stage", code).str("error", code).str("detail", detail).num("errorCode", err as i64))
    };

    if job_name.is_empty() || run_id.is_empty() || operation_id.is_empty() || fencing.is_empty() || expect_session.is_empty() {
        refuse(o, "terminate_evidence_incomplete", "--job-name, --run-id, --operation-id, --fencing-token and --expect-session-id are all required", 0);
    }
    let fencing_token = match fencing.parse::<u64>() {
        Ok(v) => v,
        Err(_) => refuse(o, "terminate_evidence_incomplete", "--fencing-token must be an integer", 0),
    };
    let expected_session: DWORD = match expect_session.parse() {
        Ok(v) => v,
        Err(_) => refuse(o, "terminate_evidence_incomplete", "--expect-session-id must be an integer", 0),
    };
    if !job::is_valid_job_name(&job_name) {
        refuse(o, "terminate_job_name_invalid", "the name is not one this helper creates or opens", 0);
    }

    // 1. SESSION. `Local\` resolves per session, so opening this name from
    // another session would open a DIFFERENT object that merely shares a
    // spelling.
    let session_id = job::current_session_id().unwrap_or(u32::MAX);
    let o = o.num("sessionId", session_id as i64).num("expectedSessionId", expected_session as i64);
    if session_id != expected_session {
        refuse(o, "terminate_session_mismatch", "this helper runs in a different session than the one that created the job", 0);
    }

    // 2. THE DURABLE IDENTITY, PROVED RATHER THAN ACCEPTED. The name must be
    // the one this exact (host, run, operation, fencing token) would produce.
    let host_sid = match root::host_user_sid() {
        Some(s) => s,
        None => refuse(o, "terminate_host_sid_unknown", "the host SID could not be read", 0),
    };
    let prefix = job::job_name_prefix_for(&host_sid, &run_id, &operation_id, fencing_token);
    if !job_name.starts_with(&prefix) || job_name.len() <= prefix.len() {
        refuse(
            o,
            "terminate_identity_unproven",
            "the job name is not the one this run id, operation id and fencing token produce for this host",
            0,
        );
    }

    // 3. THE ROOT/MARKER IDENTITY, when the caller recorded one. Binding the
    // termination to the root the caller proved stops a stale evidence set from
    // acting on a machine that has since been re-provisioned.
    let o = if expect_root.is_empty() {
        o.bool("rootChecked", false)
    } else {
        let marker_path = format!("{}\\root.marker", expect_root.trim_end_matches('\\'));
        match std::fs::read(&marker_path) {
            Ok(bytes) => {
                let got = sha256::sha256_hex(&bytes);
                if !expect_marker.is_empty() && got != expect_marker {
                    refuse(
                        o.str("markerHash", &got),
                        "terminate_root_marker_mismatch",
                        "the execution root's marker is not the one recorded with this run",
                        0,
                    );
                }
                o.bool("rootChecked", true).str("markerHash", &got)
            }
            Err(_) => refuse(o, "terminate_root_marker_unreadable", "the recorded execution root has no readable marker", 0),
        }
    };

    // 4. OPEN BY EXACT NAME, with the MINIMUM rights: query + terminate (+ read
    // the descriptor back, + synchronise). It cannot assign a process and it
    // cannot alter the limits.
    let job = match job::open_named_job(&job_name, JOB_RIGHTS_TERMINATOR) {
        Ok(h) => h,
        Err(e) if e == ERROR_FILE_NOT_FOUND => {
            // THE NAME DOES NOT RESOLVE. That is emphatically NOT the same as
            // "the tree is gone", and an earlier version of this arm said it
            // was: it returned `ok:true, treeGone:true` while the recorded tree
            // was measured still running, because a name outlives neither its
            // last handle nor, therefore, its processes. That is the precise
            // shape of failure this package exists to refuse — a verification
            // reported without a measurement.
            //
            // So the honest answer is "cannot prove", plus the ONE fact that
            // can still be measured: whether the recorded initial process is
            // alive, asked as (pid, creation time) so a reused pid cannot
            // answer for it. Recovery composes that with its own child-liveness
            // check; this verb does not guess on its behalf.
            let initial = if expect_pid > 0 { Some(job::inspect_pid(expect_pid)) } else { None };
            let initial_alive = match (&initial, expect_start) {
                (Some(f), Some(want)) => f.alive && f.start_time == want,
                (Some(f), None) => f.alive,
                (None, _) => false,
            };
            emit(
                o.bool("ok", false)
                    .bool("jobPresent", false)
                    .bool("terminated", false)
                    .bool("treeGone", false)
                    .bool("initialProcessChecked", initial.is_some())
                    .bool("initialProcessAlive", initial_alive)
                    .num("processesBefore", 0)
                    .num("processesAfter", 0)
                    .str("stage", "terminate_job_absent")
                    .str("error", "terminate_job_absent")
                    .str(
                        "detail",
                        "the recorded job name no longer resolves, so this verb cannot prove the tree ended; a name does not outlive its last handle",
                    ),
            )
        }
        Err(e) => refuse(o, "terminate_job_unopenable", "the recorded job exists but could not be opened", e),
    };
    let o = o.bool("jobPresent", true);

    // 5. IT MUST BE OUR JOB. The descriptor is the thing that decides who may
    // terminate, so it is read back and checked STRUCTURALLY — a squatter that
    // guessed the name would not carry this descriptor.
    let observed_sddl = match acl::read_kernel_object_sddl(job) {
        Ok(s) => s,
        Err(e) => {
            unsafe { CloseHandle(job) };
            refuse(o, "terminate_descriptor_unreadable", "the job's descriptor could not be read", e);
        }
    };
    if let Err(why) = job::is_protected_owner_only_job_dacl(&observed_sddl, &host_sid) {
        unsafe { CloseHandle(job) };
        refuse(o.str("jobSecurityDescriptor", &observed_sddl), "terminate_descriptor_mismatch", &why, 0);
    }

    // 6. THE BEFORE INVENTORY. Every member, with its creation time — a pid on
    // its own is not an identity.
    let (assigned_before, pids_before) = match job::job_process_ids(job) {
        Ok(v) => v,
        Err(e) => {
            unsafe { CloseHandle(job) };
            refuse(o, "terminate_job_unqueryable", "the job's process list could not be read", e);
        }
    };
    let before: Vec<job::ProcFacts> = pids_before.iter().map(|p| job::inspect_pid(*p)).collect();
    let before_json: Vec<String> = before.iter().map(|f| job::proc_facts_json(f).finish()).collect();
    let o = o
        .num("processesBefore", assigned_before as i64)
        .raw("before", &format!("[{}]", before_json.join(",")))
        .str("jobSecurityDescriptor", &observed_sddl);

    // 7. REFUSALS, ALL BEFORE ANYTHING IS TERMINATED.
    //
    // (a) An identity we could not establish. NOT the same as "it exited": a
    //     member we cannot open is one we cannot later prove dead, so the
    //     honest outcome is to defer rather than to terminate and then report a
    //     verification we did not perform.
    if let Some(f) = before.iter().find(|f| f.identity_unknown) {
        unsafe { CloseHandle(job) };
        refuse(
            o,
            "terminate_identity_unknown_deferred",
            &format!("pid {} is a member whose identity could not be established (open error {})", f.pid, f.open_error),
            f.open_error,
        );
    }
    // (b) PID REUSE. If the initial process is still a member, it must be THE
    //     process that was recorded — same pid AND same creation time.
    if expect_pid > 0 {
        if let Some(f) = before.iter().find(|f| f.pid == expect_pid) {
            if let Some(want) = expect_start {
                if f.start_time != want {
                    unsafe { CloseHandle(job) };
                    refuse(
                        o,
                        "terminate_pid_reuse_refused",
                        &format!("pid {} is in the job but was created at {}, not the recorded {}", expect_pid, f.start_time, want),
                        0,
                    );
                }
            } else {
                unsafe { CloseHandle(job) };
                refuse(o, "terminate_pid_reuse_refused", "an initial pid was given with no creation time, which is not an identity", 0);
            }
        }
    }
    // (c) A FOREIGN CONTAINER. Every member whose token we could read must
    //     belong to the AppContainer this run was launched under.
    if !expect_ac_sid.is_empty() {
        if let Some(f) = before.iter().find(|f| !f.app_container_sid.is_empty() && !f.app_container_sid.eq_ignore_ascii_case(&expect_ac_sid)) {
            unsafe { CloseHandle(job) };
            refuse(
                o,
                "terminate_foreign_process_refused",
                &format!("pid {} runs under AppContainer {}, not the recorded {}", f.pid, f.app_container_sid, expect_ac_sid),
                0,
            );
        }
    }

    // 8. TERMINATE THE JOB. This reaches every process associated with it —
    // children and grandchildren included, because no breakaway flag was ever
    // set — and nested child jobs with it.
    let call_ok = unsafe { TerminateJobObject(job, 1) } != 0;
    let call_err = if call_ok { 0 } else { unsafe { GetLastError() } };

    // 9/10. CONFIRM. The return code above says a call was made, not that a
    // tree died, so the member list is re-queried until it is empty.
    let (drained, remaining) = job::drain_job(job, budget_ms);
    let (assigned_after, pids_after) = job::job_process_ids(job).unwrap_or((remaining, Vec::new()));
    let after: Vec<job::ProcFacts> = pids_after.iter().map(|p| job::inspect_pid(*p)).collect();
    let after_json: Vec<String> = after.iter().map(|f| job::proc_facts_json(f).finish()).collect();

    // 11. AND EVERY PROCESS WE SAW IS CONFIRMED GONE INDIVIDUALLY — asked of
    // the OS about that exact (pid, creation time), so a reused pid cannot make
    // a dead process look alive or a live one look dead.
    let mut still_alive: Vec<DWORD> = Vec::new();
    for f in &before {
        let now = job::inspect_pid(f.pid);
        if now.alive && now.start_time == f.start_time {
            still_alive.push(f.pid);
        }
    }
    unsafe { CloseHandle(job) };

    let tree_gone = drained && assigned_after == 0 && still_alive.is_empty();
    emit(
        o.bool("terminated", call_ok)
            .num("terminateError", call_err as i64)
            .bool("drained", drained)
            .num("processesAfter", assigned_after as i64)
            .raw("after", &format!("[{}]", after_json.join(",")))
            .raw("stillAlive", &format!("[{}]", still_alive.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")))
            .bool("treeGone", tree_gone)
            .str("stage", if tree_gone { "tree_terminated" } else { "tree_termination_unproven" })
            .str("error", if tree_gone { "" } else { "tree_termination_unproven" })
            // `ok` is the PROOF, not the call. A `TerminateJobObject` that
            // returned success while a member survived is a failure here.
            .bool("ok", tree_gone),
    )
}

fn cmd_probe() -> ! {
    // Does the machine have the APIs at all, and can THIS user use them?
    let name = format!("abdo-probe-{}", unsafe { GetCurrentProcessId() });
    let wname = wide(&name);
    let mut derived: PSID = std::ptr::null_mut();
    let hr_derive = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut derived) };
    let derived_sid = if hr_derive >= 0 { sid_to_string(derived) } else { String::new() };
    if !derived.is_null() {
        unsafe { FreeSid(derived) };
    }

    let mut created: PSID = std::ptr::null_mut();
    let wdisp = wide(&name);
    let wdesc = wide("Abdo CL-16A2-C capability probe");
    let hr_create = unsafe { CreateAppContainerProfile(wname.as_ptr(), wdisp.as_ptr(), wdesc.as_ptr(), std::ptr::null_mut(), 0, &mut created) };
    let created_sid = if hr_create >= 0 { sid_to_string(created) } else { String::new() };
    if !created.is_null() {
        unsafe { FreeSid(created) };
    }
    let hr_delete = if hr_create >= 0 { unsafe { DeleteAppContainerProfile(wname.as_ptr()) } } else { 0 };

    // Section 10: the experimental sandbox API, as a RESEARCH LOOKUP ONLY.
    // Presence is reported; nothing calls it, nothing falls back to it, and it
    // does not become a substitute for the traditional path without its own ADR.
    let experimental = ["kernel32.dll", "kernelbase.dll", "api-ms-win-core-sandbox-l1-1-0.dll"]
        .iter()
        .any(|d| export_present(d, "Experimental_CreateProcessInSandbox"));

    emit(
        base("probe")
            .bool("experimentalCreateProcessInSandbox", experimental)
            .bool("ok", hr_create >= 0)
            .num("deriveHresult", hr_derive as i64)
            .str("derivedSid", &derived_sid)
            .num("createHresult", hr_create as i64)
            .str("createdSid", &created_sid)
            .num("deleteHresult", hr_delete as i64)
            .bool("sidsMatch", !derived_sid.is_empty() && derived_sid == created_sid),
    )
}

/// One named option's value, read only from BEFORE `--` so a program's own
/// arguments can never be mistaken for the helper's.
fn opt(args: &[String], name: &str) -> String {
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    match args[..end].iter().position(|a| a == name) {
        Some(i) => args.get(i + 1).cloned().unwrap_or_default(),
        None => String::new(),
    }
}

/// Spawn THIS executable again, with no console window, and wait.
///
/// `CREATE_NO_WINDOW` is the whole point: without it every invocation allocates
/// a console, which on Windows 11 becomes a Windows Terminal tab that outlives
/// the command. See `cmd_serve`.
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Like `spawn_self_hidden`, but reports the child's pid THE MOMENT it exists,
/// so the caller can record `child_started` before waiting on it.
fn spawn_self_hidden_reporting(args_file: &str, out_file: &str, on_started: &dyn Fn(&str)) -> (DWORD, DWORD) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let argv = vec![exe.clone(), "--out".into(), out_file.into(), "--args-file".into(), args_file.into()];
    let wexe = wide(&exe);
    let mut wcmd = wide(&cmdline::build_command_line(&argv));
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            wexe.as_ptr(),
            wcmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            FALSE,
            CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        )
    };
    if ok == 0 {
        on_started(&format!("child_start_failed {}", unsafe { GetLastError() }));
        return (0, u32::MAX);
    }
    on_started(&format!("child_started {}", pi.dwProcessId));
    unsafe {
        WaitForSingleObject(pi.hProcess, 600_000);
        let mut code: DWORD = 0;
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        (pi.dwProcessId, code)
    }
}

#[allow(dead_code)]
fn spawn_self_hidden(args_file: &str, out_file: &str) -> DWORD {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let argv = vec![exe.clone(), "--out".into(), out_file.into(), "--args-file".into(), args_file.into()];
    let wexe = wide(&exe);
    let mut wcmd = wide(&cmdline::build_command_line(&argv));
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            wexe.as_ptr(),
            wcmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            FALSE,
            CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        )
    };
    if ok == 0 {
        return unsafe { GetLastError() };
    }
    unsafe {
        WaitForSingleObject(pi.hProcess, 600_000);
        let mut code: DWORD = 0;
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        code
    }
}

/// A file-queue server, for the MEASUREMENT HARNESS only.
///
/// WHY IT EXISTS, recorded because the failure was expensive: reaching a
/// non-elevated context goes through `explorer.exe`, and the harness did that
/// once PER HELPER CALL. Each launch allocated a console, which Windows 11 turns
/// into a Windows Terminal tab that does not close on exit. A full suite run
/// left **885 terminal windows and 920 orphaned conhost processes holding
/// ~2.2 GB** on the user's machine. That is not a test artefact to shrug at; it
/// is the harness being wrong.
///
/// So the de-elevation happens ONCE. This server is launched de-elevated, then
/// picks up `<id>.req` files (one argument per line), runs each as a hidden
/// child, and writes `<id>.res`. Every later child inherits its medium
/// integrity, so the privilege property is unchanged — and no window is created
/// at any point.
///
/// It is not production code and nothing under `src/` outside this file uses it.
/// It exits on `shutdown.req` or after an idle timeout, so it cannot be left
/// running by a suite that dies.
fn cmd_serve(args: &[String]) -> ! {
    let dir = opt(args, "--requests");
    if dir.is_empty() {
        fail("args", "--requests <dir> is required", 0);
    }
    let idle_ms: u64 = opt(args, "--idle-ms").parse().unwrap_or(600_000);
    let _ = std::fs::create_dir_all(&dir);

    // EXCLUSIVE LOCK: one server per queue, enforced by the OS rather than by
    // hoping. Opening with no sharing fails for a second instance, which then
    // exits instead of racing the first for requests. Three servers once ran
    // against one queue — one of them with a stale binary — and produced results
    // that could not be reproduced.
    let lock_path = format!("{}\\server.lock", dir);
    let wl = wide(&lock_path);
    let lock = unsafe {
        acl::CreateFileW(
            wl.as_ptr(),
            0x4000_0000, // GENERIC_WRITE
            0,           // NO SHARING
            std::ptr::null(),
            2, // CREATE_ALWAYS
            0x0400_0000 /* FILE_FLAG_DELETE_ON_CLOSE */,
            std::ptr::null_mut(),
        )
    };
    if lock == INVALID_HANDLE_VALUE {
        emit(
            base("serve")
                .bool("ok", false)
                .str("stage", "server.lock")
                .str("error", "another server already owns this queue")
                .num("errorCode", unsafe { GetLastError() } as i64),
        );
    }

    // IDENTITY, published before the first request. The client refuses to talk
    // to a server whose protocol or binary hash is not the one it verified.
    let ready = json::Obj::new()
        .num("pid", unsafe { GetCurrentProcessId() } as i64)
        .num("protocolVersion", PROTOCOL_VERSION as i64)
        .str("binaryHash", &sha256::own_binary_hash())
        .str("exePath", &std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
        .finish();
    write_heartbeat(&dir, &ready);

    /// Enough to ride out contention from twenty worker threads; few enough
    /// that a directory which really vanished is reported in seconds.
    const MAX_READ_FAILURES: u32 = 40;
    let mut read_failures: u32 = 0;
    let mut last_work = std::time::Instant::now();
    let mut last_beat = std::time::Instant::now();
    let exit_with = |reason: &str| -> ! {
        // WHY IT STOPPED, on disk. The first version just exited, and when it
        // died a minute into a run there was nothing to read: no crash event, no
        // log, only a stalled queue. Every helper call then burned its full 90s
        // timeout, which is how a 6-minute suite became an 80-minute one.
        let _ = std::fs::write(format!("{}\\server.exit", dir), reason);
        let _ = std::fs::remove_file(format!("{}\\server.ready", dir));
        std::process::exit(0)
    };
    loop {
        if last_work.elapsed().as_millis() as u64 > idle_ms {
            exit_with("idle_timeout");
        }
        // A heartbeat, so a client can tell a live server from a dead one
        // instead of waiting out a timeout to find out. It republishes the same
        // identity, so the client re-checks it continuously and not just once.
        if last_beat.elapsed().as_millis() > 500 {
            write_heartbeat(&dir, &ready);
            last_beat = std::time::Instant::now();
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => {
                read_failures = 0;
                e
            }
            // A TRANSIENT READ IS NOT A REASON TO DIE. This used to `break`, and
            // with twenty worker threads renaming and deleting files in the same
            // directory a momentary sharing violation is ordinary — so the server
            // exited mid-run, silently, taking a worker thread's unfinished
            // rename with it. That is the whole 80-minute stall.
            //
            // But it is not a reason to loop for ever either: a directory that
            // has genuinely gone away must end the server LOUDLY, with a reason
            // on disk, rather than spin.
            Err(_) => {
                read_failures += 1;
                if read_failures > MAX_READ_FAILURES {
                    exit_with("read_dir_failed_repeatedly");
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        };
        #[allow(unused_assignments)]
        let mut did = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "shutdown.req" {
                let _ = std::fs::remove_file(entry.path());
                exit_with("shutdown_requested");
            }
            if !name.ends_with(".req") {
                continue;
            }
            let id = name.trim_end_matches(".req").to_string();
            let req = format!("{}\\{}", dir, name);
            let tmp = format!("{}\\{}.tmp", dir, id);
            let res = format!("{}\\{}.res", dir, id);
            // Rename the request first: two server instances cannot both take it.
            let claimed = format!("{}\\{}.busy", dir, id);
            if std::fs::rename(&req, &claimed).is_err() {
                continue;
            }
            // ONE THREAD PER REQUEST, and this is not an optimisation.
            //
            // The first version waited for each child before taking the next
            // request. That SERIALISED everything — and the suite's whole point
            // is concurrency: twenty parallel runs became twenty sequential
            // ones, and the overlapping-same-name test started failing because
            // the "concurrent" second run could not begin until the first had
            // finished and deleted its profile. A harness that quietly removes
            // the concurrency from a concurrency test is worse than no harness.
            let ev = format!("{}\\{}.ev", dir, id);
            std::thread::spawn(move || {
                // A LIFECYCLE, WRITTEN DOWN. `exit=0` with no `child_started`
                // means the harness reported a result for a command that never
                // ran — the single most dangerous outcome for a sandbox test,
                // because it looks exactly like a clean pass. The client treats
                // that combination as a harness failure, which it can only do if
                // the events exist.
                let append = |line: &str| {
                    use std::io::Write as _;
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&ev) {
                        let _ = writeln!(f, "{} {}", line, now_ms());
                    }
                };
                append("started");
                let (pid, code) = spawn_self_hidden_reporting(&claimed, &tmp, &append);
                append(&format!("child_exited {} {}", pid, code));
                // Result under a temp name, then renamed: the reader never sees
                // a half-written file.
                let renamed = std::fs::rename(&tmp, &res).is_ok();
                append(if renamed { "result" } else { "result_missing" });
                let _ = std::fs::remove_file(&claimed);
            });
            did = true;
            last_work = std::time::Instant::now();
        }
        // ALWAYS sleep, even after dispatching. Skipping it turned the loop into
        // a hot spin that re-read the directory thousands of times a second
        // while twenty threads mutated it — which is what made the transient
        // read error above likely enough to hit in the first place.
        let _ = did;
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

fn cmd_profile(command: &str, args: &[String]) -> ! {
    let mut name = String::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--name" {
            i += 1;
            name = args.get(i).cloned().unwrap_or_default();
        }
        i += 1;
    }
    if !cmdline::is_valid_profile_name(&name) {
        fail("args", "--name must be 1..=64 chars of [A-Za-z0-9._-]", 0);
    }
    let wname = wide(&name);
    let o = base(command).str("appContainerName", &name);
    match command {
        "derive-sid" => {
            let mut sid: PSID = std::ptr::null_mut();
            let hr = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut sid) };
            let s = if hr >= 0 { sid_to_string(sid) } else { String::new() };
            if !sid.is_null() {
                unsafe { FreeSid(sid) };
            }
            emit(o.bool("ok", hr >= 0).num("hresult", hr as i64).str("sid", &s))
        }
        "create-profile" => {
            let mut sid: PSID = std::ptr::null_mut();
            let wdisp = wide(&name);
            let wdesc = wide("Abdo CL-16A2-C");
            let hr = unsafe { CreateAppContainerProfile(wname.as_ptr(), wdisp.as_ptr(), wdesc.as_ptr(), std::ptr::null_mut(), 0, &mut sid) };
            let s = if hr >= 0 { sid_to_string(sid) } else { String::new() };
            if !sid.is_null() {
                unsafe { FreeSid(sid) };
            }
            emit(
                o.bool("ok", hr >= 0)
                    .num("hresult", hr as i64)
                    .bool("alreadyExists", hr == HRESULT_ALREADY_EXISTS)
                    .str("sid", &s),
            )
        }
        // Routed through the idempotent op: ownership-checked, "already gone" is
        // success, and the result reports the OBSERVED directory state rather
        // than the API's return value alone.
        "delete-profile" => emit(ops::delete_profile(base("delete-profile"), &name)),
        _ => unreachable!(),
    }
}

/// Re-launch a command with the STANDARD-USER token linked to this elevated one.
///
/// This exists because section 8 refuses to count anything measured from an
/// elevated shell. `runas /trustlevel:0x20000` was tried first and MEASURED not
/// to work: it yields a SAFER-restricted token that still reports
/// `elevated: true`. The linked token is the documented mechanism and produces a
/// genuine medium-integrity process — the same context a user's ordinary
/// terminal has.
///
/// It changes nothing about the machine: no service, no scheduled task, no
/// registry write. When this process is NOT elevated there is no linked token,
/// and the command is simply run as-is — so the harness works unchanged from an
/// ordinary shell, which is the preferred way to run it.
/// Publish the readiness heartbeat ATOMICALLY.
///
/// `std::fs::write` truncates and then writes, so a reader polling twice a second
/// can observe an EMPTY file and conclude the server published no identity —
/// which is exactly what happened: a healthy server was reported dead and the run
/// failed for a harness reason indistinguishable from a product one. Temp plus
/// rename means a reader sees either the old contents or the new ones, never a
/// half-written file.
/// MEASURED TWICE, because the obvious fix for each failure causes the other:
///
///   - a plain `write` truncates first, so a reader polling twice a second can
///     observe an EMPTY file and report that the server published no identity;
///   - a plain temp+`rename` cannot replace a file another process currently has
///     OPEN — on Windows that fails with a sharing violation — so under the
///     concurrent polling of a long battery the beat silently stops being
///     refreshed, and a healthy server looks stale and is declared dead.
///
/// So: rename (atomic for readers) with a few retries to ride out the moment a
/// reader is holding the file, and a direct write as the last resort, because a
/// beat that is briefly torn is recoverable by a re-reading client while a beat
/// that never lands is not.
fn write_heartbeat(dir: &str, ready: &str) {
    let tmp = format!("{}\\server.ready.tmp", dir);
    let dst = format!("{}\\server.ready", dir);
    if std::fs::write(&tmp, ready).is_ok() {
        for _ in 0..8 {
            if std::fs::rename(&tmp, &dst).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let _ = std::fs::remove_file(&tmp);
    }
    let _ = std::fs::write(&dst, ready);
}

fn cmd_deelevate(args: &[String]) -> ! {
    let mut argv: Vec<String> = vec![];
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--" {
            argv = args[i + 1..].to_vec();
            break;
        }
        i += 1;
    }
    if argv.is_empty() {
        fail("args", "nothing to run: pass the program after --", 0);
    }
    let o = base("deelevate");
    let token = match linked_token() {
        Ok(t) => t,
        Err((stage, code)) => emit(
            o.bool("ok", false)
                .str("stage", stage)
                .str("error", "could not obtain a standard-user primary token (already non-elevated, UAC off, or the duplicate was denied)")
                .num("errorCode", code as i64),
        ),
    };
    let exe = wide(&argv[0]);
    let mut cmd = wide(&cmdline::build_command_line(&argv));
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            exe.as_ptr(),
            cmd.as_mut_ptr(),
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        )
    };
    let err = unsafe { GetLastError() };
    if ok == 0 {
        unsafe { CloseHandle(token) };
        emit(o.bool("ok", false).str("stage", "CreateProcessWithTokenW").str("error", "could not launch with the linked token").num("errorCode", err as i64));
    }
    unsafe { WaitForSingleObject(pi.hProcess, INFINITE) };
    let mut code: DWORD = 0;
    unsafe {
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(token);
    }
    emit(o.bool("ok", true).num("childExitCode", code as i64))
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // `--out <path>` is global: it is how a de-elevated child returns its result
    // when it cannot inherit a pipe. Stripped before subcommand parsing.
    //
    // ONLY BEFORE `--`. Everything after the separator belongs to the program
    // being launched. The first version scanned the whole vector, so a parent
    // running `deelevate -- <self> --out result.json probe` consumed the CHILD's
    // flag and wrote its own result to the child's file — a harness that reports
    // the elevated parent's answer while looking exactly like the child's.
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    if let Some(p) = args[..end].iter().position(|a| a == "--out") {
        if let Some(path) = args.get(p + 1).cloned() {
            *OUT_PATH.lock().unwrap() = Some(path);
            args.drain(p..=p + 1);
        } else {
            fail("args", "--out needs a path", 0);
        }
    }
    // `--args-file <path>`: the rest of the argv, one argument per line.
    //
    // This exists for the DE-ELEVATION HARNESS. Reaching a non-elevated context
    // on this machine goes through a tiny `.cmd` launched by explorer, and
    // cmd.exe applies its OWN parsing to `&`, `|`, `^` and `%`. Putting the
    // arguments in a file means the .cmd contains nothing but fixed paths, so an
    // adversarial test command cannot be re-interpreted by the vehicle that
    // carries it. Arguments therefore stay separated end to end.
    //
    // Limitation, stated rather than discovered: an argument containing a
    // newline cannot be expressed this way. None of the measurements need one.
    if let Some(p) = args.iter().position(|a| a == "--args-file") {
        let path = match args.get(p + 1) {
            Some(v) => v.clone(),
            None => fail("args", "--args-file needs a path", 0),
        };
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(e) => fail("args", &format!("could not read --args-file: {}", e), 0),
        };
        let extra: Vec<String> = body.lines().map(|l| l.trim_end_matches('\r').to_string()).collect();
        args.drain(p..=p + 1);
        args.extend(extra);
    }
    match args.first().map(|s| s.as_str()) {
        Some("probe") => cmd_probe(),
        Some("deelevate") => cmd_deelevate(&args[1..]),
        Some("serve") => cmd_serve(&args[1..]),
        Some(c @ ("inspect-profile" | "ensure-profile")) => {
            let name = opt(&args, "--name");
            if !cmdline::is_valid_profile_name(&name) {
                fail("args", "--name must be 1..=64 chars of [A-Za-z0-9._-]", 0);
            }
            let o = base(c);
            emit(if c == "inspect-profile" { ops::inspect_profile(o, &name) } else { ops::ensure_profile(o, &name) })
        }
        Some("inspect-acl") => {
            let path = opt(&args, "--path");
            if path.is_empty() {
                fail("args", "--path is required", 0);
            }
            emit(ops::inspect_acl(base("inspect-acl"), &path))
        }
        Some("grant-acl") => {
            let path = opt(&args, "--path");
            let sid = opt(&args, "--sid");
            // CL-16A3-B2 §3. A `+`-separated list of NAMED rights, each one a
            // single documented Win32 mask, so a grant states exactly what it
            // needs — `traverse` alone for an ancestor, `read_file` without
            // `list_directory` for fixtures. Still no numeric mask from a
            // caller, so Full Control remains unexpressible.
            let spec = opt(&args, "--rights");
            let spec = if spec.is_empty() { "rx".to_string() } else { spec };
            let rights = match acl::parse_rights(&spec) {
                Some(m) => m,
                None => fail(
                    "args",
                    &format!(
                        "--rights must be a '+'-separated list of: traverse, read_attributes, read_file, execute, list_directory, create_file, create_directory, write_file, append, delete, delete_child (or the legacy rx|modify); got {}",
                        spec
                    ),
                    0,
                ),
            };
            if path.is_empty() || !sid.starts_with("S-1-15-2-") {
                fail("args", "--path is required and --sid must be an AppContainer SID (S-1-15-2-...)", 0);
            }
            // CL-16A3-B2A §1: an explicit ACE TARGET. Defaults preserve the old
            // behaviour so existing callers are unchanged.
            let target = opt(&args, "--target");
            let inherit = if target.is_empty() {
                if args.iter().any(|a| a == "--no-inherit") { acl::NO_INHERITANCE } else { acl::SUB_CONTAINERS_AND_OBJECTS_INHERIT }
            } else {
                match acl::target_flags(&target) {
                    Some(f) => f,
                    None => fail("args", &format!("--target must be one of object_self, self_and_descendants, child_files, child_directories, descendants, immediate_children; got {}", target), 0),
                }
            };
            emit(ops::grant_acl_targeted(base("grant-acl"), &path, &sid, rights, inherit))
        }
        Some("known-folder") => {
            let id = opt(&args, "--id");
            emit(root::known_folder(base("known-folder"), if id.is_empty() { "ProgramData" } else { &id }))
        }
        Some("inspect-dir") => {
            let path = opt(&args, "--path");
            if path.is_empty() { fail("args", "--path is required", 0); }
            emit(root::inspect_dir_cmd(base("inspect-dir"), &path))
        }
        Some("create-dir") => {
            let path = opt(&args, "--path");
            if path.is_empty() { fail("args", "--path is required", 0); }
            emit(root::create_dir(base("create-dir"), &path))
        }
        Some("protect-dir") => {
            let path = opt(&args, "--path");
            let owner = opt(&args, "--owner-sid");
            let dacl = opt(&args, "--dacl-sddl");
            if path.is_empty() || owner.is_empty() || dacl.is_empty() {
                fail("args", "--path, --owner-sid and --dacl-sddl are required", 0);
            }
            emit(root::protect_dir(base("protect-dir"), &path, &owner, &dacl))
        }
        Some("publish-dir") => {
            let from = opt(&args, "--from");
            let to = opt(&args, "--to");
            if from.is_empty() || to.is_empty() {
                fail("args", "--from and --to are required", 0);
            }
            emit(root::publish_dir(base("publish-dir"), &from, &to))
        }
        Some("access-probe") => {
            // The NATIVE canary. One documented Win32 call per op, reporting
            // success and GetLastError — never file content.
            let op = opt(&args, "--op");
            let path = opt(&args, "--path");
            let cwd = opt(&args, "--probe-cwd");
            if op.is_empty() || path.is_empty() {
                fail("args", "--op and --path are required", 0);
            }
            emit(probe::access_probe(base("access-probe"), &op, &path, &cwd))
        }
        Some("restore-acl") => {
            let path = opt(&args, "--path");
            let sid = opt(&args, "--sid");
            let expected = opt(&args, "--expect-granted-sddl");
            let original = opt(&args, "--original-sddl");
            if path.is_empty() || !sid.starts_with("S-1-15-2-") || original.is_empty() {
                fail("args", "--path, an AppContainer --sid and --original-sddl are required", 0);
            }
            emit(ops::restore_acl(base("restore-acl"), &path, &sid, &expected, &original))
        }
        Some("inspect-process") => {
            let pid: DWORD = opt(&args, "--pid").parse().unwrap_or(0);
            let start = opt(&args, "--expect-start").parse::<u64>().ok();
            if pid == 0 {
                fail("args", "--pid is required", 0);
            }
            emit(ops::inspect_process(base("inspect-process"), pid, start))
        }
        // CL-16A3 MEGA-1: measure executable accessibility WITHOUT running the
        // image. Same machinery as `run`, but the primary thread is never
        // resumed and the process is terminated from a suspended state.
        Some("probe-exec-access") => {
            let mut a: Vec<String> = args[1..].to_vec();
            let at = a.iter().position(|x| x == "--").unwrap_or(a.len());
            a.insert(at, "--probe-only".into());
            cmd_run(&a)
        }
        // P5c. Reach an ORPHANED run's whole process tree through the named job
        // its launch recorded, and prove the tree ended.
        Some("terminate-process-tree") => cmd_terminate_tree(&args[1..]),
        // P5c2. The TRUSTED PER-RUN KEEPER. Never invoked by a client: the
        // launch path spawns it, and the handles it needs arrive by inheritance
        // through an explicit handle list, not by name. Running it by hand gets
        // a refusal from `prove_job_handle`, because the numbers on the command
        // line address nothing in a process that inherited nothing.
        Some("job-keeper") => {
            let a = &args[1..];
            let handle_of = |flag: &str| -> HANDLE {
                let v = opt(a, flag);
                match v.parse::<usize>() {
                    Ok(n) => n as HANDLE,
                    Err(_) => fail("args", &format!("{} must be an inherited handle value", flag), 0),
                }
            };
            let fencing = match opt(a, "--fencing-token").parse::<u64>() {
                Ok(v) => v,
                Err(_) => fail("args", "--fencing-token must be a non-negative integer", 0),
            };
            let session = match opt(a, "--expect-session-id").parse::<DWORD>() {
                Ok(v) => v,
                Err(_) => fail("args", "--expect-session-id is required", 0),
            };
            let host_pid = match opt(a, "--host-pid").parse::<DWORD>() {
                Ok(v) => v,
                Err(_) => fail("args", "--host-pid is required", 0),
            };
            let host_start = match opt(a, "--host-start").parse::<u64>() {
                Ok(v) => v,
                Err(_) => fail("args", "--host-start is required", 0),
            };
            keeper::run(keeper::KeeperArgs {
                job_handle: handle_of("--job-handle"),
                arm_handle: handle_of("--arm-handle"),
                shutdown_handle: handle_of("--shutdown-handle"),
                command_handle: handle_of("--command-handle"),
                host_process: handle_of("--host-process-handle"),
                auth_nonce: opt(a, "--auth-nonce"),
                crash_at: {
                    let c = opt(a, "--crash-at");
                    if c.is_empty() { None } else { Some(c) }
                },
                job_name: opt(a, "--job-name"),
                run_id: opt(a, "--run-id"),
                operation_id: opt(a, "--operation-id"),
                fencing_token: fencing,
                expect_session_id: session,
                host_pid,
                host_start,
            })
        }
        Some("launch-in-profile") => {
            // Same machinery as `run`, but it owns NONE of the profile's life.
            // The flag is inserted BEFORE `--`; appended, it would become an
            // argument of the program being launched.
            let mut a: Vec<String> = args[1..].to_vec();
            let at = a.iter().position(|x| x == "--").unwrap_or(a.len());
            a.insert(at, "--no-manage-profile".into());
            cmd_run(&a)
        }
        // Identity on demand: protocol AND the binary's own hash, so a client
        // can confirm the process it is talking to is the file it verified.
        Some("version") => emit(base("version").bool("ok", true).str("binaryHash", &sha256::own_binary_hash())),
        Some(c @ ("derive-sid" | "create-profile" | "delete-profile")) => cmd_profile(c, &args[1..]),
        Some("run") => cmd_run(&args[1..]),
        _ => fail(
            "args",
            // THE WHOLE LIST. This advertised seven of the verbs while the match
            // handled twenty-two, so the one place an operator would look to
            // find out what exists was wrong about most of it.
            "usage: abdo-winiso [--out <path>] <probe|version|deelevate|serve|inspect-profile|ensure-profile|derive-sid|create-profile|delete-profile|\
             inspect-acl|grant-acl|restore-acl|known-folder|inspect-dir|create-dir|protect-dir|publish-dir|access-probe|inspect-process|\
             probe-exec-access|launch-in-profile|terminate-process-tree|job-keeper|run> [options] [-- program args...]",
            0,
        ),
    }
}
