//! CL-16A2-D — ACL and file-identity primitives.
//!
//! `icacls` was measured to work in CL-16A2-C, but it is the wrong tool for a
//! journal: its output is prose, and "restore" through it is a blind overwrite.
//! §7 forbids exactly that. These use the Win32 security APIs directly so the
//! DACL can be captured as SDDL, compared EXACTLY, and modified by REVOKING ONE
//! ACE rather than replacing the whole descriptor.
//!
//! SCOPE, stated so it is not overclaimed: only the DACL is read, hashed and
//! restored. Owner, group and SACL are neither read nor written, because nothing
//! here modifies them — capturing them would imply a guarantee this code does
//! not provide.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code)]

use crate::win::*;
use std::ffi::c_void;

pub const SE_FILE_OBJECT: i32 = 1;
pub const DACL_SECURITY_INFORMATION: DWORD = 0x0000_0004;
pub const SDDL_REVISION_1: DWORD = 1;

pub const GRANT_ACCESS: i32 = 1;
pub const REVOKE_ACCESS: i32 = 4;
pub const TRUSTEE_IS_SID: i32 = 0;
pub const TRUSTEE_IS_UNKNOWN: i32 = 0;
pub const NO_MULTIPLE_TRUSTEE: i32 = 0;
pub const SUB_CONTAINERS_AND_OBJECTS_INHERIT: DWORD = 3;
pub const NO_INHERITANCE: DWORD = 0;

// ───────────── CL-16A3-B2A §1: an ACE has a TARGET, not just a mask.
//
// The previous grant always used OBJECT|CONTAINER inherit, so "this directory
// only" and "children only" were not expressible at all — and several confusing
// results came from an ACE landing somewhere other than where it was meant.
pub const OBJECT_INHERIT_ACE: DWORD = 0x1;
pub const CONTAINER_INHERIT_ACE: DWORD = 0x2;
pub const NO_PROPAGATE_INHERIT_ACE: DWORD = 0x4;
pub const INHERIT_ONLY_ACE: DWORD = 0x8;

/// Map a named TARGET to its inheritance flags.
///
/// `object_self` is the important one: an ACE with NO inheritance flags applies
/// to the object it is set on and to nothing else, which is what an ancestor
/// that must only be walked through needs.
pub fn target_flags(target: &str) -> Option<DWORD> {
    Some(match target {
        "object_self" => NO_INHERITANCE,
        "self_and_descendants" => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        "child_files" => OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE,
        "child_directories" => CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE,
        "descendants" => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE,
        "immediate_children" => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE,
        _ => return None,
    })
}

/// `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`. Read and traverse — never
/// Full Control, because a scoped grant that hands over write and DACL-change
/// rights is not a scoped grant.
pub const RIGHTS_READ_EXECUTE: DWORD = 0x0012_00A9;
/// Read/execute plus write and delete, for a run that must produce output.
pub const RIGHTS_MODIFY: DWORD = 0x0013_01BF;

// ─────────────────────────── CL-16A3-B2 §3: one right, one documented mask.
//
// `rx | modify` was too coarse to express least privilege. Measured consequence:
// an ancestor that only needs to be WALKED THROUGH received full read+execute,
// and `fixtures` could not be made readable-but-not-listable, because both live
// inside one lumped constant.
//
// Each value below is a single documented Win32 file-access right, taken from
// the SDK headers rather than from a lumped GENERIC_*. They are combined by the
// CALLER, so a grant says exactly which rights it needs and nothing more.
//
// NOTE ON DIRECTORIES: several bits are reused with a different meaning for a
// directory than for a file. `FILE_READ_DATA` (0x1) is `FILE_LIST_DIRECTORY`,
// `FILE_WRITE_DATA` (0x2) is `FILE_ADD_FILE`, and `FILE_APPEND_DATA` (0x4) is
// `FILE_ADD_SUBDIRECTORY`. That aliasing is exactly why "traverse" cannot be
// approximated by a read mask: traverse is its OWN bit, 0x20.
pub const FILE_READ_DATA_OR_LIST: DWORD = 0x0001;
pub const FILE_WRITE_DATA_OR_ADD_FILE: DWORD = 0x0002;
pub const FILE_APPEND_OR_ADD_SUBDIR: DWORD = 0x0004;
pub const FILE_READ_EA: DWORD = 0x0008;
pub const FILE_WRITE_EA: DWORD = 0x0010;
/// `FILE_EXECUTE` on a file; `FILE_TRAVERSE` on a directory. The same bit.
pub const FILE_EXECUTE_OR_TRAVERSE: DWORD = 0x0020;
pub const FILE_DELETE_CHILD: DWORD = 0x0040;
pub const FILE_READ_ATTRIBUTES_RIGHT: DWORD = 0x0080;
pub const FILE_WRITE_ATTRIBUTES: DWORD = 0x0100;
pub const RIGHT_DELETE: DWORD = 0x0001_0000;
pub const RIGHT_READ_CONTROL: DWORD = 0x0002_0000;
pub const RIGHT_SYNCHRONIZE: DWORD = 0x0010_0000;

