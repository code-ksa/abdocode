//! CL-16A2-D §5 — the narrow, idempotent operations.
//!
//! CL-16A2-C's `run` did everything at once: create the profile, spawn, wait,
//! delete. That is unrecoverable by construction — a crash anywhere inside it
//! leaves the host with no idea which of the four things happened. So the
//! stages are separated, and each one:
//!
//!   - takes separated argv and never a shell string,
//!   - is SAFE TO REPEAT (running it twice reaches the same state),
//!   - returns the OBSERVED OS STATE, not merely `success`,
//!   - refuses to delete a resource that does not carry Abdo's ownership marker.
//!
//! "Returns observed state" is the load-bearing one. A host that trusts
//! `{ok:true}` has to write its journal from an intention; a host that receives
//! `{profileExists:true, sid:...}` writes it from a fact.
#![allow(non_snake_case)]

use crate::acl;
use crate::json;
use crate::win::*;

/// Abdo's ownership marker. A resource whose name does not start with this is
/// NOT ours and is never deleted, whatever the journal says.
pub const OWNERSHIP_PREFIX: &str = "abdo-winiso-";

pub fn is_owned(name: &str) -> bool {
    name.starts_with(OWNERSHIP_PREFIX)
}

/// The AppContainer package directory — the observable trace of a profile.
pub fn package_dir(name: &str) -> String {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    format!("{}\\Packages\\{}", local, name)
}

fn sid_of(name: &str) -> (Option<String>, i32) {
    let w = wide(name);
    let mut sid: PSID = std::ptr::null_mut();
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(w.as_ptr(), &mut sid) };
    if hr < 0 {
        return (None, hr);
    }
    let s = sid_to_string(sid);
    if !sid.is_null() {
        unsafe { FreeSid(sid) };
    }
    (Some(s), hr)
}

/// OBSERVE a profile. No side effects at all — this is what recovery calls
/// before it decides anything.
pub fn inspect_profile(o: json::Obj, name: &str) -> json::Obj {
    let (sid, hr) = sid_of(name);
    let dir = package_dir(name);
    o.str("appContainerName", name)
        .bool("owned", is_owned(name))
        .bool("profileExists", std::path::Path::new(&dir).exists())
        .str("packageDir", &dir)
        .str("sid", sid.as_deref().unwrap_or(""))
        .num("deriveHresult", hr as i64)
        .bool("ok", hr >= 0)
}

/// Create the profile if it is not there. Repeating this is a no-op that still
/// reports the truth, which is what makes retry-after-crash safe.
pub fn ensure_profile(o: json::Obj, name: &str) -> json::Obj {
    if !is_owned(name) {
        return o.bool("ok", false).str("error", "refusing to create a profile without Abdo's ownership prefix").str("stage", "ownership");
    }
    let w = wide(name);
    let wdisp = wide(name);
    let wdesc = wide("Abdo CL-16A2-D managed container");
    let mut sid: PSID = std::ptr::null_mut();
    let hr = unsafe { CreateAppContainerProfile(w.as_ptr(), wdisp.as_ptr(), wdesc.as_ptr(), std::ptr::null_mut(), 0, &mut sid) };
    let existed = hr == HRESULT_ALREADY_EXISTS;
    if existed || hr < 0 {
        if !sid.is_null() {
            unsafe { FreeSid(sid) };
            sid = std::ptr::null_mut();
        }
    }
    let (derived, dhr) = sid_of(name);
    if !sid.is_null() {
        unsafe { FreeSid(sid) };
    }
    let dir = package_dir(name);
    o.str("appContainerName", name)
        .bool("owned", true)
        .num("createHresult", hr as i64)
        .bool("created", hr >= 0)
        .bool("existed", existed)
        .str("sid", derived.as_deref().unwrap_or(""))
        .num("deriveHresult", dhr as i64)
        .bool("profileExists", std::path::Path::new(&dir).exists())
        .bool("ok", hr >= 0 || existed)
}

/// Delete a profile. IDEMPOTENT: "already gone" is success, per §6.
pub fn delete_profile(o: json::Obj, name: &str) -> json::Obj {
    if !is_owned(name) {
        return o
            .str("appContainerName", name)
            .bool("ok", false)
            .str("stage", "ownership")
            .str("error", "refusing to delete a profile that does not carry Abdo's ownership prefix");
    }
    let dir = package_dir(name);
    let existed_before = std::path::Path::new(&dir).exists();
    let w = wide(name);
    let hr = unsafe { DeleteAppContainerProfile(w.as_ptr()) };
    let still = std::path::Path::new(&dir).exists();
    // The OS is asked, then OBSERVED. A delete that returned success while the
    // directory survived would be a lie the journal would then record.
    o.str("appContainerName", name)
        .bool("owned", true)
        .bool("existedBefore", existed_before)
        .num("hresult", hr as i64)
        .bool("profileExists", still)
        .bool("ok", !still)
}

