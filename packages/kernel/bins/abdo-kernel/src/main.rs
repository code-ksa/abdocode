#![forbid(unsafe_code)]

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("adapter-ledger") {
        return run_adapter_ledger(&args[1..]);
    }
    abdo_runtime::run_host()
}

fn run_adapter_ledger(args: &[String]) -> std::process::ExitCode {
    let result = (|| -> Result<String, String> {
        let command = args
            .first()
            .map(String::as_str)
            .ok_or("missing adapter-ledger command")?;
        match command {
            "begin" if args.len() == 5 => {
                let mut ledger = abdo_runtime::AdapterLedger::open(std::path::Path::new(&args[1]))
                    .map_err(|error| error.to_string())?;
                ledger
                    .begin(effect_from(&args[2], &args[3], &args[4])?)
                    .map_err(|error| error.to_string())?;
                Ok("ADAPTER_LEDGER_BEGIN durable=dispatching".into())
            }
            "settle" if args.len() == 6 => {
                let mut ledger = abdo_runtime::AdapterLedger::open(std::path::Path::new(&args[1]))
                    .map_err(|error| error.to_string())?;
                ledger
                    .settle(
                        effect_from(&args[2], &args[3], &args[5])?,
                        abdo_runtime::adapter_digest_from_hex(&args[4])?,
                    )
                    .map_err(|error| error.to_string())?;
                Ok("ADAPTER_LEDGER_SETTLE durable=verified".into())
            }
            "unknown" if args.len() == 6 => {
                let mut ledger = abdo_runtime::AdapterLedger::open(std::path::Path::new(&args[1]))
                    .map_err(|error| error.to_string())?;
                ledger
                    .mark_unknown(
                        effect_from(&args[2], &args[3], &args[5])?,
                        abdo_runtime::adapter_digest_from_hex(&args[4])?,
                    )
                    .map_err(|error| error.to_string())?;
                Ok("ADAPTER_LEDGER_UNKNOWN durable=unknown_outcome".into())
            }
            "recover" if args.len() == 3 => {
                let mut ledger = abdo_runtime::AdapterLedger::open(std::path::Path::new(&args[1]))
                    .map_err(|error| error.to_string())?;
                let report = ledger
                    .recover(parse_timestamp(&args[2])?)
                    .map_err(|error| error.to_string())?;
                Ok(format!(
                    "ADAPTER_LEDGER_RECOVER scanned={} unresolved={} marked_unknown={} resumable_without_dispatch={}",
                    report.scanned, report.unresolved, report.marked_unknown, report.resumable_without_dispatch
                ))
            }
            _ => Err("invalid adapter-ledger command shape".into()),
        }
    })();
    match result {
        Ok(line) => {
            println!("{line}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("abdo-kernel adapter-ledger: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn effect_from(id: &str, digest: &str, at_ms: &str) -> Result<abdo_runtime::AdapterEffect, String> {
    abdo_runtime::AdapterEffect::from_hex(id, digest, parse_timestamp(at_ms)?)
}

fn parse_timestamp(value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| "timestamp must be an unsigned integer".into())
}
