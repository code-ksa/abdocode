/**
 * THE token estimate for this product. One implementation, deliberately.
 *
 * It lives here — in the lightest shared package, with no Node APIs and no
 * dependency at all (rebuilt effect-free on the Rust-kernel tree) — because
 * everything that needs it must be able to
 * reach it: the context compiler, the window manager, the compaction budgeter,
 * the tool-catalog ranker, and the browser UI that shows the user where their
 * context went.
 *
 * WHY THREE CHARACTERS PER TOKEN, MEASURED NOT CHOSEN
 *
 * A provider reported **15,912 tokens for messages estimated at 13,150** — 21%
 * more than believed — on ordinary JavaScript with JSON-escaped tool results.
 * That is about 3.3 characters per token. Four under-counts badly on exactly
 * the content a coding agent handles most.
 *
 * AN UNDER-COUNT IS THE DANGEROUS DIRECTION. It hands the truncation decision
 * to the provider, which makes it silently and in the middle of a prompt. Every
 * symptom downstream — an edit anchor "not present", a command that made no
 * sense, a route appended after `app.listen` — is consistent with a model that
 * was shown less than we believed. Over-counting costs a message we did not
 * have to drop; under-counting costs a prompt nobody knows was cut.
 *
 * WHY ONE COPY
 *
 * On 2026-08-20 a survey found FOUR of these in a single binary — three
 * dividing by 4 and one by 3. The context compiler sized a text at N while the
 * window manager sized the same text at 1.33N, so context was packed to a
 * budget computed one way and then measured another.
 *
 * The divergence had widened that same morning, by a change that was correct in
 * its own file: a divisor moved from 4 to 3 to fix a spill threshold, with no
 * way to know three other copies existed. **That is what duplication does — it
 * turns a correct local fix into a system-wide defect.**
 *
 * `packages/context/test/single-estimator.test.ts` fails if a second definition
 * appears anywhere in a package source tree.
 *
 * (That sentence used to name the glob directly. The glob contains the two
 * characters that END a block comment, so it closed this one early and the next
 * backtick opened a template literal that never terminated. Typecheck caught
 * it; it is worth remembering that a comment can be syntax.)
 *
 * This is a heuristic, not a tokenizer. When a real tokenizer is available,
 * replace the body here and nowhere else — which is the entire point.
 */
export const CHARS_PER_TOKEN = 3

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/**
 * The same estimate for a character count that has already been totalled.
 *
 * A legitimate second shape, not a second implementation: callers that sum
 * lengths across many pieces should not have to concatenate them into one
 * string just to measure it. It divides by the same constant, so a UI built on
 * this and an engine built on `estimateTokens` cannot disagree.
 */
export const tokensFromChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)
