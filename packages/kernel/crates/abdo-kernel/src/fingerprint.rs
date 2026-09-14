//! The deterministic state fingerprint.

use std::fmt;

use sha2::{Digest as _, Sha256};

/// Version of the canonical state encoding.
///
/// Any change to the encoding must bump this, because an old fingerprint and a
/// new one would otherwise disagree without saying why.
pub const CANONICAL_STATE_VERSION: u16 = 1;

/// A SHA-256 fingerprint of a canonical state encoding.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Fingerprint([u8; 32]);

impl Fingerprint {
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Self(hasher.finalize().into())
    }

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        let mut text = String::with_capacity(64);
        for byte in self.0 {
            text.push_str(&format!("{byte:02x}"));
        }
        text
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}
