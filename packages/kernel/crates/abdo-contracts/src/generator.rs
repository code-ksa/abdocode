//! Deterministic typed-ID generation from caller-owned entropy.
//!
//! This module never obtains or pretends to obtain entropy. The bootstrap host
//! supplies 128 random bits together with boot/run bindings. A process-lifetime
//! registry rejects duplicate seeds and derived namespaces before any ID can be
//! issued.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Mutex, OnceLock};

use crate::{BootId, RunId};

pub(crate) mod sealed {
    pub trait Sealed {}
}

/// Marker implemented only by the typed 128-bit IDs declared in the schema.
pub trait GeneratedId: sealed::Sealed + Copy + Ord {
    #[doc(hidden)]
    fn from_generated(raw: u128) -> Self;
}

/// A one-shot seed. It intentionally does not implement `Clone` or `Copy`.
pub struct GeneratorSeed {
    boot_id: BootId,
    run_id: RunId,
    entropy: [u8; 16],
}

impl GeneratorSeed {
    /// Bind caller-provided entropy to one boot and one process run.
    pub fn new(
        boot_id: BootId,
        run_id: RunId,
        entropy: [u8; 16],
    ) -> Result<Self, IdGenerationError> {
        if entropy.iter().all(|byte| *byte == 0) {
            return Err(IdGenerationError::ZeroEntropy);
        }
        Ok(Self {
            boot_id,
            run_id,
            entropy,
        })
    }

    pub const fn boot_id(&self) -> BootId {
        self.boot_id
    }

    pub const fn run_id(&self) -> RunId {
        self.run_id
    }
}

impl fmt::Debug for GeneratorSeed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratorSeed")
            .field("boot_id", &self.boot_id)
            .field("run_id", &self.run_id)
            .field("entropy", &"<opaque 128-bit caller seed>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdGenerationError {
    ZeroEntropy,
    DuplicateSeed,
    BaseCollision,
    SequenceCollision,
    RegistryUnavailable,
    CounterExhausted,
}

impl fmt::Display for IdGenerationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroEntropy => formatter.write_str("generator entropy must be non-zero"),
            Self::DuplicateSeed => formatter.write_str("generator seed was already claimed"),
            Self::BaseCollision => {
                formatter.write_str("generator base collides with an active process base")
            }
            Self::SequenceCollision => {
                formatter.write_str("generated ID collides with an issued process range")
            }
            Self::RegistryUnavailable => formatter.write_str("generator registry is unavailable"),
            Self::CounterExhausted => {
                formatter.write_str("generator counter is terminally exhausted")
            }
        }
    }
}

impl std::error::Error for IdGenerationError {}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct SeedFingerprint {
    boot_id: u128,
    run_id: u128,
    entropy: [u8; 16],
}

#[derive(Debug, Default)]
struct GeneratorRegistry {
    seeds: HashSet<SeedFingerprint>,
    bases: HashSet<u128>,
    ranges: HashMap<u64, IssuedRange>,
    next_registration: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct IssuedRange {
    first: Option<u128>,
    last: Option<u128>,
}

static REGISTRY: OnceLock<Mutex<GeneratorRegistry>> = OnceLock::new();

/// A claimed generator has no reseed operation and no clone operation.
#[derive(Debug)]
pub struct IdGenerator {
    base: u128,
    counter: u64,
    terminal_error: Option<IdGenerationError>,
    registration: u64,
}

impl IdGenerator {
    /// Consume and claim a seed exactly once for the life of this process.
    pub fn claim(seed: GeneratorSeed) -> Result<Self, IdGenerationError> {
        let fingerprint = SeedFingerprint {
            boot_id: seed.boot_id.get(),
            run_id: seed.run_id.get(),
            entropy: seed.entropy,
        };
        let base = derive_base(&fingerprint);
        if base == 0 {
            return Err(IdGenerationError::BaseCollision);
        }

        let mut registry = REGISTRY
            .get_or_init(|| Mutex::new(GeneratorRegistry::default()))
            .lock()
            .map_err(|_| IdGenerationError::RegistryUnavailable)?;
        if registry.seeds.contains(&fingerprint) {
            return Err(IdGenerationError::DuplicateSeed);
        }
        if registry.bases.contains(&base) {
            return Err(IdGenerationError::BaseCollision);
        }
        registry.seeds.insert(fingerprint);
        registry.bases.insert(base);
        let registration = registry
            .next_registration
            .checked_add(1)
            .ok_or(IdGenerationError::RegistryUnavailable)?;
        registry.next_registration = registration;
        registry.ranges.insert(registration, IssuedRange::default());

        Ok(Self {
            base,
            counter: 0,
            terminal_error: None,
            registration,
        })
    }

