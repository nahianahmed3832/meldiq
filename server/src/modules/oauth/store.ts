import type { OAuthScope } from "../../shared/contracts/http/oauthApps.js";

/** A "Log in with Meldiq" app. Its id is the OAuth client_id; only the client secret's hash is kept. */
export interface OAuthApp {
  id: string;
  ownerId: string;
  name: string;
  redirectUris: string[];
  secretHash: string;
  createdAt: number;
  updatedAt: number;
  secretRotatedAt: number;
}

/** An authorization code, kept by its hash: single use, 10 minutes. */
export interface AuthCode {
  hash: string;
  appId: string;
  userId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  /** The PKCE S256 challenge, or null when the app sent none (then only a client with its secret can use the code). */
  challenge: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  /** The tokens this code was exchanged for, revoked if the code is ever presented again. */
  familyId: string | null;
}

/** Someone approved an app: what it may see. Revoking it ends every token of the app for that person. */
export interface Grant {
  appId: string;
  userId: string;
  scopes: OAuthScope[];
  createdAt: number;
  updatedAt: number;
}

/**
 * The tokens one code exchange started: an access token (1 hour) and a refresh token (rotating, 30 days), kept by
 * their hashes. The refresh token replaced last is remembered, so presenting it again (a copy in use) revokes the family.
 */
export interface TokenFamily {
  id: string;
  appId: string;
  userId: string;
  scopes: OAuthScope[];
  /** Made with the client secret: refreshing it needs the secret too. */
  confidential: boolean;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  previousRefreshHash: string | null;
  refreshExpiresAt: number;
  createdAt: number;
  rotatedAt: number;
}

export interface Rotation {
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  scopes: OAuthScope[];
  at: number;
}

/**
 * Where apps, codes, grants and tokens live (API 0.65.0): MongoDB whenever the server has one (oauth_apps, oauth_codes,
 * oauth_grants, oauth_tokens: new data goes to MongoDB), otherwise this process's memory (development and tests).
 * Taking a code and rotating a refresh token are single conditional updates, so neither can succeed twice.
 */
export interface OAuthStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  /** PostgreSQL code exchange/refresh, including durable replay revocation, is one transaction. */
  transaction?<T>(run: () => Promise<T>): Promise<T>;
  appsOf(ownerId: string): Promise<OAuthApp[]>;
  app(id: string): Promise<OAuthApp | null>;
  appsByIds(ids: readonly string[]): Promise<OAuthApp[]>;
  insertApp(app: OAuthApp): Promise<void>;
  /** The app after the change, or null when [ownerId] has no app [id]. */
  updateApp(id: string, ownerId: string, patch: Partial<Pick<OAuthApp, "name" | "redirectUris" | "secretHash" | "secretRotatedAt">>, at: number): Promise<OAuthApp | null>;
  /** Removes the app with its codes, grants and tokens. */
  deleteApp(id: string): Promise<void>;
  insertCode(code: AuthCode): Promise<void>;
  /** Marks the code used; the code as it was, or null when there's none. A code used before comes back with its usedAt. */
  takeCode(hash: string, at: number): Promise<AuthCode | null>;
  setCodeFamily(hash: string, familyId: string): Promise<void>;
  /** Records the approval, adding [scopes] to what was approved before. */
  upsertGrant(appId: string, userId: string, scopes: readonly OAuthScope[], at: number): Promise<Grant>;
  grant(appId: string, userId: string): Promise<Grant | null>;
  grantsOf(userId: string): Promise<Grant[]>;
  /** Removes the grant with the codes and tokens of that app for that person; false when there was none. */
  revokeGrant(appId: string, userId: string): Promise<boolean>;
  insertFamily(family: TokenFamily): Promise<void>;
  family(id: string): Promise<TokenFamily | null>;
  familyByAccess(accessHash: string): Promise<TokenFamily | null>;
  /** Rotates the family if its refresh hash is still [expected]; false when another refresh got there first. */
  rotateFamily(id: string, expected: string, next: Rotation): Promise<boolean>;
  deleteFamily(id: string): Promise<void>;
  /** Everything of [userId]: the apps they own (with everyone's grants and tokens) and their own grants and tokens. */
  deleteForUser(userId: string): Promise<void>;
  /** Codes and token families that can't be used any more. */
  purgeExpired(at: number): Promise<number>;
}

const copyApp = (a: OAuthApp): OAuthApp => ({ ...a, redirectUris: [...a.redirectUris] });

export class MemoryOAuthStore implements OAuthStore {
  readonly backend = "memory" as const;
  private readonly apps = new Map<string, OAuthApp>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly grants = new Map<string, Grant>();
  private readonly families = new Map<string, TokenFamily>();

