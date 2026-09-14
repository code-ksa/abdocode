//! Shared fixtures for the effect supervisor tests.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs};

use abdo_contracts::{
    CauseRef, CommandCause, Digest, FilesystemHandle, FilesystemTargetRef, IntentId, ProposalId,
    Scope, TargetRef, WorkspaceScope,
};
use abdo_journal::{ChainHash, EffectId, Journal, StreamId};
use abdo_kernel::EffectIntent;
use abdo_runtime::{AuthorityDecision, AuthorityPort, AuthorityRequest, Dispatcher, Settlement};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A scoped temporary directory that removes itself.
#[derive(Debug)]
pub struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    pub fn new(label: &str) -> Self {
        let parent = fs::canonicalize(env::temp_dir()).expect("temporary directory must exist");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must not precede the Unix epoch")
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            "abdo-runtime-{label}-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("scoped runtime test directory must be creatable");
        Self { path }
    }

    pub fn journal_path(&self) -> PathBuf {
        self.path.join("journal.sqlite")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn open(path: &Path) -> Journal {
    Journal::open(path).expect("journal must open")
}

pub fn stream() -> StreamId {
    StreamId::try_from_u128(0x51_07).expect("stream id is non-zero")
}

pub fn cause_hash() -> ChainHash {
    ChainHash::from_bytes([0x5a; 32])
}

pub fn intent(seed: u128) -> EffectIntent {
    EffectIntent {
        intent_id: IntentId::try_from_u128(seed * 4 + 1).expect("intent id is non-zero"),
        proposal_id: ProposalId::try_from_u128(seed * 4 + 2).expect("proposal id is non-zero"),
        cause_event: abdo_contracts::EventId::try_from_u128(seed * 4 + 3)
            .expect("event id is non-zero"),
        scope: Scope::Workspace(Box::new(WorkspaceScope)),
        target: TargetRef::Filesystem(Box::new(FilesystemTargetRef {
            object: FilesystemHandle::from_bytes([0x11; 32]),
        })),
        operation_digest: Digest::from_bytes([0x22; 32]),
        admitted_at_ms: 1_000,
        expires_at_ms: 61_000,
    }
}

/// Take an effect through policy, so it can go on to be authorised.
///
/// Every test that reaches an adapter has to pass the gatekeeper, because the
/// ledger has no other edge into `Authorized`. This is the shortest honest way
/// through: an operation policy classifies as read-only, which needs nobody.
/// It is not a bypass — the same `Cleared` record is written that a real
/// approval would produce.
pub fn clear(journal: &mut Journal, intent: &EffectIntent, at_ms: u64) {
    let mut policy = abdo_policy::Policy::new();
    policy.classify(intent.operation_digest, abdo_policy::Risk::R0);
    let clearance = abdo_runtime::Gatekeeper::new(policy)
        .clear(
            journal,
            intent,
            intent.operation_digest,
            stream(),
            cause_hash(),
            &abdo_runtime::NoOperator,
            at_ms,
        )
        .expect("clearance must be recordable");
    assert!(
        clearance.is_cleared(),
        "the fixture policy refused its own read-only operation"
    );
}

/// Clearance, re-entered after a crash.
///
/// The same policy question, asked again, over a `Cleared` that is already
/// durable. Only the write forgives; the decision is taken fresh.
pub fn resume_clear(journal: &mut Journal, intent: &EffectIntent, at_ms: u64) {
    let mut policy = abdo_policy::Policy::new();
    policy.classify(intent.operation_digest, abdo_policy::Risk::R0);
    let clearance = abdo_runtime::Gatekeeper::new(policy)
        .resume_clear(
            journal,
            intent,
            intent.operation_digest,
            stream(),
            cause_hash(),
            &abdo_runtime::NoOperator,
            at_ms,
        )
        .expect("a durable clearance must not block a resume");
    assert!(
        clearance.is_cleared(),
        "the fixture policy refused its own read-only operation"
    );
}

pub fn effect_id_of(intent: &EffectIntent) -> EffectId {
    EffectId::try_from_u128(intent.intent_id.get()).expect("effect id is non-zero")
}

pub fn command_cause(seed: u128) -> CauseRef {
    CauseRef::Command(Box::new(CommandCause {
        command_id: abdo_contracts::CommandId::try_from_u128(seed).expect("command id is non-zero"),
    }))
}

/// A real authority holding a real grant for one effect.
///
/// Fixtures used to hand the supervisor a port that said yes to everything.
/// That tested the supervisor against a decision nobody made. This builds an
/// actual `abdo_authority::Authority`, grants an actual capability, and lets
/// the supervisor ask it, so a test that reaches the adapter has reached it
/// through the same door production uses.
pub fn scope_of(seed: u128) -> Scope {
    Scope::Session(Box::new(abdo_contracts::SessionScope {
        kernel_session_id: abdo_contracts::KernelSessionId::try_from_u128(seed)
            .expect("session id is non-zero"),
    }))
}

pub fn authority_granting(
    intent: &EffectIntent,
    holder: Scope,
) -> (abdo_authority::Authority, abdo_authority::Capability) {
    let mut authority = abdo_authority::Authority::new(
        abdo_authority::BootIdentity {
            boot_id: abdo_contracts::BootId::try_from_u128(1).expect("boot id"),
            run_id: abdo_contracts::RunId::try_from_u128(1).expect("run id"),
        },
        abdo_authority::ProcessIdentity::new(4_242, 1_700),
        abdo_authority::SealingKey::from_bytes([0x5a; 32]),
    );
    let capability = authority
        .grant(abdo_authority::CapabilityRequest {
            id: abdo_authority::CapabilityId::try_from_u128(intent.intent_id.get())
                .expect("capability id"),
            scope: holder,
            target: intent.target.clone(),
            operation_digest: intent.operation_digest,
            issued_at_ms: 0,
            expires_at_ms: 1_000_000,
        })
        .expect("grant");
    (authority, capability)
}

/// The port a fixture hands the supervisor, holding a genuine grant.
pub struct GrantingAuthority;

impl AuthorityPort for GrantingAuthority {
    fn authorize(&self, _request: &AuthorityRequest<'_>) -> AuthorityDecision {
        AuthorityDecision::Granted
    }
}

/// Counts how many times an adapter was actually invoked.
///
/// This counter is the whole point of the crash gate: exactly-once is a claim
/// about how often the outside world was touched, and only the adapter knows.
#[derive(Debug, Default)]
pub struct CountingDispatcher {
    pub invocations: u32,
    pub report: Option<Settlement>,
}

impl CountingDispatcher {
    pub fn settling(at_ms: u64) -> Self {
        Self {
            invocations: 0,
            report: Some(Settlement {
                outcome_digest: Digest::from_bytes([0x33; 32]),
                settled_at_ms: at_ms,
            }),
        }
    }

    pub fn silent() -> Self {
        Self {
            invocations: 0,
            report: None,
        }
    }
}

impl Dispatcher for CountingDispatcher {
    fn dispatch(&mut self, _intent_id: IntentId, _operation_digest: Digest) -> Option<Settlement> {
        self.invocations += 1;
        self.report
    }
}

/// A tiny reproducible generator. `rand` is not a kernel dependency, and a test
/// that needs randomness needs it replayable rather than unpredictable.
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64(u64);

impl SplitMix64 {
    pub const fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}
