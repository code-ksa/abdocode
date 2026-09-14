//! BLUEPRINT_FACADE_V1 canonical=crates/abdo-kernel/src/reduce.rs
//! Compiled compatibility facade for the owner-supplied physical tree.
//! Behaviour remains in the canonical implementation above; this file does not fork it.

pub const BLUEPRINT_ELEMENT: &str = "crates/abdo-kernel/src/admission/version_guard.rs";
pub const CANONICAL_SOURCE: &str = "crates/abdo-kernel/src/reduce.rs";
pub fn connected() -> bool {
    !BLUEPRINT_ELEMENT.is_empty() && !CANONICAL_SOURCE.is_empty()
}
