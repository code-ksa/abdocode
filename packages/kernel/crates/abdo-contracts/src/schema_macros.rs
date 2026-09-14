//! Declarative expansion support for the single schema in `schema.rs`.

macro_rules! schema_rule_reason {
    (NonZeroU64, $field:ident, $_argument:tt) => {
        concat!(stringify!($field), " must be non-zero")
    };
    (NonZeroBytes, $field:ident, $_argument:tt) => {
        concat!(stringify!($field), " must not be all-zero bytes")
    };
    (LessThanU64, $field:ident, $upper:ident) => {
        concat!(
            stringify!($field),
            " must be less than ",
            stringify!($upper)
        )
    };
    (MaxTtl60s, $field:ident, $upper:ident) => {
        concat!(
            stringify!($upper),
            " must be at most 60000ms after ",
            stringify!($field)
        )
    };
}

macro_rules! schema_rule_failed {
    ($value:expr, NonZeroU64, $field:ident, $_argument:tt) => {
        $value.$field == 0
    };
    ($value:expr, NonZeroBytes, $field:ident, $_argument:tt) => {
        $value.$field.is_zero()
    };
    ($value:expr, LessThanU64, $field:ident, $upper:ident) => {
        $value.$field >= $value.$upper
    };
    ($value:expr, MaxTtl60s, $field:ident, $upper:ident) => {
        $value
            .$upper
            .checked_sub($value.$field)
            .map_or(true, |span| span > 60_000)
    };
}

macro_rules! schema_validate_encode {
    ($value:expr; $( $field:ident : $rule:ident ( $argument:tt ); )*) => {
        $(
            if schema_rule_failed!($value, $rule, $field, $argument) {
                return Err($crate::wire::EncodeError::InvalidValue(
                    schema_rule_reason!($rule, $field, $argument),
                ));
            }
        )*
    };
}

macro_rules! schema_validate_decode {
    ($value:expr; $( $field:ident : $rule:ident ( $argument:tt ); )*) => {
        $(
            if schema_rule_failed!($value, $rule, $field, $argument) {
                return Err($crate::wire::DecodeError::InvalidValue(
                    schema_rule_reason!($rule, $field, $argument),
                ));
            }
        )*
    };
}

macro_rules! schema_rule_descriptor {
    (NonZeroU64, $field:ident, $_argument:tt) => {
        $crate::schema::RuleDescriptor::NonZeroU64 {
            field: stringify!($field),
        }
    };
    (NonZeroBytes, $field:ident, $_argument:tt) => {
        $crate::schema::RuleDescriptor::NonZeroBytes {
            field: stringify!($field),
        }
    };
    (LessThanU64, $field:ident, $upper:ident) => {
        $crate::schema::RuleDescriptor::LessThanU64 {
            lower: stringify!($field),
            upper: stringify!($upper),
        }
    };
    (MaxTtl60s, $field:ident, $upper:ident) => {
        $crate::schema::RuleDescriptor::MaxSpanU64 {
            lower: stringify!($field),
            upper: stringify!($upper),
            maximum: 60_000,
        }
    };
}

macro_rules! schema_id_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(u128);

        impl $name {
            pub fn try_from_u128(value: u128) -> Result<Self, &'static str> {
                if value == 0 {
                    Err(concat!(stringify!($name), " must be non-zero"))
                } else {
                    Ok(Self(value))
                }
            }

            pub const fn get(self) -> u128 {
                self.0
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter
                    .debug_tuple(stringify!($name))
                    .field(&format_args!("{:#034x}", self.0))
                    .finish()
            }
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                self.0.encode_to(writer)
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                let value = u128::decode_from(reader)?;
                Self::try_from_u128(value).map_err($crate::wire::DecodeError::InvalidValue)
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor = $crate::schema::TypeDescriptor {
                name: stringify!($name),
                kind: $crate::schema::TypeKind::Id128,
            };
        }

        impl $crate::generator::sealed::Sealed for $name {}

        impl $crate::generator::GeneratedId for $name {
            fn from_generated(raw: u128) -> Self {
                debug_assert_ne!(raw, 0);
                Self(raw)
            }
        }
    };
}

