#![forbid(unsafe_code)]

//! The exact S114 gate: nothing widens its own authority, and every question
//! that was asked has an answer in the ledger.
//!
//! The number that matters is `widened=0`, and zero only means something if
//! widening was attempted. So the gate counts attempts too, across four
//! separate ways to try it: presenting a live approval after it has run out,
//! presenting the same approval a second time for the identical work, carrying
//! it to different work of the same band, and carrying it to work of a *higher*
//! band. A run where none of those was tried would report zero and prove
//! nothing, and the validator refuses evidence in which any one of the four
//! refusal reasons never appeared.
//!
//! The ledger is walked afterwards rather than trusted from the return values.
//! A gatekeeper that returned `Refused` and wrote nothing, or wrote a grant it
//! did not give, would satisfy every counter in this file and still be wrong.

use std::time::Instant;

use abdo_contracts::Digest;
use abdo_journal::Journal;
use abdo_kernel::EffectIntent;
use abdo_policy::{Approval, ApprovalRefusal, Policy, Risk, RISK_BANDS};
use abdo_runtime::{
    ApprovalPort, ApprovalQuestion, Clearance, EffectPhase, EffectSupervisor, Gatekeeper,
};

mod support;
use support::{cause_hash, effect_id_of, stream, GrantingAuthority, TestDirectory};

const PARENT_GATE_ENV: &str = "ABDO_POLICY_PARENT_GATE";
const EFFECTS: u128 = 250;
/// Attempts to widen, per approval that was genuinely granted.
const WIDENINGS_PER_GRANT: u128 = 4;

fn digest(fill: u8) -> Digest {
    Digest::from_bytes([fill; 32])
}

/// A digest that differs per effect, so two effects never share a binding by
/// accident and a genuine one-shot refusal is never mistaken for a collision.
fn args_of(seed: u128) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&seed.to_be_bytes());
    bytes[31] = 0x77;
    Digest::from_bytes(bytes)
}

fn operation_of(band: Risk) -> Digest {
    digest(0xa0 + band.band())
}

fn intent_for(seed: u128, band: Risk) -> EffectIntent {
    let mut effect = support::intent(seed);
    effect.operation_digest = operation_of(band);
    effect
}

/// How the person on the other end behaves.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Behaviour {
    Agrees,
    Declines,
    Silent,
    AnswersElsewhere,
    AnswersExpired,
}

const BEHAVIOUR_ORDER: [Behaviour; 5] = [
    Behaviour::Agrees,
    Behaviour::Declines,
    Behaviour::Silent,
    Behaviour::AnswersElsewhere,
    Behaviour::AnswersExpired,
];

struct Operator {
    behaviour: Behaviour,
    /// Filled in when a grant is issued, so the second half of the gate has a
    /// real approval to try to carry elsewhere.
    granted: std::cell::RefCell<Option<Digest>>,
}

impl Operator {
    fn new(behaviour: Behaviour) -> Self {
        Self {
            behaviour,
            granted: std::cell::RefCell::new(None),
        }
    }
}

impl ApprovalPort for Operator {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        match self.behaviour {
            Behaviour::Silent => None,
            Behaviour::Declines => Some(Approval {
                binding: question.binding,
                granted: false,
                decided_at_ms: question.asked_at_ms,
                expires_at_ms: question.asked_at_ms + 60_000,
            }),
            Behaviour::AnswersElsewhere => Some(Approval {
                binding: digest(0xfe),
                granted: true,
                decided_at_ms: question.asked_at_ms,
                expires_at_ms: question.asked_at_ms + 60_000,
            }),
            Behaviour::AnswersExpired => Some(Approval {
                binding: question.binding,
                granted: true,
                decided_at_ms: question.asked_at_ms.saturating_sub(120_000),
                // Already run out at the moment it is presented.
                expires_at_ms: question.asked_at_ms,
            }),
            Behaviour::Agrees => {
                *self.granted.borrow_mut() = Some(question.binding);
                Some(Approval {
                    binding: question.binding,
                    granted: true,
                    decided_at_ms: question.asked_at_ms,
                    expires_at_ms: question.asked_at_ms + 60_000,
                })
            }
        }
    }
}

/// Presents a binding it was handed, whatever it is asked.
///
/// This is the shell or the model carrying somebody else's approval to work
/// nobody approved.
struct Replays {
    binding: Digest,
    expires_at_ms: u64,
}

impl ApprovalPort for Replays {
    fn ask(&self, question: &ApprovalQuestion) -> Option<Approval> {
        Some(Approval {
            binding: self.binding,
            granted: true,
            decided_at_ms: question.asked_at_ms,
            expires_at_ms: self.expires_at_ms,
        })
    }
}

#[derive(Default)]
struct Tally {
    allowed: u64,
    denied: u64,
    approved: u64,
    no_decision: u64,
    binding: u64,
    expired: u64,
    replayed: u64,
    said_no: u64,
}