pub fn inspect_acl(o: json::Obj, path: &str) -> json::Obj {
    let exists = std::path::Path::new(path).exists();
    let identity = acl::file_identity(path);
    match acl::read_dacl_sddl(path) {
        Ok(sddl) => o
            .str("path", path)
            .bool("exists", exists)
            .str("fileIdentity", identity.as_deref().unwrap_or(""))
            .str("sddl", &sddl)
            .bool("ok", true),
        Err(e) => o
            .str("path", path)
            .bool("exists", exists)
            .str("fileIdentity", identity.as_deref().unwrap_or(""))
            .str("sddl", "")
            .num("errorCode", e as i64)
            .str("stage", "GetNamedSecurityInfoW")
            .bool("ok", false),
    }
}

/// Grant read+execute (or modify) to one SID on one path. Idempotent: granting
/// twice leaves one ACE, and the reported `before`/`after` SDDL say so.
pub fn grant_acl_targeted(o: json::Obj, path: &str, sid: &str, rights: DWORD, inherit_flags: DWORD) -> json::Obj {
    let identity = acl::file_identity(path);
    let before = match acl::read_dacl_sddl(path) {
        Ok(s) => s,
        Err(e) => return o.str("path", path).bool("ok", false).str("stage", "read-before").num("errorCode", e as i64),
    };
    let already = acl::sddl_mentions_sid(&before, sid);
    if let Err(e) = acl::grant_targeted(path, sid, rights, inherit_flags) {
        return o.str("path", path).str("sid", sid).str("sddlBefore", &before).bool("ok", false).str("stage", "grant").num("errorCode", e as i64);
    }
    let after = acl::read_dacl_sddl(path).unwrap_or_default();
    let is_dir = std::path::Path::new(path).is_dir();
    o.str("path", path)
        .str("sid", sid)
        .str("fileIdentity", identity.as_deref().unwrap_or(""))
        .str("objectType", if is_dir { "directory" } else { "file" })
        .str("sddlBefore", &before)
        .str("sddlAfter", &after)
        .str("grantedMask", &format!("0x{:08X}", rights))
        .str("inheritFlags", &format!("0x{:02X}", inherit_flags))
        .bool("alreadyPresentBefore", already)
        .bool("sidPresentAfter", acl::sddl_mentions_sid(&after, sid))
        .bool("ok", acl::sddl_mentions_sid(&after, sid))
}

pub fn grant_acl(o: json::Obj, path: &str, sid: &str, rights: DWORD, inheritable: bool) -> json::Obj {
    let identity = acl::file_identity(path);
    let before = match acl::read_dacl_sddl(path) {
        Ok(s) => s,
        Err(e) => return o.str("path", path).bool("ok", false).str("stage", "read-before").num("errorCode", e as i64),
    };
    let already = acl::sddl_mentions_sid(&before, sid);
    if let Err(e) = acl::grant(path, sid, rights, inheritable) {
        return o
            .str("path", path)
            .str("sid", sid)
            .str("sddlBefore", &before)
            .bool("ok", false)
            .str("stage", "grant")
            .num("errorCode", e as i64);
    }
    let after = acl::read_dacl_sddl(path).unwrap_or_default();
    o.str("path", path)
        .str("sid", sid)
        .str("fileIdentity", identity.as_deref().unwrap_or(""))
        .str("sddlBefore", &before)
        .str("sddlAfter", &after)
        // CL-16A3-B2 sec 3: report the EXACT mask that was applied, so a grant is
        // auditable as a number rather than as a level name, and a plan can be
        // compared against what the OS actually received.
        .str("grantedMask", &format!("0x{:08X}", rights))
        .bool("alreadyPresentBefore", already)
        .bool("sidPresentAfter", acl::sddl_mentions_sid(&after, sid))
        .bool("ok", acl::sddl_mentions_sid(&after, sid))
}

