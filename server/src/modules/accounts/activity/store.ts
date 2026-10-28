import type { ActivityWire } from "../../../shared/contracts/realtime.js";

/** One person's current activity and when it lapses without a refresh. */
export interface StoredActivity {
  userId: string;
  activity: ActivityWire;
  updatedAt: number;
  expiresAt: number;
}

/**
 * Where activities are kept (docs/ACTIVITY_STATUS.md): MongoDB whenever the server has one (`user_activities`, new data
 * goes to MongoDB), otherwise this process's memory (development and tests without MONGODB_URI). Reads on the request
 * path come from ActivityService's in-memory copy; the store lets a restarted server pick up activities that haven't
 * lapsed yet.
 */
export interface ActivityStore {
  readonly backend: "memory" | "mongodb";
  /** Activities that haven't lapsed at [at]. */
  live(at: number): Promise<StoredActivity[]>;
  put(entry: StoredActivity): Promise<void>;
  remove(userId: string): Promise<void>;
  /** Drops everything that lapsed by [at]. */
  removeLapsed(at: number): Promise<void>;
}

export class MemoryActivityStore implements ActivityStore {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, StoredActivity>();

  async live(at: number): Promise<StoredActivity[]> {
    return [...this.entries.values()].filter((e) => e.expiresAt > at);
  }

  async put(entry: StoredActivity): Promise<void> {
    this.entries.set(entry.userId, entry);
  }

  async remove(userId: string): Promise<void> {
    this.entries.delete(userId);
  }

  async removeLapsed(at: number): Promise<void> {
    for (const [userId, e] of this.entries) if (e.expiresAt <= at) this.entries.delete(userId);
  }
}