macro_rules! schema_fixed_bytes_type {
    ($name:ident, $length:literal) => {
        #[derive(Clone, Copy, Eq, Hash, PartialEq)]
        pub struct $name([u8; $length]);

        impl $name {
            pub const LENGTH: usize = $length;

            pub const fn from_bytes(bytes: [u8; $length]) -> Self {
                Self(bytes)
            }

            pub const fn as_bytes(&self) -> &[u8; $length] {
                &self.0
            }

            pub const fn into_bytes(self) -> [u8; $length] {
                self.0
            }

            pub fn is_zero(&self) -> bool {
                self.0.iter().all(|byte| *byte == 0)
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter
                    .debug_struct(stringify!($name))
                    .field("opaque_bytes", &$length)
                    .finish()
            }
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                writer.write_bytes(&self.0);
                Ok(())
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                let bytes = reader
                    .read_exact($length)?
                    .try_into()
                    .expect("reader returned the requested fixed width");
                Ok(Self(bytes))
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor = $crate::schema::TypeDescriptor {
                name: stringify!($name),
                kind: $crate::schema::TypeKind::FixedBytes { length: $length },
            };
        }
    };
}

macro_rules! schema_unit_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
        pub struct $name;

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                _writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                Ok(())
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                _reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                Ok(Self)
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor = $crate::schema::TypeDescriptor {
                name: stringify!($name),
                kind: $crate::schema::TypeKind::Unit,
            };
        }
    };
}

macro_rules! schema_struct_type {
    (
        $name:ident {
            $( $field:ident : $field_type:ty, )*
        }
        rules { $( $rule_field:ident : $rule:ident ( $argument:tt ); )* }
    ) => {
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct $name {
            $( pub $field: $field_type, )*
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                schema_validate_encode!(self; $( $rule_field : $rule ( $argument ); )*);
                $( self.$field.encode_to(writer)?; )*
                Ok(())
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                let value = Self {
                    $( $field: <$field_type>::decode_from(reader)?, )*
                };
                schema_validate_decode!(&value; $( $rule_field : $rule ( $argument ); )*);
                Ok(value)
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor =
                $crate::schema::TypeDescriptor {
                    name: stringify!($name),
                    kind: $crate::schema::TypeKind::Struct {
                        fields: &[
                            $( $crate::schema::FieldDescriptor {
                                name: stringify!($field),
                                type_name: stringify!($field_type),
                            }, )*
                        ],
                        rules: &[
                            $( schema_rule_descriptor!($rule, $rule_field, $argument), )*
                        ],
                        integrity_field: None,
                    },
                };
        }
    };
}

macro_rules! schema_integrity_struct_type {
    (
        $name:ident {
            $( $field:ident : $field_type:ty, )*
        }
        integrity $integrity_field:ident : $integrity_type:ty;
        rules { $( $rule_field:ident : $rule:ident ( $argument:tt ); )* }
    ) => {
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct $name {
            $( pub $field: $field_type, )*
            pub $integrity_field: $integrity_type,
        }

        impl $name {
            /// Canonical integrity input. The stored integrity digest is excluded.
            pub fn canonical_integrity_bytes(
                &self,
            ) -> Result<Vec<u8>, $crate::wire::EncodeError> {
                schema_validate_encode!(self; $( $rule_field : $rule ( $argument ); )*);
                let mut writer = $crate::wire::Writer::new();
                writer.write_bytes($crate::schema::TRUST_INTEGRITY_DOMAIN);
                $( self.$field.encode_to(&mut writer)?; )*
                Ok(writer.into_inner())
            }
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                schema_validate_encode!(self; $( $rule_field : $rule ( $argument ); )*);
                if self.$integrity_field.is_zero() {
                    return Err($crate::wire::EncodeError::InvalidValue(concat!(
                        stringify!($integrity_field),
                        " must not be all-zero bytes",
                    )));
                }
                $( self.$field.encode_to(writer)?; )*
                self.$integrity_field.encode_to(writer)?;
                Ok(())
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                let value = Self {
                    $( $field: <$field_type>::decode_from(reader)?, )*
                    $integrity_field: <$integrity_type>::decode_from(reader)?,
                };
                schema_validate_decode!(&value; $( $rule_field : $rule ( $argument ); )*);
                if value.$integrity_field.is_zero() {
                    return Err($crate::wire::DecodeError::InvalidValue(concat!(
                        stringify!($integrity_field),
                        " must not be all-zero bytes",
                    )));
                }
                Ok(value)
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor =
                $crate::schema::TypeDescriptor {
                    name: stringify!($name),
                    kind: $crate::schema::TypeKind::Struct {
                        fields: &[
                            $( $crate::schema::FieldDescriptor {
                                name: stringify!($field),
                                type_name: stringify!($field_type),
                            }, )*
                            $crate::schema::FieldDescriptor {
                                name: stringify!($integrity_field),
                                type_name: stringify!($integrity_type),
                            },
                        ],
                        rules: &[
                            $( schema_rule_descriptor!($rule, $rule_field, $argument), )*
                            $crate::schema::RuleDescriptor::NonZeroBytes {
                                field: stringify!($integrity_field),
                            },
                        ],
                        integrity_field: Some(stringify!($integrity_field)),
                    },
                };
        }
    };
}

