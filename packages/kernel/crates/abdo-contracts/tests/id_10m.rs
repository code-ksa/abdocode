#![forbid(unsafe_code)]

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::process::Command as ProcessCommand;

use abdo_contracts::{BootId, GeneratorSeed, IdGenerator, IntentId, RunId};

const TOTAL_IDS: usize = 10_000_000;
const GENERATOR_COUNT: usize = 8;
const CHILD_INDEX_ENV: &str = "ABDO_ID_10M_CHILD_INDEX";
const CHILD_OUTPUT_ENV: &str = "ABDO_ID_10M_CHILD_OUTPUT";
const CHILD_DIRECTORY_ENV: &str = "ABDO_ID_10M_CHILD_DIRECTORY";
const CHILD_TOKEN_ENV: &str = "ABDO_ID_10M_CHILD_TOKEN";
const PARENT_GATE_ENV: &str = "ABDO_ID_10M_PARENT_GATE";

#[test]
#[ignore = "S104 exact 10M release stress gate"]
fn id_generator_ten_million_unique() {
    let parent_gate = env::var(PARENT_GATE_ENV).ok();
    let has_child_marker = [
        CHILD_INDEX_ENV,
        CHILD_OUTPUT_ENV,
        CHILD_DIRECTORY_ENV,
        CHILD_TOKEN_ENV,
    ]
    .iter()
    .any(|name| env::var_os(name).is_some());
    match invocation_role(parent_gate, has_child_marker)
        .unwrap_or_else(|message| panic!("{message}"))
    {
        InvocationRole::Child => {
            let child = child_context().expect("complete child context");
            generate_child(child.index, &child.output);
        }
        InvocationRole::Parent(parent_gate) => run_parent(parent_gate),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum InvocationRole {
    Parent(String),
    Child,
}

fn invocation_role(
    parent_gate: Option<String>,
    has_child_marker: bool,
) -> Result<InvocationRole, &'static str> {
    match (parent_gate, has_child_marker) {
        (Some(_), true) => Err("parent and child gate markers cannot coexist"),
        (None, false) => Err("exact 10M test requires the forced parent gate"),
        (None, true) => Ok(InvocationRole::Child),
        (Some(parent_gate), false) => Ok(InvocationRole::Parent(parent_gate)),
    }
}

fn run_parent(token: String) {
    assert!(valid_gate_token(&token), "invalid forced parent gate token");

    assert_eq!(TOTAL_IDS % GENERATOR_COUNT, 0);
    let per_generator = TOTAL_IDS / GENERATOR_COUNT;
    let directory = env::temp_dir().join(format!("abdo-contracts-id-10m-{token}"));
    fs::create_dir(&directory).unwrap();
    let handshake = directory.join(format!("handshake-{token}"));
    let mut handshake_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&handshake)
        .unwrap();
    handshake_file.write_all(token.as_bytes()).unwrap();
    handshake_file.flush().unwrap();
    let executable = env::current_exe().unwrap();
    let mut children = Vec::with_capacity(GENERATOR_COUNT);

    for index in 0..GENERATOR_COUNT {
        let output = directory.join(format!("generator-{index}.bin"));
        let child = ProcessCommand::new(&executable)
            .arg("id_generator_ten_million_unique")
            .arg("--ignored")
            .arg("--exact")
            .env_remove(PARENT_GATE_ENV)
            .env(CHILD_INDEX_ENV, index.to_string())
            .env(CHILD_OUTPUT_ENV, &output)
            .env(CHILD_DIRECTORY_ENV, &directory)
            .env(CHILD_TOKEN_ENV, &token)
            .spawn()
            .unwrap();
        children.push((child, output));
    }

    for (child, _) in &mut children {
        assert!(child.wait().unwrap().success(), "ID child process failed");
    }

    let mut all = Vec::with_capacity(TOTAL_IDS);
    for (_, output) in &children {
        let bytes = fs::read(output).unwrap();
        assert_eq!(bytes.len(), per_generator * 16);
        for chunk in bytes.chunks_exact(16) {
            all.push(u128::from_le_bytes(chunk.try_into().unwrap()));
        }
        fs::remove_file(output).unwrap();
    }
    fs::remove_file(&handshake).unwrap();
    fs::remove_dir(&directory).unwrap();

    assert_eq!(all.len(), TOTAL_IDS);
    all.sort_unstable();
    assert_eq!(all.len(), TOTAL_IDS);
    assert!(
        all.windows(2).all(|pair| pair[0] < pair[1]),
        "sorted adjacent IDs from all child processes must be strictly unique"
    );
}

