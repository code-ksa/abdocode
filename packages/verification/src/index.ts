/**
 * @abdo/verification — one engine, one verdict, and UNAVAILABLE is never a pass.
 *
 * Every gate here exists because of a specific way a run reports success while
 * being wrong, and most of them have happened in this repository: a build
 * failure swallowed by a pipe, "11/11 passed" with the database stopped, a
 * green build for an app that does not boot, a UI sprint where nobody loaded
 * the page, a secret in a diff, and a criterion nothing could check.
 *
 * The expensive half of verification — the second model run — is spent in
 * proportion to risk, and every skip is recorded with its reason.
 */
export * from "./engine"
export * from "./gates"
export * from "./network"
