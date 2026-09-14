#![forbid(unsafe_code)]

//! Asking, refusing, and the ledger that records both.

use abdo_contracts::Digest;
use abdo_journal::Journal;
use abdo_kernel::EffectIntent;
use abdo_policy::{Approval, ApprovalRefusal, Policy, Risk};
use abdo_runtime::{
    ApprovalPort, ApprovalQuestion, Clearance, EffectPhase, EffectSupervisor, Gatekeeper,
    NoOperator, Recovered, RuntimeError,
};

mod support;
use support::{cause_hash, effect_id_of, stream, GrantingAuthority, TestDirectory};

fn digest(fill: u8) -> Digest {
    Digest::from_bytes([fill; 32])
}

/// The shared fixture, with the operation it is judged by made explicit.
///
/// Built from `support::intent` rather than assembled here, so a change to what
/// an effect is does not leave this file describing an older one.
fn intent(seed: u128, operation: u8) -> EffectIntent {
    let mut effect = support::intent(seed);
    effect.operation_digest = digest(operation);
    effect
}

fn open(name: &str) -> (TestDirectory, Journal) {
    let directory = TestDirectory::new(name);
    let journal = Journal::open(directory.journal_path()).expect("open");
    (directory, journal)
}

/// Take responsibility first, so the gatekeeper has a `Prepared` to follow.
fn prepare(journal: &mut Journal, effect: &EffectIntent) {
    EffectSupervisor::new()
        .prepare(journal, effect, stream(), cause_hash(), 1_000)
        .expect("prepare");
}

fn phases(journal: &Journal, effect: &EffectIntent) -> Vec<EffectPhase> {
    journal
        .effect_history(effect_id_of(effect))
        .expect("history")
        .iter()
        .map(|record| EffectPhase::from_tag(record.phase_tag.get()).expect("known phase"))
        .collect()
}

/// An operator who says yes to whatever they are shown.
struct Agrees;

impl ApprovalPort for Agrees {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        Some(Approval {
            binding: question.binding,
            granted: true,
            decided_at_ms: question.asked_at_ms + 1,
            expires_at_ms: question.asked_at_ms + 60_000,
        })
    }
}

/// An operator who answers a different question than the one asked.
struct AnswersElsewhere;

impl ApprovalPort for AnswersElsewhere {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        Some(Approval {
            binding: digest(0xee),
            granted: true,
            decided_at_ms: question.asked_at_ms + 1,
            expires_at_ms: question.asked_at_ms + 60_000,
        })
    }
}

/// An operator who says no.
struct Declines;

impl ApprovalPort for Declines {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        Some(Approval {
            binding: question.binding,
            granted: false,
            decided_at_ms: question.asked_at_ms + 1,
            expires_at_ms: question.asked_at_ms + 60_000,
        })
    }
}

/// Records what it was shown, so the test can check the question itself.
struct Records {
    seen: std::cell::RefCell<Vec<ApprovalQuestion>>,
}

impl ApprovalPort for Records {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        self.seen.borrow_mut().push(*question);
        Some(Approval {
            binding: question.binding,
            granted: true,
            decided_at_ms: question.asked_at_ms + 1,
            expires_at_ms: question.asked_at_ms + 60_000,
        })
    }
}

fn gatekeeper_for(operation: u8, risk: Risk) -> Gatekeeper {
    let mut policy = Policy::new();
    policy.classify(digest(operation), risk);
    Gatekeeper::new(policy)
}

#[test]
fn with_nobody_attached_the_question_is_recorded_and_the_answer_is_no() {
    let (_directory, mut journal) = open("no-operator");
    let effect = intent(1, 0x41);
    prepare(&mut journal, &effect);

    let mut gatekeeper = gatekeeper_for(0x41, Risk::R3);
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x42),
            stream(),
            cause_hash(),
            &NoOperator,
            1_100,
        )
        .expect("clear");

    assert_eq!(
        clearance,
        Clearance::Refused {
            risk: Risk::R3,
            refusal: ApprovalRefusal::NoDecision
        }
    );
    assert!(!clearance.is_cleared());

    // Both facts are in the chain, in order: the question was put, and it came
    // back unanswered. A side log would have let the second exist without the
    // first, or neither.
    assert_eq!(
        phases(&journal, &effect),
        vec![
            EffectPhase::Prepared,
            EffectPhase::ApprovalAsked,
            EffectPhase::ApprovalRefused
        ]
    );
    assert_eq!(gatekeeper.asked(), 1);
    assert_eq!(gatekeeper.granted(), 0);
    assert_eq!(gatekeeper.refused(), 1);
}

