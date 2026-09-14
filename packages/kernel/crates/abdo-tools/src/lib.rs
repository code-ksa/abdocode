#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! Canonical Rust ownership of tool registration, disclosure and isolation.

mod adapters;
mod broker;
mod disclosure;

pub use abdo_authority::ReceiptSubject as ToolSubject;
pub use abdo_evidence::{EvidenceChain, EvidenceError, EvidenceReceipt};
pub use abdo_policy::Risk as ToolRisk;
pub use adapters::{adapter_kind, AdapterKind};
pub use broker::{CompiledBoundary, NoSandbox, RegistrationError, Sandbox, ToolCatalog, ToolLease};
pub use disclosure::{class_tag, Brief, CatalogSnapshot, Disclosed, SearchQuery, SearchResult};
pub mod blueprint_facades;
