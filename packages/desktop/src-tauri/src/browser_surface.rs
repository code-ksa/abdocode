//! A lease identifies only this desktop's live controlled browser. A listening
//! CDP port alone is not ownership: Windows must name the Child as its owner.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const LEASE_FILE: &str = "browser-control-lease.json";
pub(crate) const INITIAL_URL: &str = "about:blank";

pub(crate) fn launch(exe: &str, profile: &Path, port: u16) -> Result<Child, String> {
    let mut command = Command::new(exe);
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--remote-debugging-address=127.0.0.1")
        // Keep the Child as owner instead of Edge's compatibility relaunch.
        .arg("--edge-skip-compat-layer-relaunch")
        .arg("--no-first-run")
        .arg("--new-window")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(INITIAL_URL)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not open the controlled browser: {error}"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserLease {
    version: u8,
    port: u16,
    pid: u32,
    owner_pid: u32,
    endpoint: String,
}

fn lease_path() -> Result<PathBuf, String> {
    super::workspace_controls::engine_settings_path()?
        .parent()
        .map(|path| path.join(LEASE_FILE))
        .ok_or_else(|| "Browser lease directory is unavailable".into())
}

fn valid_endpoint(raw: &str, port: u16) -> bool {
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    let Some(id) = url.path().strip_prefix("/devtools/browser/") else {
        return false;
    };
    url.scheme() == "ws"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && uuid::Uuid::parse_str(id).is_ok()
}