    /// Issue the next typed ID. One counter is shared across all ID kinds.
    pub fn issue<T: GeneratedId>(&mut self) -> Result<T, IdGenerationError> {
        if let Some(error) = self.terminal_error {
            return Err(error);
        }
        let Some(counter) = self.counter.checked_add(1) else {
            self.terminal_error = Some(IdGenerationError::CounterExhausted);
            return Err(IdGenerationError::CounterExhausted);
        };
        let Some(raw) = self.base.checked_add(u128::from(counter)) else {
            self.terminal_error = Some(IdGenerationError::CounterExhausted);
            return Err(IdGenerationError::CounterExhausted);
        };
        let mut registry = match REGISTRY
            .get_or_init(|| Mutex::new(GeneratorRegistry::default()))
            .lock()
        {
            Ok(registry) => registry,
            Err(_) => {
                self.terminal_error = Some(IdGenerationError::RegistryUnavailable);
                return Err(IdGenerationError::RegistryUnavailable);
            }
        };
        let collides = registry.ranges.iter().any(|(registration, range)| {
            *registration != self.registration
                && range
                    .first
                    .zip(range.last)
                    .is_some_and(|(first, last)| raw >= first && raw <= last)
        });
        if collides {
            self.terminal_error = Some(IdGenerationError::SequenceCollision);
            return Err(IdGenerationError::SequenceCollision);
        }
        let Some(range) = registry.ranges.get_mut(&self.registration) else {
            self.terminal_error = Some(IdGenerationError::RegistryUnavailable);
            return Err(IdGenerationError::RegistryUnavailable);
        };
        if range.first.is_none() {
            range.first = Some(raw);
        }
        range.last = Some(raw);
        self.counter = counter;
        Ok(T::from_generated(raw))
    }

    pub const fn issued_count(&self) -> u64 {
        self.counter
    }

    #[cfg(test)]
    fn set_counter_for_terminal_test(&mut self, counter: u64) {
        self.counter = counter;
    }

