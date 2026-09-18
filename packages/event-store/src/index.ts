/**
 * @abdo/event-store — the append-only log that is AbdoCode's source of truth.
 *
 * Everything durable (messages, runs, tool executions, context, memory) is a
 * projection of events appended here. The summary is never authoritative; this
 * log is. See docs/adr/0002-event-store-is-source-of-truth.md.
 */
export * from "./store"
export { MemoryEventStore } from "./memory"
export { KeyedMutex } from "./mutex"