  async appsOf(ownerId: string): Promise<OAuthApp[]> {
    return [...this.apps.values()].filter((a) => a.ownerId === ownerId).sort((a, b) => a.createdAt - b.createdAt).map(copyApp);
  }

  async app(id: string): Promise<OAuthApp | null> {
    const a = this.apps.get(id);
    return a ? copyApp(a) : null;
  }

  async appsByIds(ids: readonly string[]): Promise<OAuthApp[]> {
    return ids.flatMap((id) => (this.apps.has(id) ? [copyApp(this.apps.get(id)!)] : []));
  }

  async insertApp(app: OAuthApp): Promise<void> {
    this.apps.set(app.id, copyApp(app));
  }

  async updateApp(id: string, ownerId: string, patch: Partial<Pick<OAuthApp, "name" | "redirectUris" | "secretHash" | "secretRotatedAt">>, at: number): Promise<OAuthApp | null> {
    const a = this.apps.get(id);
    if (!a || a.ownerId !== ownerId) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...a, ...defined, updatedAt: at };
    this.apps.set(id, next);
    return copyApp(next);
  }

  async deleteApp(id: string): Promise<void> {
    this.apps.delete(id);
    this.dropWhere((x) => x.appId === id);
  }

  async insertCode(code: AuthCode): Promise<void> {
    this.codes.set(code.hash, { ...code });
  }

  async takeCode(hash: string, at: number): Promise<AuthCode | null> {
    const c = this.codes.get(hash);
    if (!c) return null;
    if (c.usedAt === null) this.codes.set(hash, { ...c, usedAt: at });
    return { ...c };
  }

  async setCodeFamily(hash: string, familyId: string): Promise<void> {
    const c = this.codes.get(hash);
    if (c) this.codes.set(hash, { ...c, familyId });
  }

  async upsertGrant(appId: string, userId: string, scopes: readonly OAuthScope[], at: number): Promise<Grant> {
    const key = `${appId}|${userId}`;
    const g = this.grants.get(key);
    const next: Grant = g ? { ...g, scopes: [...new Set([...g.scopes, ...scopes])], updatedAt: at } : { appId, userId, scopes: [...scopes], createdAt: at, updatedAt: at };
    this.grants.set(key, next);
    return { ...next };
  }

  async grant(appId: string, userId: string): Promise<Grant | null> {
    const g = this.grants.get(`${appId}|${userId}`);
    return g ? { ...g } : null;
  }

  async grantsOf(userId: string): Promise<Grant[]> {
    return [...this.grants.values()].filter((g) => g.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt).map((g) => ({ ...g }));
  }

  async revokeGrant(appId: string, userId: string): Promise<boolean> {
    const had = this.grants.has(`${appId}|${userId}`);
    this.dropWhere((x) => x.appId === appId && x.userId === userId);
    return had;
  }

  async insertFamily(family: TokenFamily): Promise<void> {
    this.families.set(family.id, { ...family });
  }

  async family(id: string): Promise<TokenFamily | null> {
    const f = this.families.get(id);
    return f ? { ...f } : null;
  }

  async familyByAccess(accessHash: string): Promise<TokenFamily | null> {
    const f = [...this.families.values()].find((x) => x.accessHash === accessHash);
    return f ? { ...f } : null;
  }

  async rotateFamily(id: string, expected: string, next: Rotation): Promise<boolean> {
    const f = this.families.get(id);
    if (!f || f.refreshHash !== expected) return false;
    this.families.set(id, { ...f, ...next, previousRefreshHash: expected, rotatedAt: next.at });
    return true;
  }

  async deleteFamily(id: string): Promise<void> {
    this.families.delete(id);
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const a of [...this.apps.values()]) if (a.ownerId === userId) await this.deleteApp(a.id);
    this.dropWhere((x) => x.userId === userId);
  }

  async purgeExpired(at: number): Promise<number> {
    let n = 0;
    for (const [k, c] of this.codes) if (c.expiresAt <= at) n += Number(this.codes.delete(k));
    for (const [k, f] of this.families) if (f.refreshExpiresAt <= at) n += Number(this.families.delete(k));
    return n;
  }

  /** Grants, codes and token families matching [pred]. */
  private dropWhere(pred: (x: { appId: string; userId: string }) => boolean): void {
    for (const [k, g] of this.grants) if (pred(g)) this.grants.delete(k);
    for (const [k, c] of this.codes) if (pred(c)) this.codes.delete(k);
    for (const [k, f] of this.families) if (pred(f)) this.families.delete(k);
  }
}
