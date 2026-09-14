//! A minimal JSON writer. There is no serde here because there are no crates
//! here; the helper's whole output surface is a flat object, so this is enough.

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Control characters must be escaped or the output is not JSON.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[derive(Default, Clone)]
pub struct Obj {
    fields: Vec<String>,
}

impl Obj {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn str(mut self, k: &str, v: &str) -> Self {
        self.fields.push(format!("\"{}\":\"{}\"", escape(k), escape(v)));
        self
    }
    pub fn bool(mut self, k: &str, v: bool) -> Self {
        self.fields.push(format!("\"{}\":{}", escape(k), v));
        self
    }
    pub fn num(mut self, k: &str, v: i64) -> Self {
        self.fields.push(format!("\"{}\":{}", escape(k), v));
        self
    }
    pub fn raw(mut self, k: &str, v: &str) -> Self {
        self.fields.push(format!("\"{}\":{}", escape(k), v));
        self
    }
    pub fn null(mut self, k: &str) -> Self {
        self.fields.push(format!("\"{}\":null", escape(k)));
        self
    }
    pub fn finish(self) -> String {
        format!("{{{}}}", self.fields.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_quotes_backslashes_and_controls() {
        assert_eq!(escape("a\"b"), "a\\\"b");
        assert_eq!(escape("C:\\x"), "C:\\\\x");
        assert_eq!(escape("a\nb"), "a\\nb");
        assert_eq!(escape("\u{7}"), "\\u0007");
    }

    #[test]
    fn a_child_that_prints_json_cannot_break_the_envelope() {
        // The child's stdout is DATA. If it were interpolated raw, a program
        // printing `","ok":true` would forge a field.
        let hostile = "\",\"ok\":true,\"x\":\"";
        let out = Obj::new().bool("ok", false).str("stdout", hostile).finish();
        assert_eq!(out, "{\"ok\":false,\"stdout\":\"\\\",\\\"ok\\\":true,\\\"x\\\":\\\"\"}");
        assert!(!out.contains("\"ok\":true"));
    }
}
