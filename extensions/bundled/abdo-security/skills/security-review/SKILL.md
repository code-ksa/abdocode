---
name: security-review
description: Security review of a change or a module — injection (SQL, shell, template, path), authentication and authorization gaps, unsafe deserialization, SSRF, insecure defaults, and data exposure; every finding carries file:line, a failure scenario, and a fix. Use before merging or when the user asks "راجع الأمان".
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). -->

# Security review

Review the diff (or the named files) with these lenses, in order. Report only findings you can point to with `file:line` and a concrete failure scenario; "could be risky" without a path is not a finding.

1. **Input reaches a sink** — trace user-controlled input to: SQL/ORM raw queries, shell/`run` commands, HTML/template rendering, file paths, redirects and outbound URLs (SSRF). Parameterise, escape, allow-list, or normalise the path and re-check it stays inside the root.
2. **Who may do this?** — for every route, command, or IPC frame: is the caller authenticated, and is the *object* authorised for *this* user (IDOR)? Absence of a check is a finding, not a default.
3. **Secrets and tokens** — no credentials in code, logs, URLs, error messages, or commit history; tokens compared in constant time; refresh and revocation paths exist.
4. **Crypto and randomness** — passwords hashed with a slow hash (argon2/bcrypt/scrypt), no home-made crypto, random from a CSPRNG.
5. **Deserialization and parsing** — untrusted JSON/YAML/XML parsed with safe loaders and size limits; prototype-pollution-safe merges in JavaScript.
6. **Transport and headers** — TLS verified (no `rejectUnauthorized:false`), cookies `HttpOnly; Secure; SameSite`, CSP present for web UIs.
7. **Fail-closed** — missing config, missing key, or an exception must deny, never allow.

Output: a table `severity · file:line · scenario · fix`, then the one-line verdict: **safe to merge** / **fix first**. If you changed code to fix a finding, run the project's tests and quote the result.
