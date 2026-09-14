//! Durable bridge for product adapters that execute outside the Rust process.
//!
//! The shell supplies only identities and digests. This module owns lifecycle
//! transitions in the same `journal_effects` chain as the native host and
//! commits `Dispatching` before an external adapter may run.

use std::path::Path;

use abdo_contracts::{Digest, IntentId};
use abdo_journal::{ChainHash, EffectId, EffectRecord, Journal, StreamId};

use crate::error::RuntimeError;
use crate::phase::EffectPhase;
use crate::supervisor::{append_phase, phase_of, phase_payload, Write};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdapterEffect {
    pub effect_id: EffectId,
    pub operation_digest: Digest,
    pub at_ms: u64,
}

impl AdapterEffect {
    pub fn from_hex(id: &str, digest: &str, at_ms: u64) -> Result<Self, String> {
        let value =
            u128::from_str_radix(id, 16).map_err(|_| "effect id must be 32 hex characters")?;
        if id.len() != 32 {
            return Err("effect id must be 32 hex characters".into());
        }
        Ok(Self {
            effect_id: EffectId::try_from_u128(value).map_err(str::to_owned)?,
            operation_digest: adapter_digest_from_hex(digest)?,
            at_ms,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AdapterRecoveryReport {
    pub scanned: u64,
    pub unresolved: u64,
    pub marked_unknown: u64,
    pub resumable_without_dispatch: u64,
}

#[derive(Debug)]
pub struct AdapterLedger {
    journal: Journal,
}

impl AdapterLedger {
    pub fn open(path: &Path) -> Result<Self, RuntimeError> {
        Ok(Self {
            journal: Journal::open(path)?,
        })
    }

    /// Persist the complete pre-effect chain. Success is the permit to invoke
    /// the adapter; it cannot be returned before `Dispatching` is committed.
    pub fn begin(&mut self, effect: AdapterEffect) -> Result<(), RuntimeError> {
        let intent_id = intent_id(effect.effect_id)?;
        let stream_id = stream_id(effect.effect_id)?;
        let cause = ChainHash::from_bytes(*effect.operation_digest.as_bytes());
        let phases = [
            (EffectPhase::Prepared, None),
            (EffectPhase::Cleared, Some(EffectPhase::Prepared)),
            (EffectPhase::Authorized, Some(EffectPhase::Cleared)),
            (EffectPhase::Dispatching, Some(EffectPhase::Authorized)),
        ];
        for (offset, (phase, previous)) in phases.into_iter().enumerate() {
            let at_ms = effect.at_ms.saturating_add(offset as u64);
            append_phase(
                &mut self.journal,
                effect.effect_id,
                stream_id,
                cause,
                phase,
                previous,
                &phase_payload(phase, effect.operation_digest, at_ms),
                at_ms,
                intent_id,
                Write::Fresh,
            )?;
        }
        Ok(())
    }

    /// Close a known adapter outcome. The original operation digest must match
    /// the durable prepare record, so an effect id cannot be rebound.
    pub fn settle(
        &mut self,
        effect: AdapterEffect,
        outcome_digest: Digest,
    ) -> Result<(), RuntimeError> {
        let history = self.checked_history(effect.effect_id, effect.operation_digest)?;
        let last = last_phase(&history)?;
        if last == Some(EffectPhase::Verified) {
            return Ok(());
        }
        if last != Some(EffectPhase::Dispatching) {
            return Err(transition(effect.effect_id, last, EffectPhase::Started)?);
        }
        let intent_id = intent_id(effect.effect_id)?;
        let first = history
            .first()
            .ok_or_else(|| RuntimeError::Corrupt("adapter effect has no prepare record".into()))?;
        let steps = [
            (EffectPhase::Started, EffectPhase::Dispatching),
            (EffectPhase::Settled, EffectPhase::Started),
            (EffectPhase::Verified, EffectPhase::Settled),
        ];
        for (offset, (phase, previous)) in steps.into_iter().enumerate() {
            let at_ms = effect.at_ms.saturating_add(offset as u64);
            append_phase(
                &mut self.journal,
                effect.effect_id,
                first.stream_id,
                first.cause_event_hash,
                phase,
                Some(previous),
                &phase_payload(phase, outcome_digest, at_ms),
                at_ms,
                intent_id,
                Write::Fresh,
            )?;
        }
        Ok(())
    }

    /// Record ambiguity without retrying. Repeating the same notification is
    /// idempotent because `UnknownOutcome` is already the durable answer.
    pub fn mark_unknown(
        &mut self,
        effect: AdapterEffect,
        reason_digest: Digest,
    ) -> Result<(), RuntimeError> {
        let history = self.checked_history(effect.effect_id, effect.operation_digest)?;
        let last = last_phase(&history)?;
        if last == Some(EffectPhase::UnknownOutcome) {
            return Ok(());
        }
        let previous = match last {
            Some(EffectPhase::Dispatching) => EffectPhase::Dispatching,
            Some(EffectPhase::Started) => EffectPhase::Started,
            other => {
                return Err(transition(
                    effect.effect_id,
                    other,
                    EffectPhase::UnknownOutcome,
                )?)
            }
        };
        let first = history
            .first()
            .ok_or_else(|| RuntimeError::Corrupt("adapter effect has no prepare record".into()))?;
        append_phase(
            &mut self.journal,
            effect.effect_id,
            first.stream_id,
            first.cause_event_hash,
            EffectPhase::UnknownOutcome,
            Some(previous),
            &phase_payload(EffectPhase::UnknownOutcome, reason_digest, effect.at_ms),
            effect.at_ms,
            intent_id(effect.effect_id)?,
            Write::Fresh,
        )
    }

    /// Sweep at startup. Anything lost after the dispatch barrier becomes an
    /// explicit unknown outcome and is surfaced, never re-dispatched.
    pub fn recover(&mut self, at_ms: u64) -> Result<AdapterRecoveryReport, RuntimeError> {
        let mut report = AdapterRecoveryReport::default();
        for effect_id in self.journal.effect_ids()? {
            report.scanned += 1;
            let history = self.journal.effect_history(effect_id)?;
            let last = last_phase(&history)?;
            match last {
                Some(EffectPhase::Dispatching | EffectPhase::Started) => {
                    report.unresolved += 1;
                    let digest = operation_digest(&history)?;
                    self.mark_unknown(
                        AdapterEffect {
                            effect_id,
                            operation_digest: digest,
                            at_ms,
                        },
                        digest,
                    )?;
                    report.marked_unknown += 1;
                }
                Some(EffectPhase::UnknownOutcome | EffectPhase::Escalated) => {
                    report.unresolved += 1
                }
                Some(EffectPhase::Settled | EffectPhase::Reconciled) => report.unresolved += 1,
                Some(EffectPhase::Prepared | EffectPhase::Cleared | EffectPhase::Authorized) => {
                    report.resumable_without_dispatch += 1;
                }
                _ => {}
            }
        }
        Ok(report)
    }

    fn checked_history(
        &self,
        effect_id: EffectId,
        operation: Digest,
    ) -> Result<Vec<EffectRecord>, RuntimeError> {
        let history = self.journal.effect_history(effect_id)?;
        if operation_digest(&history)? != operation {
            return Err(RuntimeError::Corrupt(
                "adapter effect id was rebound to another operation".into(),
            ));
        }
        Ok(history)
    }
}

fn operation_digest(history: &[EffectRecord]) -> Result<Digest, RuntimeError> {
    let first = history
        .first()
        .ok_or_else(|| RuntimeError::Corrupt("adapter effect has no history".into()))?;
    if first.phase_tag.get() != EffectPhase::Prepared.tag() || first.payload.len() != 41 {
        return Err(RuntimeError::Corrupt(
            "adapter prepare payload is invalid".into(),
        ));
    }
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&first.payload[1..33]);
    Ok(Digest::from_bytes(bytes))
}

fn last_phase(history: &[EffectRecord]) -> Result<Option<EffectPhase>, RuntimeError> {
    history.last().map(phase_of).transpose()
}

fn intent_id(effect_id: EffectId) -> Result<IntentId, RuntimeError> {
    IntentId::try_from_u128(effect_id.get())
        .map_err(|reason| RuntimeError::Corrupt(reason.to_owned()))
}

fn stream_id(effect_id: EffectId) -> Result<StreamId, RuntimeError> {
    StreamId::try_from_u128(effect_id.get())
        .map_err(|reason| RuntimeError::Corrupt(reason.to_owned()))
}

fn transition(
    effect_id: EffectId,
    from: Option<EffectPhase>,
    to: EffectPhase,
) -> Result<RuntimeError, RuntimeError> {
    Ok(RuntimeError::Transition(crate::TransitionError {
        intent_id: intent_id(effect_id)?,
        from,
        to,
    }))
}

pub fn adapter_digest_from_hex(value: &str) -> Result<Digest, String> {
    if value.len() != 64 {
        return Err("digest must be 64 hex characters".into());
    }
    let mut bytes = [0_u8; 32];
    for (index, slot) in bytes.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "digest must be lowercase hexadecimal")?;
    }
    Ok(Digest::from_bytes(bytes))
}
