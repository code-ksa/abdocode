/**
 * 10-08 (measured with two projects in two chains): every engine launched its managed Edge on the same CDP port 9333; when it was taken the
 * engine attached to whatever answered — another project's browser, with that project's profile and sign-ins — and the site's audit drove it
 * and stalled ("stuck"). The port is derived from the engine's own state directory: stable for one engine (it re-attaches to its own browser
 * after a restart), different for two engines.
 */
import { createHash } from "node:crypto"

export const BROWSER_PORT_BASE = 9333

export function browserPortFor(stateRoot: string): number {
  const digest = createHash("sha256").update(stateRoot.replace(/\\/gu, "/").toLowerCase()).digest()
  return BROWSER_PORT_BASE + (digest.readUInt16BE(0) % 400)
}
