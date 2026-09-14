//! P5c2-FINAL — the resume authorisation message, parsed strictly.
//!
//! ## Why this file exists rather than a `line.find(...)` helper
//!
//! The first version of this parser read each field by locating `"key":` and
//! taking the bytes to the next quote. It shipped a defect immediately: it did
//! not UNESCAPE, so every job name — all of which contain a backslash — came
//! back with a doubled one and every legitimate resume was refused. The failure
//! direction was safe and the identity check caught it, but the lesson is the
//! one this package keeps relearning: a hand-rolled writer needs a reader that
//! provably agrees with it, and "provably" means tests that round-trip through
//! the real writer rather than through a hand-typed string.
//!
//! This message authorises a trusted process to start untrusted code. That is
//! the highest-value message in the system, so it is parsed by a strict reader
//! that refuses everything it does not positively recognise:
//!
//!   * a size limit, checked before anything is scanned;
//!   * no NUL and no other control character anywhere in the raw bytes;
//!   * exactly one flat JSON object, with no nesting and no arrays;
//!   * NO TRAILING DATA after the closing brace;
//!   * DUPLICATE KEYS REFUSED — the classic parser-differential: two readers
//!     disagreeing on whether the first or last wins is how one component
//!     validates a value a different component then acts on;
//!   * UNKNOWN KEYS REFUSED, so a field added by a newer writer cannot be
//!     silently ignored by an older reader that then acts on a partial message;
//!   * MISSING KEYS REFUSED, so an omission cannot read as a default;
//!   * invalid escapes refused rather than passed through.
//!
//! Everything here is a REFUSAL on doubt. The caller turns any `Err` into a
//! refused resume, and a refused resume leaves the target suspended — which is
//! the safe direction, because a target that never resumed never ran.

use crate::json;

/// A message larger than this is refused before it is scanned.
///
/// The real message is ~600 bytes. This is generous enough that a legitimate
/// one can never approach it and small enough that a hostile writer cannot make
/// the parser do meaningful work.
pub const MAX_AUTH_MESSAGE: usize = 4096;

/// The EXACT key set. Not a minimum — a message with more or fewer is refused.
const REQUIRED_KEYS: &[&str] = &[
    "event",
    "protocolVersion",
    "authNonce",
    "runId",
    "operationId",
    "fencingToken",
    "jobNameHash",
    "sessionId",
    "targetPid",
    "targetStartTime",
    "targetThreadId",
    "threadHandle",
    "targetImage",
    "appContainerSid",
];

#[derive(Debug, PartialEq, Eq)]
pub struct ResumeAuthorization {
    pub protocol_version: u32,
    pub auth_nonce: String,
    pub run_id: String,
    pub operation_id: String,
    pub fencing_token: u64,
    pub job_name_hash: String,
    pub session_id: u32,
    pub target_pid: u32,
    pub target_start: u64,
    pub target_thread_id: u32,
    /// The value of the thread handle THE HOST DUPLICATED INTO THE KEEPER.
    ///
    /// Meaningful only inside the keeper's own process, which is where
    /// `DuplicateHandle` created it. A value from anywhere else addresses
    /// nothing there — and the keeper does not trust it regardless: it asks
    /// `GetProcessIdOfThread` which process owns the thread and refuses unless
    /// the answer is the pid authorised alongside it.
    pub thread_handle: u64,
    pub target_image: String,
    pub app_container_sid: String,
}

/// The job's NAME is not sent; its HASH is.
///
/// The keeper already knows the name — it was bound to it at startup and
/// refuses to hold anything else. Sending a hash means the authorisation
/// carries a binding to that name without re-transmitting a string the keeper
/// would then have to re-validate, and it removes the one field that contains a
/// backslash from the wire entirely. The escaping defect that started this file
/// cannot recur for this field because the field is now hex.
pub fn job_name_hash(name: &str) -> String {
    crate::sha256::sha256_hex(name.as_bytes())
}

