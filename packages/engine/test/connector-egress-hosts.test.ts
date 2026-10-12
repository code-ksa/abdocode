/**
 * 10-09 — measured live: «egress refused: mcp.slack.com — destination was never declared» on Connect (Linear and Notion the same way);
 * the existing live test links against 127.0.0.1, which the fence declares already, so it stayed green. Here the real fence decides.
 */
import { expect, test } from "bun:test"
import { allow, decide } from "@abdo/egress"
import { connectorAuthHosts, connectorDiscoveryFetch, GOOGLE_API_HOSTS, httpsHost } from "../src/connectors/egress-hosts"

test("discovery declares each https host it reaches — and the fence then allows exactly those", async () => {
  const resourceHost = "mcp.example-connector.test"
  const authHost = "auth.example-connector.test"
  expect(decide(resourceHost).decision).toBe("denied")
  const seen: string[] = []
  const fetchImpl = async (input: string | URL | Request) => { const host = new URL(String(input)).hostname; seen.push(`${host}:${decide(host).decision}`); return new Response("{}") }
  const discover = connectorDiscoveryFetch("slack", allow, fetchImpl)
  await discover(`https://${resourceHost}/.well-known/oauth-protected-resource/mcp`)
  await discover(`https://${authHost}/.well-known/oauth-authorization-server`)
  expect(seen).toEqual([`${resourceHost}:allowed`, `${authHost}:allowed`])
  expect(decide(resourceHost).reason).toContain("connector slack")
  // the twin: a plain-http host is never declared through this door
  await discover("http://plain-http.example-connector.test/x")
  expect(decide("plain-http.example-connector.test").decision).toBe("denied")
  expect(decide("unrelated.example-connector.test").decision).toBe("denied")
})

test("auth hosts come from the announced endpoints, https only; Google API hosts cover the bridge's calls", () => {
  expect(connectorAuthHosts({ token_endpoint: "https://slack.com/api/oauth.v2.user.access", registration_endpoint: "https://slack.com/register", authorization_endpoint: "https://slack.com/oauth" })).toEqual(["slack.com"])
  expect(connectorAuthHosts({ token_endpoint: "http://evil.test/token" })).toEqual([])
  expect(httpsHost("not a url")).toBeUndefined()
  expect([...GOOGLE_API_HOSTS].sort()).toEqual(["gmail.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"])
})
