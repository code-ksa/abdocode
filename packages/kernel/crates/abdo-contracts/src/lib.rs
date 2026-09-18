#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! Canonical, dependency-free contracts for the Abdo Code kernel boundary.
//!
//! [`schema`] is the sole protocol schema. Rust types, fixed-order binary
//! codecs, the runtime descriptor, and the TypeScript artifact are all derived
//! from that declaration.

#[macro_use]
mod schema_macros;

pub mod blueprint_facades;
pub mod codegen;
pub mod generator;
pub mod schema;
pub mod wire;

pub use generator::{GeneratorSeed, IdGenerationError, IdGenerator};
pub use schema::*;
pub use wire::{
    decode_frame, decode_frame_header, encode_frame, DecodeError, EncodeError, FrameHeader,
    Message, Reader, WireDecode, WireEncode, Writer, FRAME_HEADER_LEN,
};
