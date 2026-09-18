//! The trusted tool broker.
//!
//! A tool is a contract before it is code: what it takes, what it returns, what
//! class of effect it is, what it costs, what it promises afterwards, and — for
//! anything that touches the world — how it is undone. [`abdo_contracts::ToolSpec`]
//! carries all of that, and this module is the only thing that turns one into
//! something callable.
//!
//! # What is unrepresentable here
//!
//! A mutating tool with no recovery plan cannot be built, because the recovery
//! lives *inside* [`abdo_contracts::MutatingEffect`]. This is not a rule the
//! broker checks; it is a shape the type does not have. The same goes for
//! reaching and spending. Irreversible work carries evidence instead of
//! compensation, because there is no compensating a thing that cannot be taken
//! back, and pretending otherwise is worse than admitting it.
//!
//! # Enforcement is not a boolean
//!
//! Registration produces an [`abdo_contracts::EnforcementReport`], never a flag.
//! A field called `sandboxed` can say yes or no, and the honest answer is
//! usually "partly, by this backend, with these gaps" — which a boolean reports
//! as a clean yes. So the report carries what was requested, what was granted,
//! which backend granted it, what it could not do, and one of three verdicts:
//! full, partial, or unavailable.
//!
//! # What the worker never sees
//!
//! The broker hands out a [`ToolLease`], which carries the resource limits and
//! the operation digest and nothing else. No policy, no capability, no key, no
//! spec. A worker that could read the policy it is judged by is a worker that
//! can plan around it.

use std::collections::BTreeMap;

use abdo_contracts::{
    CatalogHandle, Digest, EffectClass, Enforcement, EnforcementReport, ResourceLimits, ToolId,
    ToolSpec,
};

use crate::disclosure::CatalogSnapshot;

/// Why a spec was not admitted to the catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistrationError {
    /// The spec names a handler the host does not have.
    ///
    /// A schema without a handler is a promise nobody keeps. The catalog
    /// refuses it rather than serving a lookup that fails at call time, when
    /// the caller has already committed.
    NoHandler { tool_id: ToolId },
    /// Two specs claim the same identifier.
    ///
    /// Refused rather than overwritten: a silent replacement is how a tool's
    /// meaning changes underneath everything already holding its id.
    Duplicate { tool_id: ToolId },
    /// Nothing was enforceable and the class needed enforcement.
    Unenforceable { tool_id: ToolId },
}

/// What a worker is given, and the whole of it.
///
/// Deliberately small. It has no reference to the spec, the policy, the
/// capability or the key: a worker holding any of those could reason about the
/// rules it is being judged by.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolLease {
    operation_digest: Digest,
    resources: ResourceLimits,
    enforcement: Enforcement,
}

impl ToolLease {
    pub const fn operation_digest(&self) -> Digest {
        self.operation_digest
    }

    pub const fn resources(&self) -> &ResourceLimits {
        &self.resources
    }

    /// How much of the requested isolation the host could actually apply.
    ///
    /// Passed on rather than hidden, because a worker running with partial
    /// isolation should be able to know it and a log should be able to say it.
    pub const fn enforcement(&self) -> Enforcement {
        self.enforcement
    }
}

/// Whoever can actually confine a running tool.
pub trait Sandbox {
    /// Apply what was asked, and say what was actually applied.
    ///
    /// Returning an [`EnforcementReport`] rather than a bool is the contract:
    /// there is nothing this can return that means "isolated" without also
    /// saying by what and with what gaps.
    fn confine(&self, requested_digest: Digest, class: &EffectClass) -> EnforcementReport;
}

/// A host with no isolation at all.
///
/// It reports [`Enforcement::Unavailable`], which is a true statement rather
/// than a failure. A broker that refused to start without a sandbox would be a
/// broker nobody could run on a plain machine; one that pretended is worse.
#[derive(Clone, Copy, Debug)]
pub struct NoSandbox {
    backend_digest: Digest,
    limitations_digest: Digest,
}

impl NoSandbox {
    pub const fn new(backend_digest: Digest, limitations_digest: Digest) -> Self {
        Self {
            backend_digest,
            limitations_digest,
        }
    }
}

impl Sandbox for NoSandbox {
    fn confine(&self, requested_digest: Digest, _class: &EffectClass) -> EnforcementReport {
        EnforcementReport {
            requested_digest,
            // Nothing was granted, and the granted digest still has to be a
            // real value: an empty one would read as "not filled in yet".
            granted_digest: requested_digest,
            enforcement: Enforcement::Unavailable,
            backend_digest: self.backend_digest,
            limitations_digest: self.limitations_digest,
        }
    }
}

/// Measurable application-level confinement for compiled product adapters.
///
/// This is deliberately `Partial`: admission proves a compiled adapter/class
/// pairing and the adapter enforces its path, argv, lockfile, or egress rules.
/// It does not claim an operating-system sandbox.
#[derive(Clone, Copy, Debug)]
pub struct CompiledBoundary {
    backend_digest: Digest,
    limitations_digest: Digest,
}