/// §7's restore. **It removes Abdo's ACE. It never writes a remembered
/// descriptor back.**
///
/// The first version had two modes: put the original DACL back when the current
/// one still matched what we granted, and otherwise revoke just our ACE. That
/// was MEASURED to destroy a concurrent run's access — two runs granting the
/// same directory, the second one captured its "original" before the first one's
/// ACE landed, finished first, and restoring that original deleted the first
/// run's grant while it was still using it.
///
/// Removing only our own ACE has the same result when nothing else changed
/// (the descriptor returns to the original, and that is asserted, not assumed)
/// and is correct when something did. There is no case where the blind restore
/// was better, so it is gone rather than guarded.
///
/// `expected_granted` is now EVIDENCE, not a branch: the report says whether the
/// descriptor still matched what this run left, which is what the journal wants
/// to know. Three outcomes: already absent, removed, or removal unproven — and
/// the third is what makes the host say `manual_intervention_required` instead
/// of pretending.
pub fn restore_acl(o: json::Obj, path: &str, sid: &str, expected_granted: &str, original: &str) -> json::Obj {
    let identity = acl::file_identity(path);
    let current = match acl::read_dacl_sddl(path) {
        Ok(s) => s,
        Err(e) => {
            // The path is gone. Nothing to restore, and nothing was left behind.
            let missing = !std::path::Path::new(path).exists();
            return o
                .str("path", path)
                .str("sid", sid)
                .bool("ok", missing)
                .str("mode", if missing { "path_absent" } else { "read_failed" })
                .num("errorCode", e as i64);
        }
    };
    let o = o.str("path", path).str("sid", sid).str("fileIdentity", identity.as_deref().unwrap_or("")).str("sddlCurrent", &current);

    let unchanged_since_grant = !expected_granted.is_empty() && current == expected_granted;
    let o = o.bool("descriptorUnchangedSinceGrant", unchanged_since_grant);

    if !acl::sddl_mentions_sid(&current, sid) {
        // Already clean. Repeating a restore must not be an error — recovery
        // runs at every startup and would otherwise report failures that are
        // actually successes.
        return o.bool("ok", true).str("mode", "already_absent").str("sddlAfter", &current).bool("matchesOriginal", current == original);
    }
    if let Err(e) = acl::revoke(path, sid) {
        return o.bool("ok", false).str("mode", "ace_removal_failed").num("errorCode", e as i64);
    }
    let after = acl::read_dacl_sddl(path).unwrap_or_default();
    let clean = !acl::sddl_mentions_sid(&after, sid);
    let matches_original = after == original;
    o.str("sddlAfter", &after)
        .bool("ok", clean)
        .bool("matchesOriginal", matches_original)
        // The descriptor differing from the original after our ACE is gone means
        // somebody else's change is still there — which is the desired outcome,
        // not a problem.
        .bool("externalChangePreserved", clean && !matches_original)
        .str("mode", if !clean { "ace_removal_unproven" } else if matches_original { "restored_to_original" } else { "ace_removed" })
}

/// Is a process still alive, and is it the one we started? A PID alone is not
/// an identity — Windows reuses them — so the creation time is compared too.
pub fn inspect_process(o: json::Obj, pid: DWORD, expect_start: Option<u64>) -> json::Obj {
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    const STILL_ACTIVE: DWORD = 259;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return o.num("pid", pid as i64).bool("alive", false).bool("ok", true).str("reason", "no_such_process");
        }
        let mut code: DWORD = 0;
        GetExitCodeProcess(h, &mut code);
        let mut c: [DWORD; 2] = [0, 0];
        let mut e: [DWORD; 2] = [0, 0];
        let mut k: [DWORD; 2] = [0, 0];
        let mut u: [DWORD; 2] = [0, 0];
        let got = GetProcessTimes(h, c.as_mut_ptr(), e.as_mut_ptr(), k.as_mut_ptr(), u.as_mut_ptr());
        CloseHandle(h);
        let start = if got != 0 { ((c[1] as u64) << 32) | c[0] as u64 } else { 0 };
        let alive = code == STILL_ACTIVE;
        let identity_ok = expect_start.map(|s| s == start).unwrap_or(true);
        o.num("pid", pid as i64)
            .bool("alive", alive && identity_ok)
            .bool("pidReused", alive && !identity_ok)
            // Decimal digits, not a JSON number: a FILETIME exceeds 2^53 and a
            // client that parses it as a number cannot ask about it again. See
            // the note at the other emit site in main.rs.
            .str("startTime", &start.to_string())
            .num("exitCode", code as i64)
            .bool("ok", true)
    }
}