/// Resolve ONE named right to its mask. Unknown names are rejected by the caller.
///
/// `SYNCHRONIZE` is folded into every right because a handle opened for
/// synchronous IO needs it; without it an otherwise-correct grant fails in a way
/// that looks like a policy error rather than a missing bit.
pub fn named_right(name: &str) -> Option<DWORD> {
    let m = match name {
        "traverse" => FILE_EXECUTE_OR_TRAVERSE | FILE_READ_ATTRIBUTES_RIGHT,
        "read_attributes" => FILE_READ_ATTRIBUTES_RIGHT,
        "read_file" => FILE_READ_DATA_OR_LIST | FILE_READ_EA | FILE_READ_ATTRIBUTES_RIGHT | RIGHT_READ_CONTROL,
        "execute" => FILE_EXECUTE_OR_TRAVERSE | FILE_READ_ATTRIBUTES_RIGHT | RIGHT_READ_CONTROL,
        "list_directory" => FILE_READ_DATA_OR_LIST | FILE_READ_ATTRIBUTES_RIGHT,
        "create_file" => FILE_WRITE_DATA_OR_ADD_FILE | FILE_READ_ATTRIBUTES_RIGHT,
        "create_directory" => FILE_APPEND_OR_ADD_SUBDIR | FILE_READ_ATTRIBUTES_RIGHT,
        "write_file" => FILE_WRITE_DATA_OR_ADD_FILE | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES,
        "append" => FILE_APPEND_OR_ADD_SUBDIR,
        "delete" => RIGHT_DELETE,
        "delete_child" => FILE_DELETE_CHILD,
        // Kept for compatibility with the two coarse levels, expressed as the
        // union of the named rights they stand for.
        "modify" => RIGHTS_MODIFY,
        "rx" => RIGHTS_READ_EXECUTE,
        _ => return None,
    };
    Some(m | RIGHT_SYNCHRONIZE)
}

/// Combine a `+`-separated list of named rights. Returns None on any unknown name.
///
/// There is deliberately NO numeric mask input: a caller cannot express
/// "everything", so Full Control is not reachable through this interface.
pub fn parse_rights(spec: &str) -> Option<DWORD> {
    let mut mask: DWORD = 0;
    for part in spec.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        mask |= named_right(p)?;
    }
    if mask == 0 { None } else { Some(mask) }
}

pub const ERROR_SUCCESS: DWORD = 0;
pub const ERROR_FILE_NOT_FOUND: DWORD = 2;
pub const ERROR_PATH_NOT_FOUND: DWORD = 3;

const FILE_READ_ATTRIBUTES: DWORD = 0x0080;
const FILE_SHARE_ALL: DWORD = 0x0000_0007;
const OPEN_EXISTING: DWORD = 3;
const FILE_FLAG_BACKUP_SEMANTICS: DWORD = 0x0200_0000;

#[repr(C)]
pub struct TRUSTEE_W {
    pub pMultipleTrustee: *mut c_void,
    pub MultipleTrusteeOperation: i32,
    pub TrusteeForm: i32,
    pub TrusteeType: i32,
    pub ptstrName: *mut u16,
}

#[repr(C)]
pub struct EXPLICIT_ACCESS_W {
    pub grfAccessPermissions: DWORD,
    pub grfAccessMode: i32,
    pub grfInheritance: DWORD,
    pub Trustee: TRUSTEE_W,
}

#[repr(C)]
pub struct BY_HANDLE_FILE_INFORMATION {
    pub dwFileAttributes: DWORD,
    pub ftCreationTime: [DWORD; 2],
    pub ftLastAccessTime: [DWORD; 2],
    pub ftLastWriteTime: [DWORD; 2],
    pub dwVolumeSerialNumber: DWORD,
    pub nFileSizeHigh: DWORD,
    pub nFileSizeLow: DWORD,
    pub nNumberOfLinks: DWORD,
    pub nFileIndexHigh: DWORD,
    pub nFileIndexLow: DWORD,
}

