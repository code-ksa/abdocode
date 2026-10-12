/**
 * 10-08 — measured with two projects in two chains: a Next server of another project listened on 0.0.0.0:3000 and [::]:3000; binding
 * 127.0.0.1:3000 still succeeded on Windows, so the port was called free, our server failed silently, the other project answered the probe,
 * its pid was reported as ours, and `audit /` measured a site that was not ours. A port held on any address is not free: the start leases another.
 * The foreign server is a Node listener with no host (dual-stack [::], like `next start`) — Bun's own listener is exclusive and would hide the bug.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listeningPorts, ManagedServers } from "../src/managed-server"

const freePort = (): number => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p + 7 }

test("a port another process holds on [::]/0.0.0.0 is not free: our server gets a leased port and never the foreign pid", async () => {
  const port = freePort()
  const foreign = Bun.spawn(["node", "-e", `require('node:http').createServer((q, r) => r.end("someone else's site")).listen(${port})`], { stdout: "ignore", stderr: "ignore" })
  const dir = mkdtempSync(join(tmpdir(), "abdo-foreign-port-"))
  const servers = new ManagedServers()
  try {
    for (let i = 0; i < 40 && !listeningPorts().has(port); i++) await Bun.sleep(150)
    expect(listeningPorts().has(port)).toBe(true)
    writeFileSync(join(dir, "server.js"), "require('node:http').createServer((q, r) => r.end('ours')).listen(Number(process.env.PORT), '127.0.0.1')\n")
    const receipt = await servers.start({ launch: ["node", "server.js"], port }, dir)
    expect(receipt).toContain("أجّرت لك النواة")
    const leased = Number(/http:\/\/127\.0\.0\.1:(\d+)/u.exec(receipt)?.[1])
    expect(leased).not.toBe(port)
    expect(await (await fetch(`http://127.0.0.1:${leased}/`)).text()).toBe("ours")
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("someone else's site")
  } finally {
    servers.stopAll()
    foreign.kill()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 60_000)
