# Updates

## How the app learns about a new version

The desktop shell reads one small JSON document from the public distribution repository:

```
https://raw.githubusercontent.com/code-ksa/abdocode-addons/main/release/abdocode-desktop.json
```

```json
{
  "schemaVersion": 1,
  "version": "4.0.24",
  "publishedAt": "2026-09-14",
  "notes": "short human notes, up to 600 characters",
  "page": "https://github.com/code-ksa/abdocode/releases/tag/v4.0.24"
}
```

Rules, implemented in `packages/desktop/src-tauri/src/release_check.rs`:

- Versions are compared numerically (`4.0.10` is newer than `4.0.9`); a suffix after `-` is ignored.
- `page` must start with `https://github.com/code-ksa/`, otherwise the releases index is used instead.
- The document is capped at 64 KB and fetched with a 12-second timeout and no redirects.

## When it checks

- 8 seconds after startup.
- Every 6 hours while the app stays open.
- When the window regains focus and the last check is older than an hour.
- Manually from Help → Check for updates.

The check can be turned off in Settings → Runtime ("Check for updates at startup").

## What the user sees

An **Update available &lt;version&gt;** button in the top bar with the notes as its tooltip, plus a short notice. Pressing it opens the release page in the system browser. Dismissing hides that version until a newer one appears or the app restarts. AbdoCode never downloads or installs an update by itself.

## Publishing a release (maintainers)

1. Build the installer and compute `SHA256SUMS.txt`.
2. Create the GitHub release `v<version>` on `code-ksa/abdocode` with both assets.
3. Update `release/abdocode-desktop.json` on `code-ksa/abdocode-addons` (`main`). Installed apps pick it up on their next check.
