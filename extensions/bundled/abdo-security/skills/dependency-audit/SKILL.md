---
name: dependency-audit
description: Audit third-party dependencies — known vulnerabilities, unpinned or wildcard versions, install scripts, typosquat-looking names, licenses incompatible with a proprietary product — using the project's package manager audit command and lockfile evidence. Use before adding a dependency or before a release.
---
<!-- Original Abdo Code skill (example, 2026-09-06). -->

# Dependency audit

1. **Inventory** from the lockfile (never from memory): `bun pm ls` / `npm ls --all --json` / `cargo tree` / `pip freeze`. Count direct vs transitive.
2. **Vulnerabilities**: run the native audit (`npm audit --json`, `cargo audit`, `pip-audit`) and list each advisory with package, version, fixed version, and whether the vulnerable code path is reachable in this project.
3. **Hygiene**: flag `latest`, `*`, `^0.x`, git URLs, and packages with `postinstall` scripts; flag names within one edit of a popular package.
4. **License**: list packages whose license is GPL/AGPL/SSPL or unknown — these matter for a closed-core product; Apache-2.0/MIT/BSD/ISC are fine with attribution.
5. **Recommendation** per finding: upgrade (with the exact version), replace, vendor, or accept-with-reason.

Abdo Code rule: an agent never adds a dependency silently — propose it with the audit result and let the owner approve.
