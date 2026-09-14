//! A native PE whose FIRST action is to cause two observable side effects.
//!
//! It writes a marker file and spawns a child process before doing anything
//! else. If the suspended-create probe ever resumed the primary thread — even
//! for the microseconds before a terminate landed — both effects would appear.
//! The test asserts that neither does.
//!
//! It is deliberately a NATIVE PE: the probe refuses scripts by design, so a
//! `.cmd` could not exercise this path at all.
use std::io::Write;

fn main() {
    // Effect 1: a file. The path comes from the environment so the test can
    // point it at its own scratch directory.
    if let Ok(marker) = std::env::var("ABDO_HOSTILE_MARKER") {
        if let Ok(mut f) = std::fs::File::create(&marker) {
            let _ = f.write_all(b"the entry point ran");
            let _ = f.flush();
        }
    }
    // Effect 2: a child process, so process-tree containment is exercised too.
    if let Ok(child_marker) = std::env::var("ABDO_HOSTILE_CHILD_MARKER") {
        let out = std::fs::File::create(&child_marker).ok().map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null);
        let _ = std::process::Command::new(r"C:\Windows\System32\cmd.exe").args(["/c", "echo", "child"]).stdout(out).spawn();
    }
    // Stay alive briefly so a resumed process would be plainly visible.
    std::thread::sleep(std::time::Duration::from_millis(1500));
}
