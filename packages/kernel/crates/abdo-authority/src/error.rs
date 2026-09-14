//! Refusals, and the few things that are errors rather than refusals.

use std::fmt;

use crate::capability::CapabilityId;

/// Why authority said no.
///
/// Every variant names something an attacker cannot simply restate: a different
/// boot, a different process, a spent clock, a bumped generation, a scope that
/// is not theirs. "Denied because the check failed" is not among them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Denial {
    /// Issued in a different boot of the kernel.
    WrongBoot,
    /// Issued to a different process, or to a recycled PID.
    WrongProcess,
    /// The clock ran past the grant.
    Expired { expires_at_ms: u64, now_ms: u64 },
    /// Superseded by a later generation.
    Revoked { held: u64, current: u64 },
    /// Presented by somebody it was not granted to.
    WrongScope,
    /// Aimed at something other than what was granted.
    WrongTarget,
    /// A different operation than the one granted.
    WrongOperation,
    /// The seal does not match. Either the receipt was altered or it was not
    /// issued by this authority.
    ForgedSeal,
    /// No such capability, or it was never granted here.
    UnknownCapability { id: CapabilityId },
}

/// A failure to do the work at all, as distinct from refusing it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityError {
    /// A grant whose lifetime is empty or inverted.
    InvalidLifetime {
        issued_at_ms: u64,
        expires_at_ms: u64,
    },
    /// A time-to-live longer than the contract permits.
    LifetimeTooLong { ttl_ms: u64, maximum_ms: u64 },
    /// The capability identifier is already in use.
    DuplicateCapability { id: CapabilityId },
    /// A value that cannot be encoded canonically, so cannot be sealed.
    NotCanonical(&'static str),
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLifetime {
                issued_at_ms,
                expires_at_ms,
            } => write!(
                formatter,
                "a grant issued at {issued_at_ms} cannot expire at {expires_at_ms}"
            ),
            Self::LifetimeTooLong { ttl_ms, maximum_ms } => write!(
                formatter,
                "a lifetime of {ttl_ms}ms exceeds the {maximum_ms}ms maximum"
            ),
            Self::DuplicateCapability { id } => {
                write!(formatter, "capability {} is already granted", id.get())
            }
            Self::NotCanonical(reason) => write!(formatter, "value is not canonical: {reason}"),
        }
    }
}

impl std::error::Error for AuthorityError {}
