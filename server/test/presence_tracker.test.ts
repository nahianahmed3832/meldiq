import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceTracker } from "../src/modules/realtime/presence.js";

/** The settle and grace rules on their own, with fake timers (presence_stability.test.ts runs them through a server). */
describe("PresenceTracker", () => {
  let connected: Set<string>;
  let announced: [string, boolean][];
  let tracker: PresenceTracker;
  const open = (u: string) => (connected.add(u), tracker.connectedNow(u));
  const close = (u: string) => (connected.delete(u), tracker.disconnectedNow(u));

  beforeEach(() => {
    vi.useFakeTimers();
    connected = new Set();
    announced = [];
    tracker = new PresenceTracker({ settleMs: 4000, graceMs: 10_000 }, (u) => connected.has(u), (u, on) => announced.push([u, on]));
  });
  afterEach(() => {
    tracker.close();
    vi.useRealTimers();
  });

  it("announces online only after the settle time", () => {
    open("a");
    vi.advanceTimersByTime(3999);
    expect(announced).toEqual([]);
    expect(tracker.isPresent("a")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(announced).toEqual([["a", true]]);
    expect(tracker.isPresent("a")).toBe(true);
  });

  it("never announces a connection that closes while settling", () => {
    open("a");
    vi.advanceTimersByTime(1000);
    close("a");
    vi.advanceTimersByTime(60_000);
    expect(announced).toEqual([]);
  });

  it("ignores repeated connect and disconnect signals", () => {
    open("a");
    tracker.connectedNow("a");
    vi.advanceTimersByTime(4000);
    tracker.connectedNow("a");
    expect(announced).toEqual([["a", true]]);
    close("a");
    tracker.disconnectedNow("a");
    vi.advanceTimersByTime(10_000);
    tracker.disconnectedNow("a");
    expect(announced).toEqual([
      ["a", true],
      ["a", false],
    ]);
  });

  it("rapid toggling settles on the final state without flapping", () => {
    open("a");
    vi.advanceTimersByTime(4000);
    for (let i = 0; i < 20; i++) {
      close("a");
      vi.advanceTimersByTime(200);
      open("a");
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(60_000);
    expect(announced).toEqual([["a", true]]);
  });

  it("a stale grace timer can't take someone offline who came back", () => {
    open("a");
    vi.advanceTimersByTime(4000);
    close("a");
    vi.advanceTimersByTime(9000);
    open("a");
    vi.advanceTimersByTime(60_000);
    expect(tracker.isPresent("a")).toBe(true);
    expect(announced).toEqual([["a", true]]);
  });

  it("with zero delays every change is immediate", () => {
    const immediate = new PresenceTracker({ settleMs: 0, graceMs: 0 }, (u) => connected.has(u), (u, on) => announced.push([u, on]));
    connected.add("b");
    immediate.connectedNow("b");
    expect(immediate.isPresent("b")).toBe(true);
    connected.delete("b");
    immediate.disconnectedNow("b");
    expect(immediate.isPresent("b")).toBe(false);
    expect(announced).toEqual([
      ["b", true],
      ["b", false],
    ]);
  });
});
