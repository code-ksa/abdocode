#![forbid(unsafe_code)]

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use abdo_contracts::{
    decode_frame, encode_frame, label_digest, Digest, EffectClass, Enforcement, EnforcementReport,
    IrreversibleEffect, MutatingEffect, ReachingEffect, ReadEffect, RecoveryPlan, ResourceLimits,
    SpendingEffect, ToolId, ToolSpec,
};

const PARENT_GATE_ENV: &str = "ABDO_WORKER_PARENT_GATE";

fn digest(seed: u8) -> Digest {
    let mut bytes = [0_u8; 32];
    bytes[0] = seed;
    bytes[31] = 1;
    Digest::from_bytes(bytes)
}

fn spec(handler_digest: Digest, name_digest: Digest, effect: EffectClass) -> ToolSpec {
    ToolSpec {
        tool_id: ToolId::try_from_u128(1).expect("tool id"),
        name_digest,
        input_schema_digest: digest(3),
        output_schema_digest: digest(4),
        effect,
        resources: ResourceLimits {
            wall_ms: 1_000,
            memory_bytes: 16 * 1024 * 1024,
            output_bytes: 1_024,
            open_handles: 4,
        },
        postcondition_digest: digest(5),
        handler_digest,
    }
}

fn recovery(seed: u8) -> RecoveryPlan {
    RecoveryPlan {
        compensating_operation_digest: digest(seed),
        evidence_operation_digest: digest(seed.wrapping_add(1)),
        max_attempts: 2,
    }
}

fn effect(seed: u8) -> EffectClass {
    match seed % 5 {
        0 => EffectClass::Read(Box::new(ReadEffect)),
        1 => EffectClass::Mutate(Box::new(MutatingEffect {
            recovery: recovery(seed),
        })),
        2 => EffectClass::Reach(Box::new(ReachingEffect {
            recovery: recovery(seed),
            endpoint_class_digest: digest(seed.wrapping_add(2)),
        })),
        3 => EffectClass::Spend(Box::new(SpendingEffect {
            recovery: recovery(seed),
            ledger_digest: digest(seed.wrapping_add(3)),
        })),
        _ => EffectClass::Irreversible(Box::new(IrreversibleEffect {
            evidence_operation_digest: digest(seed.wrapping_add(4)),
        })),
    }
}

fn adapter_name(seed: u8) -> Digest {
    match seed % 5 {
        0 => label_digest(b"abdo-git-read-adapter"),
        1 => label_digest(b"abdo-write-adapter"),
        2 => label_digest(b"abdo-network-adapter"),
        3 => label_digest(b"abdo-package-adapter"),
        _ => label_digest(b"abdo-write-adapter"),
    }
}

fn ask(frame: &[u8]) -> Result<Vec<u8>, i32> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_abdo-tool-worker"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("worker binary");
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(frame)
        .expect("write request");
    let output = child.wait_with_output().expect("worker exit");
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(output.status.code().unwrap_or(-1))
    }
}

#[test]
#[ignore = "S117 exact worker gate; run by the bounded parent harness"]
fn worker_uses_the_canonical_catalog_and_fails_closed() {
    assert_eq!(
        std::env::var(PARENT_GATE_ENV).unwrap_or_default().len(),
        64,
        "S117 worker gate requires its exact parent marker"
    );
    let started = Instant::now();
    let known = label_digest(b"abdo-bounded-tool");
    let mut admitted = 0_u32;
    let mut partial = 0_u32;
    let mut irreversible_refused = 0_u32;
    for seed in 0_u8..125 {
        let request = spec(known, adapter_name(seed), effect(seed));
        let result = ask(&encode_frame(&request).expect("request encodes"));
        if seed % 5 >= 3 {
            assert!(result.is_err());
            irreversible_refused += 1;
            continue;
        }
        let reply = result.expect("compiled enforceable class is admitted");
        let report: EnforcementReport = decode_frame(&reply).expect("report decodes");
        assert_eq!(report.requested_digest, known);
        assert_eq!(report.enforcement, Enforcement::Partial);
        assert!(!report.backend_digest.is_zero());
        assert!(!report.limitations_digest.is_zero());
        admitted += 1;
        partial += 1;
    }

    let unknown = spec(
        digest(99),
        label_digest(b"abdo-git-read-adapter"),
        EffectClass::Read(Box::new(ReadEffect)),
    );
    assert!(ask(&encode_frame(&unknown).expect("request encodes")).is_err());

    let unknown_adapter = spec(
        known,
        label_digest(b"not-a-compiled-adapter"),
        EffectClass::Read(Box::new(ReadEffect)),
    );
    assert!(ask(&encode_frame(&unknown_adapter).expect("request encodes")).is_err());

    let mismatched_effect = spec(
        known,
        label_digest(b"abdo-git-read-adapter"),
        EffectClass::Mutate(Box::new(MutatingEffect {
            recovery: recovery(90),
        })),
    );
    assert!(ask(&encode_frame(&mismatched_effect).expect("request encodes")).is_err());

    assert!(ask(&[]).is_err());
    assert!(ask(&vec![0_u8; 65_537]).is_err());
    println!(
        "S117_WORKER specs=125 admitted={admitted} classes=5 partial={partial} unavailable=0 unknown_refused=1 irreversible_refused={irreversible_refused} malformations=2 elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
