//! The session actor and the immutable snapshot it hands to the engine.
//!
//! # Turn, step, round
//!
//! These three words are used loosely almost everywhere, and the looseness is
//! expensive: it makes "the model was asked again" ambiguous between *there was
//! more to do* and *the connection dropped*. Here they are defined, and the
//! definitions are what the counters mean:
//!
//! - a **turn** runs from an accepted input until the agent yields control;
//! - a **step** is one model request-and-response inside a turn;
//! - a **round** is one attempt at a step. A transport failure retried is a new
//!   round of the same step, never a new step.
//!
//! The distinction earns its keep immediately: configuration is applied at step
//! boundaries only, so a retry cannot silently change the rules under a request
//! that is already in flight.
//!
//! # One writer
//!
//! A session has exactly one actor, and the actor holds a [`SessionWriter`] that
//! cannot be copied, cloned or constructed outside this module. Two writers to
//! one session is not a race to be detected and reported; it is a value that
//! cannot be brought into existence.

use std::collections::BTreeMap;
use std::fmt;

use abdo_contracts::{Digest, KernelSessionId, PolicyHandle, StateHandle};
use abdo_journal::{ChainHash, StreamId};
use abdo_kernel::Fingerprint;

use crate::error::RuntimeError;

/// Version of the snapshot encoding. Changing the layout must bump it.
pub const SNAPSHOT_VERSION: u16 = 1;

/// Proof that the holder is the one writer for a session.
///
/// Deliberately not `Clone`, not `Copy` and not constructible outside this
/// module. Handing one out twice is impossible rather than merely forbidden.
#[derive(Debug)]
pub struct SessionWriter {
    session_id: KernelSessionId,
}

impl SessionWriter {
    pub const fn session_id(&self) -> KernelSessionId {
        self.session_id
    }
}

/// Where a session is in the turn/step/round hierarchy.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StepCursor {
    pub turn: u64,
    pub step: u64,
    pub round: u64,
}

impl fmt::Display for StepCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "t{}.s{}.r{}", self.turn, self.step, self.round)
    }
}

/// The configuration a step runs under.
///
/// Carried as digests and opaque handles: the actor decides *when* a
/// configuration takes effect and never needs to read what is in it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionConfig {
    pub config_digest: Digest,
    pub policy: PolicyHandle,
    pub policy_digest: Digest,
}

/// An immutable description of one step, handed to the engine.
///
/// Immutable is the point. The engine may hold it for as long as a model call
/// takes; if the actor could edit it in place, the engine would be reasoning
/// about a configuration that no longer exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StepSnapshot {
    pub session_id: KernelSessionId,
    pub stream_id: StreamId,
    pub cursor: StepCursor,
    pub config: SessionConfig,
    pub state: StateHandle,
    pub state_digest: Digest,
    /// Head of the session stream when the snapshot was taken.
    pub journal_head: ChainHash,
    pub taken_at_ms: u64,
}

impl StepSnapshot {
    /// The canonical bytes of this snapshot.
    ///
    /// This is the handover format. When the Bun client exists in S110 it will
    /// receive exactly these bytes; defining them now, with a fingerprint, is
    /// what makes "the snapshot is stable" checkable before there is a
    /// transport to check it over.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(200);
        bytes.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.session_id.get().to_be_bytes());
        bytes.extend_from_slice(&self.stream_id.to_be_bytes());
        bytes.extend_from_slice(&self.cursor.turn.to_be_bytes());
        bytes.extend_from_slice(&self.cursor.step.to_be_bytes());
        bytes.extend_from_slice(&self.cursor.round.to_be_bytes());
        bytes.extend_from_slice(self.config.config_digest.as_bytes());
        bytes.extend_from_slice(self.config.policy.as_bytes());
        bytes.extend_from_slice(self.config.policy_digest.as_bytes());
        bytes.extend_from_slice(self.state.as_bytes());
        bytes.extend_from_slice(self.state_digest.as_bytes());
        bytes.extend_from_slice(self.journal_head.as_bytes());
        bytes.extend_from_slice(&self.taken_at_ms.to_be_bytes());
        bytes
    }

    pub fn fingerprint(&self) -> Fingerprint {
        Fingerprint::of(&self.canonical_bytes())
    }
}

