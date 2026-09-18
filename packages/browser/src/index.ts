/**
 * @abdo/browser — the ladder, and the rung you may not skip.
 *
 * DOM and the accessibility tree first, semantics before pixels, vision only
 * after a RECORDED semantic failure, and raw coordinates last with the target
 * re-verified before the click lands. Every agent that drives a browser badly
 * does it in the opposite order, because a screenshot and a click at (412, 388)
 * is the shortest thing to write — and the first thing to break when a banner
 * loads.
 */
export * from "./provider"
export * from "./page"
export * from "./observe"
export * from "./sessions"
export * from "./cdp"
export * from "./spec-walker"
