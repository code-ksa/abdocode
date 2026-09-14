//! CL-16A3-B2B-ROOT — Known Folder discovery, host identity, protected DACL.
//!
//! WHY NOT `%ProgramData%`. An environment variable is inherited, and anything
//! that inherits can be set by whoever launched us. The execution root is the
//! one directory whose location must not be attacker-influenced, so it is
//! resolved through `SHGetKnownFolderPath(FOLDERID_ProgramData)` — the same
//! source the OS itself uses — and then re-derived from a HANDLE rather than
//! from the string, so a reparse point in the path cannot redirect it silently.
#![allow(non_snake_case, non_upper_case_globals)]

use crate::json;
use crate::win::*;
use std::ffi::c_void;

const FILE_ATTRIBUTE_REPARSE_POINT: DWORD = 0x0000_0400;
const FILE_FLAG_BACKUP_SEMANTICS: DWORD = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: DWORD = 0x0020_0000;
const FILE_SHARE_ALL: DWORD = 0x0000_0007;
const OPEN_EXISTING: DWORD = 3;
const READ_CONTROL: DWORD = 0x0002_0000;
const VOLUME_NAME_GUID: DWORD = 0x2;

const OWNER_SECURITY_INFORMATION: DWORD = 0x0000_0001;
const DACL_SECURITY_INFORMATION: DWORD = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION: DWORD = 0x8000_0000;

/// `FOLDERID_ProgramData` = {62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}
#[repr(C)]
struct GUID {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
const FOLDERID_ProgramData: GUID = GUID {
    a: 0x62AB_5D82,
    b: 0xFDC1,
    c: 0x4DC3,
    d: [0xA9, 0xDD, 0x07, 0x0D, 0x1D, 0x49, 0x5D, 0x97],
};

#[repr(C)]
struct TOKEN_USER {
    Sid: PSID,
    Attributes: DWORD,
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetKnownFolderPath(rfid: *const GUID, flags: DWORD, token: HANDLE, out: *mut *mut u16) -> i32;
}
#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(p: *mut c_void);
}
#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(h: HANDLE, out: *mut u16, len: DWORD, flags: DWORD) -> DWORD;
    fn GetFileAttributesW(path: *const u16) -> DWORD;
    fn CreateDirectoryW(path: *const u16, sa: *mut c_void) -> BOOL;
}
#[link(name = "advapi32")]
extern "system" {
    fn SetNamedSecurityInfoW(
        name: *mut u16,
        obj_type: i32,
        info: DWORD,
        owner: PSID,
        group: PSID,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> DWORD;
}

fn from_wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0usize;
    unsafe {
        while *p.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }
}

/// The SID of the user this process runs as. The root is owned by it.
pub fn host_user_sid() -> Option<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut needed: DWORD = 0;
        GetTokenInformation(token, 1 /* TokenUser */, std::ptr::null_mut(), 0, &mut needed);
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(token, 1, buf.as_mut_ptr() as *mut c_void, needed, &mut needed);
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        Some(sid_to_string(tu.Sid))
    }
}

/// Everything observable about one directory, WITHOUT following reparse points.
struct DirFacts {
    exists: bool,
    is_dir: bool,
    reparse: bool,
    final_path: String,
    volume_serial: String,
    file_id: String,
    owner_sid: String,
    dacl: String,
}

