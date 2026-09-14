//! The supervisor: the only path an effect may take through its lifecycle.

use abdo_contracts::{Digest, IntentId};
use abdo_journal::{ChainHash, EffectAppendRequest, EffectId, EffectRecord, Journal, StreamId};
use abdo_kernel::EffectIntent;

use crate::authority::{AuthorityDecision, AuthorityPort, AuthorityRequest};
use crate::error::{RuntimeError, TransitionError};
use crate::phase::EffectPhase;

/// A durable outcome report from an adapter.
///
/// Separate from [`Verification`] on purpose: settling says the adapter
/// finished and what it claims happened. It does not say the claim is true.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub outcome_digest: Digest,
    pub settled_at_ms: u64,
}

/// The kernel checked the settled outcome against what the effect promised.
///
/// A settlement that is never verified stays visible as exactly that. Folding
/// these two into one flag is how a runtime starts believing adapters about
/// their own success.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Verification {
    pub postcondition_digest: Digest,
    pub verified_at_ms: u64,
}

/// What an adapter is asked to do. Implemented outside the trusted core.
pub trait Dispatcher {
    /// Perform the effect. Returning `None` means the adapter could not say
    /// what happened, which resolves to [`EffectPhase::UnknownOutcome`] rather
    /// than to a retry.
    fn dispatch(&mut self, intent_id: IntentId, operation_digest: Digest) -> Option<Settlement>;
}

macro_rules! token {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct $name {
            intent_id: IntentId,
            effect_id: EffectId,
            stream_id: StreamId,
            cause_event_hash: ChainHash,
        }

        impl $name {
            pub const fn intent_id(&self) -> IntentId {
                self.intent_id
            }
        }
    };
}

token!(
    /// The kernel has durably taken responsibility. Nothing observable yet.
    ///
    /// There is no public constructor. A caller cannot fabricate one, so the
    /// steps that follow are unreachable until a durable record exists: "no
    /// mutation before a durable prepare" is enforced by the type system rather
    /// than checked at the point of use.
    Prepared
);
token!(
    /// Authority granted this effect. Still nothing observable.
    Authorized
);
token!(
    /// The intent to dispatch is durable. The adapter has not run yet, and this
    /// is the only moment in the lifecycle where that distinction is invisible
    /// from the outside: after a crash here the kernel cannot know whether the
    /// world changed, which is exactly why the record exists.
    Dispatching
);
token!(
    /// The adapter returned control. The effect definitely started.
    Started
);
/// The adapter reported an outcome. Carries the claim, not a verdict on it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settled {
    intent_id: IntentId,
    effect_id: EffectId,
    stream_id: StreamId,
    cause_event_hash: ChainHash,
    settlement: Settlement,
}

impl Settled {
    pub const fn intent_id(&self) -> IntentId {
        self.intent_id
    }

    pub const fn settlement(&self) -> Settlement {
        self.settlement
    }
}

/// The outcome was checked against its postconditions.
///
/// Only a value of this type means the effect both finished and did what it
/// promised, and it can only be built by supplying both halves.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Verified {
    intent_id: IntentId,
    settlement: Settlement,
    verification: Verification,
}

impl Verified {
    pub const fn intent_id(&self) -> IntentId {
        self.intent_id
    }

    pub const fn settlement(&self) -> Settlement {
        self.settlement
    }

    pub const fn verification(&self) -> Verification {
        self.verification
    }
}

/// What a recovered ledger says about an effect.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Recovered {
    /// No durable record. The effect never began; starting it is safe.
    Fresh,
    /// Durable, but nothing observable happened. Continuing is safe.
    Resumable {
        phase: EffectPhase,
    },
    /// `Dispatching` is durable and no outcome followed.
    ///
    /// The adapter may have run. There is no API that turns this into a second
    /// dispatch; it is handed to reconciliation.
    UnknownOutcome,
    /// Settled, not yet verified. Visible as unfinished, never as done.
    AwaitingVerification {
        settlement: Settlement,
    },
    /// Reconciliation established what happened; postconditions still unchecked.
    Reconciled,
    /// Nobody could establish what happened. A person owns it, and it keeps
    /// being reported as unfinished until they answer.
    Escalated,
    /// A question was put to a person and no answer was recorded.
    ///
    /// Deliberately not [`Recovered::Resumable`]: resuming means carrying on,
    /// and there is nothing to carry on from. The question has to be asked
    /// again, and recovery that quietly continued would be answering it.
    AwaitingApproval,
    /// Refused. Nothing ran, and nothing may.
    Refused,
    Complete,
}