pub(crate) fn endpoint(port: u16) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_millis(250)).ok()?;
    socket
        .set_read_timeout(Some(Duration::from_millis(400)))
        .ok()?;
    socket
        .set_write_timeout(Some(Duration::from_millis(250)))
        .ok()?;
    // Current Edge silently closes HTTP/1.0 requests. Read a bounded HTTP/1.1
    // response to Content-Length rather than waiting for a keep-alive EOF.
    socket
        .write_all(
            format!(
                "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .ok()?;
    let body = read_http_body(&mut socket)?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let endpoint = value.get("webSocketDebuggerUrl")?.as_str()?;
    valid_endpoint(endpoint, port).then(|| endpoint.to_owned())
}

fn read_http_body(socket: &mut TcpStream) -> Option<Vec<u8>> {
    const MAX_RESPONSE: usize = 16 * 1024;
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut reply = Vec::new();
    let mut body_start = None;
    let mut content_length = None;
    loop {
        if let (Some(start), Some(length)) = (body_start, content_length) {
            if reply.len() >= start + length {
                return Some(reply[start..start + length].to_vec());
            }
        }
        if reply.len() >= MAX_RESPONSE {
            return None;
        }
        let remaining = deadline.checked_duration_since(Instant::now())?;
        socket
            .set_read_timeout(Some(remaining.min(Duration::from_millis(400))))
            .ok()?;
        let mut buffer = [0u8; 2048];
        let count = socket.read(&mut buffer).ok()?;
        if count == 0 {
            return match (body_start, content_length) {
                (Some(start), None) => Some(reply[start..].to_vec()),
                _ => None,
            };
        }
        reply.extend_from_slice(&buffer[..count]);
        if reply.len() > MAX_RESPONSE {
            return None;
        }
        if body_start.is_none() {
            if let Some(end) = reply.windows(4).position(|value| value == b"\r\n\r\n") {
                let head = std::str::from_utf8(&reply[..end]).ok()?;
                if !head.starts_with("HTTP/1.1 200 ") && !head.starts_with("HTTP/1.0 200 ") {
                    return None;
                }
                for line in head.split("\r\n").skip(1) {
                    let (key, value) = line.split_once(':')?;
                    if key.eq_ignore_ascii_case("content-length") {
                        let length = value.trim().parse::<usize>().ok()?;
                        if content_length.is_some() || length > MAX_RESPONSE - end - 4 {
                            return None;
                        }
                        content_length = Some(length);
                    } else if key.eq_ignore_ascii_case("transfer-encoding") {
                        // Chromium's small version reply has a Content-Length.
                        // Reject an unexpected transfer format instead of guessing.
                        return None;
                    }
                }
                body_start = Some(end + 4);
            }
        }
    }
}

#[cfg(windows)]
fn listener_owned_by(port: u16, pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
            TCP_TABLE_OWNER_PID_LISTENER,
        },
        Networking::WinSock::AF_INET,
    };
    let mut size = 0u32;
    // Windows first reports the required size. Retry once if a concurrent
    // listener changes that size; never infer ownership from a failed query.
    let result = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 122 || size < 4 {
        return Err("Could not verify the browser port owner".into());
    }
    for _ in 0..2 {
        if size > 16 * 1024 * 1024 {
            return Err("Browser port ownership table is too large".into());
        }
        let mut table = vec![0u8; size as usize];
        let result = unsafe {
            GetExtendedTcpTable(
                table.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == 122 {
            continue;
        }
        if result != 0 {
            return Err("Could not verify the browser port owner".into());
        }
        let count = unsafe { std::ptr::read_unaligned(table.as_ptr().cast::<u32>()) } as usize;
        let offset = std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
        if count > table.len().saturating_sub(offset) / row_size {
            return Err("Invalid browser port ownership table".into());
        }
        for index in 0..count {
            let row = unsafe {
                std::ptr::read_unaligned(
                    table
                        .as_ptr()
                        .add(offset + index * row_size)
                        .cast::<MIB_TCPROW_OWNER_PID>(),
                )
            };
            if u16::from_be(row.dwLocalPort as u16) == port
                && row.dwLocalAddr == u32::from_ne_bytes([127, 0, 0, 1])
            {
                return Ok(row.dwOwningPid == pid);
            }
        }
        return Ok(false);
    }
    Err("Browser port ownership changed while being verified".into())
}

#[cfg(not(windows))]
fn listener_owned_by(_port: u16, _pid: u32) -> Result<bool, String> {
    Err("Controlled browser ownership verification requires Windows".into())
}

fn write_lease(path: &Path, lease: &BrowserLease) -> Result<(), String> {
    let bytes = serde_json::to_vec(lease).map_err(|_| "Could not encode browser ownership")?;
    if fs::read(path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or("Browser lease directory is unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create browser lease directory")?;
    let staging = parent.join(format!("browser-control-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&staging, bytes).map_err(|_| "Could not save browser ownership")?;
    if fs::rename(&staging, path).is_err() {
        let _ = fs::remove_file(staging);
        return Err("Could not publish browser ownership".into());
    }
    Ok(())
}

fn clear_owned_lease(path: &Path, owner_pid: u32) {
    let lease = fs::read(path)
        .ok()
        .filter(|bytes| bytes.len() <= 4096)
        .and_then(|bytes| serde_json::from_slice::<BrowserLease>(&bytes).ok());
    if lease.is_some_and(|lease| lease.owner_pid == owner_pid) {
        let _ = fs::remove_file(path);
    }
}

/// هل العمليّةُ حيّة؟ عبر tasklist بمسارها المطلق (لا تخمينَ من غياب الأداة في PATH).
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let output = Command::new(format!("{root}\\System32\\tasklist.exe"))
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .stdin(Stdio::null())
        .output();
    // جدولٌ لا يُقرأ = «قد يكون حيّاً» (الغيابُ رفضٌ لا إذن — مراجعة 09-14): لا قتلَ على قياسٍ مجهول.
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")),
        _ => true,
    }
}

/// اليتيمُ على منفذ التحكّم (مقيس 2026-09-13: «port is in use» بعد إعادة تشغيل التطبيق): عقدٌ محفوظ مالكُه ميّت
/// والمستمعُ على المنفذ هو pid العقد نفسِه (Edge الذي أطلقناه بملفّنا) ⇦ يُنهى ويُمسح العقد ويُعاد true؛
/// أيُّ شرطٍ يخيب ⇦ false ولا يُمَسّ شيء (متصفّحٌ غريب على المنفذ ليس لنا).
#[cfg(windows)]
pub(crate) fn reclaim_orphan(port: u16) -> Result<bool, String> {
    let path = lease_path()?;
    let Some(lease) = fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() <= 4096)
        .and_then(|bytes| serde_json::from_slice::<BrowserLease>(&bytes).ok())
    else { return Ok(false) };
    if lease.port != port || lease.owner_pid == std::process::id() || process_alive(lease.owner_pid) {
        return Ok(false);
    }
    if !listener_owned_by(port, lease.pid)? {
        return Ok(false);
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let killed = Command::new(format!("{root}\\System32\\taskkill.exe"))
        .args(["/PID", &lease.pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !killed {
        return Ok(false);
    }
    let _ = fs::remove_file(&path);
    std::thread::sleep(Duration::from_millis(400));
    Ok(TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(200)).is_err())
}

#[cfg(not(windows))]
pub(crate) fn reclaim_orphan(_port: u16) -> Result<bool, String> {
    Ok(false)
}

pub(crate) fn clear_lease() {
    if let Ok(path) = lease_path() {
        clear_owned_lease(&path, std::process::id());
    }
}

/// Called only while holding BrowserPane's live Child lock. Check ownership
/// before and after HTTP discovery so a reused/foreign port gets no lease.
pub(crate) fn publish_owned_endpoint(pid: u32, port: u16) -> Result<Option<String>, String> {
    let path = lease_path()?;
    let measured = (|| {
        if !listener_owned_by(port, pid)? {
            return Ok(None);
        }
        let Some(endpoint) = endpoint(port) else {
            return Ok(None);
        };
        if !listener_owned_by(port, pid)? {
            return Ok(None);
        }
        write_lease(
            &path,
            &BrowserLease {
                version: 1,
                port,
                pid,
                owner_pid: std::process::id(),
                endpoint: endpoint.clone(),
            },
        )?;
        Ok(Some(endpoint))
    })();
    if !matches!(&measured, Ok(Some(_))) {
        clear_owned_lease(&path, std::process::id());
    }
    measured
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_the_unique_local_browser_websocket() {
        let id = uuid::Uuid::new_v4();
        assert!(valid_endpoint(
            &format!("ws://127.0.0.1:9366/devtools/browser/{id}"),
            9366
        ));
        assert!(valid_endpoint(
            &format!("ws://localhost:9366/devtools/browser/{id}"),
            9366
        ));
        for url in [
            format!("ws://127.0.0.1:9367/devtools/browser/{id}"),
            format!("ws://example.com:9366/devtools/browser/{id}"),
            format!("ws://127.0.0.1:9366/devtools/page/{id}"),
            format!("ws://user@127.0.0.1:9366/devtools/browser/{id}"),
            format!("ws://127.0.0.1:9366/devtools/browser/{id}?other"),
            "ws://127.0.0.1:9366/devtools/browser/not-a-uuid".into(),
        ] {
            assert!(!valid_endpoint(&url, 9366));
        }
    }

    #[test]
    fn lease_replacement_and_cleanup_preserve_another_owners_lease() {
        let root =
            std::env::temp_dir().join(format!("abdo-browser-lease-{}", uuid::Uuid::new_v4()));
        let path = root.join(LEASE_FILE);
        let mut lease = BrowserLease {
            version: 1,
            port: 9366,
            pid: 101,
            owner_pid: 202,
            endpoint: format!(
                "ws://127.0.0.1:9366/devtools/browser/{}",
                uuid::Uuid::new_v4()
            ),
        };
        write_lease(&path, &lease).unwrap();
        lease.pid = 303;
        write_lease(&path, &lease).unwrap();
        assert_eq!(
            serde_json::from_slice::<BrowserLease>(&fs::read(&path).unwrap())
                .unwrap()
                .pid,
            303
        );
        clear_owned_lease(&path, 404);
        assert!(path.exists());
        clear_owned_lease(&path, 202);
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_measures_the_real_listener_pid_and_rejects_other_processes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(listener_owned_by(port, std::process::id()).unwrap());
        assert!(!listener_owned_by(port, 0).unwrap());
        drop(listener);
        assert!(!listener_owned_by(port, std::process::id()).unwrap());
    }

    #[test]
    fn discovery_uses_http11_and_finishes_at_content_length_before_eof() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let expected = format!(
            "ws://127.0.0.1:{port}/devtools/browser/{}",
            uuid::Uuid::new_v4()
        );
        let body = serde_json::json!({"webSocketDebuggerUrl": expected}).to_string();
        let (finished, receiver) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 256];
            while !request.ends_with(b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0 && request.len() < 2048);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = std::str::from_utf8(&request).unwrap();
            assert!(request.starts_with("GET /json/version HTTP/1.1\r\n"));
            assert!(request.contains(&format!("\r\nHost: 127.0.0.1:{port}\r\n")));
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body.as_bytes()).unwrap();
            // Keep the server socket open until discovery has returned. A
            // read-to-EOF implementation times out and fails this assertion.
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        let result = endpoint(port);
        finished.send(()).unwrap();
        server.join().unwrap();
        assert_eq!(result, Some(expected));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Launches installed Edge with an isolated temporary profile; run explicitly for native release qualification"]
    fn real_edge_native_discovery_keeps_child_ownership_and_closes_endpoint() {
        struct Probe {
            child: Child,
            profile: PathBuf,
        }
        impl Drop for Probe {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                // Only the unique directory created by this test is removed.
                let _ = fs::remove_dir_all(&self.profile);
            }
        }
        let exe = [
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
        .into_iter()
        .find(|path| Path::new(path).is_file())
        .expect("installed Edge");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let profile = std::env::temp_dir().join(format!(
            "abdo-native-edge-http-proof-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&profile).unwrap();
        let child = launch(exe, &profile, port).unwrap();
        let mut probe = Probe { child, profile };
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut ready = false;
        while Instant::now() < deadline {
            assert!(
                probe.child.try_wait().unwrap().is_none(),
                "original native browser Child must remain alive"
            );
            if listener_owned_by(port, probe.child.id()).unwrap() && endpoint(port).is_some() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            ready,
            "actual native Rust discovery must return the live Edge browser endpoint"
        );
        assert!(listener_owned_by(port, probe.child.id()).unwrap());
        assert!(probe.child.try_wait().unwrap().is_none());
        probe.child.kill().unwrap();
        probe.child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        while Instant::now() < deadline
            && TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok()
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err(),
            "native close must remove the real listener"
        );
        eprintln!("Native Edge proof: original Child alive, actual Rust discovery ready, listener PID matched, endpoint closed");
    }
}
