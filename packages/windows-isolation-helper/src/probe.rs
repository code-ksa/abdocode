//! CL-16A3-B2A §3 — the NATIVE access canary.
//!
//! WHY THIS EXISTS. The previous matrices used `cmd`'s `dir`, `type` and `del`
//! as evidence, and concluded that `list_directory` and `delete_child` "do not
//! work". That conclusion was not sound: `cmd` is a program with its own opening
//! sequence and its own idea of what it needs, so its failure says something
//! about `cmd`, not about the access mask. A right is proven by calling the Win32
//! API that uses it and reading `GetLastError`.
//!
//! Each operation performs ONE documented call and reports `success` plus the
//! raw error code. Nothing here reads file CONTENT into the result: the answer is
//! whether the operation was permitted, never what the bytes were.
#![allow(non_snake_case)]

use crate::acl;
use crate::json;
use crate::win::*;

const GENERIC_READ: DWORD = 0x8000_0000;
const GENERIC_WRITE: DWORD = 0x4000_0000;
const FILE_SHARE_ALL: DWORD = 0x0000_0007;
const CREATE_NEW: DWORD = 1;
const OPEN_EXISTING: DWORD = 3;
const FILE_FLAG_BACKUP_SEMANTICS: DWORD = 0x0200_0000;
const INVALID_FILE_ATTRIBUTES: DWORD = 0xFFFF_FFFF;

/// `WIN32_FIND_DATAW` is 592 bytes; only the header fields are read here, so the
/// tail is reserved as a byte array rather than transcribed field by field.
#[repr(C)]
struct WIN32_FIND_DATAW {
    dwFileAttributes: DWORD,
    ftCreationTime: [u32; 2],
    ftLastAccessTime: [u32; 2],
    ftLastWriteTime: [u32; 2],
    nFileSizeHigh: DWORD,
    nFileSizeLow: DWORD,
    dwReserved0: DWORD,
    dwReserved1: DWORD,
    cFileName: [u16; 260],
    cAlternateFileName: [u16; 14],
}

#[link(name = "kernel32")]
extern "system" {
    fn FindFirstFileW(name: *const u16, data: *mut WIN32_FIND_DATAW) -> HANDLE;
    fn FindNextFileW(h: HANDLE, data: *mut WIN32_FIND_DATAW) -> BOOL;
    fn FindClose(h: HANDLE) -> BOOL;
    fn WriteFile(h: HANDLE, buf: *const u8, len: DWORD, written: *mut DWORD, ov: *mut c_void) -> BOOL;
    fn CreateDirectoryW(path: *const u16, sa: *mut c_void) -> BOOL;
    fn DeleteFileW(path: *const u16) -> BOOL;
    fn RemoveDirectoryW(path: *const u16) -> BOOL;
    fn GetFileAttributesW(path: *const u16) -> DWORD;
    fn SetCurrentDirectoryW(path: *const u16) -> BOOL;
}

use std::ffi::c_void;

fn done(o: json::Obj, op: &str, path: &str, ok: bool, err: DWORD, extra: Option<(&str, i64)>) -> json::Obj {
    let o = o.str("op", op).str("target", path).bool("success", ok).num("lastError", err as i64).bool("ok", true);
    match extra {
        Some((k, v)) => o.num(k, v),
        None => o,
    }
}

