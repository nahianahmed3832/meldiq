import type { FastifyBaseLogger } from "fastify";
import type { ActivityInput } from "../../../shared/contracts/http/activity.js";
import type { ActivityWire } from "../../../shared/contracts/realtime.js";
import type { ActivityStore, StoredActivity } from "./store.js";

/** An activity lapses this long after the app last reported it (the app refreshes it every few minutes). */
export const ACTIVITY_TTL_MS = 10 * 60_000;
/** How often lapsed activities are dropped and their end announced. */
const SWEEP_EVERY_MS = 60_000;
/** A reported start older than this, or later than the server's clock allows, is replaced by the time it arrived. */
const MAX_STARTED_AGE_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 60_000;

const sameActivity = (a: ActivityWire, b: ActivityInput) => a.kind === b.kind && a.name === b.name && a.packageId === b.packageId;

function sensibleStart(reported: number | undefined, at: number): number {
  if (reported == null || reported > at + CLOCK_SKEW_MS || reported < at - MAX_STARTED_AGE_MS) return at;
  return Math.min(reported, at);
}

/**
 * Who is playing what right now (API 0.56.0, docs/ACTIVITY_STATUS.md). The request path reads this in-memory copy
 * (member lists and profiles are built synchronously); every change is written to the store first. An activity ends
 * when the person clears it, when their last app disconnects (ended), or ACTIVITY_TTL_MS after the last refresh.
 */
export class ActivityService {
  private readonly held = new Map<string, StoredActivity>();
  private sweeper: NodeJS.Timeout | null = null;
  /** Set by the server: tells the people who may see [userId]'s presence what they show now. */
  onChange: (userId: string) => void = () => {};

  constructor(
    private readonly store: ActivityStore,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  get backend(): ActivityStore["backend"] {
    return this.store.backend;
  }

  /** Loads activities a restarted server still has to honour and starts the sweep. */
  async start(): Promise<void> {
    for (const e of await this.store.live(this.clock())) this.held.set(e.userId, e);
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** [userId]'s activity, whoever may see it (callers decide that: modules/accounts/activity/visibility.ts). */
  current(userId: string, at = this.clock()): ActivityWire | null {
    const e = this.held.get(userId);
    return e && e.expiresAt > at ? e.activity : null;
  }

  /**
   * Sets or refreshes [userId]'s activity. The same game reported again keeps its start time and announces nothing;
   * another game, or the first one, is announced.
   */
  async set(userId: string, input: ActivityInput): Promise<ActivityWire> {
    const at = this.clock();
    const previous = this.current(userId, at);
    const same = previous !== null && sameActivity(previous, input);
    const activity: ActivityWire = {
      kind: input.kind,
      name: input.name,
      ...(input.packageId ? { packageId: input.packageId } : {}),
      startedAt: same ? previous.startedAt : sensibleStart(input.startedAt, at),
    };
    const entry: StoredActivity = { userId, activity, updatedAt: at, expiresAt: at + ACTIVITY_TTL_MS };
    await this.store.put(entry);
    this.held.set(userId, entry);
    if (!same) this.onChange(userId);
    return activity;
  }

  async clear(userId: string): Promise<void> {
    const had = this.current(userId) !== null;
    this.held.delete(userId);
    await this.store.remove(userId);
    if (had) this.onChange(userId);
  }

  /** [userId]'s last connection closed (after presence's grace period): their activity ends with it. */
  ended(userId: string): void {
    if (!this.held.has(userId)) return;
    this.clear(userId).catch((err) => this.log.warn({ err, userId }, "activity: not cleared after disconnect"));
  }

  /** Drops lapsed activities and announces that they ended. */
  async sweep(): Promise<void> {
    const at = this.clock();
    const lapsed = [...this.held.values()].filter((e) => e.expiresAt <= at).map((e) => e.userId);
    for (const userId of lapsed) this.held.delete(userId);
    try {
      await this.store.removeLapsed(at);
    } catch (err) {
      this.log.warn({ err }, "activity: lapsed entries not removed from the store");
    }
    for (const userId of lapsed) this.onChange(userId);
  }
}
