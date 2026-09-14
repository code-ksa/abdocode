//! Strict fixed-order binary framing and primitive codecs.

use std::fmt;

use crate::schema::{
    is_known_message_tag, MAX_MESSAGE_BYTES, MESSAGE_MAGIC, PROTOCOL_DESCRIPTOR, PROTOCOL_VERSION,
};

/// The byte width of the fixed protocol frame header.
pub const FRAME_HEADER_LEN: usize = 28;

/// A canonical wire value can append itself to a writer.
pub trait WireEncode {
    fn encode_to(&self, writer: &mut Writer) -> Result<(), EncodeError>;
}

/// A canonical wire value can be decoded from a bounded reader.
pub trait WireDecode: Sized {
    fn decode_from(reader: &mut Reader<'_>) -> Result<Self, DecodeError>;
}

/// A top-level framed protocol message.
pub trait Message: WireEncode + WireDecode {
    const TYPE_TAG: u16;
    const TYPE_NAME: &'static str;
}

/// Encoding failures are deterministic and never perform I/O.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncodeError {
    InvalidValue(&'static str),
    Oversize { actual: usize, maximum: usize },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue(reason) => write!(formatter, "non-canonical value: {reason}"),
            Self::Oversize { actual, maximum } => {
                write!(formatter, "message is {actual} bytes; maximum is {maximum}")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

/// Strict decoder failures. No error contains input bytes or opaque handles.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodeError {
    Truncated,
    BadMagic,
    UnsupportedVersion(u16),
    SchemaFingerprintMismatch,
    UnknownMessageTag(u16),
    UnexpectedMessageTag { expected: u16, actual: u16 },
    UnknownVariant { type_name: &'static str, tag: u8 },
    InvalidValue(&'static str),
    Oversize { actual: usize, maximum: usize },
    TrailingBytes,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("truncated message"),
            Self::BadMagic => formatter.write_str("invalid message magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported protocol version {version}")
            }
            Self::SchemaFingerprintMismatch => formatter.write_str("schema fingerprint mismatch"),
            Self::UnknownMessageTag(tag) => write!(formatter, "unknown message tag {tag}"),
            Self::UnexpectedMessageTag { expected, actual } => {
                write!(
                    formatter,
                    "expected message tag {expected}, received {actual}"
                )
            }
            Self::UnknownVariant { type_name, tag } => {
                write!(formatter, "unknown {type_name} variant tag {tag}")
            }
            Self::InvalidValue(reason) => write!(formatter, "non-canonical value: {reason}"),
            Self::Oversize { actual, maximum } => {
                write!(formatter, "message is {actual} bytes; maximum is {maximum}")
            }
            Self::TrailingBytes => formatter.write_str("trailing message bytes"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// In-memory writer used by every generated codec.
#[derive(Debug, Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
        }
    }

    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    pub fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

/// Bounds-checked reader used by every generated codec.
#[derive(Debug)]
pub struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    pub fn read_exact(&mut self, length: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(DecodeError::Truncated)?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or(DecodeError::Truncated)?;
        self.position = end;
        Ok(value)
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    pub fn finish(self) -> Result<(), DecodeError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(DecodeError::TrailingBytes)
        }
    }
}

impl WireEncode for u8 {
    fn encode_to(&self, writer: &mut Writer) -> Result<(), EncodeError> {
        writer.write_bytes(&[*self]);
        Ok(())
    }
}

impl WireDecode for u8 {
    fn decode_from(reader: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(reader.read_exact(1)?[0])
    }
}

macro_rules! integer_codec {
    ($type:ty, $width:literal) => {
        impl WireEncode for $type {
            fn encode_to(&self, writer: &mut Writer) -> Result<(), EncodeError> {
                writer.write_bytes(&self.to_le_bytes());
                Ok(())
            }
        }

        impl WireDecode for $type {
            fn decode_from(reader: &mut Reader<'_>) -> Result<Self, DecodeError> {
                let bytes: [u8; $width] = reader
                    .read_exact($width)?
                    .try_into()
                    .expect("reader returned the requested fixed width");
                Ok(<$type>::from_le_bytes(bytes))
            }
        }
    };
}

integer_codec!(u16, 2);
integer_codec!(u32, 4);
integer_codec!(u64, 8);
integer_codec!(u128, 16);

/// What a frame header claims about the frame behind it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameHeader {
    pub message_tag: u16,
    pub payload_length: usize,
    /// Header plus payload. What a reader has to have before it may decode.
    pub frame_length: usize,
}

