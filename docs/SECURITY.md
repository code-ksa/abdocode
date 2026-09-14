# Security model

## Principles

- **Absence is refusal.** A missing key, a missing trust file or an unknown site means "cannot prove", never "allowed".
- **One gate.** Every effect (file write, command, network, browser input, desktop input) goes through the kernel's policy with the mode the user chose: read-only, ask, or full access. In *ask* mode the shell shows an approval request; the engine re-verifies the target after approval, because pages move between the question and the click.
- **Receipts, not claims.** Tool results carry a verdict. The model's own prose cannot mark a task done; fabricated command output without a receipt is detected and corrected.
- **Local by default.** State, ledger, memory and screenshots stay on the machine. Nothing is uploaded except the model requests the user configured.

## Secrets

- Keys are stored in the Windows vault (DPAPI, current user). They never appear in argv, in the ledger, in the UI, or in the model prompt.
- Provider calls are executed by the Rust tool worker, which reads the key from the vault handle; the TypeScript engine only passes URL and body.
- A secret pasted into the chat is detected before storage, the user is warned to rotate it, and it is moved into the vault under a suggested handle.
- Child MCP servers receive credentials only as granted environment variables, one server at a time.

## Browser

- The owned browser is an isolated Edge profile. Site access follows a saved allow/block policy; unknown sites ask.
- Credential fields are refused by type: the agent never types into a password field.
- In the user's own browser (extension backend) the agent can read and tap, never type.

## Desktop control

Off by default. When enabled, every input action needs a window bound in the same call, and the window is re-checked before and after the action.

## Engine lifecycle

- One engine per state directory; a second engine is refused with a named reason.
- The engine exits on its own when the desktop that launched it dies (owner watch), so no orphan holds the state lock or the payload files.

## Updates

No automatic download or install. The app reads a small JSON document from the public distribution repository, compares versions numerically, and offers a button that opens the release page. Pages outside `github.com/code-ksa/` are ignored.

## Reporting

Please report security issues privately to technoksaweb@gmail.com with steps to reproduce.
