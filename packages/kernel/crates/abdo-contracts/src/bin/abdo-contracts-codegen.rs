#![forbid(unsafe_code)]

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("abdo-contracts-codegen: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let mode = arguments.next();
    let path = arguments.next();
    let fixture_directory = arguments.next();

    if arguments.next().is_some() {
        return Err(usage());
    }

    let generated = abdo_contracts::codegen::typescript_artifact();
    match (mode.as_deref(), path, fixture_directory) {
        (None, None, None) => io::stdout()
            .lock()
            .write_all(generated.as_bytes())
            .map_err(|error| format!("cannot write stdout: {error}")),
        (Some(mode), Some(path), fixtures) if mode == "--out" => {
            let path = PathBuf::from(path);
            fs::write(&path, generated.as_bytes())
                .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
            if let Some(fixtures) = fixtures {
                write_fixtures(&PathBuf::from(fixtures))?;
            }
            Ok(())
        }
        (Some(mode), Some(path), fixtures) if mode == "--check" => {
            let path = PathBuf::from(path);
            let existing = fs::read(&path)
                .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
            if existing != generated.as_bytes() {
                return Err(format!(
                    "{} is not the canonical generated artifact",
                    path.display()
                ));
            }
            if let Some(fixtures) = fixtures {
                check_fixtures(&PathBuf::from(fixtures))?;
            }
            Ok(())
        }
        (Some(mode), Some(directory), None) if mode == "--fixtures" => {
            write_fixtures(&PathBuf::from(directory))
        }
        (Some(mode), Some(directory), None) if mode == "--check-fixtures" => {
            check_fixtures(&PathBuf::from(directory))
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: abdo-contracts-codegen [--out <ts-path> [fixture-dir] | --check <ts-path> [fixture-dir] | --fixtures <dir> | --check-fixtures <dir>]"
        .to_owned()
}

fn write_fixtures(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    write_file(
        directory.join(abdo_contracts::codegen::GOLDEN_CANCEL_COMMAND_BINARY),
        &abdo_contracts::codegen::golden_cancel_command_bytes(),
    )?;
    write_file(
        directory.join(abdo_contracts::codegen::GOLDEN_CANCEL_COMMAND_MANIFEST),
        abdo_contracts::codegen::golden_cancel_command_manifest().as_bytes(),
    )
}

fn check_fixtures(directory: &Path) -> Result<(), String> {
    check_file(
        directory.join(abdo_contracts::codegen::GOLDEN_CANCEL_COMMAND_BINARY),
        &abdo_contracts::codegen::golden_cancel_command_bytes(),
    )?;
    check_file(
        directory.join(abdo_contracts::codegen::GOLDEN_CANCEL_COMMAND_MANIFEST),
        abdo_contracts::codegen::golden_cancel_command_manifest().as_bytes(),
    )
}

fn write_file(path: PathBuf, contents: &[u8]) -> Result<(), String> {
    fs::write(&path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

fn check_file(path: PathBuf, expected: &[u8]) -> Result<(), String> {
    let actual =
        fs::read(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{} is not the canonical generated fixture",
            path.display()
        ))
    }
}