macro_rules! schema_enum_type {
    ($name:ident { $( $variant:ident = $tag:literal, )* }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum $name {
            $( $variant, )*
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                let tag: u8 = match self {
                    $( Self::$variant => $tag, )*
                };
                tag.encode_to(writer)
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                match u8::decode_from(reader)? {
                    $( $tag => Ok(Self::$variant), )*
                    tag => Err($crate::wire::DecodeError::UnknownVariant {
                        type_name: stringify!($name),
                        tag,
                    }),
                }
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor =
                $crate::schema::TypeDescriptor {
                    name: stringify!($name),
                    kind: $crate::schema::TypeKind::Enum {
                        variants: &[
                            $( $crate::schema::VariantDescriptor {
                                name: stringify!($variant),
                                tag: $tag,
                                payload_type: None,
                            }, )*
                        ],
                    },
                };
        }
    };
}

macro_rules! schema_union_type {
    ($name:ident { $( $variant:ident ( $payload:ty ) = $tag:literal, )* }) => {
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub enum $name {
            $( $variant(Box<$payload>), )*
        }

        impl $crate::wire::WireEncode for $name {
            fn encode_to(
                &self,
                writer: &mut $crate::wire::Writer,
            ) -> Result<(), $crate::wire::EncodeError> {
                match self {
                    $( Self::$variant(payload) => {
                        ($tag as u8).encode_to(writer)?;
                        payload.encode_to(writer)
                    }, )*
                }
            }
        }

        impl $crate::wire::WireDecode for $name {
            fn decode_from(
                reader: &mut $crate::wire::Reader<'_>,
            ) -> Result<Self, $crate::wire::DecodeError> {
                match u8::decode_from(reader)? {
                    $( $tag => Ok(Self::$variant(Box::new(<$payload>::decode_from(reader)?))), )*
                    tag => Err($crate::wire::DecodeError::UnknownVariant {
                        type_name: stringify!($name),
                        tag,
                    }),
                }
            }
        }

        impl $crate::schema::ContractType for $name {
            const DESCRIPTOR: $crate::schema::TypeDescriptor =
                $crate::schema::TypeDescriptor {
                    name: stringify!($name),
                    kind: $crate::schema::TypeKind::Union {
                        variants: &[
                            $( $crate::schema::VariantDescriptor {
                                name: stringify!($variant),
                                tag: $tag,
                                payload_type: Some(stringify!($payload)),
                            }, )*
                        ],
                    },
                };
        }
    };
}