#[link(name = "advapi32")]
extern "system" {
    pub fn GetNamedSecurityInfoW(
        name: *const u16,
        objectType: i32,
        info: DWORD,
        owner: *mut PSID,
        group: *mut PSID,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        sd: *mut *mut c_void,
    ) -> DWORD;
    pub fn SetNamedSecurityInfoW(
        name: *mut u16,
        objectType: i32,
        info: DWORD,
        owner: PSID,
        group: PSID,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> DWORD;
    pub fn SetEntriesInAclW(count: DWORD, entries: *mut EXPLICIT_ACCESS_W, old: *mut c_void, new: *mut *mut c_void) -> DWORD;
    pub fn ConvertSecurityDescriptorToStringSecurityDescriptorW(sd: *mut c_void, revision: DWORD, info: DWORD, out: *mut *mut u16, len: *mut u32) -> BOOL;
    pub fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revision: DWORD, sd: *mut *mut c_void, size: *mut u32) -> BOOL;
    pub fn ConvertStringSidToSidW(sid: *const u16, out: *mut PSID) -> BOOL;
    pub fn GetSecurityDescriptorDacl(sd: *mut c_void, present: *mut BOOL, dacl: *mut *mut c_void, defaulted: *mut BOOL) -> BOOL;
    /// P5c. The HANDLE-based sibling of `GetNamedSecurityInfoW`, for a kernel
    /// object (a job) which has no path to name it by.
    pub fn GetSecurityInfo(
        handle: HANDLE,
        objectType: i32,
        info: DWORD,
        owner: *mut PSID,
        group: *mut PSID,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        sd: *mut *mut c_void,
    ) -> DWORD;
}

/// The owner + DACL of a KERNEL object, as SDDL.
///
/// Read back from the handle rather than trusted from what was requested,
/// because the descriptor the OS actually stores is the only one that decides
/// who may terminate this job. MEASURED ELSEWHERE IN THIS PACKAGE and it applies
/// here too: Windows rewrites a requested `D:P(...)` as `D:PAI(...)`, so the
/// caller compares this STRUCTURALLY and never as a string against its request.
pub fn read_kernel_object_sddl(handle: HANDLE) -> Result<String, DWORD> {
    unsafe {
        let info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION_;
        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut dacl: *mut c_void = std::ptr::null_mut();
        let rc = GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            info,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != ERROR_SUCCESS {
            return Err(rc);
        }
        let mut out: *mut u16 = std::ptr::null_mut();
        let mut len: u32 = 0;
        let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, info, &mut out, &mut len);
        let s = if ok != 0 { from_wide_ptr(out) } else { String::new() };
        if !out.is_null() {
            LocalFree(out as *mut c_void);
        }
        LocalFree(sd);
        if ok == 0 {
            return Err(GetLastError());
        }
        Ok(s)
    }
}

#[link(name = "kernel32")]
extern "system" {
    pub fn CreateFileW(
        name: *const u16,
        access: DWORD,
        share: DWORD,
        sa: *const SECURITY_ATTRIBUTES,
        disposition: DWORD,
        flags: DWORD,
        template: HANDLE,
    ) -> HANDLE;
    pub fn GetFileInformationByHandle(h: HANDLE, info: *mut BY_HANDLE_FILE_INFORMATION) -> BOOL;
}