/// The trusted actor for one session.
///
/// It owns the cursor and the configuration, and it is the only writer for its
/// stream. It performs no I/O of its own: a snapshot is a value, and what is
/// done with it belongs to the engine.
#[derive(Debug)]
pub struct SessionActor {
    writer: SessionWriter,
    stream_id: StreamId,
    cursor: StepCursor,
    active: SessionConfig,
    /// A configuration that will take effect at the next step boundary.
    ///
    /// Applying it immediately would change the rules under a request already
    /// in flight, which is precisely the bug this staging exists to prevent.
    staged: Option<SessionConfig>,
    state: StateHandle,
    state_digest: Digest,
    journal_head: ChainHash,
}

impl SessionActor {
    pub const fn session_id(&self) -> KernelSessionId {
        self.writer.session_id()
    }

    pub const fn cursor(&self) -> StepCursor {
        self.cursor
    }

    /// The configuration in force right now, which is not necessarily the most
    /// recently supplied one.
    pub const fn active_config(&self) -> SessionConfig {
        self.active
    }

    pub const fn has_staged_config(&self) -> bool {
        self.staged.is_some()
    }

    /// Supply a new configuration. It takes effect at the next step, not now.
    pub fn stage_config(&mut self, config: SessionConfig) {
        self.staged = Some(config);
    }

    pub fn set_state(&mut self, state: StateHandle, state_digest: Digest, head: ChainHash) {
        self.state = state;
        self.state_digest = state_digest;
        self.journal_head = head;
    }

    /// Begin a turn: a new accepted input.
    pub fn begin_turn(&mut self) -> Result<StepCursor, RuntimeError> {
        self.cursor = StepCursor {
            turn: next(self.cursor.turn)?,
            step: 0,
            round: 0,
        };
        Ok(self.cursor)
    }

    /// Begin a step, applying any staged configuration.
    ///
    /// This is the only place a configuration changes. A step is the unit at
    /// which the rules may move, because it is the unit at which nothing is in
    /// flight.
    pub fn begin_step(&mut self) -> Result<StepCursor, RuntimeError> {
        if self.cursor.turn == 0 {
            return Err(RuntimeError::Corrupt(
                "a step cannot begin outside a turn".into(),
            ));
        }
        if let Some(staged) = self.staged.take() {
            self.active = staged;
        }
        self.cursor = StepCursor {
            turn: self.cursor.turn,
            step: next(self.cursor.step)?,
            round: 1,
        };
        Ok(self.cursor)
    }

    /// Begin another attempt at the current step.
    ///
    /// A round never applies staged configuration. Retrying a request must
    /// retry *that* request, not a different one that happens to share its
    /// place in the conversation.
    pub fn begin_round(&mut self) -> Result<StepCursor, RuntimeError> {
        if self.cursor.step == 0 {
            return Err(RuntimeError::Corrupt(
                "a round cannot begin outside a step".into(),
            ));
        }
        self.cursor.round = next(self.cursor.round)?;
        Ok(self.cursor)
    }

    /// Take an immutable snapshot of the current step.
    pub fn snapshot(&self, taken_at_ms: u64) -> StepSnapshot {
        StepSnapshot {
            session_id: self.session_id(),
            stream_id: self.stream_id,
            cursor: self.cursor,
            config: self.active,
            state: self.state,
            state_digest: self.state_digest,
            journal_head: self.journal_head,
            taken_at_ms,
        }
    }
}

/// Hands out at most one actor per session.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    open: BTreeMap<u128, StreamId>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_sessions(&self) -> usize {
        self.open.len()
    }

    pub fn is_open(&self, session_id: KernelSessionId) -> bool {
        self.open.contains_key(&session_id.get())
    }

    /// Open a session, or refuse because it is already open.
    ///
    /// The refusal is the single-writer rule. A second actor is not detected
    /// later and reported; it is never created.
    pub fn open(
        &mut self,
        session_id: KernelSessionId,
        stream_id: StreamId,
        config: SessionConfig,
        state: StateHandle,
        state_digest: Digest,
        journal_head: ChainHash,
    ) -> Result<SessionActor, RuntimeError> {
        if self.open.contains_key(&session_id.get()) {
            return Err(RuntimeError::SessionAlreadyOpen { session_id });
        }
        self.open.insert(session_id.get(), stream_id);
        Ok(SessionActor {
            writer: SessionWriter { session_id },
            stream_id,
            cursor: StepCursor::default(),
            active: config,
            staged: None,
            state,
            state_digest,
            journal_head,
        })
    }

    /// Close a session, consuming its actor so no writer outlives the entry.
    pub fn close(&mut self, actor: SessionActor) {
        self.open.remove(&actor.session_id().get());
    }
}

fn next(value: u64) -> Result<u64, RuntimeError> {
    value
        .checked_add(1)
        .ok_or_else(|| RuntimeError::Corrupt("session counter overflowed".into()))
}