/// Build the message. THE ONLY WRITER, so the reader has exactly one thing to
/// agree with.
#[allow(clippy::too_many_arguments)]
pub fn build(a: &ResumeAuthorization) -> String {
    json::Obj::new()
        .str("event", "resume_authorized")
        .num("protocolVersion", a.protocol_version as i64)
        .str("authNonce", &a.auth_nonce)
        .str("runId", &a.run_id)
        .str("operationId", &a.operation_id)
        // STRINGS for the wide values: a FILETIME exceeds 2^53 and a fencing
        // token is an identity rather than a quantity.
        .str("fencingToken", &a.fencing_token.to_string())
        .str("jobNameHash", &a.job_name_hash)
        .num("sessionId", a.session_id as i64)
        .num("targetPid", a.target_pid as i64)
        .str("targetStartTime", &a.target_start.to_string())
        .num("targetThreadId", a.target_thread_id as i64)
        .str("threadHandle", &a.thread_handle.to_string())
        .str("targetImage", &a.target_image)
        .str("appContainerSid", &a.app_container_sid)
        .finish()
}

/// One scanned key/value pair, with the value already unescaped.
struct Pair {
    key: String,
    value: String,
    /// Was the value written as a JSON string? A number arriving quoted, or a
    /// string arriving bare, is a shape change and is refused.
    quoted: bool,
}