fn inspect_dir(path: &str) -> DirFacts {
    let mut f = DirFacts {
        exists: false,
        is_dir: false,
        reparse: false,
        final_path: String::new(),
        volume_serial: String::new(),
        file_id: String::new(),
        owner_sid: String::new(),
        dacl: String::new(),
    };
    unsafe {
        let w = wide(path);
        let attrs = GetFileAttributesW(w.as_ptr());
        if attrs == 0xFFFF_FFFF {
            return f;
        }
        f.exists = true;
        f.is_dir = attrs & 0x10 != 0;
        f.reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;

        // OPEN_REPARSE_POINT: identity of the LINK itself, not of its target.
        let h = crate::acl::CreateFileW(
            w.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_ALL,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        );
        if h != INVALID_HANDLE_VALUE {
            let mut info: crate::acl::BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if crate::acl::GetFileInformationByHandle(h, &mut info) != 0 {
                f.volume_serial = format!("{:08x}", info.dwVolumeSerialNumber);
                f.file_id = format!("{:08x}{:08x}", info.nFileIndexHigh, info.nFileIndexLow);
            }
            let mut buf = vec![0u16; 32768];
            let n = GetFinalPathNameByHandleW(h, buf.as_mut_ptr(), buf.len() as DWORD, VOLUME_NAME_GUID);
            if n > 0 && (n as usize) < buf.len() {
                f.final_path = String::from_utf16_lossy(&buf[..n as usize]);
            }
            CloseHandle(h);
        }
        f.owner_sid = read_owner_sid(path).unwrap_or_default();
        f.dacl = crate::acl::read_dacl_sddl(path).unwrap_or_default();
    }
    f
}

fn read_owner_sid(path: &str) -> Option<String> {
    unsafe {
        let w = wide(path);
        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut owner: PSID = std::ptr::null_mut();
        let rc = crate::acl::GetNamedSecurityInfoW(
            w.as_ptr(),
            crate::acl::SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != crate::acl::ERROR_SUCCESS || owner.is_null() {
            return None;
        }
        let s = sid_to_string(owner);
        LocalFree(sd);
        Some(s)
    }
}

fn facts_into(o: json::Obj, prefix: &str, f: &DirFacts) -> json::Obj {
    o.bool(&format!("{}Exists", prefix), f.exists)
        .bool(&format!("{}IsDirectory", prefix), f.is_dir)
        .bool(&format!("{}IsReparsePoint", prefix), f.reparse)
        .str(&format!("{}FinalPath", prefix), &f.final_path)
        .str(&format!("{}VolumeSerial", prefix), &f.volume_serial)
        .str(&format!("{}FileId", prefix), &f.file_id)
        .str(&format!("{}OwnerSid", prefix), &f.owner_sid)
        .str(&format!("{}Dacl", prefix), &f.dacl)
}

/// Resolve ProgramData through the Known Folder API and report what it is.
pub fn known_folder(o: json::Obj, id: &str) -> json::Obj {
    if id != "ProgramData" {
        return o.bool("ok", false).str("stage", "args").str("error", "only ProgramData is supported");
    }
    unsafe {
        let mut out: *mut u16 = std::ptr::null_mut();
        let hr = SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut out);
        if hr < 0 || out.is_null() {
            return o.bool("ok", false).str("stage", "SHGetKnownFolderPath").num("hresult", hr as i64);
        }
        let lexical = from_wide(out);
        CoTaskMemFree(out as *mut c_void);
        let f = inspect_dir(&lexical);
        facts_into(o.str("knownFolderId", "FOLDERID_ProgramData").str("sourceApi", "SHGetKnownFolderPath").str("lexicalPath", &lexical), "path", &f)
            .str("hostUserSid", &host_user_sid().unwrap_or_default())
            .bool("ok", f.exists && f.is_dir && !f.reparse)
    }
}

/// Inspect any directory with the same evidence shape. Used for ancestors.
pub fn inspect_dir_cmd(o: json::Obj, path: &str) -> json::Obj {
    let f = inspect_dir(path);
    facts_into(o.str("lexicalPath", path), "path", &f).bool("ok", f.exists)
}

/// Create a directory. `alreadyExisted` is reported, never treated as failure.
pub fn create_dir(o: json::Obj, path: &str) -> json::Obj {
    unsafe {
        let w = wide(path);
        let created = CreateDirectoryW(w.as_ptr(), std::ptr::null_mut()) != 0;
        let err = if created { 0 } else { GetLastError() };
        // 183 = ERROR_ALREADY_EXISTS. A concurrent creator is normal, not an error.
        let already = err == 183;
        let f = inspect_dir(path);
        facts_into(o.str("lexicalPath", path).bool("created", created).bool("alreadyExisted", already).num("errorCode", err as i64), "path", &f)
            .bool("ok", (created || already) && f.exists && f.is_dir && !f.reparse)
    }
}

