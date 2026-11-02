/** A username someone gave up, kept for them until [expiresAt] (API 0.65.0). */
export interface UsernameHold {
  /** Lower case, as usernames are stored. */
  username: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Where username holds are kept (docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one (`username_holds`,
 * new data goes to MongoDB), otherwise this process's memory. UsernameHolds keeps an in-memory copy for the request
 * path (usernames are checked synchronously at sign-up).
 */
export interface UsernameHoldStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  /** Holds still in force at [at]. */
  live(at: number): Promise<UsernameHold[]>;
  /** Holds [username] for its user, replacing any earlier hold of the same name. */
  put(hold: UsernameHold): Promise<void>;
  remove(username: string): Promise<void>;
  removeExpired(at: number): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export class MemoryUsernameHoldStore implements UsernameHoldStore {
  readonly backend = "memory" as const;
  private readonly rows = new Map<string, UsernameHold>();

  async live(at: number): Promise<UsernameHold[]> {
    return [...this.rows.values()].filter((h) => h.expiresAt > at).map((h) => ({ ...h }));
  }

  async put(hold: UsernameHold): Promise<void> {
    this.rows.set(hold.username, { ...hold });
  }

  async remove(username: string): Promise<void> {
    this.rows.delete(username);
  }

  async removeExpired(at: number): Promise<void> {
    for (const [name, h] of this.rows) if (h.expiresAt <= at) this.rows.delete(name);
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const [name, h] of this.rows) if (h.userId === userId) this.rows.delete(name);
  }
}