fn scan_string(b: &[char], i: &mut usize) -> Result<String, String> {
    if b.get(*i) != Some(&'"') {
        return Err("expected a string".into());
    }
    *i += 1;
    let mut out = String::new();
    while *i < b.len() {
        let c = b[*i];
        *i += 1;
        match c {
            '"' => return Ok(out),
            '\\' => {
                let e = *b.get(*i).ok_or("a trailing backslash")?;
                *i += 1;
                match e {
                    '\\' => out.push('\\'),
                    '"' => out.push('"'),
                    '/' => out.push('/'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'u' => {
                        let hex: String = b.get(*i..*i + 4).ok_or("a truncated \\u escape")?.iter().collect();
                        *i += 4;
                        let n = u32::from_str_radix(&hex, 16).map_err(|_| format!("a non-hex \\u escape {:?}", hex))?;
                        // A \u escape that decodes to a control character is
                        // refused for the same reason a raw one is: this message
                        // has no field that may contain one, and allowing it
                        // through an escape would make the raw-byte check above
                        // decorative.
                        let ch = char::from_u32(n).ok_or_else(|| format!("an unpaired surrogate \\u{}", hex))?;
                        if (ch as u32) < 0x20 || ch == '\u{7f}' {
                            return Err(format!("an escaped control character \\u{}", hex));
                        }
                        out.push(ch);
                    }
                    other => return Err(format!("an unknown escape \\{}", other)),
                }
            }
            other => out.push(other),
        }
    }
    Err("an unterminated string".into())
}

/// Parse the message, or say exactly what was wrong with it.
pub fn parse(raw: &str) -> Result<ResumeAuthorization, String> {
    // 1. SIZE, before anything is scanned.
    if raw.len() > MAX_AUTH_MESSAGE {
        return Err(format!("the message is {} bytes, over the {} limit", raw.len(), MAX_AUTH_MESSAGE));
    }
    if raw.is_empty() {
        return Err("the message is empty".into());
    }
    // 2. NO CONTROL CHARACTERS ANYWHERE, NUL above all. Checked on the RAW
    //    bytes, so an embedded NUL cannot ride in and truncate a later
    //    comparison that happens to reach a C API.
    if let Some(c) = raw.chars().find(|&c| (c as u32) < 0x20 || c == '\u{7f}') {
        return Err(format!("the message contains the control character U+{:04X}", c as u32));
    }

    let b: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    let skip_ws = |b: &[char], i: &mut usize| while b.get(*i) == Some(&' ') { *i += 1 };

    skip_ws(&b, &mut i);
    if b.get(i) != Some(&'{') {
        return Err("the message is not a JSON object".into());
    }
    i += 1;

    let mut pairs: Vec<Pair> = Vec::new();
    loop {
        skip_ws(&b, &mut i);
        if b.get(i) == Some(&'}') {
            i += 1;
            break;
        }
        if !pairs.is_empty() {
            if b.get(i) != Some(&',') {
                return Err("expected a comma between fields".into());
            }
            i += 1;
            skip_ws(&b, &mut i);
        }
        let key = scan_string(&b, &mut i).map_err(|e| format!("a key could not be read: {}", e))?;
        skip_ws(&b, &mut i);
        if b.get(i) != Some(&':') {
            return Err(format!("field {:?} has no colon", key));
        }
        i += 1;
        skip_ws(&b, &mut i);
        // FLAT ONLY. A nested object or an array is refused outright rather
        // than skipped, because a reader that skips what it cannot model is a
        // reader that acts on a message it did not fully understand.
        match b.get(i) {
            Some('{') | Some('[') => return Err(format!("field {:?} is nested; this message is flat", key)),
            Some('"') => {
                let value = scan_string(&b, &mut i)?;
                pairs.push(Pair { key, value, quoted: true });
            }
            Some(_) => {
                let start = i;
                while i < b.len() && b[i] != ',' && b[i] != '}' && b[i] != ' ' {
                    i += 1;
                }
                let value: String = b[start..i].iter().collect();
                if value.is_empty() {
                    return Err(format!("field {:?} has no value", key));
                }
                // Only non-negative integers are legal unquoted here; this
                // message has no floats, no booleans and no nulls.
                if !value.chars().all(|c| c.is_ascii_digit()) {
                    return Err(format!("field {:?} has the unquoted non-integer value {:?}", key, value));
                }
                pairs.push(Pair { key, value, quoted: false });
            }
            None => return Err(format!("field {:?} is truncated", key)),
        }
    }

    // 3. NO TRAILING DATA. A second object, or anything at all after the close,
    //    means the sender and this reader disagree about where the message ends.
    skip_ws(&b, &mut i);
    if i != b.len() {
        return Err(format!("there are {} bytes of trailing data after the object", b.len() - i));
    }

    // 4. DUPLICATE KEYS. The classic parser differential: if one component takes
    //    the first and another takes the last, a message can be validated on one
    //    value and acted on with another.
    for (n, p) in pairs.iter().enumerate() {
        if pairs.iter().take(n).any(|q| q.key == p.key) {
            return Err(format!("the key {:?} appears more than once", p.key));
        }
    }
    // 5. EXACTLY THE EXPECTED KEYS — no unknown, none missing.
    for p in &pairs {
        if !REQUIRED_KEYS.contains(&p.key.as_str()) {
            return Err(format!("the key {:?} is not part of this message", p.key));
        }
    }
    for k in REQUIRED_KEYS {
        if !pairs.iter().any(|p| p.key == *k) {
            return Err(format!("the key {:?} is missing", k));
        }
    }

    let get = |k: &str| -> &Pair { pairs.iter().find(|p| p.key == k).expect("presence checked above") };
    let want_quoted = |k: &str| -> Result<String, String> {
        let p = get(k);
        if !p.quoted {
            return Err(format!("field {:?} must be a string", k));
        }
        Ok(p.value.clone())
    };
    let want_number = |k: &str| -> Result<u64, String> {
        let p = get(k);
        if p.quoted {
            return Err(format!("field {:?} must be an unquoted number", k));
        }
        p.value.parse::<u64>().map_err(|_| format!("field {:?} is not a number", k))
    };
    // A wide value travels as a string but must still BE a number.
    let want_numeric_string = |k: &str| -> Result<u64, String> {
        let v = want_quoted(k)?;
        if v.is_empty() || !v.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("field {:?} must be decimal digits, got {:?}", k, v));
        }
        v.parse::<u64>().map_err(|_| format!("field {:?} does not fit", k))
    };

    if want_quoted("event")? != "resume_authorized" {
        return Err("the message is not a resume authorisation".into());
    }
    let nonce = want_quoted("authNonce")?;
    if nonce.len() != 32 || !nonce.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("the authorisation nonce {:?} is not 32 hex characters", nonce));
    }
    let job_hash = want_quoted("jobNameHash")?;
    if job_hash.len() != 64 || !job_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("the job name hash {:?} is not 64 hex characters", job_hash));
    }

    Ok(ResumeAuthorization {
        protocol_version: want_number("protocolVersion")? as u32,
        auth_nonce: nonce,
        run_id: want_quoted("runId")?,
        operation_id: want_quoted("operationId")?,
        fencing_token: want_numeric_string("fencingToken")?,
        job_name_hash: job_hash,
        session_id: want_number("sessionId")? as u32,
        target_pid: want_number("targetPid")? as u32,
        target_start: want_numeric_string("targetStartTime")?,
        target_thread_id: want_number("targetThreadId")? as u32,
        thread_handle: want_numeric_string("threadHandle")?,
        target_image: want_quoted("targetImage")?,
        app_container_sid: want_quoted("appContainerSid")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ResumeAuthorization {
        ResumeAuthorization {
            protocol_version: 10,
            auth_nonce: "0123456789abcdef0123456789abcdef".into(),
            run_id: "run_abc".into(),
            operation_id: "op_def".into(),
            fencing_token: 7,
            job_name_hash: job_name_hash(r"Local\Abdo-IsolatedRun-abc-run_abc-op_def-7-nonce"),
            session_id: 11,
            target_pid: 4242,
            target_start: 134297912686957556,
            target_thread_id: 909,
            thread_handle: 748,
            target_image: r"C:\Windows\System32\cmd.exe".into(),
            app_container_sid: "S-1-15-2-1-2-3".into(),
        }
    }

    /// THROUGH THE REAL WRITER, not a hand-typed string. A test that spells the
    /// escaped form itself encodes the author's belief about the writer, which
    /// is exactly the belief that was wrong the first time.
    #[test]
    fn a_built_message_round_trips_exactly() {
        let a = sample();
        let wire = build(&a);
        // The wire form really does contain an escaped backslash in the image
        // path — otherwise this proves nothing about unescaping.
        assert!(wire.contains(r"C:\\Windows\\System32\\cmd.exe"), "writer must escape: {}", wire);
        assert_eq!(parse(&wire).expect("must parse"), a);
    }

    #[test]
    fn the_job_name_never_travels_as_a_string() {
        let wire = build(&sample());
        assert!(!wire.contains("Abdo-IsolatedRun"), "the NAME must not be on the wire, only its hash");
        assert_eq!(job_name_hash("a").len(), 64);
        assert_ne!(job_name_hash("a"), job_name_hash("b"));
    }

    /// THE NEGATIVE MATRIX. Every one of these must be a refusal, and the
    /// refusal must name what was wrong — a parser that fails without saying why
    /// turns every future incident into a bisect.
    #[test]
    fn the_negative_matrix_refuses_every_malformed_shape() {
        let good = build(&sample());
        let cases: Vec<(&str, String)> = vec![
            ("empty", String::new()),
            ("not an object", "resume_authorized".into()),
            ("oversized", format!("{}{}", good, "x".repeat(MAX_AUTH_MESSAGE))),
            ("trailing data", format!("{} ", good).trim_end().to_string() + "{}"),
            ("two objects", format!("{}{}", good, good)),
            ("duplicate key", good.replacen("\"runId\":\"run_abc\"", "\"runId\":\"run_abc\",\"runId\":\"run_evil\"", 1)),
            ("unknown key", good.replacen('}', ",\"extra\":\"x\"}", 1)),
            ("missing key", good.replacen(",\"targetThreadId\":909", "", 1)),
            ("wrong event", good.replacen("resume_authorized", "resume_something", 1)),
            ("nested object", good.replacen("\"runId\":\"run_abc\"", "\"runId\":{\"a\":1}", 1)),
            ("array value", good.replacen("\"runId\":\"run_abc\"", "\"runId\":[1]", 1)),
            ("number as string", good.replacen("\"targetPid\":4242", "\"targetPid\":\"4242\"", 1)),
            ("string as number", good.replacen("\"runId\":\"run_abc\"", "\"runId\":4242", 1)),
            ("negative number", good.replacen("\"targetPid\":4242", "\"targetPid\":-1", 1)),
            ("non-numeric wide value", good.replacen("\"targetStartTime\":\"134297912686957556\"", "\"targetStartTime\":\"12x4\"", 1)),
            ("short nonce", good.replacen("0123456789abcdef0123456789abcdef", "0123", 1)),
            ("non-hex nonce", good.replacen("0123456789abcdef0123456789abcdef", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", 1)),
            ("short job hash", good.replacen(&job_name_hash(r"Local\Abdo-IsolatedRun-abc-run_abc-op_def-7-nonce"), "abcd", 1)),
            ("unknown escape", good.replacen(r"C:\\Windows", r"C:\qWindows", 1)),
            ("trailing backslash", good.replacen(r"C:\\Windows\\System32\\cmd.exe", r"C:\\Windows\\System32\\cmd.exe\", 1)),
            ("unterminated string", good.replacen("\"run_abc\"", "\"run_abc", 1)),
            ("embedded NUL", good.replacen("run_abc", "run\u{0}abc", 1)),
            ("embedded newline", good.replacen("run_abc", "run\nabc", 1)),
            // An ESCAPED control character, distinct from the two RAW cases
            // above: the raw-byte check never sees this one, so the escape
            // branch is what has to refuse it. Written as an escape in the
            // SOURCE too - a raw control byte in a .rs file is the trap
            // finding 19 records, and the first draft of this line tripped it.
            ("escaped control char", good.replacen("run_abc", r"run\u0007abc", 1)),
            ("no colon", good.replacen("\"runId\":", "\"runId\" ", 1)),
            ("missing comma", good.replacen("\",\"operationId\"", "\" \"operationId\"", 1)),
        ];
        for (label, wire) in cases {
            let r = parse(&wire);
            assert!(r.is_err(), "{}: must be refused, but parsed as {:?}", label, r.ok());
            let why = r.unwrap_err();
            assert!(!why.is_empty(), "{}: the refusal must say why", label);
        }
    }

    /// NON-VACUITY for the matrix above: the unmodified message parses, so the
    /// refusals are the mutations and not some accident of the fixture.
    #[test]
    fn the_matrixs_base_message_is_genuinely_valid() {
        assert!(parse(&build(&sample())).is_ok());
    }

    /// A SPACE INSIDE A VALUE IS LEGAL, and this is not a hypothetical: half the
    /// executables on Windows live under `C:\Program Files`. A parser that
    /// rejected a space in a string would refuse the resume for every one of
    /// them, and it would do it only on machines where the target happened to
    /// be installed there — the worst possible distribution of a bug.
    ///
    /// Written because a case in the negative matrix substitutes a space and is
    /// refused; this proves the refusal there comes from the SHAPE of that
    /// mutation and not from spaces being illegal.
    #[test]
    fn a_space_inside_a_value_is_legal_and_a_program_files_path_survives() {
        let mut a = sample();
        a.target_image = r"C:\Program Files\Some Vendor\tool.exe".into();
        let wire = build(&a);
        let got = parse(&wire).expect("a path with spaces must parse");
        assert_eq!(got.target_image, r"C:\Program Files\Some Vendor\tool.exe");
    }
}
