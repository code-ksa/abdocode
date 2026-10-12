/** sshd in a fresh container takes a moment: retry the connection test a few times before calling it a failure. */
export async function addServerReady(
  test: () => Promise<{ readonly ok: boolean; readonly text: string }>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  attempts = 10,
): Promise<{ readonly ok: boolean; readonly text: string }> {
  let last: { readonly ok: boolean; readonly text: string } = { ok: false, text: "لم يُقَس" }
  for (let i = 0; i < attempts; i += 1) {
    last = await test()
    if (last.ok) return last
    await sleep(1_500)
  }
  return last
}
