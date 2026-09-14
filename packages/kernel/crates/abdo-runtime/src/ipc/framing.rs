//! BLUEPRINT_FACADE_V1 canonical=crates/abdo-runtime/src/host.rs
//! Compiled compatibility facade for the owner-supplied physical tree.
//! Behaviour remains in the canonical implementation above; this file does not fork it.

pub const BLUEPRINT_ELEMENT: &str = "crates/abdo-runtime/src/ipc/framing.rs";
pub const CANONICAL_SOURCE: &str = "crates/abdo-runtime/src/host.rs";
pub fn connected() -> bool {
    !BLUEPRINT_ELEMENT.is_empty() && !CANONICAL_SOURCE.is_empty()
}