/// Apply a PROTECTED DACL and set the owner. Inheritance from the parent is
/// severed, so `ProgramData`'s own ACEs do not leak into the root.
///
/// The DACL is supplied as SDDL built by the HOST from the rights matrix; this
/// function neither invents ACEs nor merges with what was there.
pub fn protect_dir(o: json::Obj, path: &str, owner_sid: &str, dacl_sddl: &str) -> json::Obj {
    unsafe {
        let owner = match crate::acl::sid_from_string(owner_sid) {
            Some(s) => s,
            None => return o.bool("ok", false).str("stage", "owner-sid").num("errorCode", GetLastError() as i64),
        };
        let mut sd: *mut c_void = std::ptr::null_mut();
        let wsddl = wide(dacl_sddl);
        if crate::acl::ConvertStringSecurityDescriptorToSecurityDescriptorW(wsddl.as_ptr(), crate::acl::SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            LocalFree(owner);
            return o.bool("ok", false).str("stage", "parse-sddl").num("errorCode", GetLastError() as i64);
        }
        let mut dacl: *mut c_void = std::ptr::null_mut();
        let mut present: BOOL = 0;
        let mut defaulted: BOOL = 0;
        if crate::acl::GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) == 0 || present == 0 {
            LocalFree(sd);
            LocalFree(owner);
            return o.bool("ok", false).str("stage", "extract-dacl").num("errorCode", GetLastError() as i64);
        }
        let mut wpath = wide(path);
        let rc = SetNamedSecurityInfoW(
            wpath.as_mut_ptr(),
            crate::acl::SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        );
        LocalFree(sd);
        LocalFree(owner);
        if rc != crate::acl::ERROR_SUCCESS {
            return o.bool("ok", false).str("stage", "SetNamedSecurityInfoW").num("errorCode", rc as i64);
        }
        // OBSERVE the result. A return code is not evidence.
        let f = inspect_dir(path);
        let protected = f.dacl.starts_with("D:P") || f.dacl.contains("D:PAI") || f.dacl.contains("D:P(");
        facts_into(o.str("lexicalPath", path).str("requestedOwner", owner_sid), "path", &f)
            .bool("protectedObserved", protected)
            .bool("ownerMatches", f.owner_sid.eq_ignore_ascii_case(owner_sid))
            .bool("ok", protected && f.owner_sid.eq_ignore_ascii_case(owner_sid))
    }
}

/// Publish a fully-prepared staging directory as the final root, ATOMICALLY.
///
/// `MoveFileExW` is called WITHOUT `MOVEFILE_REPLACE_EXISTING`. That is the whole
/// point: publication must FAIL if the final path already exists, so a root
/// somebody else published — or planted — is never silently replaced. It is also
/// why the final path never exists in a half-protected state: it comes into being
/// already owned, already protected and already carrying its marker.
///
/// `MOVEFILE_COPY_ALLOWED` is deliberately NOT passed either. A cross-volume move
/// would degrade into copy-then-delete, which is not atomic and would expose a
/// partial root; the host keeps staging on the same volume, and if that ever
/// stops being true this call must fail rather than quietly do the slow thing.
pub fn publish_dir(o: json::Obj, from: &str, to: &str) -> json::Obj {
    unsafe {
        let wf = wide(from);
        let wt = wide(to);
        let moved = MoveFileExW(wf.as_ptr(), wt.as_ptr(), 0) != 0;
        let err = if moved { 0 } else { GetLastError() };
        // 183 ERROR_ALREADY_EXISTS / 5 ERROR_ACCESS_DENIED are what a taken final
        // path looks like. Reported distinctly so the host can tell "somebody won
        // the race" from "we cannot write here at all".
        let target_taken = err == 183 || err == 5;
        let f = inspect_dir(to);
        facts_into(o.str("from", from).str("to", to).bool("moved", moved).bool("targetTaken", target_taken).num("errorCode", err as i64), "path", &f)
            .bool("sourceStillExists", inspect_dir(from).exists)
            .bool("ok", moved)
    }
}