/// The supervisor itself. It holds no effect state: the ledger does.
#[derive(Clone, Copy, Debug, Default)]
pub struct EffectSupervisor;

impl EffectSupervisor {
    pub const fn new() -> Self {
        Self
    }

    /// Take durable responsibility for an owed effect.
    pub fn prepare(
        &self,
        journal: &mut Journal,
        intent: &EffectIntent,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        at_ms: u64,
    ) -> Result<Prepared, RuntimeError> {
        self.prepare_with(
            journal,
            intent,
            stream_id,
            cause_event_hash,
            at_ms,
            Write::Fresh,
        )
    }

    /// The same door, re-entered after a crash.
    ///
    /// Not a second way in: it walks the identical write with the identical
    /// transition rules, and the only difference is that a phase already
    /// standing in the ledger satisfies the step instead of failing it. That
    /// matters because S114 deleted the `Prepared -> Authorized` edge so there
    /// would be ONE door into authorisation, and a function that minted a token
    /// from a recovery verdict would have quietly built a second one — opened
    /// "only for recovery", which is still open.
    pub fn resume_prepare(
        &self,
        journal: &mut Journal,
        intent: &EffectIntent,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        at_ms: u64,
    ) -> Result<Prepared, RuntimeError> {
        self.prepare_with(
            journal,
            intent,
            stream_id,
            cause_event_hash,
            at_ms,
            Write::Resume,
        )
    }

    fn prepare_with(
        &self,
        journal: &mut Journal,
        intent: &EffectIntent,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        at_ms: u64,
        mode: Write,
    ) -> Result<Prepared, RuntimeError> {
        let effect_id = effect_id_of(intent.intent_id)?;
        self.write(
            mode,
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            EffectPhase::Prepared,
            None,
            &phase_payload(EffectPhase::Prepared, intent.operation_digest, at_ms),
            at_ms,
            intent.intent_id,
        )?;
        Ok(Prepared {
            intent_id: intent.intent_id,
            effect_id,
            stream_id,
            cause_event_hash,
        })
    }

    /// Ask authority. A denial is recorded and returned, never retried into a
    /// grant by the caller that asked.
    pub fn authorize(
        &self,
        journal: &mut Journal,
        prepared: Prepared,
        intent: &EffectIntent,
        authority: &dyn AuthorityPort,
        at_ms: u64,
    ) -> Result<Authorized, RuntimeError> {
        self.authorize_with(journal, prepared, intent, authority, at_ms, Write::Fresh)
    }

    /// Authorisation, re-entered after a crash.
    ///
    /// Authority is asked AGAIN, deliberately. A grant that was durable an hour
    /// ago is not a grant now — a capability can be revoked while a host is
    /// down, and a resume that skipped the question would carry an expired yes
    /// forward. Re-asking can only make the answer stricter.
    pub fn resume_authorize(
        &self,
        journal: &mut Journal,
        prepared: Prepared,
        intent: &EffectIntent,
        authority: &dyn AuthorityPort,
        at_ms: u64,
    ) -> Result<Authorized, RuntimeError> {
        self.authorize_with(journal, prepared, intent, authority, at_ms, Write::Resume)
    }

    #[allow(clippy::too_many_arguments)]
    fn authorize_with(
        &self,
        journal: &mut Journal,
        prepared: Prepared,
        intent: &EffectIntent,
        authority: &dyn AuthorityPort,
        at_ms: u64,
        mode: Write,
    ) -> Result<Authorized, RuntimeError> {
        let decision = authority.authorize(&AuthorityRequest {
            intent_id: prepared.intent_id,
            scope: &intent.scope,
            target: &intent.target,
            operation_digest: intent.operation_digest,
            at_ms,
            expires_at_ms: intent.expires_at_ms,
        });
        match decision {
            AuthorityDecision::Denied { reason_digest } => Err(RuntimeError::Denied {
                intent_id: prepared.intent_id,
                reason_digest,
            }),
            AuthorityDecision::Granted => {
                self.write(
                    mode,
                    journal,
                    prepared.effect_id,
                    prepared.stream_id,
                    prepared.cause_event_hash,
                    EffectPhase::Authorized,
                    Some(EffectPhase::Cleared),
                    &phase_payload(EffectPhase::Authorized, intent.operation_digest, at_ms),
                    at_ms,
                    prepared.intent_id,
                )?;
                Ok(Authorized {
                    intent_id: prepared.intent_id,
                    effect_id: prepared.effect_id,
                    stream_id: prepared.stream_id,
                    cause_event_hash: prepared.cause_event_hash,
                })
            }
        }
    }

