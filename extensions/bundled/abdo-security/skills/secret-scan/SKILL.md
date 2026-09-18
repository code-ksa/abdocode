---
name: secret-scan
description: Scan the working tree and recent history for leaked secrets (API keys, tokens, private keys, connection strings, .env files) using grep patterns, and produce a burn-and-rotate list. Use before pushing, before publishing a preview, or when a secret may have been pasted into the chat.
---
<!-- Original Abdo Code skill (example, 2026-09-06). -->

# Secret scan

1. **Tree scan** with `grep` (regex, case-insensitive) over tracked and untracked files, skipping `node_modules`, `dist`, `target`:
   - `(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}`
   - the PEM header of a private key: `BEGIN … PRIVATE KEY` framed by five dashes on each side (RSA, EC, OPENSSH or plain)
   - `(postgres|mysql|mongodb|redis|amqp)://[^\s"']+:[^\s"']+@`
   - `sk-[A-Za-z0-9]{20,}`, `ghp_[A-Za-z0-9]{30,}`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `AKIA[0-9A-Z]{16}`
   - files named `.env`, `.env.*`, `*.pem`, `*.p12`, `id_rsa*`
2. **History scan**: run `git log -p --all -S "<pattern>" --since="30 days ago"` for each hit family; a secret that was committed once is burned even if deleted later.
3. **Classify** each hit: real secret / example placeholder / test fixture. Only real secrets go to the list.
4. **Burn list**: for each real secret — where it lives, who issued it, the rotation link, and whether it must be removed from history (`git filter-repo`) or only from the tree.
5. **Never print the secret value** in the report; show the file, line, and the first four characters only.

The vault is the only legal home for secrets: point the user to Abdo Code's Settings → Providers / Connectors grants, never to a config file.
