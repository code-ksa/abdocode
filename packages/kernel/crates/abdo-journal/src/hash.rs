use sha2::{Digest as ShaDigest, Sha256};

use crate::{BlobHash, ChainHash, StreamId};

const EVENT_DOMAIN: &[u8] = b"ABDO/JOURNAL/EVENT/1\0";
const BLOB_DOMAIN: &[u8] = b"ABDO/JOURNAL/BLOB/1\0";
const OPTIONS_DOMAIN: &[u8] = b"ABDO/JOURNAL/SQLITE-OPTIONS/1\0";

pub(crate) fn event_hash(
    stream_id: StreamId,
    global_sequence: u64,
    stream_sequence: u64,
    event_id: u128,
    previous_hash: ChainHash,
    event_frame: &[u8],
) -> ChainHash {
    let mut hasher = Sha256::new();
    hasher.update(EVENT_DOMAIN);
    hasher.update(abdo_contracts::PROTOCOL_DESCRIPTOR.schema_fingerprint);
    hasher.update(stream_id.to_be_bytes());
    hasher.update(global_sequence.to_be_bytes());
    hasher.update(stream_sequence.to_be_bytes());
    hasher.update(event_id.to_be_bytes());
    hasher.update(previous_hash.as_bytes());
    hasher.update((event_frame.len() as u32).to_be_bytes());
    hasher.update(event_frame);
    ChainHash::from_bytes(hasher.finalize().into())
}

pub(crate) fn blob_hash(bytes: &[u8]) -> BlobHash {
    let mut hasher = Sha256::new();
    hasher.update(BLOB_DOMAIN);
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    BlobHash::from_bytes(hasher.finalize().into())
}

pub(crate) fn option_digest(options: &[String]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(OPTIONS_DOMAIN);
    for option in options {
        hasher.update((option.len() as u32).to_be_bytes());
        hasher.update(option.as_bytes());
    }
    hasher.finalize().into()
}

pub(crate) fn bytes_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