    /// Commit the intent to dispatch, then dispatch.
    ///
    /// The order is the whole point. `Dispatching` is durable before the
    /// adapter is invoked, so a crash in the gap is recoverable as
    /// [`Recovered::UnknownOutcome`] instead of being indistinguishable from
    /// never having run.
    pub fn dispatch<D: Dispatcher>(
        &self,
        journal: &mut Journal,
        authorized: Authorized,
        intent: &EffectIntent,
        dispatcher: &mut D,
        at_ms: u64,
    ) -> Result<DispatchOutcome, RuntimeError> {
        if !cfg!(feature = "effectful-dispatch") {
            return Err(RuntimeError::DispatchDisabled {
                intent_id: authorized.intent_id,
            });
        }
        self.dispatch_unguarded(journal, authorized, intent, dispatcher, at_ms)
    }

    /// Commit the intent to dispatch, durably, before anything runs.
    ///
    /// This is the barrier. Everything before it is invisible to the world and
    /// freely retryable; everything after it must be reconciled rather than
    /// repeated.
    pub fn commit_dispatch(
        &self,
        journal: &mut Journal,
        authorized: Authorized,
        intent: &EffectIntent,
        at_ms: u64,
    ) -> Result<Dispatching, RuntimeError> {
        self.record(
            journal,
            authorized.effect_id,
            authorized.stream_id,
            authorized.cause_event_hash,
            EffectPhase::Dispatching,
            Some(EffectPhase::Authorized),
            &phase_payload(EffectPhase::Dispatching, intent.operation_digest, at_ms),
            at_ms,
            authorized.intent_id,
        )?;
        Ok(Dispatching {
            intent_id: authorized.intent_id,
            effect_id: authorized.effect_id,
            stream_id: authorized.stream_id,
            cause_event_hash: authorized.cause_event_hash,
        })
    }

    /// Invoke the adapter, and record nothing.
    ///
    /// Separate from [`EffectSupervisor::record_started`] on purpose. The gap
    /// between "the adapter ran" and "the ledger says it ran" is a real state a
    /// crash can land in, and a supervisor that did both in one call would make
    /// that state untestable: every gate would have to claim it and none could
    /// reach it.
    pub fn invoke<D: Dispatcher>(
        &self,
        dispatching: &Dispatching,
        intent: &EffectIntent,
        dispatcher: &mut D,
    ) -> AdapterReport {
        AdapterReport {
            settlement: dispatcher.dispatch(dispatching.intent_id, intent.operation_digest),
        }
    }

    /// Record what the adapter did, and resolve the effect.
    ///
    /// Takes `Dispatching` by value, so one committed dispatch is recorded at
    /// most once per token. There is no way to obtain a second token for the
    /// same effect: the ledger refuses a repeated `Dispatching` phase.
    pub fn record_started(
        &self,
        journal: &mut Journal,
        dispatching: Dispatching,
        intent: &EffectIntent,
        report: AdapterReport,
        at_ms: u64,
    ) -> Result<DispatchOutcome, RuntimeError> {
        let reported = report.settlement;

        self.record(
            journal,
            dispatching.effect_id,
            dispatching.stream_id,
            dispatching.cause_event_hash,
            EffectPhase::Started,
            Some(EffectPhase::Dispatching),
            &phase_payload(EffectPhase::Started, intent.operation_digest, at_ms),
            at_ms,
            dispatching.intent_id,
        )?;
        let started = Started {
            intent_id: dispatching.intent_id,
            effect_id: dispatching.effect_id,
            stream_id: dispatching.stream_id,
            cause_event_hash: dispatching.cause_event_hash,
        };

        match reported {
            Some(settlement) => Ok(DispatchOutcome::Settled(
                self.settle(journal, started, settlement)?,
            )),
            None => {
                self.record(
                    journal,
                    started.effect_id,
                    started.stream_id,
                    started.cause_event_hash,
                    EffectPhase::UnknownOutcome,
                    Some(EffectPhase::Started),
                    &phase_payload(EffectPhase::UnknownOutcome, intent.operation_digest, at_ms),
                    at_ms,
                    started.intent_id,
                )?;
                Ok(DispatchOutcome::Unknown {
                    intent_id: started.intent_id,
                })
            }
        }
    }

