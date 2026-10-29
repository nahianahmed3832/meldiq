import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { APP_LIMIT, type AppBody, type AppPatch, type DeveloperApp, type GrantView } from "../../shared/contracts/http/oauthApps.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { newSecret, secretHash } from "../../shared/utilities/secrets.js";
import { newId } from "../../shared/utilities/util.js";
import { namesOf } from "../accounts/index.js";
import { PREFIX } from "./rules.js";
import type { OAuthApp, OAuthStore } from "./store.js";

/** How often expired codes and token families are swept (on the next token request after this long). */
const PURGE_EVERY_MS = 10 * 60_000;

export const appView = (a: OAuthApp): z.infer<typeof DeveloperApp> => ({
  id: a.id,
  name: a.name,
  redirectUris: a.redirectUris,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  secretRotatedAt: a.secretRotatedAt,
});

/**
 * "Log in with Meldiq" apps and the approvals people gave them (API 0.65.0, docs/SETTINGS_PARITY_API.md). The
 * authorization flow itself is flow.ts. Secrets and tokens are only ever stored as hashes.
 */
export class OAuthService {
  private lastPurge = 0;

  constructor(
    readonly ctx: AppContext,
    readonly store: OAuthStore,
    readonly clock: () => number = Date.now,
  ) {}

  async listApps(ownerId: string) {
    return { apps: (await this.store.appsOf(ownerId)).map(appView), limit: APP_LIMIT };
  }

  async createApp(ownerId: string, body: z.infer<typeof AppBody>) {
    if ((await this.store.appsOf(ownerId)).length >= APP_LIMIT) {
      throw new ApiError(409, "limit_reached", `You can have up to ${APP_LIMIT} apps. Delete one to make another.`, { limit: APP_LIMIT });
    }
    const t = this.clock();
    const clientSecret = newSecret(PREFIX.secret);
    const app: OAuthApp = { id: newId("app"), ownerId, name: body.name, redirectUris: body.redirectUris, secretHash: secretHash(clientSecret), createdAt: t, updatedAt: t, secretRotatedAt: t };
    await this.store.insertApp(app);
    this.ctx.audit({ actorId: ownerId, action: "oauth.app_create", target: app.id });
    return { app: appView(app), clientSecret };
  }

  async updateApp(ownerId: string, id: string, patch: z.infer<typeof AppPatch>) {
    const app = await this.store.updateApp(id, ownerId, { name: patch.name, redirectUris: patch.redirectUris }, this.clock());
    if (!app) throw notFound("You have no app with that id");
    this.ctx.audit({ actorId: ownerId, action: "oauth.app_update", target: id });
    return { app: appView(app) };
  }

  async deleteApp(ownerId: string, id: string) {
    const app = await this.store.app(id);
    if (!app || app.ownerId !== ownerId) throw notFound("You have no app with that id");
    await this.store.deleteApp(id);
    this.ctx.audit({ actorId: ownerId, action: "oauth.app_delete", target: id });
    return { deleted: true as const };
  }

  /** A new client secret; the old one stops working at once. Tokens already given out keep working. */
  async rotateSecret(ownerId: string, id: string) {
    const t = this.clock();
    const clientSecret = newSecret(PREFIX.secret);
    const app = await this.store.updateApp(id, ownerId, { secretHash: secretHash(clientSecret), secretRotatedAt: t }, t);
    if (!app) throw notFound("You have no app with that id");
    this.ctx.audit({ actorId: ownerId, action: "oauth.secret_rotate", target: id });
    return { app: appView(app), clientSecret };
  }

  /** An app as people see it: its name and its owner's username (null once the owner is gone). */
  summaries(apps: readonly OAuthApp[]): Map<string, { id: string; name: string; ownerUsername: string | null }> {
    const owners = new Map(namesOf(this.ctx.identity, [...new Set(apps.map((a) => a.ownerId))]).map((n) => [n.id, n.username]));
    return new Map(apps.map((a) => [a.id, { id: a.id, name: a.name, ownerUsername: owners.get(a.ownerId) ?? null }]));
  }

  async grants(userId: string): Promise<{ grants: z.infer<typeof GrantView>[] }> {
    const grants = await this.store.grantsOf(userId);
    const apps = this.summaries(await this.store.appsByIds(grants.map((g) => g.appId)));
    return {
      grants: grants.flatMap((g) => {
        const app = apps.get(g.appId);
        return app ? [{ app, scopes: g.scopes, createdAt: g.createdAt, updatedAt: g.updatedAt }] : [];
      }),
    };
  }

  /** Ends an app's access for [userId]: the grant, its codes and every token. */
  async revoke(userId: string, clientId: string): Promise<{ revoked: boolean }> {
    const revoked = await this.store.revokeGrant(clientId, userId);
    if (revoked) this.ctx.audit({ actorId: userId, action: "oauth.grant_revoke", target: clientId });
    return { revoked };
  }

  deleteForUser(userId: string): Promise<void> {
    return this.store.deleteForUser(userId);
  }

  /** Sweeps expired codes and token families now and then (called from the token endpoint). */
  async purgeNowAndThen(): Promise<void> {
    const t = this.clock();
    if (t - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = t;
    await this.store.purgeExpired(t);
  }
}
