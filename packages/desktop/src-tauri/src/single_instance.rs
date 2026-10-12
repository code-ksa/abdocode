//! 10-09 (measured on installed 4.0.111 through computer use): launching AbdoCode while it ran started a second process with its own
//! window ("No project", read-only) — two shells over one state directory, which the engine refuses ("state directory owned by a live
//! harness"). The default profile is single-instance: a named mutex per profile; a second launch brings the running window forward and
//! exits. Explicit profiles (`ABDO_DESKTOP_PROFILE`) are separate on purpose, so their mutex name carries the profile path.

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// The mutex name: one per profile. The default profile shares one name; an explicit profile hashes its path into the name.
    pub fn mutex_name(profile: Option<&std::ffi::OsStr>) -> String {
        match profile {
            None => "Local\\AbdoCodeDesktop.SingleInstance".to_string(),
            Some(path) => {
                let lower = path.to_string_lossy().to_lowercase();
                let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
                for byte in lower.bytes() { hash ^= u64::from(byte); hash = hash.wrapping_mul(0x0100_0000_01b3); }
                format!("Local\\AbdoCodeDesktop.SingleInstance.{hash:016x}")
            }
        }
    }

    /// True when another instance of this profile already holds the mutex. The handle is kept for the life of the process.
    pub fn another_instance_running() -> bool {
        let name = wide(&mutex_name(std::env::var_os("ABDO_DESKTOP_PROFILE").as_deref()));
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if handle.is_null() { return false; } // cannot tell: never block a launch on our own failure
            let exists = GetLastError() == ERROR_ALREADY_EXISTS;
            if exists { CloseHandle(handle); }
            exists
        }
    }

    fn image_of(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return None; }
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) != 0;
            CloseHandle(process);
            if ok { Some(String::from_utf16_lossy(&buffer[..size as usize])) } else { None }
        }
    }

    struct Search { own_pid: u32, own_image: String, visible: Option<HWND>, titled: Option<HWND> }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let search = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == search.own_pid { return 1; }
        let Some(image) = image_of(pid) else { return 1 };
        if !image.eq_ignore_ascii_case(&search.own_image) { return 1; }
        let mut title = [0u16; 128];
        let length = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let title = String::from_utf16_lossy(&title[..length.max(0) as usize]);
        if title != "AbdoCode" { return 1; }
        if IsWindowVisible(hwnd) != 0 { search.visible = Some(hwnd); return 0; }
        if search.titled.is_none() { search.titled = Some(hwnd); }
        1
    }

    /// Bring the running instance's main window forward (restoring it from the tray or a minimized state). True if one was found.
    pub fn focus_running_instance() -> bool {
        let own_image = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        let mut search = Search { own_pid: std::process::id(), own_image, visible: None, titled: None };
        unsafe {
            EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
            match search.visible.or(search.titled) {
                Some(hwnd) => { ShowWindow(hwnd, SW_SHOW); ShowWindow(hwnd, SW_RESTORE); SetForegroundWindow(hwnd); true }
                None => false,
            }
        }
    }
}

/// Called first in `main` (after the automation-worker entry). Returns true when this launch should exit because an instance of the same
/// profile already runs — its window has been brought forward.
pub(crate) fn hand_over_to_running_instance() -> bool {
    #[cfg(windows)]
    {
        if imp::another_instance_running() {
            imp::focus_running_instance();
            return true;
        }
    }
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::mutex_name;
    #[test]
    fn default_profile_shares_one_name_and_explicit_profiles_get_their_own() {
        assert_eq!(mutex_name(None), "Local\\AbdoCodeDesktop.SingleInstance");
        let a = mutex_name(Some(std::ffi::OsStr::new("C:\\Profiles\\Work")));
        let b = mutex_name(Some(std::ffi::OsStr::new("c:\\profiles\\work")));
        let c = mutex_name(Some(std::ffi::OsStr::new("C:\\Profiles\\Home")));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, mutex_name(None));
    }
}