    #[cfg(test)]
    fn set_base_for_terminal_test(&mut self, base: u128) {
        self.base = base;
    }
}

/// Derive a full-width base by applying a reversible 128-bit permutation to
/// caller entropy combined with boot/run bindings. This preserves the caller's
/// 128-bit collision model for a fixed binding. It is not an entropy source, a
/// cryptographic digest, a signature, or an authority proof.
fn derive_base(seed: &SeedFingerprint) -> u128 {
    let entropy = u128::from_le_bytes(seed.entropy);
    let binding = seed.boot_id.rotate_left(29) ^ seed.run_id.rotate_left(83);
    permute128(entropy ^ binding)
}

fn permute128(mut value: u128) -> u128 {
    value ^= value >> 61;
    value = value.wrapping_mul(0xda94_2042_e4dd_58b5_d6e8_feb8_6659_fd93);
    value ^= value >> 47;
    value = value.wrapping_mul(0x9e37_79b9_7f4a_7c15_f39c_c060_5ced_c835);
    value ^ (value >> 53)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IntentId;

    fn seed(byte: u8) -> GeneratorSeed {
        GeneratorSeed::new(
            BootId::try_from_u128(0x1000 + u128::from(byte)).unwrap(),
            RunId::try_from_u128(0x2000 + u128::from(byte)).unwrap(),
            [byte; 16],
        )
        .unwrap()
    }

    #[test]
    fn rejects_zero_entropy_and_duplicate_seed_in_one_process() {
        assert_eq!(
            GeneratorSeed::new(
                BootId::try_from_u128(1).unwrap(),
                RunId::try_from_u128(2).unwrap(),
                [0; 16],
            )
            .unwrap_err(),
            IdGenerationError::ZeroEntropy
        );

        IdGenerator::claim(seed(0xa1)).unwrap();
        assert_eq!(
            IdGenerator::claim(seed(0xa1)).unwrap_err(),
            IdGenerationError::DuplicateSeed
        );
    }

    #[test]
    fn counter_overflow_is_terminal() {
        let mut generator = IdGenerator::claim(seed(0xa2)).unwrap();
        generator.set_counter_for_terminal_test(u64::MAX);
        assert_eq!(
            generator.issue::<IntentId>().unwrap_err(),
            IdGenerationError::CounterExhausted
        );
        assert_eq!(
            generator.issue::<IntentId>().unwrap_err(),
            IdGenerationError::CounterExhausted
        );
    }

    #[test]
    fn full_entropy_width_survives_a_colliding_u64_projection() {
        let first = SeedFingerprint {
            boot_id: 0x3100,
            run_id: 0x3200,
            entropy: 0x1111_1111_1111_1111_aaaa_aaaa_aaaa_aaaa_u128.to_le_bytes(),
        };
        let second = SeedFingerprint {
            boot_id: first.boot_id,
            run_id: first.run_id,
            entropy: 0x2222_2222_2222_2222_aaaa_aaaa_aaaa_aaaa_u128.to_le_bytes(),
        };
        let first_entropy = u128::from_le_bytes(first.entropy);
        let second_entropy = u128::from_le_bytes(second.entropy);
        assert_eq!(first_entropy as u64, second_entropy as u64);
        assert_ne!(derive_base(&first), derive_base(&second));
    }

    #[test]
    fn full_width_base_addition_overflow_is_terminal() {
        let mut generator = IdGenerator::claim(seed(0xa3)).unwrap();
        generator.set_base_for_terminal_test(u128::MAX);
        assert_eq!(
            generator.issue::<IntentId>().unwrap_err(),
            IdGenerationError::CounterExhausted
        );
        assert_eq!(
            generator.issue::<IntentId>().unwrap_err(),
            IdGenerationError::CounterExhausted
        );
    }

    #[test]
    fn adjacent_full_width_bases_fail_closed_before_an_overlap_is_issued() {
        let mut first = IdGenerator::claim(seed(0xa4)).unwrap();
        let mut second = IdGenerator::claim(seed(0xa5)).unwrap();
        first.set_base_for_terminal_test(0x1_0000);
        second.set_base_for_terminal_test(0x1_0001);

        assert_eq!(first.issue::<IntentId>().unwrap().get(), 0x1_0001);
        assert_eq!(first.issue::<IntentId>().unwrap().get(), 0x1_0002);
        assert_eq!(
            second.issue::<IntentId>().unwrap_err(),
            IdGenerationError::SequenceCollision
        );
        assert_eq!(
            second.issue::<IntentId>().unwrap_err(),
            IdGenerationError::SequenceCollision
        );
    }

    #[test]
    fn auditor_adjacent_seed_repro_is_rejected_in_the_opposite_issue_order() {
        let boot_id = BootId::try_from_u128(1).unwrap();
        let run_id = RunId::try_from_u128(2).unwrap();
        let seed_a = GeneratorSeed::new(
            boot_id,
            run_id,
            [
                0x52, 0xc5, 0x8f, 0xc1, 0xfa, 0x27, 0xf2, 0x2e, 0x28, 0x40, 0xef, 0x04, 0x65, 0xeb,
                0x4c, 0x70,
            ],
        )
        .unwrap();
        let seed_b = GeneratorSeed::new(
            boot_id,
            run_id,
            [
                0x5d, 0xb3, 0x13, 0x2d, 0x6a, 0xfa, 0xc4, 0x10, 0x47, 0x5f, 0x4c, 0x49, 0x21, 0x50,
                0x3c, 0xe7,
            ],
        )
        .unwrap();
        let mut first = IdGenerator::claim(seed_a).unwrap();
        let mut second = IdGenerator::claim(seed_b).unwrap();
        assert_eq!(first.base, 0x1000);
        assert_eq!(second.base, 0x1001);

        assert_eq!(second.issue::<IntentId>().unwrap().get(), 0x1002);
        assert_eq!(first.issue::<IntentId>().unwrap().get(), 0x1001);
        assert_eq!(
            first.issue::<IntentId>().unwrap_err(),
            IdGenerationError::SequenceCollision
        );
        assert_eq!(
            first.issue::<IntentId>().unwrap_err(),
            IdGenerationError::SequenceCollision
        );
    }

    #[test]
    fn same_process_multi_generator_stress_has_no_duplicate_issued_ranges() {
        const GENERATORS: usize = 4;
        const IDS_PER_GENERATOR: usize = 25_000;
        let mut generators = (0..GENERATORS)
            .map(|index| IdGenerator::claim(seed(0xb0 + index as u8)).unwrap())
            .collect::<Vec<_>>();
        let mut ids = Vec::with_capacity(GENERATORS * IDS_PER_GENERATOR);
        for _ in 0..IDS_PER_GENERATOR {
            for generator in &mut generators {
                ids.push(generator.issue::<IntentId>().unwrap().get());
            }
        }
        ids.sort_unstable();
        assert_eq!(ids.len(), GENERATORS * IDS_PER_GENERATOR);
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