/// Run one native access probe. `op` is a fixed name; no shell, no interpolation.
pub fn access_probe(o: json::Obj, op: &str, path: &str, cwd: &str) -> json::Obj {
    unsafe {
        // A relative probe must run FROM the directory, which is the only honest
        // way to show a child can use its own cwd: CreateProcess accepting a cwd
        // is the PARENT's right, not the child's.
        if !cwd.is_empty() {
            let w = wide(cwd);
            if SetCurrentDirectoryW(w.as_ptr()) == 0 {
                return done(o, op, path, false, GetLastError(), Some(("stage", 1)));
            }
        }
        let w = wide(path);
        match op {
            // Open for read. The right under test is FILE_READ_DATA on the file.
            "open_file_read" => {
                let h = acl::CreateFileW(w.as_ptr(), GENERIC_READ, FILE_SHARE_ALL, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
                if h == INVALID_HANDLE_VALUE {
                    return done(o, op, path, false, GetLastError(), None);
                }
                CloseHandle(h);
                done(o, op, path, true, 0, None)
            }
            // FILE_READ_ATTRIBUTES only — deliberately not a read of the data.
            "query_attributes" => {
                let a = GetFileAttributesW(w.as_ptr());
                if a == INVALID_FILE_ATTRIBUTES {
                    return done(o, op, path, false, GetLastError(), None);
                }
                done(o, op, path, true, 0, Some(("attributes", a as i64)))
            }
            // FILE_LIST_DIRECTORY on the directory. THE call `dir` ultimately makes.
            "enumerate_directory" => {
                let pattern = wide(&format!("{}\\*", path.trim_end_matches('\\')));
                let mut data: WIN32_FIND_DATAW = std::mem::zeroed();
                let h = FindFirstFileW(pattern.as_ptr(), &mut data);
                if h == INVALID_HANDLE_VALUE {
                    return done(o, op, path, false, GetLastError(), None);
                }
                let mut count: i64 = 1;
                while FindNextFileW(h, &mut data) != 0 {
                    count += 1;
                    if count > 4096 {
                        break;
                    }
                }
                FindClose(h);
                done(o, op, path, true, 0, Some(("entries", count)))
            }
            // FILE_ADD_FILE on the parent directory.
            "create_file" => {
                let h = acl::CreateFileW(w.as_ptr(), GENERIC_WRITE, FILE_SHARE_ALL, std::ptr::null(), CREATE_NEW, 0, std::ptr::null_mut());
                if h == INVALID_HANDLE_VALUE {
                    return done(o, op, path, false, GetLastError(), None);
                }
                CloseHandle(h);
                done(o, op, path, true, 0, None)
            }
            // FILE_WRITE_DATA on the file.
            "write_file" => {
                let h = acl::CreateFileW(w.as_ptr(), GENERIC_WRITE, FILE_SHARE_ALL, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
                if h == INVALID_HANDLE_VALUE {
                    return done(o, op, path, false, GetLastError(), None);
                }
                let bytes = b"abdo-probe";
                let mut written: DWORD = 0;
                let ok = WriteFile(h, bytes.as_ptr(), bytes.len() as DWORD, &mut written, std::ptr::null_mut()) != 0;
                let err = if ok { 0 } else { GetLastError() };
                CloseHandle(h);
                done(o, op, path, ok, err, Some(("written", written as i64)))
            }
            // FILE_ADD_SUBDIRECTORY on the parent.
            "create_directory" => {
                let ok = CreateDirectoryW(w.as_ptr(), std::ptr::null_mut()) != 0;
                let err = if ok { 0 } else { GetLastError() };
                done(o, op, path, ok, err, None)
            }
            // DELETE on the file, or FILE_DELETE_CHILD on its parent.
            "delete_file" => {
                let ok = DeleteFileW(w.as_ptr()) != 0;
                let err = if ok { 0 } else { GetLastError() };
                done(o, op, path, ok, err, None)
            }
            "delete_directory" => {
                let ok = RemoveDirectoryW(w.as_ptr()) != 0;
                let err = if ok { 0 } else { GetLastError() };
                done(o, op, path, ok, err, None)
            }
            // FILE_TRAVERSE along the chain: open the DIRECTORY itself.
            "open_directory" => {
                let h = acl::CreateFileW(w.as_ptr(), GENERIC_READ, FILE_SHARE_ALL, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, std::ptr::null_mut());
                if h == INVALID_HANDLE_VALUE {
                    return done(o, op, path, false, GetLastError(), None);
                }
                CloseHandle(h);
                done(o, op, path, true, 0, None)
            }
            other => o.bool("ok", false).str("stage", "args").str("error", &format!("unknown probe op {}", other)),
        }
    }
}
