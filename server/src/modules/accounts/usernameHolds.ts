import type { UsernameHold, UsernameHoldStore } from "./usernameHoldStore.js";

/** How long a username someone gave up stays theirs (API 0.65.0). */
export const USERNAME_HOLD_MS = 7 * 86_400_000;

/**
 * Old usernames held for their last owner (API 0.65.0, docs/SETTINGS_PARITY_API.md): after a change, nobody else can
 * take the old name for 7 days, so links and mentions can't be picked up by someone else; its owner can take it back.
 * Reads come from this in-memory copy (sign-up checks usernames synchronously); every change goes to the store first.
 */
export class UsernameHolds {
  private readonly byName = new Map<string, UsernameHold>();

  constructor(
    readonly store: UsernameHoldStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const t = this.clock();
    await this.store.removeExpired(t);
    for (const h of await this.store.live(t)) this.byName.set(h.username, h);
  }

  /** Whether [username] is held for someone other than [userId] (anyone, when no user is given). */
  heldFromOthers(username: string, userId?: string): boolean {
    const name = username.toLowerCase();
    const h = this.byName.get(name);
    if (!h) return false;
    if (h.expiresAt <= this.clock()) {
      this.byName.delete(name);
      return false;
    }
    return h.userId !== userId;
  }

  /** [userId] gave up [oldName] and took [newName]: the old one is held for them, and a hold of the new one ends. */
  async changed(userId: string, oldName: string, newName: string): Promise<void> {
    const t = this.clock();
    const hold: UsernameHold = { username: oldName.toLowerCase(), userId, createdAt: t, expiresAt: t + USERNAME_HOLD_MS };
    await this.store.put(hold);
    this.byName.set(hold.username, hold);
    const taken = newName.toLowerCase();
    if (this.byName.get(taken)?.userId === userId) {
      await this.store.remove(taken);
      this.byName.delete(taken);
    }
  }

  /** An account was deleted: the names held for it are free. */
  async deleteForUser(userId: string): Promise<void> {
    await this.store.deleteForUser(userId);
    for (const [name, h] of this.byName) if (h.userId === userId) this.byName.delete(name);
  }
}
