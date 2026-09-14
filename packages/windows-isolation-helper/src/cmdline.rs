//! Argv -> Windows command line, and the input validation the protocol needs.
//!
//! `CreateProcessW` takes a STRING, not an argv array — that is the OS boundary
//! and it cannot be avoided. So the encoding happens HERE, once, by the rules
//! `CommandLineToArgvW` parses back. The caller always passes separated
//! arguments; nothing in this helper ever concatenates caller text into a shell
//! command, and there is no code path that hands a string to `cmd.exe /c`.

/// Quote one argument per the CommandLineToArgvW rules.
pub fn quote_arg(arg: &str) -> String {
    // An empty argument must still be a distinct, empty token.
    if !arg.is_empty() && !arg.contains(|c: char| c == ' ' || c == '\t' || c == '"' || c == '\n' || c == '\x0b') {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let chars: Vec<char> = arg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut backslashes = 0;
        while i < chars.len() && chars[i] == '\\' {
            backslashes += 1;
            i += 1;
        }
        if i == chars.len() {
            // Trailing backslashes are doubled so they do not escape the
            // closing quote.
            for _ in 0..backslashes * 2 {
                out.push('\\');
            }
            break;
        } else if chars[i] == '"' {
            for _ in 0..backslashes * 2 + 1 {
                out.push('\\');
            }
            out.push('"');
            i += 1;
        } else {
            for _ in 0..backslashes {
                out.push('\\');
            }
            out.push(chars[i]);
            i += 1;
        }
    }
    out.push('"');
    out
}

pub fn build_command_line(argv: &[String]) -> String {
    argv.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")
}

/// AppContainer profile names are restricted to what the API documents plus our
/// own tightening. A name is the ONLY caller-controlled string that reaches a
/// security API in this helper, so it is validated rather than trusted: no path
/// separators, no wildcards, no unicode games, bounded length.
pub fn is_valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Bounded, so a caller cannot ask the helper to wait forever.
pub const MAX_TIMEOUT_MS: u32 = 600_000;

pub fn parse_timeout(s: &str) -> Option<u32> {
    let v: u32 = s.parse().ok()?;
    if v == 0 || v > MAX_TIMEOUT_MS {
        None
    } else {
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_arguments_are_untouched() {
        assert_eq!(quote_arg("hello"), "hello");
        assert_eq!(quote_arg("C:\\Windows\\System32\\cmd.exe"), "C:\\Windows\\System32\\cmd.exe");
    }

    #[test]
    fn spaces_force_quoting() {
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn embedded_quotes_are_escaped() {
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn trailing_backslashes_are_doubled_before_the_closing_quote() {
        // Otherwise `C:\dir\` would escape the quote and swallow the next token.
        assert_eq!(quote_arg("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
    }

    #[test]
    fn metacharacters_are_data_not_syntax() {
        // The helper never invokes a shell, so these are ordinary characters.
        // The test records that they survive intact rather than being split.
        let line = build_command_line(&["a.exe".into(), "& del x".into(), "| whoami".into()]);
        assert_eq!(line, "a.exe \"& del x\" \"| whoami\"");
    }

    #[test]
    fn profile_names_reject_paths_and_wildcards() {
        assert!(is_valid_profile_name("abdo-run-1"));
        assert!(!is_valid_profile_name(""));
        assert!(!is_valid_profile_name("../escape"));
        assert!(!is_valid_profile_name("a\\b"));
        assert!(!is_valid_profile_name("a*"));
        assert!(!is_valid_profile_name("a b"));
        assert!(!is_valid_profile_name(&"x".repeat(65)));
    }

    #[test]
    fn timeouts_are_bounded() {
        assert_eq!(parse_timeout("1000"), Some(1000));
        assert_eq!(parse_timeout("0"), None);
        assert_eq!(parse_timeout("600001"), None);
        assert_eq!(parse_timeout("abc"), None);
    }
}