/// Read a fixed-width frame header, and check it before anything follows it.
///
/// Exists so that "how long is this frame" has one answer. A host reading
/// frames off a pipe has to know where one ends before it can hand the bytes to
/// a decoder, and the alternative is that it works the length out itself — a
/// second parser, which is one more opinion about the wire than a boundary can
/// hold. [`decode_frame`] uses it too, so the two cannot drift.
///
/// The declared length is checked against the protocol ceiling here, before the
/// payload is read. A caller that allocated first and checked afterwards would
/// be spending a memory budget the other end sets.
pub fn decode_frame_header(header: &[u8; FRAME_HEADER_LEN]) -> Result<FrameHeader, DecodeError> {
    let mut reader = Reader::new(header);
    if reader.read_exact(MESSAGE_MAGIC.len())? != MESSAGE_MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let version = u16::decode_from(&mut reader)?;
    if version != PROTOCOL_VERSION {
        return Err(DecodeError::UnsupportedVersion(version));
    }
    if reader.read_exact(PROTOCOL_DESCRIPTOR.schema_fingerprint.len())?
        != PROTOCOL_DESCRIPTOR.schema_fingerprint
    {
        return Err(DecodeError::SchemaFingerprintMismatch);
    }
    let message_tag = u16::decode_from(&mut reader)?;
    if !is_known_message_tag(message_tag) {
        return Err(DecodeError::UnknownMessageTag(message_tag));
    }
    let payload_length = u32::decode_from(&mut reader)? as usize;
    let frame_length =
        FRAME_HEADER_LEN
            .checked_add(payload_length)
            .ok_or(DecodeError::Oversize {
                actual: usize::MAX,
                maximum: MAX_MESSAGE_BYTES,
            })?;
    if frame_length > MAX_MESSAGE_BYTES {
        return Err(DecodeError::Oversize {
            actual: frame_length,
            maximum: MAX_MESSAGE_BYTES,
        });
    }
    reader.finish()?;
    Ok(FrameHeader {
        message_tag,
        payload_length,
        frame_length,
    })
}

/// Encode one complete canonical frame.
pub fn encode_frame<T: Message>(message: &T) -> Result<Vec<u8>, EncodeError> {
    let mut payload = Writer::new();
    message.encode_to(&mut payload)?;
    let payload = payload.into_inner();
    let actual = FRAME_HEADER_LEN
        .checked_add(payload.len())
        .ok_or(EncodeError::Oversize {
            actual: usize::MAX,
            maximum: MAX_MESSAGE_BYTES,
        })?;
    if actual > MAX_MESSAGE_BYTES {
        return Err(EncodeError::Oversize {
            actual,
            maximum: MAX_MESSAGE_BYTES,
        });
    }

    let payload_length = u32::try_from(payload.len()).map_err(|_| EncodeError::Oversize {
        actual,
        maximum: MAX_MESSAGE_BYTES,
    })?;
    let mut frame = Writer::with_capacity(actual);
    frame.write_bytes(&MESSAGE_MAGIC);
    PROTOCOL_VERSION.encode_to(&mut frame)?;
    frame.write_bytes(&PROTOCOL_DESCRIPTOR.schema_fingerprint);
    T::TYPE_TAG.encode_to(&mut frame)?;
    payload_length.encode_to(&mut frame)?;
    frame.write_bytes(&payload);
    Ok(frame.into_inner())
}

/// Decode one complete frame as the expected message type.
pub fn decode_frame<T: Message>(bytes: &[u8]) -> Result<T, DecodeError> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(DecodeError::Oversize {
            actual: bytes.len(),
            maximum: MAX_MESSAGE_BYTES,
        });
    }

    let header: &[u8; FRAME_HEADER_LEN] = bytes
        .get(..FRAME_HEADER_LEN)
        .ok_or(DecodeError::Truncated)?
        .try_into()
        .map_err(|_| DecodeError::Truncated)?;
    let parsed = decode_frame_header(header)?;
    if parsed.message_tag != T::TYPE_TAG {
        return Err(DecodeError::UnexpectedMessageTag {
            expected: T::TYPE_TAG,
            actual: parsed.message_tag,
        });
    }
    if bytes.len() < parsed.frame_length {
        return Err(DecodeError::Truncated);
    }
    if bytes.len() > parsed.frame_length {
        return Err(DecodeError::TrailingBytes);
    }

    let payload = &bytes[FRAME_HEADER_LEN..parsed.frame_length];
    let mut payload_reader = Reader::new(payload);
    let decoded = T::decode_from(&mut payload_reader)?;
    payload_reader.finish()?;
    Ok(decoded)
}
