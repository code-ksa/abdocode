//! The control plane: bounded mailboxes, typed input, and a cancel tree.
//!
//! # Input is classified, not merely delivered
//!
//! Everything that arrives while an agent is working used to be "another
//! prompt". That flattening loses the two things a long-running agent most
//! needs to know: who is speaking, and whether this should interrupt anything.
//! So input carries an [`InputChannel`], and each channel states whether it
//! wakes a paused session. Waking is a declared property of the channel, not an
//! incidental consequence of the code path a message happened to take.
//!
//! # Bounded, always
//!
//! A mailbox has a capacity and refuses beyond it. Refusing is the feature: an
//! unbounded queue does not remove the limit, it moves the failure from a
//! visible rejection to an invisible one, and a kernel meant to run for weeks
//! cannot afford a queue whose depth is a function of how long it has been up.
//!
//! # Cancelling a tree
//!
//! Work spawns work. Cancelling a parent that leaves its children running is
//! how an agent ends up with orphans nobody is waiting for, so cancellation
//! descends the tree in one operation and reports how many it reached.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use abdo_contracts::{Digest, KernelSessionId, TaskId};

use crate::error::RuntimeError;

pub use abdo_contracts::InputChannel;

/// Every channel, in tag order.
pub const INPUT_CHANNELS: [InputChannel; 6] = [
    InputChannel::UserFollowup,
    InputChannel::OperatorSteer,
    InputChannel::SystemInject,
    InputChannel::PolicyInterrupt,
    InputChannel::RecoveryInject,
    InputChannel::SchedulerSignal,
];

/// What a channel is entitled to do.
///
/// The tag and the codec belong to `abdo-contracts`, which owns the wire. What
/// a channel *means* to a running kernel belongs here, and lives on that one
/// type rather than on a second copy of it: two enums for one concept is the
/// duplication the K10 gate exists to catch.
pub trait ChannelSemantics {
    /// Does delivering this wake a paused session?
    fn wakes(self) -> bool;

    /// The earliest boundary at which this input may take effect.
    fn applies_at(self) -> Boundary;

    /// May this be dropped when a mailbox is full?
    ///
    /// Takes `self` by value: an `InputChannel` is a copyable tag, and the
    /// borrow the lint expects would be noise on a one-byte value.
    #[allow(clippy::wrong_self_convention)]
    fn is_sheddable(self) -> bool;

    fn tag(self) -> u8;

    fn from_tag(tag: u8) -> Option<InputChannel>;
}

impl ChannelSemantics for InputChannel {
    fn wakes(self) -> bool {
        !matches!(self, Self::SystemInject)
    }

    fn applies_at(self) -> Boundary {
        match self {
            Self::UserFollowup => Boundary::NextTurn,
            Self::SystemInject
            | Self::OperatorSteer
            | Self::PolicyInterrupt
            | Self::RecoveryInject
            | Self::SchedulerSignal => Boundary::NextStep,
        }
    }

    /// A policy interrupt may not be shed. Dropping one under load would mean
    /// the kernel is likeliest to ignore a withdrawal of permission exactly
    /// when it is busiest.
    fn is_sheddable(self) -> bool {
        !matches!(self, Self::PolicyInterrupt)
    }

    fn tag(self) -> u8 {
        match self {
            Self::UserFollowup => 1,
            Self::OperatorSteer => 2,
            Self::SystemInject => 3,
            Self::PolicyInterrupt => 4,
            Self::RecoveryInject => 5,
            Self::SchedulerSignal => 6,
        }
    }

    fn from_tag(tag: u8) -> Option<InputChannel> {
        INPUT_CHANNELS
            .into_iter()
            .find(|channel| channel.tag() == tag)
    }
}

/// When an input may take effect.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Boundary {
    NextStep,
    NextTurn,
}

/// One classified message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Envelope {
    pub session_id: KernelSessionId,
    pub channel: InputChannel,
    /// The message itself never enters the control plane; only its digest does.
    pub payload_digest: Digest,
    pub at_ms: u64,
}

