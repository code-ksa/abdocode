---
name: pre-commit-security
description: Security checklist to run on the staged diff right before a commit — secrets, debug backdoors, disabled checks, broadened permissions, new network destinations, and dangerous file changes — with a go/no-go verdict. Use when the user says "commit" or asks for a final check.
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). -->

# Pre-commit security checklist

Read `git diff --cached` and answer each line with evidence (file:line) or "none":

- [ ] **Secrets**: any key, token, password, connection string, or `.env` content in the diff?
- [ ] **Backdoors and debug leftovers**: hard-coded credentials, `if user == "admin"`, disabled auth for "testing", verbose logging of request bodies?
- [ ] **Checks removed**: a validation, guard, permission check, TLS verification, or test deleted or skipped (`.skip`, `xit`, `#[ignore]`)?
- [ ] **Permissions widened**: new file permissions, CORS `*`, broader OAuth scopes, `<all_urls>`, sudo/admin flags?
- [ ] **New network destinations**: any new host, URL, or port — is it declared with a written reason (egress guard)?
- [ ] **Dangerous files**: changes to CI config, install scripts, git hooks, shell aliases, or system settings?
- [ ] **Data handling**: new logging or storage of personal data without a stated purpose?

Verdict: **GO** (nothing found) or **NO-GO** with the list. Never commit for the user without the verdict shown first.
