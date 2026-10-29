/**
 * Decorations people starred (API 0.65.0, docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one
 * (`decoration_favorites`, new data goes to MongoDB), otherwise this process's memory. Any decoration id can be kept
 * (Meldiq's own and community ones); one taken down stays listed until its owner unstars it.
 */
export interface FavoriteStore {
  readonly backend: "memory" | "mongodb";
  /** [userId]'s favourites, newest first. */
  list(userId: string): Promise<string[]>;
  count(userId: string): Promise<number>;
  /** Adds one; false when it was a favourite already. */
  add(userId: string, decorationId: string, at: number): Promise<boolean>;
  remove(userId: string, decorationId: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export class MemoryFavoriteStore implements FavoriteStore {
  readonly backend = "memory" as const;
  /** Per person: decoration id → when it was starred. */
  private readonly rows = new Map<string, Map<string, number>>();

  async list(userId: string): Promise<string[]> {
    return [...(this.rows.get(userId) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  async count(userId: string): Promise<number> {
    return this.rows.get(userId)?.size ?? 0;
  }

  async add(userId: string, decorationId: string, at: number): Promise<boolean> {
    const mine = this.rows.get(userId) ?? new Map<string, number>();
    if (mine.has(decorationId)) return false;
    this.rows.set(userId, new Map([...mine, [decorationId, at]]));
    return true;
  }

  async remove(userId: string, decorationId: string): Promise<void> {
    const mine = this.rows.get(userId);
    if (mine) this.rows.set(userId, new Map([...mine].filter(([id]) => id !== decorationId)));
  }

  async deleteForUser(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}
