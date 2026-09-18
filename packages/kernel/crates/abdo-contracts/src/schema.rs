//! The single declarative S104 protocol schema.
//!
//! Do not hand-maintain a second type list or wire layout. The declaration at
//! the bottom of this file generates every Rust contract, codec, descriptor,
//! and the metadata consumed by TypeScript code generation.

use crate::wire::{EncodeError, WireEncode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FieldDescriptor {
    pub name: &'static str,
    pub type_name: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VariantDescriptor {
    pub name: &'static str,
    pub tag: u8,
    pub payload_type: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleDescriptor {
    NonZeroU64 {
        field: &'static str,
    },
    NonZeroBytes {
        field: &'static str,
    },
    LessThanU64 {
        lower: &'static str,
        upper: &'static str,
    },
    MaxSpanU64 {
        lower: &'static str,
        upper: &'static str,
        maximum: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TypeKind {
    Id128,
    FixedBytes {
        length: usize,
    },
    Unit,
    Struct {
        fields: &'static [FieldDescriptor],
        rules: &'static [RuleDescriptor],
        integrity_field: Option<&'static str>,
    },
    Enum {
        variants: &'static [VariantDescriptor],
    },
    Union {
        variants: &'static [VariantDescriptor],
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TypeDescriptor {
    pub name: &'static str,
    pub kind: TypeKind,
}

pub trait ContractType {
    const DESCRIPTOR: TypeDescriptor;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MessageDescriptor {
    pub type_name: &'static str,
    pub tag: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolDescriptor {
    pub name: &'static str,
    pub magic: [u8; 4],
    pub version: u16,
    pub max_message_bytes: usize,
    pub trust_integrity_domain: &'static [u8],
    pub schema_fingerprint: [u8; 16],
    pub types: &'static [TypeDescriptor],
    pub messages: &'static [MessageDescriptor],
}

/// Derive a compatibility fingerprint from every declared type, rule, variant,
/// and message. This is a layout identity, not a cryptographic trust proof.
pub const fn compute_schema_fingerprint(
    name: &str,
    magic: [u8; 4],
    version: u16,
    max_message_bytes: usize,
    trust_integrity_domain: &[u8],
    types: &[TypeDescriptor],
    messages: &[MessageDescriptor],
) -> [u8; 16] {
    let mut state = FingerprintState::new();
    state = state.bytes(name.as_bytes());
    state = state.bytes(&magic);
    state = state.number(version as u64);
    state = state.number(max_message_bytes as u64);
    state = state.bytes(trust_integrity_domain);
    state = state.number(types.len() as u64);

    let mut type_index = 0;
    while type_index < types.len() {
        let descriptor = types[type_index];
        state = state.bytes(descriptor.name.as_bytes());
        match descriptor.kind {
            TypeKind::Id128 => state = state.byte(1),
            TypeKind::FixedBytes { length } => {
                state = state.byte(2);
                state = state.number(length as u64);
            }
            TypeKind::Unit => state = state.byte(3),
            TypeKind::Struct {
                fields,
                rules,
                integrity_field,
            } => {
                state = state.byte(4);
                state = state.number(fields.len() as u64);
                let mut field_index = 0;
                while field_index < fields.len() {
                    state = state.bytes(fields[field_index].name.as_bytes());
                    state = state.bytes(fields[field_index].type_name.as_bytes());
                    field_index += 1;
                }
                state = state.number(rules.len() as u64);
                let mut rule_index = 0;
                while rule_index < rules.len() {
                    match rules[rule_index] {
                        RuleDescriptor::NonZeroU64 { field } => {
                            state = state.byte(1);
                            state = state.bytes(field.as_bytes());
                        }
                        RuleDescriptor::NonZeroBytes { field } => {
                            state = state.byte(2);
                            state = state.bytes(field.as_bytes());
                        }
                        RuleDescriptor::LessThanU64 { lower, upper } => {
                            state = state.byte(3);
                            state = state.bytes(lower.as_bytes());
                            state = state.bytes(upper.as_bytes());
                        }
                        RuleDescriptor::MaxSpanU64 {
                            lower,
                            upper,
                            maximum,
                        } => {
                            state = state.byte(4);
                            state = state.bytes(lower.as_bytes());
                            state = state.bytes(upper.as_bytes());
                            state = state.number(maximum);
                        }
                    }
                    rule_index += 1;
                }
                match integrity_field {
                    Some(field) => {
                        state = state.byte(1);
                        state = state.bytes(field.as_bytes());
                    }
                    None => state = state.byte(0),
                }
            }
            TypeKind::Enum { variants } => {
                state = state.byte(5);
                state = fingerprint_variants(state, variants);
            }
            TypeKind::Union { variants } => {
                state = state.byte(6);
                state = fingerprint_variants(state, variants);
            }
        }
        type_index += 1;
    }

    state = state.number(messages.len() as u64);
    let mut message_index = 0;
    while message_index < messages.len() {
        state = state.bytes(messages[message_index].type_name.as_bytes());
        state = state.number(messages[message_index].tag as u64);
        message_index += 1;
    }
    state.finish()
}

const fn fingerprint_variants(
    mut state: FingerprintState,
    variants: &[VariantDescriptor],
) -> FingerprintState {
    state = state.number(variants.len() as u64);
    let mut index = 0;
    while index < variants.len() {
        state = state.bytes(variants[index].name.as_bytes());
        state = state.byte(variants[index].tag);
        match variants[index].payload_type {
            Some(payload) => {
                state = state.byte(1);
                state = state.bytes(payload.as_bytes());
            }
            None => state = state.byte(0),
        }
        index += 1;
    }
    state
}

#[derive(Clone, Copy)]
struct FingerprintState {
    left: u64,
    right: u64,
    count: u64,
}

impl FingerprintState {
    const fn new() -> Self {
        Self {
            left: 0x243f_6a88_85a3_08d3,
            right: 0x1319_8a2e_0370_7344,
            count: 0,
        }
    }

    const fn byte(mut self, byte: u8) -> Self {
        self.left ^= (byte as u64).wrapping_add(self.count.rotate_left(17));
        self.left = self
            .left
            .wrapping_mul(0x9e37_79b1_85eb_ca87)
            .rotate_left(23);
        self.right ^= self.left.wrapping_add(0xc2b2_ae3d_27d4_eb4f);
        self.right = self
            .right
            .wrapping_mul(0x1656_67b1_9e37_79f9)
            .rotate_left(29);
        self.count = self.count.wrapping_add(1);
        self
    }

    const fn number(mut self, value: u64) -> Self {
        let bytes = value.to_le_bytes();
        let mut index = 0;
        while index < bytes.len() {
            self = self.byte(bytes[index]);
            index += 1;
        }
        self
    }

    const fn bytes(mut self, bytes: &[u8]) -> Self {
        self = self.number(bytes.len() as u64);
        let mut index = 0;
        while index < bytes.len() {
            self = self.byte(bytes[index]);
            index += 1;
        }
        self
    }

    const fn finish(self) -> [u8; 16] {
        let left = avalanche(self.left ^ self.count ^ self.right.rotate_left(11));
        let right = avalanche(self.right ^ self.count.rotate_left(31) ^ left);
        let left = left.to_le_bytes();
        let right = right.to_le_bytes();
        [
            left[0], left[1], left[2], left[3], left[4], left[5], left[6], left[7], right[0],
            right[1], right[2], right[3], right[4], right[5], right[6], right[7],
        ]
    }
}

const fn avalanche(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

contract_schema! {
    protocol {
        name: "abdo-kernel-contracts",
        magic: *b"ABDC",
        version: 1,
        max_message_bytes: 65_536,
        trust_integrity_domain: "ABDO/TRUST-RECEIPT/1",
    }

    ids {
        BootId,
        RunId,
        KernelSessionId,
        TaskId,
        CommandId,
        ProposalId,
        IntentId,
        EventId,
        ReceiptId,
        CancellationId,
        ToolId,
    }

    fixed_bytes {
        Digest[32],
        Nonce[32],
        ArtifactHandle[32],
        StateHandle[32],
        PolicyHandle[32],
        CatalogHandle[32],
        FilesystemHandle[32],
        ProcessHandle[32],
        NetworkHandle[32],
        ExternalHandle[32],
        SurfaceHandle[32],
        WindowHandle[16],
    }

    units {
        WorkspaceScope,
        RootCause,
        // A read observes and changes nothing, so there is nothing to undo.
        // It is a unit rather than a struct with an empty recovery, because an
        // empty recovery is a recovery somebody could fill in later.
        ReadEffect,
    }

    structs {
        SessionScope {
            kernel_session_id: KernelSessionId,
        }
        rules {}

        TaskScope {
            task_id: TaskId,
        }
        rules {}

        CommandCause {
            command_id: CommandId,
        }
        rules {}

        EventCause {
            event_id: EventId,
        }
        rules {}

        IntentCause {
            intent_id: IntentId,
        }
        rules {}

        TargetClaim {
            kind: TargetKind,
            claim_digest: Digest,
        }
        rules {
            claim_digest: NonZeroBytes(_);
        }

        FilesystemTargetRef {
            object: FilesystemHandle,
        }
        rules {
            object: NonZeroBytes(_);
        }

        ProcessTargetRef {
            process: ProcessHandle,
        }
        rules {
            process: NonZeroBytes(_);
        }

        NetworkTargetRef {
            endpoint: NetworkHandle,
        }
        rules {
            endpoint: NonZeroBytes(_);
        }

        ExternalTargetRef {
            resource: ExternalHandle,
        }
        rules {
            resource: NonZeroBytes(_);
        }

        SurfaceTargetRef {
            surface: SurfaceHandle,
            window: WindowHandle,
            generation: u64,
            snapshot: Digest,
        }
        rules {
            surface: NonZeroBytes(_);
            window: NonZeroBytes(_);
            generation: NonZeroU64(_);
            snapshot: NonZeroBytes(_);
        }

        // The three counters a surface moves under you.
        //
        // Named separately rather than folded into one, because they fail
        // differently: a navigation replaces the document, a window generation
        // replaces the frame the coordinates mean anything in, and a view
        // generation moves what is on screen without changing either. An action
        // that was correct against one of them can be wrong against another,
        // and a single counter cannot say which.
        SurfaceGenerations {
            navigation: u64,
            window: u64,
            view: u64,
        }
        rules {
            navigation: NonZeroU64(_);
            window: NonZeroU64(_);
            view: NonZeroU64(_);
        }

        // What was seen, and exactly when it stopped being true.
        SurfaceObservation {
            kind: SurfaceKind,
            target: SurfaceTargetRef,
            generations: SurfaceGenerations,
            content_digest: Digest,
            observed_at_ms: u64,
        }
        rules {
            content_digest: NonZeroBytes(_);
            observed_at_ms: NonZeroU64(_);
        }

        // What is to be done, carrying the generations it was decided against.
        //
        // Carried rather than looked up, because looking them up at execution
        // would read the world as it is now and lose the only fact that matters:
        // what the caller believed when it chose.
        SurfaceAction {
            kind: SurfaceKind,
            target: SurfaceTargetRef,
            generations: SurfaceGenerations,
            action_digest: Digest,
            args_digest: Digest,
            requested_at_ms: u64,
        }
        rules {
            action_digest: NonZeroBytes(_);
            args_digest: NonZeroBytes(_);
            requested_at_ms: NonZeroU64(_);
        }

        SurfaceReceipt {
            action_digest: Digest,
            observed_generations: SurfaceGenerations,
            outcome_digest: Digest,
            settled_at_ms: u64,
        }
        rules {
            action_digest: NonZeroBytes(_);
            outcome_digest: NonZeroBytes(_);
            settled_at_ms: NonZeroU64(_);
        }

        // How an effect that touched the world is undone, or failing that,
        // established. Carried inside the classes that can touch it, so a
        // mutating tool without one is unrepresentable rather than merely
        // rejected.
        RecoveryPlan {
            compensating_operation_digest: Digest,
            evidence_operation_digest: Digest,
            max_attempts: u64,
        }
        rules {
            compensating_operation_digest: NonZeroBytes(_);
            evidence_operation_digest: NonZeroBytes(_);
            max_attempts: NonZeroU64(_);
        }

        MutatingEffect {
            recovery: RecoveryPlan,
        }
        rules {}

        ReachingEffect {
            recovery: RecoveryPlan,
            endpoint_class_digest: Digest,
        }
        rules {
            endpoint_class_digest: NonZeroBytes(_);
        }

        SpendingEffect {
            recovery: RecoveryPlan,
            ledger_digest: Digest,
        }
        rules {
            ledger_digest: NonZeroBytes(_);
        }

        // Irreversible work carries no compensation, because there is none.
        // What it carries instead is how to establish what happened, which is
        // the only thing left to do once it has.
        IrreversibleEffect {
            evidence_operation_digest: Digest,
        }
        rules {
            evidence_operation_digest: NonZeroBytes(_);
        }

        // Every limit is non-zero. A zero here would read as "no limit" to
        // anyone enforcing it and as "forbidden" to anyone reading it, and a
        // field with two meanings is a field with none.
        ResourceLimits {
            wall_ms: u64,
            memory_bytes: u64,
            output_bytes: u64,
            open_handles: u64,
        }
        rules {
            wall_ms: NonZeroU64(_);
            memory_bytes: NonZeroU64(_);
            output_bytes: NonZeroU64(_);
            open_handles: NonZeroU64(_);
        }

        // A schema with no handler is a promise nobody keeps, so the handler is
        // a required non-zero field of the spec itself.
        ToolSpec {
            tool_id: ToolId,
            name_digest: Digest,
            input_schema_digest: Digest,
            output_schema_digest: Digest,
            effect: EffectClass,
            resources: ResourceLimits,
            postcondition_digest: Digest,
            handler_digest: Digest,
        }
        rules {
            name_digest: NonZeroBytes(_);
            input_schema_digest: NonZeroBytes(_);
            output_schema_digest: NonZeroBytes(_);
            postcondition_digest: NonZeroBytes(_);
            handler_digest: NonZeroBytes(_);
        }

        // What isolation was asked for, what was granted, and how much of it the
        // host could actually enforce.
        //
        // There is deliberately no boolean here. A field called `sandboxed` can
        // only say yes or no, and the true answer is usually "partly, by this
        // backend, with these gaps" — which a boolean reports as a clean yes.
        EnforcementReport {
            requested_digest: Digest,
            granted_digest: Digest,
            enforcement: Enforcement,
            backend_digest: Digest,
            limitations_digest: Digest,
        }
        rules {
            requested_digest: NonZeroBytes(_);
            granted_digest: NonZeroBytes(_);
            backend_digest: NonZeroBytes(_);
            limitations_digest: NonZeroBytes(_);
        }

        ProposedIntent {
            proposal_id: ProposalId,
            scope: Scope,
            cause: CauseRef,
            target: TargetClaim,
            operation_digest: Digest,
            artifact: ArtifactHandle,
            state: StateHandle,
            state_digest: Digest,
            policy: PolicyHandle,
            policy_digest: Digest,
            catalog: CatalogHandle,
            catalog_digest: Digest,
            trust_receipt_digest: Digest,
            requested_at_ms: u64,
            expires_at_ms: u64,
        }
        rules {
            operation_digest: NonZeroBytes(_);
            artifact: NonZeroBytes(_);
            state: NonZeroBytes(_);
            state_digest: NonZeroBytes(_);
            policy: NonZeroBytes(_);
            policy_digest: NonZeroBytes(_);
            catalog: NonZeroBytes(_);
            catalog_digest: NonZeroBytes(_);
            trust_receipt_digest: NonZeroBytes(_);
            requested_at_ms: LessThanU64(expires_at_ms);
        }

        AdmittedIntent {
            intent_id: IntentId,
            proposal_id: ProposalId,
            scope: Scope,
            cause: CauseRef,
            target: TargetRef,
            proposed_digest: Digest,
            operation_digest: Digest,
            artifact: ArtifactHandle,
            state: StateHandle,
            state_digest: Digest,
            policy: PolicyHandle,
            policy_digest: Digest,
            catalog: CatalogHandle,
            catalog_digest: Digest,
            trust_receipt_id: ReceiptId,
            trust_receipt_digest: Digest,
            admitted_at_ms: u64,
            expires_at_ms: u64,
        }
        rules {
            proposed_digest: NonZeroBytes(_);
            operation_digest: NonZeroBytes(_);
            artifact: NonZeroBytes(_);
            state: NonZeroBytes(_);
            state_digest: NonZeroBytes(_);
            policy: NonZeroBytes(_);
            policy_digest: NonZeroBytes(_);
            catalog: NonZeroBytes(_);
            catalog_digest: NonZeroBytes(_);
            trust_receipt_digest: NonZeroBytes(_);
            admitted_at_ms: LessThanU64(expires_at_ms);
        }

        ProposeCommand {
            command_id: CommandId,
            intent: ProposedIntent,
        }
        rules {}

        CancelCommand {
            command_id: CommandId,
            cancellation_id: CancellationId,
            proposal_id: ProposalId,
            scope: Scope,
            cause: CauseRef,
            requested_at_ms: u64,
        }
        rules {
            requested_at_ms: NonZeroU64(_);
        }

        ReceivedEvent {
            event_id: EventId,
            proposal_id: ProposalId,
            command_id: CommandId,
            cause: CauseRef,
            at_ms: u64,
        }
        rules {
            at_ms: NonZeroU64(_);
        }

        ValidatedEvent {
            event_id: EventId,
            proposal_id: ProposalId,
            cause: CauseRef,
            claim_digest: Digest,
            at_ms: u64,
        }
        rules {
            claim_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        AdmittedEvent {
            event_id: EventId,
            intent: AdmittedIntent,
            at_ms: u64,
        }
        rules {
            at_ms: NonZeroU64(_);
        }

        RefusedEvent {
            event_id: EventId,
            proposal_id: ProposalId,
            cause: CauseRef,
            reason_digest: Digest,
            at_ms: u64,
        }
        rules {
            reason_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        ExpiredEvent {
            event_id: EventId,
            proposal_id: ProposalId,
            cause: CauseRef,
            reason_digest: Digest,
            at_ms: u64,
        }
        rules {
            reason_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        CancelledEvent {
            event_id: EventId,
            proposal_id: ProposalId,
            cancellation_id: CancellationId,
            cause: CauseRef,
            reason_digest: Digest,
            at_ms: u64,
        }
        rules {
            reason_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        UnverifiedTrustReceipt {
            receipt: TrustReceipt,
        }
        rules {}

        InputEnvelope {
            session_id: KernelSessionId,
            channel: InputChannel,
            payload_digest: Digest,
            at_ms: u64,
        }
        rules {
            payload_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        // What the engine asks the kernel to discharge.
        //
        // There is no path in it, and that is the point. The target is a handle
        // the host was given before the engine ever spoke, so naming a file is
        // not something this message is able to do; naming a binding the host
        // already holds is. A request carrying a path would make the engine the
        // thing that decides what the kernel may touch, which is the
        // arrangement the kernel exists to replace.
        //
        // `args_digest` is carried rather than derived from the operation,
        // because what a person approves is the arguments they were shown, and
        // policy binds an approval to exactly those.
        EffectRequest {
            intent_id: IntentId,
            proposal_id: ProposalId,
            cause_event_id: EventId,
            scope: Scope,
            target: TargetRef,
            operation_digest: Digest,
            args_digest: Digest,
            requested_at_ms: u64,
            expires_at_ms: u64,
        }
        rules {
            operation_digest: NonZeroBytes(_);
            args_digest: NonZeroBytes(_);
            requested_at_ms: LessThanU64(expires_at_ms);
        }

        // The effect ran, settled, and was checked against what it promised.
        //
        // Both times are carried because they are two facts. An outcome
        // reporting one instant would make "finished" and "checked" the same
        // event, which is the collapse `Settlement` and `Verification` are two
        // types to prevent.
        EffectVerified {
            intent_id: IntentId,
            outcome_digest: Digest,
            postcondition_digest: Digest,
            settled_at_ms: u64,
            verified_at_ms: u64,
        }
        rules {
            outcome_digest: NonZeroBytes(_);
            postcondition_digest: NonZeroBytes(_);
            settled_at_ms: NonZeroU64(_);
            verified_at_ms: NonZeroU64(_);
        }

        // The ledger cannot say whether the world changed.
        //
        // Deliberately not an error and deliberately not a failure: an effect
        // that committed its dispatch and never reported is one reconciliation
        // owns. A caller receiving this has been told the truth, and the one
        // thing it must not do is send the request again.
        EffectUnresolved {
            intent_id: IntentId,
            reason_digest: Digest,
            at_ms: u64,
        }
        rules {
            reason_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }

        // The request will not be dispatched, and here is why.
        //
        // Policy said no, authority said no, nobody answered, the target was
        // never bound, or the ledger already holds a conclusion for it. They
        // are one message because they have one consequence, and they stay
        // distinguishable because the reason is carried.
        EffectDeclined {
            intent_id: IntentId,
            reason_digest: Digest,
            at_ms: u64,
        }
        rules {
            reason_digest: NonZeroBytes(_);
            at_ms: NonZeroU64(_);
        }
    }

    integrity_structs {
        TrustReceipt {
            contract_version: ContractVersion,
            decision: TrustDecision,
            receipt_id: ReceiptId,
            os_identity_digest: Digest,
            nonce: Nonce,
            boot_id: BootId,
            run_id: RunId,
            generation: u64,
            source_digest: Digest,
            entrypoint_digest: Digest,
            issuer_digest: Digest,
            artifact_digest: Digest,
            trust_policy_digest: Digest,
            reason_digest: Digest,
            issued_at_ms: u64,
            expires_at_ms: u64,
        }
        integrity integrity_digest: Digest;
        rules {
            os_identity_digest: NonZeroBytes(_);
            nonce: NonZeroBytes(_);
            generation: NonZeroU64(_);
            source_digest: NonZeroBytes(_);
            entrypoint_digest: NonZeroBytes(_);
            issuer_digest: NonZeroBytes(_);
            artifact_digest: NonZeroBytes(_);
            trust_policy_digest: NonZeroBytes(_);
            reason_digest: NonZeroBytes(_);
            issued_at_ms: LessThanU64(expires_at_ms);
            issued_at_ms: MaxTtl60s(expires_at_ms);
        }
    }

    enums {
        ContractVersion {
            V1 = 1,
        }

        TargetKind {
            Filesystem = 1,
            Process = 2,
            Network = 3,
            External = 4,
            Surface = 5,
        }

        TrustDecision {
            Trusted = 1,
        }

        // Which kind of surface, as a tag rather than as two implementations.
        //
        // The ports differ in what drives them and not in what the kernel may
        // say about them, so the kernel holds the distinction and nothing else.
        // Strategy — what to click, what a page means — stays in Bun, and there
        // is deliberately no CDP, UIA or vision anything in this contract.
        SurfaceKind {
            Browser = 1,
            Computer = 2,
        }

        // Three answers, not two. `Unavailable` is a real result: the host
        // could not enforce what was asked, and saying so is not the same as
        // saying it enforced nothing.
        Enforcement {
            Full = 1,
            Partial = 2,
            Unavailable = 3,
        }

        InputChannel {
            UserFollowup = 1,
            OperatorSteer = 2,
            SystemInject = 3,
            PolicyInterrupt = 4,
            RecoveryInject = 5,
            SchedulerSignal = 6,
        }
    }

    unions {
        Scope {
            Workspace(WorkspaceScope) = 1,
            Session(SessionScope) = 2,
            Task(TaskScope) = 3,
        }

        CauseRef {
            Root(RootCause) = 1,
            Command(CommandCause) = 2,
            Event(EventCause) = 3,
            Intent(IntentCause) = 4,
        }

        TargetRef {
            Filesystem(FilesystemTargetRef) = 1,
            Process(ProcessTargetRef) = 2,
            Network(NetworkTargetRef) = 3,
            External(ExternalTargetRef) = 4,
            Surface(SurfaceTargetRef) = 5,
        }

        // Recovery lives inside the classes that can need it. A `Mutate` with
        // no recovery plan cannot be constructed, so "no mutating tool without
        // recovery" is a fact about the type rather than a rule somebody
        // remembered to check.
        EffectClass {
            Read(ReadEffect) = 1,
            Mutate(MutatingEffect) = 2,
            Reach(ReachingEffect) = 3,
            Spend(SpendingEffect) = 4,
            Irreversible(IrreversibleEffect) = 5,
        }

        Command {
            Propose(ProposeCommand) = 1,
            Cancel(CancelCommand) = 2,
        }

        AdmissionEvent {
            Received(ReceivedEvent) = 1,
            Validated(ValidatedEvent) = 2,
            Admitted(AdmittedEvent) = 3,
            Refused(RefusedEvent) = 4,
            Expired(ExpiredEvent) = 5,
            Cancelled(CancelledEvent) = 6,
        }

        // Three answers, and no fourth that means "it worked, probably".
        //
        // `Unresolved` is not a softer `Declined`: one says nothing ran, the
        // other says something may have. Folding them together would let a
        // caller retry the one case where retrying is the whole danger.
        EffectOutcome {
            Verified(EffectVerified) = 1,
            Unresolved(EffectUnresolved) = 2,
            Declined(EffectDeclined) = 3,
        }
    }

    messages {
        Command = 1,
        AdmissionEvent = 2,
        UnverifiedTrustReceipt = 3,
        InputEnvelope = 4,
        ToolSpec = 5,
        EnforcementReport = 6,
        SurfaceObservation = 7,
        SurfaceAction = 8,
        SurfaceReceipt = 9,
        EffectRequest = 10,
        EffectOutcome = 11,
    }
}

/// A fixed label, widened to a digest.
///
/// Not a hash. This crate is dependency-free on purpose — its manifest says so
/// and the guard holds it to it — so there is no hasher here and none is
/// needed: these fields are opaque identifiers, and one that is legible in a
/// hex dump is more use to whoever is reading a ledger than one that is not.
///
/// It lives here rather than in each binary that wants one. Two copies of
/// "turn this word into a digest" are two answers the moment one of them
/// changes its padding, and the digests they produce are compared across a
/// process boundary.
///
/// Labels longer than 31 bytes are truncated, so they must be chosen to be
/// distinct within that length.
pub fn label_digest(text: &[u8]) -> Digest {
    let mut bytes = [0_u8; 32];
    let width = if text.len() < 31 { text.len() } else { 31 };
    bytes[..width].copy_from_slice(&text[..width]);
    // The contract requires a non-zero digest, and the last byte is never part
    // of the label, so it can carry that guarantee unconditionally.
    bytes[31] = 1;
    Digest::from_bytes(bytes)
}

/// The bytes an authority seals, and nothing else.
///
/// There is deliberately no `verify_with` taking a checker the caller supplies.
/// A receipt this crate would call verified on anyone's say-so proves nothing,
/// and verification belongs to `abdo-authority`, which holds the key that
/// sealed it.
impl UnverifiedTrustReceipt {
    pub fn canonical_integrity_bytes(&self) -> Result<Vec<u8>, EncodeError> {
        self.receipt.canonical_integrity_bytes()
    }

    /// The still-unverified receipt inside.
    ///
    /// Named for what it is: reading a field off this is reading whatever the
    /// presenter wanted it to say.
    pub const fn unverified(&self) -> &TrustReceipt {
        &self.receipt
    }
}
