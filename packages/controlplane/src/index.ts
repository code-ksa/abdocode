/**
 * @abdo/controlplane — state in the log, not in a process.
 *
 * An agent whose state lives in memory can only be watched from the machine it
 * runs on, can only be resumed by the process that started it, and disappears
 * with a laptop lid. Everything here folds over claims and events, so a task
 * looks the same from a laptop, a server and a phone — and the same after any
 * of them dies.
 */
export * from "./registry"
export * from "./gateway"
