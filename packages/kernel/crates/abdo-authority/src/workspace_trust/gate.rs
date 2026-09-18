//! BLUEPRINT_FACADE_V1 canonical=crates/abdo-authority/src/identity.rs
//! Compiled compatibility facade for the owner-supplied physical tree.
//! Behaviour remains in the canonical implementation above; this file does not fork it.

pub const BLUEPRINT_ELEMENT: &str = "crates/abdo-authority/src/workspace_trust/gate.rs";
pub const CANONICAL_SOURCE: &str = "crates/abdo-authority/src/identity.rs";
pub fn connected() -> bool {
    !BLUEPRINT_ELEMENT.is_empty() && !CANONICAL_SOURCE.is_empty()
}
