/**
 * 10-10 — measured live: Figma's dynamic registration answers 403 with a bare "Forbidden" (shown as «ردٌّ ليس JSON (403)»), Gamma answers
 * invalid_redirect_uri for any loopback address (only approved clients' URIs). Both are the service's policy; the message must say so.
 */
import { expect, test } from "bun:test"
import { registerClient, type AuthServerMetadata } from "../src/connectors/oauth"

const meta = { issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/a", token_endpoint: "https://auth.example.test/t", registration_endpoint: "https://auth.example.test/register" } as AuthServerMetadata
const reply = (status: number, body: string) => async () => new Response(body, { status })
const opts = { clientName: "Abdo Code", redirectUris: ["http://127.0.0.1:53111/callback"] }

test("403 with a bare text body (Figma): named as a service that only admits approved clients", async () => {
  const why = await registerClient(meta, opts, reply(403, "Forbidden")).then(() => "", (e: Error) => e.message)
  expect(why).toContain("HTTP 403")
  expect(why).toContain("عملاءٍ اعتمدتهم")
  expect(why).not.toContain("ليس JSON")
})

test("invalid_redirect_uri (Gamma): named as refusing the local return address", async () => {
  const why = await registerClient(meta, opts, reply(400, JSON.stringify({ error: "invalid_redirect_uri", error_description: "redirect_uri not allowed" }))).then(() => "", (e: Error) => e.message)
  expect(why).toContain("عنوانَ العودة المحلّيّ")
  expect(why).toContain("127.0.0.1:53111")
})

test("the twin: a 201 with client_id still registers", async () => {
  const client = await registerClient(meta, opts, reply(201, JSON.stringify({ client_id: "abc" })))
  expect(client.clientId).toBe("abc")
})