#[test]
fn a_question_carries_digests_and_the_risk_policy_assigned() {
    let (_directory, mut journal) = open("question-shape");
    let effect = intent(3, 0x45);
    prepare(&mut journal, &effect);

    let operator = Records {
        seen: std::cell::RefCell::new(Vec::new()),
    };
    let mut gatekeeper = gatekeeper_for(0x45, Risk::R3);
    gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x46),
            stream(),
            cause_hash(),
            &operator,
            1_100,
        )
        .expect("clear");

    let seen = operator.seen.into_inner();
    assert_eq!(seen.len(), 1);
    let question = seen[0];
    assert_eq!(question.intent_id, effect.intent_id);
    // The risk shown is the policy's, and the expiry is the intent's. Neither
    // is anything the operator or the caller supplied at ask time.
    assert_eq!(question.risk, Risk::R3);
    assert_eq!(question.expires_at_ms, effect.expires_at_ms);
    assert_ne!(question.binding, effect.operation_digest);
}

#[test]
fn an_answer_to_another_question_does_not_clear_this_one() {
    let (_directory, mut journal) = open("wrong-binding");
    let effect = intent(4, 0x47);
    prepare(&mut journal, &effect);

    let mut gatekeeper = gatekeeper_for(0x47, Risk::R2);
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x48),
            stream(),
            cause_hash(),
            &AnswersElsewhere,
            1_100,
        )
        .expect("clear");

    assert_eq!(
        clearance,
        Clearance::Refused {
            risk: Risk::R2,
            refusal: ApprovalRefusal::BindingMismatch
        }
    );
    assert_eq!(
        phases(&journal, &effect).last().copied(),
        Some(EffectPhase::ApprovalRefused)
    );
}

#[test]
fn no_is_recorded_as_a_refusal_and_kept_apart_from_silence() {
    let (_directory, mut journal) = open("declined");
    let effect = intent(5, 0x49);
    prepare(&mut journal, &effect);

    let mut gatekeeper = gatekeeper_for(0x49, Risk::R4);
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x4a),
            stream(),
            cause_hash(),
            &Declines,
            1_100,
        )
        .expect("clear");

    // Same consequence as silence, different fact. Conflating them would make
    // an unreachable operator and a deliberate refusal indistinguishable to
    // anyone reading the ledger afterwards.
    assert_eq!(
        clearance,
        Clearance::Refused {
            risk: Risk::R4,
            refusal: ApprovalRefusal::Refused
        }
    );
    assert_ne!(
        clearance,
        Clearance::Refused {
            risk: Risk::R4,
            refusal: ApprovalRefusal::NoDecision
        }
    );
}

#[test]
fn a_denial_is_recorded_without_anybody_being_asked() {
    let (_directory, mut journal) = open("denied");
    let effect = intent(6, 0x4b);
    prepare(&mut journal, &effect);

    let mut policy = Policy::new();
    policy.classify(digest(0x4b), Risk::R1);
    policy.deny(digest(0x4b));
    let mut gatekeeper = Gatekeeper::new(policy);

    // An operator who would have said yes, to prove they were never consulted.
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x4c),
            stream(),
            cause_hash(),
            &Agrees,
            1_100,
        )
        .expect("clear");

    assert!(!clearance.is_cleared());
    assert_eq!(gatekeeper.asked(), 0, "a denied effect was put to a person");
    assert_eq!(
        phases(&journal, &effect),
        vec![EffectPhase::Prepared, EffectPhase::ApprovalRefused],
        "a denial left no trace, or asked anyway"
    );
}

#[test]
fn an_allowance_writes_nothing_and_asks_nobody() {
    let (_directory, mut journal) = open("allowed");
    let effect = intent(7, 0x4d);
    prepare(&mut journal, &effect);

    let mut gatekeeper = gatekeeper_for(0x4d, Risk::R0);
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x4e),
            stream(),
            cause_hash(),
            &NoOperator,
            1_100,
        )
        .expect("clear");

    assert_eq!(clearance, Clearance::Allowed);
    assert!(clearance.is_cleared());
    // Nobody was asked, but the clearance is still recorded: it is the only
    // phase authorisation may follow, so leaving it out would leave the effect
    // stranded rather than trusted.
    assert_eq!(
        phases(&journal, &effect),
        vec![EffectPhase::Prepared, EffectPhase::Cleared]
    );
    assert_eq!(gatekeeper.asked(), 0);
}

