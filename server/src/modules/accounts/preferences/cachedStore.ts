import type { RedisInfrastructure } from "../../../infrastructure/redis/service.js";
import type { NavPrefs } from "./schema.js";
import type { PreferenceStore } from "./store.js";

/** Display preferences only; membership is always checked by routes before reads. Never caches entitlements or message content. */
export class CachedPreferenceStore implements PreferenceStore {
  readonly backend;
  constructor(
    private readonly source: PreferenceStore,
    private readonly redis: RedisInfrastructure,
  ) {
    this.backend = source.backend;
  }
  get(userId: string, communityId: string) {
    return this.redis.cached("preferences", [userId, communityId], 15_000, () =>
      this.source.get(userId, communityId),
    );
  }
  async put(
    userId: string,
    communityId: string,
    prefs: NavPrefs,
    baseRev: number,
    at: number,
  ) {
    const result = await this.source.put(
      userId,
      communityId,
      prefs,
      baseRev,
      at,
    );
    if (result.ok) await this.redis.invalidate("preferences");
    return result;
  }
  async deleteForMember(userId: string, communityId: string) {
    await this.source.deleteForMember(userId, communityId);
    await this.redis.invalidate("preferences");
  }
  async deleteForWorkspace(communityId: string) {
    await this.source.deleteForWorkspace(communityId);
    await this.redis.invalidate("preferences");
  }
  async deleteForUser(userId: string) {
    await this.source.deleteForUser(userId);
    await this.redis.invalidate("preferences");
  }
}