impl Tally {
    fn refusal(&mut self, refusal: ApprovalRefusal, denied_by_policy: bool) {
        if denied_by_policy {
            self.denied += 1;
            return;
        }
        match refusal {
            ApprovalRefusal::NoDecision => self.no_decision += 1,
            ApprovalRefusal::BindingMismatch => self.binding += 1,
            ApprovalRefusal::Expired { .. } => self.expired += 1,
            ApprovalRefusal::Replayed => self.replayed += 1,
            ApprovalRefusal::Refused => self.said_no += 1,
        }
    }
}

#[test]
#[ignore = "S114 exact policy and approval gate"]
fn nothing_widens_its_own_authority_and_every_question_is_answered_in_the_ledger() {
    let gate = std::env::var(PARENT_GATE_ENV).unwrap_or_default();
    assert_eq!(
        gate.len(),
        64,
        "S114 policy gate requires its exact parent marker"
    );

    let started = Instant::now();
    let directory = TestDirectory::new("s114-policy");
    let mut journal = Journal::open(directory.journal_path()).expect("journal opens");
    let supervisor = EffectSupervisor::new();

    let mut policy = Policy::new();
    for band in RISK_BANDS {
        policy.classify(operation_of(band), band);
    }
    // The top band is refused outright, and also put on the allow list, so the
    // run proves denial is reached before the allowance rather than after it.
    policy.deny(operation_of(Risk::R4));
    policy.allow_without_approval(operation_of(Risk::R4));
    let mut gatekeeper = Gatekeeper::new(policy);

    let mut tally = Tally::default();
    let mut reached_authorized = 0_u64;
    let mut authorized_uncleared = 0_u64;
    // Each granted binding, with the seed whose arguments produced it. The seed
    // matters: reusing the *identical* arguments is the only way to reach the
    // one-shot check, because anything else is stopped earlier by the binding.
    let mut live_bindings: Vec<(Digest, u128)> = Vec::new();
    let mut seeds_used: Vec<u128> = Vec::new();

    // --- the honest sweep ---------------------------------------------------
    for index in 0..EFFECTS {
        let bands = RISK_BANDS.len() as u128;
        let band = RISK_BANDS[(index % bands) as usize];
        let behaviour = BEHAVIOUR_ORDER[((index / bands) % BEHAVIOUR_ORDER.len() as u128) as usize];
        let seed = index + 1;
        let effect = intent_for(seed, band);
        seeds_used.push(seed);

        let prepared = supervisor
            .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
            .expect("prepare");

        let operator = Operator::new(behaviour);
        let clearance = gatekeeper
            .clear(
                &mut journal,
                &effect,
                args_of(seed),
                stream(),
                cause_hash(),
                &operator,
                1_100,
            )
            .expect("clear");

        match clearance {
            Clearance::Allowed => tally.allowed += 1,
            Clearance::Approved { risk } => {
                assert_eq!(
                    risk, band,
                    "the band shown was not the band policy assigned"
                );
                tally.approved += 1;
                if let Some(binding) = *operator.granted.borrow() {
                    live_bindings.push((binding, seed));
                }
            }
            Clearance::Refused { risk, refusal } => {
                assert_eq!(
                    risk, band,
                    "the band shown was not the band policy assigned"
                );
                tally.refusal(refusal, band == Risk::R4);
            }
        }

        // Every effect is offered to an authority that grants everything, so
        // the only thing that can stop it is the clearance. The token was
        // obtained before the gatekeeper ran, which is exactly the position a
        // caller trying to skip the gate would be in.
        if supervisor
            .authorize(&mut journal, prepared, &effect, &GrantingAuthority, 1_200)
            .is_ok()
        {
            reached_authorized += 1;
            if !clearance.is_cleared() {
                authorized_uncleared += 1;
            }
        }
    }

    // --- the attempts to widen ----------------------------------------------
    assert!(
        !live_bindings.is_empty(),
        "no approval was ever granted, so carrying one elsewhere proves nothing"
    );
    let mut widening_attempts = 0_u64;
    let mut widened = 0_u64;
    let mut widening_refusals = Tally::default();

    for (offset, (binding, source_seed)) in live_bindings.iter().copied().enumerate() {
        // The order is deliberate. Expiry is checked before the one-shot record
        // is spent, so the expired attempt has to come first; the other way
        // round it would be refused as a replay and the expiry check would go
        // untested while the gate still reported zero widenings.
        let attempts = [
            // 1. The same approval, the same work, already run out.
            (Risk::R1, args_of(source_seed), 1_100_u64),
            // 2. The same approval, the same work, still live: one answer used
            //    twice.
            (Risk::R1, args_of(source_seed), 61_100),
            // 3. Different work of the same band.
            (Risk::R1, args_of(EFFECTS * 7 + offset as u128), 61_100),
            // 4. Different work of a higher band: an R1 answer covering R3.
            (Risk::R3, args_of(EFFECTS * 9 + offset as u128), 61_100),
        ];
        for (step, (band, args, expiry)) in attempts.into_iter().enumerate() {
            let seed = EFFECTS
                + 1
                + (offset as u128) * WIDENINGS_PER_GRANT
                + u128::try_from(step).unwrap();
            let effect = intent_for(seed, band);
            seeds_used.push(seed);
            supervisor
                .prepare(&mut journal, &effect, stream(), cause_hash(), 1_000)
                .expect("prepare");
            widening_attempts += 1;
            let clearance = gatekeeper
                .clear(
                    &mut journal,
                    &effect,
                    args,
                    stream(),
                    cause_hash(),
                    &Replays {
                        binding,
                        expires_at_ms: expiry,
                    },
                    1_100,
                )
                .expect("clear");
            match clearance {
                Clearance::Refused { refusal, .. } => widening_refusals.refusal(refusal, false),
                _ => widened += 1,
            }
        }
    }

    // Every one of the attempts must have been refused for its own reason.
    // Without this, three of them could be stopped by the same early check and
    // the gate would still report zero widenings.
    assert!(
        widening_refusals.expired > 0,
        "no attempt was refused for being out of date"
    );
    assert!(
        widening_refusals.replayed > 0,
        "no approval was ever presented twice, so one-shot went untested"
    );
    assert!(
        widening_refusals.binding > 0,
        "no approval was carried to different work"
    );

    // --- what the ledger says ------------------------------------------------
    let mut asked_in_ledger = 0_u64;
    let mut decided_in_ledger = 0_u64;
    let mut unanswered = 0_u64;
    let mut decided_without_asking = 0_u64;
    let mut authorized_without_clearance = 0_u64;

    for seed in seeds_used.iter().copied() {
        let effect = support::intent(seed);
        let phases: Vec<EffectPhase> = journal
            .effect_history(effect_id_of(&effect))
            .expect("history")
            .iter()
            .map(|record| EffectPhase::from_tag(record.phase_tag.get()).expect("known phase"))
            .collect();
        assert!(!phases.is_empty(), "an effect left no trace at all");

        let asked = phases
            .iter()
            .filter(|phase| **phase == EffectPhase::ApprovalAsked)
            .count() as u64;
        let decided = phases
            .iter()
            .filter(|phase| matches!(phase, EffectPhase::Cleared | EffectPhase::ApprovalRefused))
            .count() as u64;
        asked_in_ledger += asked;
        decided_in_ledger += decided;
        // Nothing crashed in this run, so a question without an answer beside
        // it is a question the kernel dropped.
        if asked > decided {
            unanswered += 1;
        }
        // The other direction is legitimate and has exactly two causes: policy
        // allowed the operation, or policy denied it. Either way a decision
        // exists that nobody was asked for. Counting it separately keeps that
        // from hiding a dropped question.
        if decided > asked {
            decided_without_asking += 1;
        }

        for pair in phases.windows(2) {
            if pair[1] == EffectPhase::Authorized && pair[0] != EffectPhase::Cleared {
                authorized_without_clearance += 1;
            }
        }
    }

    let Tally {
        allowed,
        denied,
        approved,
        no_decision,
        binding,
        expired,
        replayed,
        said_no,
    } = tally;

    assert_eq!(widened, 0, "an approval was widened onto other work");
    assert_eq!(
        authorized_uncleared, 0,
        "an effect the gatekeeper refused reached authorisation anyway"
    );
    assert_eq!(unanswered, 0, "a question was asked and never answered");
    assert_eq!(
        decided_without_asking,
        allowed + denied,
        "an answer appeared for work nobody was asked about and policy neither allowed nor denied it"
    );
    assert_eq!(
        authorized_without_clearance, 0,
        "an effect reached authorisation without an allowance or a grant"
    );
    assert_eq!(
        asked_in_ledger,
        gatekeeper.asked(),
        "the ledger and the counter disagree about how many people were asked"
    );
    assert_eq!(
        decided_in_ledger,
        gatekeeper.allowed() + gatekeeper.granted() + gatekeeper.refused(),
        "the ledger and the counter disagree about how many answers were recorded"
    );
    // A person saying yes and a rule saying nobody needs to are counted apart,
    // so an unattended run cannot report itself as a supervised one.
    assert_eq!(gatekeeper.allowed(), allowed);
    assert_eq!(gatekeeper.granted(), approved);

    let elapsed_ms = started.elapsed().as_millis();
    let widened_expired = widening_refusals.expired;
    let widened_replayed = widening_refusals.replayed;
    let widened_binding = widening_refusals.binding;
    println!(
        "S114_POLICY effects={EFFECTS} allowed={allowed} denied={denied} asked={} approved={approved} refused_no_decision={no_decision} refused_binding={binding} refused_expired={expired} refused_replay={replayed} refused_no={said_no} widened_expired={widened_expired} widened_replayed={widened_replayed} widened_binding={widened_binding} widening_attempts={widening_attempts} widened={widened} asked_in_ledger={asked_in_ledger} decided_in_ledger={decided_in_ledger} unanswered={unanswered} decided_without_asking={decided_without_asking} authorized_reached={reached_authorized} authorized_without_clearance={authorized_without_clearance} elapsed_ms={elapsed_ms}",
        gatekeeper.asked()
    );
}