#[test]
fn an_approval_is_spent_by_the_effect_it_was_given_for() {
    let (_directory, mut journal) = open("one-shot");
    let first = intent(8, 0x4f);
    let second = intent(9, 0x4f);
    prepare(&mut journal, &first);
    prepare(&mut journal, &second);

    // Two effects, same operation, same scope, same target, same arguments —
    // so the same binding. The first answer must not carry the second.
    struct SaysYesToTheFirstBinding {
        binding: std::cell::RefCell<Option<Digest>>,
    }

    impl ApprovalPort for SaysYesToTheFirstBinding {
        fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
            let mut held = self.binding.borrow_mut();
            let binding = *held.get_or_insert(question.binding);
            Some(Approval {
                binding,
                granted: true,
                decided_at_ms: question.asked_at_ms + 1,
                expires_at_ms: question.asked_at_ms + 60_000,
            })
        }
    }

    let operator = SaysYesToTheFirstBinding {
        binding: std::cell::RefCell::new(None),
    };
    let mut gatekeeper = gatekeeper_for(0x4f, Risk::R2);

    let one = gatekeeper
        .clear(
            &mut journal,
            &first,
            digest(0x50),
            stream(),
            cause_hash(),
            &operator,
            1_100,
        )
        .expect("clear");
    assert_eq!(one, Clearance::Approved { risk: Risk::R2 });

    let two = gatekeeper
        .clear(
            &mut journal,
            &second,
            digest(0x50),
            stream(),
            cause_hash(),
            &operator,
            1_200,
        )
        .expect("clear");
    assert_eq!(
        two,
        Clearance::Refused {
            risk: Risk::R2,
            refusal: ApprovalRefusal::Replayed
        },
        "one answer covered two effects"
    );
}

#[test]
fn a_question_left_unanswered_by_a_crash_is_not_resumed_past() {
    let (directory, mut journal) = open("recover-asked");
    let effect = intent(10, 0x51);
    prepare(&mut journal, &effect);

    // The operator process dies while being asked. The question is already
    // durable; the answer never becomes one.
    struct DiesWhileBeingAsked;
    impl ApprovalPort for DiesWhileBeingAsked {
        fn ask(&self, _question: &ApprovalQuestion) -> Option<Approval> {
            panic!("the operator went away mid-question")
        }
    }

    let mut gatekeeper = gatekeeper_for(0x51, Risk::R3);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        gatekeeper.clear(
            &mut journal,
            &effect,
            digest(0x52),
            stream(),
            cause_hash(),
            &DiesWhileBeingAsked,
            1_100,
        )
    }));
    std::panic::set_hook(previous);
    assert!(crashed.is_err(), "the operator was supposed to die");

    // The handler never returned, so the record cannot have been written after
    // it answered. It is there anyway, which is the ordering claim.
    assert_eq!(
        phases(&journal, &effect),
        vec![EffectPhase::Prepared, EffectPhase::ApprovalAsked]
    );

    // And it is committed, not held open: closing the handle and opening a new
    // one finds the same two phases. A record that only existed in this
    // connection would be a durability claim that a real crash disproves.
    drop(journal);
    let reopened = Journal::open(directory.journal_path()).expect("reopen");
    assert_eq!(
        reopened
            .effect_history(effect_id_of(&effect))
            .expect("history")
            .len(),
        2
    );

    // Awaiting a person, not resumable. Resuming means carrying on from where
    // things stopped, and where things stopped is a question nobody answered:
    // carrying on would be the kernel answering it.
    let recovered = EffectSupervisor::new()
        .recover(&reopened, effect.intent_id)
        .expect("recover");
    assert_eq!(recovered, Recovered::AwaitingApproval);
    assert!(!matches!(recovered, Recovered::Resumable { .. }));
    assert_ne!(recovered, Recovered::Complete);
}

#[test]
fn nothing_follows_a_refusal_even_holding_the_token_that_preceded_it() {
    let directory = TestDirectory::new("refusal-terminal");
    let mut journal = Journal::open(directory.journal_path()).expect("open");
    let effect = intent(12, 0x53);

    let supervisor = EffectSupervisor::new();
    // Kept deliberately: this is the token a caller would still be holding
    // after a refusal, and it is the one thing that could plausibly be used to
    // walk the effect forward anyway.
    let prepared = supervisor
        .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
        .expect("prepare");

    let mut gatekeeper = gatekeeper_for(0x53, Risk::R4);
    let clearance = gatekeeper
        .clear(
            &mut journal,
            &effect,
            digest(0x54),
            stream(),
            cause_hash(),
            &NoOperator,
            1_100,
        )
        .expect("clear");
    assert!(!clearance.is_cleared());

    // An authority that grants, so the refusal is the only thing in the way.
    let refused = supervisor.authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_200);
    assert!(
        matches!(refused, Err(RuntimeError::Transition(_))),
        "a refused effect was authorized anyway: {refused:?}"
    );
    assert_eq!(
        phases(&journal, &effect),
        vec![
            EffectPhase::Prepared,
            EffectPhase::ApprovalAsked,
            EffectPhase::ApprovalRefused
        ],
        "the refusal was walked forward"
    );
    assert!(EffectPhase::ApprovalRefused.is_resolved());
}