    /// Invoke the adapter and record the result, in one call.
    ///
    /// A convenience over the two halves, for callers with nothing to do
    /// between them.
    pub fn run<D: Dispatcher>(
        &self,
        journal: &mut Journal,
        dispatching: Dispatching,
        intent: &EffectIntent,
        dispatcher: &mut D,
        at_ms: u64,
    ) -> Result<DispatchOutcome, RuntimeError> {
        let report = self.invoke(&dispatching, intent, dispatcher);
        self.record_started(journal, dispatching, intent, report, at_ms)
    }

    fn dispatch_unguarded<D: Dispatcher>(
        &self,
        journal: &mut Journal,
        authorized: Authorized,
        intent: &EffectIntent,
        dispatcher: &mut D,
        at_ms: u64,
    ) -> Result<DispatchOutcome, RuntimeError> {
        let dispatching = self.commit_dispatch(journal, authorized, intent, at_ms)?;
        self.run(journal, dispatching, intent, dispatcher, at_ms)
    }

    pub fn settle(
        &self,
        journal: &mut Journal,
        started: Started,
        settlement: Settlement,
    ) -> Result<Settled, RuntimeError> {
        self.record(
            journal,
            started.effect_id,
            started.stream_id,
            started.cause_event_hash,
            EffectPhase::Settled,
            Some(EffectPhase::Started),
            &phase_payload(
                EffectPhase::Settled,
                settlement.outcome_digest,
                settlement.settled_at_ms,
            ),
            settlement.settled_at_ms,
            started.intent_id,
        )?;
        Ok(Settled {
            intent_id: started.intent_id,
            effect_id: started.effect_id,
            stream_id: started.stream_id,
            cause_event_hash: started.cause_event_hash,
            settlement,
        })
    }

    pub fn verify(
        &self,
        journal: &mut Journal,
        settled: Settled,
        verification: Verification,
    ) -> Result<Verified, RuntimeError> {
        self.record(
            journal,
            settled.effect_id,
            settled.stream_id,
            settled.cause_event_hash,
            EffectPhase::Verified,
            Some(EffectPhase::Settled),
            &phase_payload(
                EffectPhase::Verified,
                verification.postcondition_digest,
                verification.verified_at_ms,
            ),
            verification.verified_at_ms,
            settled.intent_id,
        )?;
        Ok(Verified {
            intent_id: settled.intent_id,
            settlement: settled.settlement,
            verification,
        })
    }

    /// Record a reconciliation conclusion durably.
    ///
    /// Only reconciliation may reach these phases, and it reaches them without
    /// a dispatcher: the argument list has no adapter in it, so no conclusion
    /// can smuggle in a second touch of the world.
    pub fn record_reconciliation(
        &self,
        journal: &mut Journal,
        intent_id: IntentId,
        phase: EffectPhase,
        from: EffectPhase,
        digest: Digest,
        at_ms: u64,
    ) -> Result<(), RuntimeError> {
        let effect_id = effect_id_of(intent_id)?;
        let history = journal.effect_history(effect_id)?;
        let anchor = history
            .first()
            .ok_or_else(|| RuntimeError::Corrupt("reconciled effect has no history".into()))?;
        let stream_id = anchor.stream_id;
        let cause_event_hash = anchor.cause_event_hash;
        self.record(
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            phase,
            Some(from),
            &phase_payload(phase, digest, at_ms),
            at_ms,
            intent_id,
        )
    }

    /// Read the ledger and say what may safely happen next.
    pub fn recover(
        &self,
        journal: &Journal,
        intent_id: IntentId,
    ) -> Result<Recovered, RuntimeError> {
        let effect_id = effect_id_of(intent_id)?;
        let history = journal.effect_history(effect_id)?;
        classify(&history)
    }

