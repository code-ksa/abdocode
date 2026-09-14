//! BLUEPRINT_FACADE_V1 canonical=crates/abdo-contracts/src/wire.rs
//! Compiled compatibility facade for the owner-supplied physical tree.
//! Behaviour remains in the canonical implementation above; this file does not fork it.

pub const BLUEPRINT_ELEMENT: &str = "crates/abdo-contracts/src/protocol/frame_limits.rs";
pub const CANONICAL_SOURCE: &str = "crates/abdo-contracts/src/wire.rs";
pub fn connected() -> bool {
    !BLUEPRINT_ELEMENT.is_empty() && !CANONICAL_SOURCE.is_empty()
}
