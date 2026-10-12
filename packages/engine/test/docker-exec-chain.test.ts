/**
 * 10-08 — بروفة النشر: `docker exec test-server mkdir -p /root/.ssh && chmod 700 /root/.ssh` ⇦ «The token '&&' is not a valid statement
 * separator» في PowerShell 5.1. السلسلةُ بعد docker exec تُلفّ sh -c '…' (الحاويةُ هي المقصودة)، وما لا يُصلَح بعد صدفٍ بعيدة يُردّ
 * بالصيغة المقتبسة؛ وسلاسلُ docker compose/run المحلّيّة تُترجم كأيّ سلسلة.
 */
import { describe, expect, test } from "bun:test"
import { dockerExecChainRepair, powershellChainRepair, remoteChainViolation } from "../src/powershell-call-repair"

describe("docker exec chains run inside the container", () => {
  test("the measured command is wrapped in sh -c after the container name", () => {
    expect(dockerExecChainRepair("docker exec test-server mkdir -p /root/.ssh && chmod 700 /root/.ssh")?.command)
      .toBe("docker exec test-server sh -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh'")
  })
  test("flags with and without values stay before the container", () => {
    expect(dockerExecChainRepair("docker exec -it -u root -w /app web npm ci && npm test || echo bad")?.command)
      .toBe("docker exec -it -u root -w /app web sh -c 'npm ci && npm test || echo bad'")
  })
  test("no repair: already sh -c, a single quote inside, no chain, or not docker exec", () => {
    expect(dockerExecChainRepair(`docker exec web sh -c "a" && b`)).toBeUndefined()
    expect(dockerExecChainRepair("docker exec web echo 'x' && y")).toBeUndefined()
    expect(dockerExecChainRepair("docker exec web ls /root")).toBeUndefined()
    expect(dockerExecChainRepair("npm ci && npm test")).toBeUndefined()
  })
})

describe("remote shells: an unquoted chain is refused with the quoted form", () => {
  test("ssh/wsl/docker exec with an unquoted && are refused, naming the quoted form", () => {
    for (const cmd of ["ssh host cd /srv && ls", "wsl bash -c a && b", `docker exec web sh -c "a" && b`]) {
      const r = remoteChainViolation(cmd)
      expect(r).toBeDefined()
      expect(r!).toContain("sh -c 'A && B'")
    }
  })
  test("positive twins: quoted chains pass, and docker compose/run chains are translated locally", () => {
    expect(remoteChainViolation("ssh host 'cd /x && ls'")).toBeUndefined()
    expect(remoteChainViolation("docker exec web sh -c 'a && b'")).toBeUndefined()
    expect(remoteChainViolation("docker compose build && docker compose up -d")).toBeUndefined()
    expect(powershellChainRepair("docker compose build && docker compose up -d")?.command).toBe("docker compose build; if ($?) { docker compose up -d }")
    expect(powershellChainRepair("docker run -d -p 127.0.0.1:8080:80 img && docker ps")?.command).toBe("docker run -d -p 127.0.0.1:8080:80 img; if ($?) { docker ps }")
  })
})
