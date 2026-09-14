# Third-Party Licenses

Abdo Code is proprietary, all rights reserved (see [LICENSE](../LICENSE)).
This file exists because `LICENSE` section 5 promises it, and because removing a
notice that a license requires would strip our own permission to use that code. It
is reproduced for that reason alone.

Reproducing a notice is a legal obligation attached to code. It is not an
affiliation, an endorsement, a dependency, or a channel of any kind: Abdo Code has
no remote, no update path, no telemetry, and no data path to any of these projects.

## Provenance status of THIS tree - measured 2026-09-06

This super-shell tree looks like clean-room work, not derived code. Measured:
no `@opencode-ai/*` package scopes, no `packages/opencode` directory, and every
occurrence of the word `opencode` under `packages/` is a **guard or a comment**:
`engine/src/cli.ts` (forbidden-token list), `egress/src/egress.ts` (forbidden
destination), `engine/src/rail-policy.ts` (a design comparison in a comment).
`scripts/independence-gate.mjs` also passes "replaced core packages absent" and
"no Effect dependency".

**That is an indexed check, not a full provenance audit.** The notice below is kept
deliberately, as the conservative choice: keeping a notice that may not apply costs
nothing, while dropping one that does apply is not recoverable. **A full provenance
audit is required before any public source release** - it is tracked in the
maintainer's internal release checklist.

---

## Engine base — MIT

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Third-party npm dependencies carry their own licenses inside `node_modules`
and are not vendored into this repository.