impl CompiledBoundary {
    pub const fn new(backend_digest: Digest, limitations_digest: Digest) -> Self {
        Self {
            backend_digest,
            limitations_digest,
        }
    }
}

impl Sandbox for CompiledBoundary {
    fn confine(&self, requested_digest: Digest, _class: &EffectClass) -> EnforcementReport {
        EnforcementReport {
            requested_digest,
            granted_digest: requested_digest,
            enforcement: Enforcement::Partial,
            backend_digest: self.backend_digest,
            limitations_digest: self.limitations_digest,
        }
    }
}

/// One registered tool: its spec, and what the host could enforce for it.
#[derive(Clone, Debug)]
struct Registered {
    spec: ToolSpec,
    report: EnforcementReport,
}

/// The tool catalog.
///
/// Ordered rather than hashed, for the same reason the kernel state is: a hash
/// container's iteration order depends on process-local seeding, and a catalog
/// that enumerates differently between runs makes a digest of "what tools exist"
/// meaningless.
#[derive(Debug, Default)]
pub struct ToolCatalog {
    tools: BTreeMap<u128, Registered>,
    handlers: BTreeMap<[u8; 32], ()>,
}

impl ToolCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Declare that the host has a handler with this digest.
    ///
    /// Separate from registration on purpose: handlers come from the host and
    /// specs come from the catalog author, and letting one supply both is how a
    /// spec ends up vouching for itself.
    pub fn install_handler(&mut self, handler_digest: Digest) {
        self.handlers.insert(*handler_digest.as_bytes(), ());
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Admit a spec, if the host has its handler.
    pub fn register(
        &mut self,
        spec: ToolSpec,
        sandbox: &dyn Sandbox,
    ) -> Result<EnforcementReport, RegistrationError> {
        let tool_id = spec.tool_id;
        if !self.handlers.contains_key(spec.handler_digest.as_bytes()) {
            return Err(RegistrationError::NoHandler { tool_id });
        }
        if self.tools.contains_key(&tool_id.get()) {
            return Err(RegistrationError::Duplicate { tool_id });
        }
        let report = sandbox.confine(spec.handler_digest, &spec.effect);
        // Irreversible work is the one class where an unenforceable host is a
        // refusal rather than a note. Everything else can run with the gaps
        // recorded; this cannot, because there is no undoing it afterwards.
        if matches!(spec.effect, EffectClass::Irreversible(_))
            && report.enforcement == Enforcement::Unavailable
        {
            return Err(RegistrationError::Unenforceable { tool_id });
        }
        self.tools.insert(
            tool_id.get(),
            Registered {
                spec,
                report: report.clone(),
            },
        );
        Ok(report)
    }

    /// Find a tool. The hot path.
    pub fn lookup(&self, tool_id: ToolId) -> Option<ToolLease> {
        let registered = self.tools.get(&tool_id.get())?;
        Some(ToolLease {
            operation_digest: registered.spec.handler_digest,
            resources: registered.spec.resources.clone(),
            enforcement: registered.report.enforcement,
        })
    }

    /// What the host could enforce for this tool.
    pub fn enforcement_of(&self, tool_id: ToolId) -> Option<EnforcementReport> {
        self.tools
            .get(&tool_id.get())
            .map(|entry| entry.report.clone())
    }

    /// The recovery a tool declared, if its class has one.
    ///
    /// `Read` has none because there is nothing to undo, and `Irreversible` has
    /// none because there is no undoing it. Both return `None`, and the caller
    /// has to tell them apart by the class rather than by this.
    pub fn recovery_of(&self, tool_id: ToolId) -> Option<&abdo_contracts::RecoveryPlan> {
        let effect = &self.tools.get(&tool_id.get())?.spec.effect;
        match effect {
            EffectClass::Mutate(mutating) => Some(&mutating.recovery),
            EffectClass::Reach(reaching) => Some(&reaching.recovery),
            EffectClass::Spend(spending) => Some(&spending.recovery),
            EffectClass::Read(_) | EffectClass::Irreversible(_) => None,
        }
    }

    /// Freeze what is here now, for one step to work against.
    ///
    /// The snapshot copies rather than borrows, so nothing registered after
    /// this call can reach it. That is why a step cannot have the catalog move
    /// underneath it, and why a run recorded against a snapshot still resolves
    /// the same tools long after the live catalog has changed.
    pub fn snapshot(&self, handle: CatalogHandle) -> CatalogSnapshot {
        CatalogSnapshot::build(
            handle,
            self.tools
                .iter()
                .map(|(id, entry)| (*id, (entry.spec.clone(), entry.report.enforcement)))
                .collect(),
        )
    }

    /// Does this class change anything outside the kernel?
    pub fn is_world_changing(class: &EffectClass) -> bool {
        !matches!(class, EffectClass::Read(_))
    }
}
