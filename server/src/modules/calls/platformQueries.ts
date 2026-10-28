/**
 * Call figures for the Platform Admin Console (counts only: no rooms, names or conversation ids) now come from the call
 * store, wherever calls live: `ctx.calls.activeCounts()` and `ctx.calls.days(from)` (src/modules/calls/store.ts).
 */
export type { CallDay } from "./store.js";