#[derive(Debug)]
struct ChildContext {
    index: usize,
    output: std::path::PathBuf,
}

fn child_context() -> Option<ChildContext> {
    let index = env::var_os(CHILD_INDEX_ENV);
    let output = env::var_os(CHILD_OUTPUT_ENV);
    let directory = env::var_os(CHILD_DIRECTORY_ENV);
    let token = env::var_os(CHILD_TOKEN_ENV);
    if index.is_none() && output.is_none() && directory.is_none() && token.is_none() {
        return None;
    }

    let index: usize = index
        .expect("partial child environment: missing index")
        .to_string_lossy()
        .parse()
        .expect("invalid child index");
    assert!(
        index < GENERATOR_COUNT,
        "child index is outside the bounded set"
    );
    let output =
        std::path::PathBuf::from(output.expect("partial child environment: missing output"));
    let directory =
        std::path::PathBuf::from(directory.expect("partial child environment: missing directory"));
    let token = token
        .expect("partial child environment: missing token")
        .to_string_lossy()
        .into_owned();
    assert!(valid_gate_token(&token), "invalid child token");

    let canonical_directory = fs::canonicalize(&directory).expect("child directory does not exist");
    let output_parent = output.parent().expect("child output has no parent");
    assert_eq!(
        fs::canonicalize(output_parent).expect("child output parent does not exist"),
        canonical_directory,
        "child output escaped the parent-created directory"
    );
    assert_eq!(
        output.file_name().and_then(|name| name.to_str()),
        Some(format!("generator-{index}.bin").as_str()),
        "child output name is not canonical"
    );
    let handshake = canonical_directory.join(format!("handshake-{token}"));
    assert_eq!(
        fs::read_to_string(handshake).expect("child handshake is missing"),
        token,
        "child handshake token mismatch"
    );
    Some(ChildContext { index, output })
}

fn valid_gate_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[test]
fn parent_gate_token_shape_is_strict() {
    assert!(valid_gate_token(&"ab".repeat(32)));
    assert!(!valid_gate_token(&"AB".repeat(32)));
    assert!(!valid_gate_token(&"ab".repeat(31)));
    assert!(!valid_gate_token(&format!("{}g", "ab".repeat(31))));
}

#[test]
fn forced_parent_invocation_rejects_injected_child_markers() {
    let token = "ab".repeat(32);
    assert_eq!(
        invocation_role(Some(token.clone()), false),
        Ok(InvocationRole::Parent(token))
    );
    assert_eq!(
        invocation_role(Some("ab".repeat(32)), true),
        Err("parent and child gate markers cannot coexist")
    );
    assert_eq!(
        invocation_role(None, false),
        Err("exact 10M test requires the forced parent gate")
    );
    assert_eq!(invocation_role(None, true), Ok(InvocationRole::Child));
}

fn generate_child(index: usize, output: &Path) {
    let per_generator = TOTAL_IDS / GENERATOR_COUNT;
    let discriminator = u8::try_from(index + 0x41).unwrap();
    let seed = GeneratorSeed::new(
        BootId::try_from_u128(0x1_0000 + index as u128).unwrap(),
        RunId::try_from_u128(0x2_0000 + index as u128).unwrap(),
        [discriminator; 16],
    )
    .unwrap();
    let mut generator = IdGenerator::claim(seed).unwrap();
    let mut previous = 0_u128;
    let mut writer = BufWriter::new(File::create(output).unwrap());
    for _ in 0..per_generator {
        let next = generator.issue::<IntentId>().unwrap().get();
        assert!(
            next > previous,
            "each child generator must be strictly increasing"
        );
        previous = next;
        writer.write_all(&next.to_le_bytes()).unwrap();
    }
    writer.flush().unwrap();
    assert_eq!(generator.issued_count(), per_generator as u64);
}