    #[allow(clippy::too_many_arguments)]
    /// Every phase this supervisor writes goes through here, freshly.
    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        journal: &mut Journal,
        effect_id: EffectId,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        phase: EffectPhase,
        expected_previous: Option<EffectPhase>,
        payload: &[u8],
        at_ms: u64,
        intent_id: IntentId,
    ) -> Result<(), RuntimeError> {
        self.write(
            Write::Fresh,
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            phase,
            expected_previous,
            payload,
            at_ms,
            intent_id,
        )
    }

    /// The same write, with the mode named by the caller.
    ///
    /// Only the pre-dispatch doors ever pass `Resume`, and only a host that has
    /// already been told `Recovered::Resumable` calls those.
    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        mode: Write,
        journal: &mut Journal,
        effect_id: EffectId,
        stream_id: StreamId,
        cause_event_hash: ChainHash,
        phase: EffectPhase,
        expected_previous: Option<EffectPhase>,
        payload: &[u8],
        at_ms: u64,
        intent_id: IntentId,
    ) -> Result<(), RuntimeError> {
        append_phase(
            journal,
            effect_id,
            stream_id,
            cause_event_hash,
            phase,
            expected_previous,
            payload,
            at_ms,
            intent_id,
            mode,
        )
    }
}

/// Whether this write is starting something or carrying on with it.
///
/// `Resume` exists for exactly one caller: a host that has already asked the
/// ledger and been told [`Recovered::Resumable`] — durable, nothing observable
/// happened. It is NOT a general tolerance. The schema's own comment says
/// `UNIQUE (intent_id, phase_tag)` is the exactly-once guarantee, held by the
/// database rather than by a check in code that a crash can skip, and a
/// primitive that forgave a repeated phase everywhere would dissolve it: a
/// blind retry would walk silently forward through phases it never performed,
/// which is what `no_blind_retry` exists to prevent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Write {
    Fresh,
    Resume,
}

/// Append one phase, or accept that it is already there.
///
/// One writer, used by the supervisor and the gatekeeper both.
///
/// There were two, byte-identical down to the payload encoder, and they had to
/// be merged before resumption could be added — otherwise the rule about when a
/// durable phase may be re-entered would have lived in two places, which is
/// this repository's most expensive defect class by its own count. Two copies
/// of a safety rule disagree the first time either is tuned, and each passes
/// its own tests while doing it.
///
/// In `Resume` mode the durability check comes FIRST, before the transition
/// check, and that ordering is the whole mechanism. A resumed walk re-enters at
/// `Prepared` while the ledger already stands at `Authorized`, so the
/// transition check would reject it for going backwards before anything had a
/// chance to notice that the phase is already recorded.
///
/// What it will not forgive is a different operation under the same intent. The
/// durable payload carries the operation digest, so a resume of something else
/// wearing this intent's id is a real conflict and stays an error. The
/// timestamps legitimately differ — a resume happens at a different moment —
/// so they are not compared.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_phase(
    journal: &mut Journal,
    effect_id: EffectId,
    stream_id: StreamId,
    cause_event_hash: ChainHash,
    phase: EffectPhase,
    expected_previous: Option<EffectPhase>,
    payload: &[u8],
    at_ms: u64,
    intent_id: IntentId,
    mode: Write,
) -> Result<(), RuntimeError> {
    let history = journal.effect_history(effect_id)?;

    if mode == Write::Resume {
        if let Some(existing) = history.iter().find(|record| {
            phase_of(record)
                .map(|found| found == phase)
                .unwrap_or(false)
        }) {
            let (durable_digest, _) = decode_payload(&existing.payload)?;
            let (incoming_digest, _) = decode_payload(payload)?;
            if durable_digest != incoming_digest {
                return Err(RuntimeError::Transition(TransitionError {
                    intent_id,
                    from: Some(phase),
                    to: phase,
                }));
            }
            return Ok(());
        }
    }

    let current = history.last().map(phase_of).transpose()?;
    if current != expected_previous {
        return Err(RuntimeError::Transition(TransitionError {
            intent_id,
            from: current,
            to: phase,
        }));
    }
    if let Some(from) = current {
        if !from.may_precede(phase) {
            return Err(RuntimeError::Transition(TransitionError {
                intent_id,
                from: Some(from),
                to: phase,
            }));
        }
    }
    journal
        .append_effect(EffectAppendRequest {
            effect_id,
            phase_tag: phase.journal_tag(),
            stream_id,
            cause_event_hash,
            payload,
            at_ms,
        })
        .map(|_| ())
        .map_err(|source| match source {
            abdo_journal::JournalError::Sqlite { .. } => {
                RuntimeError::AlreadyRecorded { intent_id, phase }
            }
            other => RuntimeError::Journal(other),
        })
}