/// What happened to an offered envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    /// Queued, and whether the session should wake.
    Accepted { wake: bool, depth: usize },
    /// Refused because the mailbox is full. Visible, counted, never silent.
    Backpressure { capacity: usize },
}

/// A bounded queue for one session.
#[derive(Debug)]
pub struct Mailbox {
    capacity: usize,
    queue: VecDeque<Envelope>,
    accepted: u64,
    refused: u64,
    high_water: usize,
}

impl Mailbox {
    pub fn with_capacity(capacity: usize) -> Result<Self, RuntimeError> {
        if capacity == 0 {
            return Err(RuntimeError::Corrupt("a mailbox needs capacity".into()));
        }
        Ok(Self {
            capacity,
            queue: VecDeque::with_capacity(capacity),
            accepted: 0,
            refused: 0,
            high_water: 0,
        })
    }

    pub const fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn depth(&self) -> usize {
        self.queue.len()
    }

    /// The deepest this mailbox has ever been.
    ///
    /// Reported because "bounded memory" is a claim about the worst moment, not
    /// about the moment somebody happened to look.
    pub const fn high_water(&self) -> usize {
        self.high_water
    }

    pub const fn accepted(&self) -> u64 {
        self.accepted
    }

    pub const fn refused(&self) -> u64 {
        self.refused
    }

    fn offer(&mut self, envelope: Envelope) -> Delivery {
        if self.queue.len() >= self.capacity {
            if envelope.channel.is_sheddable() {
                self.refused += 1;
                return Delivery::Backpressure {
                    capacity: self.capacity,
                };
            }
            // An unsheddable channel displaces the oldest sheddable message
            // rather than growing the queue. The bound holds either way.
            if let Some(position) = self
                .queue
                .iter()
                .position(|queued| queued.channel.is_sheddable())
            {
                self.queue.remove(position);
                self.refused += 1;
            } else {
                self.refused += 1;
                return Delivery::Backpressure {
                    capacity: self.capacity,
                };
            }
        }
        self.queue.push_back(envelope);
        self.accepted += 1;
        if self.queue.len() > self.high_water {
            self.high_water = self.queue.len();
        }
        Delivery::Accepted {
            wake: envelope.channel.wakes(),
            depth: self.queue.len(),
        }
    }

    pub fn take(&mut self) -> Option<Envelope> {
        self.queue.pop_front()
    }
}

/// Cancellation state of one task.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskState {
    Running,
    Paused,
    Cancelled,
}

/// The control plane for one kernel.
#[derive(Debug)]
pub struct ControlPlane {
    capacity: usize,
    mailboxes: BTreeMap<u128, Mailbox>,
    paused: BTreeSet<u128>,
    parents: BTreeMap<u128, u128>,
    children: BTreeMap<u128, Vec<u128>>,
    states: BTreeMap<u128, TaskState>,
    routed: u64,
    refused: u64,
}

/// What one cancellation reached.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CancelReport {
    pub cancelled: usize,
    /// Tasks already cancelled, which a repeat pass must not count again.
    pub already_cancelled: usize,
    pub depth: usize,
}

impl ControlPlane {
    pub fn new(mailbox_capacity: usize) -> Result<Self, RuntimeError> {
        if mailbox_capacity == 0 {
            return Err(RuntimeError::Corrupt("a mailbox needs capacity".into()));
        }
        Ok(Self {
            capacity: mailbox_capacity,
            mailboxes: BTreeMap::new(),
            paused: BTreeSet::new(),
            parents: BTreeMap::new(),
            children: BTreeMap::new(),
            states: BTreeMap::new(),
            routed: 0,
            refused: 0,
        })
    }

    pub fn register(&mut self, session_id: KernelSessionId) -> Result<(), RuntimeError> {
        if self.mailboxes.contains_key(&session_id.get()) {
            return Err(RuntimeError::SessionAlreadyOpen { session_id });
        }
        self.mailboxes
            .insert(session_id.get(), Mailbox::with_capacity(self.capacity)?);
        Ok(())
    }

