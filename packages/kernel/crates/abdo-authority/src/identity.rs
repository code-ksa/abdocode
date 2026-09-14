//! Boot and process identity.

use abdo_contracts::{BootId, Digest, RunId};
use sha2::{Digest as _, Sha256};

const PROCESS_DOMAIN: &[u8] = b"ABDO/AUTHORITY/PROCESS/1\0";

/// Which boot of the kernel this is.
///
/// A restart is the cheapest way to lose every in-memory guarantee, so it gets
/// an identity of its own and every receipt carries it. Receipts from a previous
/// boot do not verify, and they do not need a revocation list to stop working.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BootIdentity {
    pub boot_id: BootId,
    pub run_id: RunId,
}

/// Which process is acting.
///
/// A PID alone is not an identity. Operating systems hand the same number out
/// again, often within minutes, and a grant bound to the number alone would be
/// inherited by whatever unrelated process happened to receive it. Binding the
/// start time as well makes the pair unique for as long as anyone cares.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// When the process started, in milliseconds since the Unix epoch.
    pub started_at_ms: u64,
}

impl ProcessIdentity {
    pub const fn new(pid: u32, started_at_ms: u64) -> Self {
        Self { pid, started_at_ms }
    }

    /// The digest a receipt carries. Binds both halves, never the PID alone.
    pub fn digest(&self) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(PROCESS_DOMAIN);
        hasher.update(self.pid.to_be_bytes());
        hasher.update(self.started_at_ms.to_be_bytes());
        Digest::from_bytes(hasher.finalize().into())
    }

    /// Is this the same process, rather than merely the same number?
    pub fn is_same_as(&self, other: &Self) -> bool {
        self.pid == other.pid && self.started_at_ms == other.started_at_ms
    }
}