macro_rules! contract_schema {
    (
        protocol {
            name: $protocol_name:literal,
            magic: $magic:expr,
            version: $version:literal,
            max_message_bytes: $max_message_bytes:literal,
            trust_integrity_domain: $integrity_domain:literal,
        }
        ids { $( $id:ident, )* }
        fixed_bytes { $( $bytes_name:ident [ $bytes_length:literal ], )* }
        units { $( $unit:ident, )* }
        structs {
            $(
                $struct_name:ident {
                    $( $field:ident : $field_type:ty, )*
                }
                rules { $( $rule_field:ident : $rule:ident ( $argument:tt ); )* }
            )*
        }
        integrity_structs {
            $(
                $integrity_name:ident {
                    $( $integrity_normal_field:ident : $integrity_normal_type:ty, )*
                }
                integrity $integrity_field:ident : $integrity_type:ty;
                rules {
                    $( $integrity_rule_field:ident : $integrity_rule:ident ( $integrity_argument:tt ); )*
                }
            )*
        }
        enums {
            $( $enum_name:ident { $( $enum_variant:ident = $enum_tag:literal, )* } )*
        }
        unions {
            $( $union_name:ident { $( $union_variant:ident ( $union_payload:ty ) = $union_tag:literal, )* } )*
        }
        messages { $( $message:ident = $message_tag:literal, )* }
    ) => {
        pub const PROTOCOL_NAME: &str = $protocol_name;
        pub const MESSAGE_MAGIC: [u8; 4] = $magic;
        pub const PROTOCOL_VERSION: u16 = $version;
        pub const MAX_MESSAGE_BYTES: usize = $max_message_bytes;
        // NUL terminates the domain so no future suffix can share its prefix.
        pub const TRUST_INTEGRITY_DOMAIN: &[u8] = concat!($integrity_domain, "\0").as_bytes();

        $( schema_id_type!($id); )*
        $( schema_fixed_bytes_type!($bytes_name, $bytes_length); )*
        $( schema_unit_type!($unit); )*
        $(
            schema_struct_type!(
                $struct_name {
                    $( $field : $field_type, )*
                }
                rules { $( $rule_field : $rule ( $argument ); )* }
            );
        )*
        $(
            schema_integrity_struct_type!(
                $integrity_name {
                    $( $integrity_normal_field : $integrity_normal_type, )*
                }
                integrity $integrity_field : $integrity_type;
                rules {
                    $( $integrity_rule_field : $integrity_rule ( $integrity_argument ); )*
                }
            );
        )*
        $( schema_enum_type!($enum_name { $( $enum_variant = $enum_tag, )* }); )*
        $( schema_union_type!($union_name { $( $union_variant($union_payload) = $union_tag, )* }); )*

        $(
            impl $crate::wire::Message for $message {
                const TYPE_TAG: u16 = $message_tag;
                const TYPE_NAME: &'static str = stringify!($message);
            }
        )*

        pub const fn is_known_message_tag(tag: u16) -> bool {
            let known = [$( $message_tag, )*];
            let mut index = 0;
            while index < known.len() {
                if known[index] == tag {
                    return true;
                }
                index += 1;
            }
            false
        }

        pub static TYPE_DESCRIPTORS: &[$crate::schema::TypeDescriptor] = &[
            $( <$id as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$bytes_name as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$unit as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$struct_name as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$integrity_name as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$enum_name as $crate::schema::ContractType>::DESCRIPTOR, )*
            $( <$union_name as $crate::schema::ContractType>::DESCRIPTOR, )*
        ];

        pub static MESSAGE_DESCRIPTORS: &[$crate::schema::MessageDescriptor] = &[
            $( $crate::schema::MessageDescriptor {
                type_name: stringify!($message),
                tag: $message_tag,
            }, )*
        ];

        pub static PROTOCOL_DESCRIPTOR: $crate::schema::ProtocolDescriptor =
            $crate::schema::ProtocolDescriptor {
                name: PROTOCOL_NAME,
                magic: MESSAGE_MAGIC,
                version: PROTOCOL_VERSION,
                max_message_bytes: MAX_MESSAGE_BYTES,
                trust_integrity_domain: TRUST_INTEGRITY_DOMAIN,
                schema_fingerprint: $crate::schema::compute_schema_fingerprint(
                    PROTOCOL_NAME,
                    MESSAGE_MAGIC,
                    PROTOCOL_VERSION,
                    MAX_MESSAGE_BYTES,
                    TRUST_INTEGRITY_DOMAIN,
                    TYPE_DESCRIPTORS,
                    MESSAGE_DESCRIPTORS,
                ),
                types: TYPE_DESCRIPTORS,
                messages: MESSAGE_DESCRIPTORS,
            };
    };
}