    pub fn sessions(&self) -> usize {
        self.mailboxes.len()
    }

    pub const fn routed(&self) -> u64 {
        self.routed
    }

    pub const fn refused(&self) -> u64 {
        self.refused
    }

    /// The deepest any mailbox has ever been.
    pub fn high_water(&self) -> usize {
        self.mailboxes
            .values()
            .map(Mailbox::high_water)
            .max()
            .unwrap_or(0)
    }

    pub fn is_paused(&self, session_id: KernelSessionId) -> bool {
        self.paused.contains(&session_id.get())
    }

    pub fn pause(&mut self, session_id: KernelSessionId) {
        self.paused.insert(session_id.get());
    }

    pub fn resume(&mut self, session_id: KernelSessionId) {
        self.paused.remove(&session_id.get());
    }

    /// Route one envelope to its session.
    ///
    /// Returns the delivery, including whether the session should wake. A
    /// waking channel resumes a paused session as part of delivery: leaving the
    /// caller to notice and act would be a rule nobody enforces.
    pub fn route(&mut self, envelope: Envelope) -> Result<Delivery, RuntimeError> {
        let mailbox = self.mailboxes.get_mut(&envelope.session_id.get()).ok_or(
            RuntimeError::UnknownSession {
                session_id: envelope.session_id,
            },
        )?;
        let delivery = mailbox.offer(envelope);
        match delivery {
            Delivery::Accepted { wake, .. } => {
                self.routed += 1;
                if wake {
                    self.paused.remove(&envelope.session_id.get());
                }
            }
            Delivery::Backpressure { .. } => self.refused += 1,
        }
        Ok(delivery)
    }

    pub fn take(&mut self, session_id: KernelSessionId) -> Option<Envelope> {
        self.mailboxes
            .get_mut(&session_id.get())
            .and_then(Mailbox::take)
    }

    pub fn mailbox(&self, session_id: KernelSessionId) -> Option<&Mailbox> {
        self.mailboxes.get(&session_id.get())
    }

    /// Record that `child` was spawned by `parent`.
    pub fn attach(&mut self, parent: TaskId, child: TaskId) -> Result<(), RuntimeError> {
        if parent == child {
            return Err(RuntimeError::Corrupt("a task cannot parent itself".into()));
        }
        // A cycle would make cancellation non-terminating, so refuse to build
        // one rather than defend against it at every traversal.
        let mut cursor = Some(parent.get());
        while let Some(current) = cursor {
            if current == child.get() {
                return Err(RuntimeError::Corrupt("task parentage would cycle".into()));
            }
            cursor = self.parents.get(&current).copied();
        }
        self.parents.insert(child.get(), parent.get());
        self.children
            .entry(parent.get())
            .or_default()
            .push(child.get());
        self.states
            .entry(parent.get())
            .or_insert(TaskState::Running);
        self.states.insert(child.get(), TaskState::Running);
        Ok(())
    }

    pub fn task_state(&self, task: TaskId) -> Option<TaskState> {
        self.states.get(&task.get()).copied()
    }

    /// Cancel a task and everything below it, in one operation.
    pub fn cancel_tree(&mut self, root: TaskId) -> CancelReport {
        let mut report = CancelReport::default();
        let mut frontier = vec![(root.get(), 1_usize)];
        while let Some((task, depth)) = frontier.pop() {
            report.depth = report.depth.max(depth);
            match self.states.get(&task) {
                Some(TaskState::Cancelled) => report.already_cancelled += 1,
                _ => {
                    self.states.insert(task, TaskState::Cancelled);
                    report.cancelled += 1;
                }
            }
            if let Some(children) = self.children.get(&task) {
                for child in children {
                    frontier.push((*child, depth + 1));
                }
            }
        }
        report
    }
}