/// `volumeSerial:fileIndex` — the identity §11 re-checks. A path can be
/// replaced by a junction pointing somewhere else while keeping its name; this
/// does not follow the name.
pub fn file_identity(path: &str) -> Option<String> {
    unsafe {
        let w = wide(path);
        let h = CreateFileW(
            w.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_ALL,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, // required to open a DIRECTORY handle
            std::ptr::null_mut(),
        );
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let ok = GetFileInformationByHandle(h, &mut info);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(format!(
            "{:08x}:{:08x}{:08x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}

/// The object's DACL as SDDL. `None` means it could not be read at all.
pub fn read_dacl_sddl(path: &str) -> Result<String, DWORD> {
    unsafe {
        let w = wide(path);
        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut dacl: *mut c_void = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != ERROR_SUCCESS {
            return Err(rc);
        }
        let mut out: *mut u16 = std::ptr::null_mut();
        let mut len: u32 = 0;
        let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut out, &mut len);
        let s = if ok != 0 { from_wide_ptr(out) } else { String::new() };
        if !out.is_null() {
            LocalFree(out as *mut c_void);
        }
        LocalFree(sd);
        if ok == 0 {
            return Err(GetLastError());
        }
        Ok(s)
    }
}

pub fn sid_from_string(s: &str) -> Option<PSID> {
    unsafe {
        let w = wide(s);
        let mut sid: PSID = std::ptr::null_mut();
        if ConvertStringSidToSidW(w.as_ptr(), &mut sid) == 0 {
            None
        } else {
            Some(sid)
        }
    }
}

/// Apply ONE explicit-access entry on top of the object's CURRENT DACL.
///
/// `SetEntriesInAclW` merges into the existing ACL, so an external ACE added
/// while a run is live survives a grant and survives the matching revoke. That
/// is the whole reason this is not "write the descriptor we remembered".
fn apply_entry(path: &str, sid_str: &str, rights: DWORD, mode: i32, inherit: DWORD) -> Result<(), DWORD> {
    unsafe {
        let sid = match sid_from_string(sid_str) {
            Some(s) => s,
            None => return Err(GetLastError()),
        };
        let w = wide(path);
        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut old_dacl: *mut c_void = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut old_dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != ERROR_SUCCESS {
            LocalFree(sid);
            return Err(rc);
        }
        let mut ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: rights,
            grfAccessMode: mode,
            grfInheritance: inherit,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut new_dacl: *mut c_void = std::ptr::null_mut();
        let rc2 = SetEntriesInAclW(1, &mut ea, old_dacl, &mut new_dacl);
        if rc2 != ERROR_SUCCESS {
            LocalFree(sd);
            LocalFree(sid);
            return Err(rc2);
        }
        let mut wm = wide(path);
        let rc3 = SetNamedSecurityInfoW(
            wm.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        );
        LocalFree(new_dacl);
        LocalFree(sd);
        LocalFree(sid);
        if rc3 != ERROR_SUCCESS {
            return Err(rc3);
        }
        Ok(())
    }
}

pub fn grant(path: &str, sid: &str, rights: DWORD, inheritable: bool) -> Result<(), DWORD> {
    apply_entry(path, sid, rights, GRANT_ACCESS, if inheritable { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { NO_INHERITANCE })
}

/// Grant with an EXPLICIT ACE target, so the caller says where the ACE applies.
pub fn grant_targeted(path: &str, sid: &str, rights: DWORD, inherit_flags: DWORD) -> Result<(), DWORD> {
    apply_entry(path, sid, rights, GRANT_ACCESS, inherit_flags)
}

/// Remove every ACE for this SID, leaving all others exactly as they are.
pub fn revoke(path: &str, sid: &str) -> Result<(), DWORD> {
    apply_entry(path, sid, 0, REVOKE_ACCESS, NO_INHERITANCE)
}

/// Overwrite the DACL with one parsed from SDDL.
///
/// **NOT USED BY THE RESTORE PATH, DELIBERATELY.** It was, and it was MEASURED
/// to destroy a concurrent run's grant: writing back a remembered descriptor
/// deletes every ACE added since it was remembered. `ops::restore_acl` removes
/// only Abdo's own ACE instead. This is kept because parsing SDDL back into a
/// descriptor is the one operation a future "reset a directory to a known
/// state" tool would need, and it is exercised by its own test — but a caller
/// reaching for it on a restore path is making the mistake this comment exists
/// to describe.
pub fn set_dacl_from_sddl(path: &str, sddl: &str) -> Result<(), DWORD> {
    unsafe {
        let w = wide(sddl);
        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut size: u32 = 0;
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(w.as_ptr(), SDDL_REVISION_1, &mut sd, &mut size) == 0 {
            return Err(GetLastError());
        }
        let mut present: BOOL = 0;
        let mut dacl: *mut c_void = std::ptr::null_mut();
        let mut defaulted: BOOL = 0;
        if GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) == 0 {
            let e = GetLastError();
            LocalFree(sd);
            return Err(e);
        }
        let mut wm = wide(path);
        let rc = SetNamedSecurityInfoW(
            wm.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        );
        LocalFree(sd);
        if rc != ERROR_SUCCESS {
            return Err(rc);
        }
        Ok(())
    }
}

/// Does the DACL mention this SID at all?
///
/// A substring test, and it is exact FOR THE SIDS THIS IS USED WITH. SDDL
/// abbreviates well-known SIDs — `S-1-5-32-545` comes back as `BU`, SYSTEM as
/// `SY` — so a substring test would MISS those. AppContainer SIDs
/// (`S-1-15-2-...`) have no abbreviation and are always spelled out in full,
/// and this is only ever asked about Abdo's own container SID. The callers that
/// pass anything else do not exist; if one is ever added, this stops being
/// correct and needs a real ACE walk.
pub fn sddl_mentions_sid(sddl: &str, sid: &str) -> bool {
    debug_assert!(sid.starts_with("S-1-15-2-"), "only AppContainer SIDs are safe to match by substring in SDDL");
    sddl.contains(sid)
}