/// What the adapter said, before anything was written down.
///
/// Holding this and nothing else is the state a crash can land in between the
/// adapter returning and the ledger recording it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdapterReport {
    settlement: Option<Settlement>,
}

impl AdapterReport {
    /// Did the adapter say what happened?
    pub const fn is_reported(&self) -> bool {
        self.settlement.is_some()
    }
}

/// What one dispatch produced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchOutcome {
    Settled(Settled),
    /// Recorded, surfaced, and never silently retried.
    Unknown {
        intent_id: IntentId,
    },
}

fn classify(history: &[EffectRecord]) -> Result<Recovered, RuntimeError> {
    let mut phases = Vec::with_capacity(history.len());
    for record in history {
        phases.push(phase_of(record)?);
    }
    let Some(last) = phases.last().copied() else {
        return Ok(Recovered::Fresh);
    };
    Ok(match last {
        EffectPhase::Prepared | EffectPhase::Cleared | EffectPhase::Authorized => {
            Recovered::Resumable { phase: last }
        }
        // Asked, unanswered. The kernel does not get to supply the answer.
        EffectPhase::ApprovalAsked => Recovered::AwaitingApproval,
        EffectPhase::ApprovalRefused => Recovered::Refused,
        // Dispatching or Started without an outcome: the adapter may have run.
        EffectPhase::Dispatching | EffectPhase::Started | EffectPhase::UnknownOutcome => {
            Recovered::UnknownOutcome
        }
        EffectPhase::Settled => Recovered::AwaitingVerification {
            settlement: settlement_from(history)?,
        },
        // Escalated is not resolved: a person still owes an answer, so recovery
        // keeps reporting it as unfinished.
        EffectPhase::Escalated => Recovered::Escalated,
        EffectPhase::Reconciled => Recovered::Reconciled,
        EffectPhase::Verified | EffectPhase::Compensated => Recovered::Complete,
    })
}

fn settlement_from(history: &[EffectRecord]) -> Result<Settlement, RuntimeError> {
    let record = history
        .iter()
        .find(|record| record.phase_tag.get() == EffectPhase::Settled.tag())
        .ok_or_else(|| RuntimeError::Corrupt("settled phase is missing its record".into()))?;
    let (digest, at_ms) = decode_payload(&record.payload)?;
    Ok(Settlement {
        outcome_digest: digest,
        settled_at_ms: at_ms,
    })
}

pub(crate) fn phase_of(record: &EffectRecord) -> Result<EffectPhase, RuntimeError> {
    EffectPhase::from_tag(record.phase_tag.get()).ok_or_else(|| {
        RuntimeError::Corrupt(format!(
            "unknown effect phase tag {}",
            record.phase_tag.get()
        ))
    })
}

pub(crate) fn effect_id_of(intent_id: IntentId) -> Result<EffectId, RuntimeError> {
    EffectId::try_from_u128(intent_id.get())
        .map_err(|reason| RuntimeError::Corrupt(reason.to_owned()))
}

/// Canonical phase payload: the phase tag, a digest, and the time claimed.
pub(crate) fn phase_payload(phase: EffectPhase, digest: Digest, at_ms: u64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(41);
    bytes.push(phase.tag());
    bytes.extend_from_slice(digest.as_bytes());
    bytes.extend_from_slice(&at_ms.to_be_bytes());
    bytes
}

fn decode_payload(bytes: &[u8]) -> Result<(Digest, u64), RuntimeError> {
    if bytes.len() != 41 {
        return Err(RuntimeError::Corrupt(
            "phase payload is the wrong size".into(),
        ));
    }
    let mut digest = [0_u8; 32];
    digest.copy_from_slice(&bytes[1..33]);
    let mut at_ms = [0_u8; 8];
    at_ms.copy_from_slice(&bytes[33..41]);
    Ok((Digest::from_bytes(digest), u64::from_be_bytes(at_ms)))
}
