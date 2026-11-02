import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import { PostgresDocuments } from "../../infrastructure/database/postgres/documents.js";
import type { OAuthScope } from "../../shared/contracts/http/oauthApps.js";
import type { AuthCode, Grant, OAuthApp, OAuthStore, Rotation, TokenFamily } from "./store.js";

const codeColumns = 'id AS hash,app_id AS "appId",user_id AS "userId",redirect_uri AS "redirectUri",scopes,challenge,created_at AS "createdAt",expires_at AS "expiresAt",used_at AS "usedAt",family_id AS "familyId"';
const grantColumns = 'app_id AS "appId",user_id AS "userId",scopes,created_at AS "createdAt",updated_at AS "updatedAt"';
const decode = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])) as T;

/** Existing Meldiq OAuth app protocol: hashed codes/tokens and typed scopes. This is distinct from Supabase user Auth. */
export class PostgresOAuthStore implements OAuthStore {
  readonly backend = "postgres" as const;
  private readonly apps: PostgresDocuments<OAuthApp>;
  private readonly families: PostgresDocuments<TokenFamily>;
  constructor(private readonly db: MeldiqPostgres) {
    this.apps = new PostgresDocuments(db, "oauth_apps");
    this.families = new PostgresDocuments(db, "oauth_tokens");
  }
  transaction<T>(run: () => Promise<T>): Promise<T> { return this.db.transaction(run); }
  async appsOf(ownerId: string): Promise<OAuthApp[]> {
    return (await this.apps.find({ownerId})).sort((a, b) => a.createdAt - b.createdAt);
  }
  async app(id: string): Promise<OAuthApp | null> {
    // During token exchange this lock fences concurrent secret rotation, app deletion and grant revocation.
    const row = (await this.db.query("SELECT * FROM meldiq.oauth_apps WHERE id=$1 FOR SHARE", [id])).rows[0];
    return row ? decode<OAuthApp>(row) : null;
  }
  async appsByIds(ids: readonly string[]): Promise<OAuthApp[]> {
    return (await this.db.query("SELECT * FROM meldiq.oauth_apps WHERE id=ANY($1::text[])", [[...ids]])).rows.map(row => decode<OAuthApp>(row));
  }
  async insertApp(app: OAuthApp): Promise<void> { await this.apps.insert(app); }
  async updateApp(id: string, ownerId: string, patch: Partial<Pick<OAuthApp, "name" | "redirectUris" | "secretHash" | "secretRotatedAt">>, at: number): Promise<OAuthApp | null> {
    return this.apps.update(id, {ownerId}, {...patch, updatedAt: at});
  }
  async deleteApp(id: string): Promise<void> { await this.apps.take(id); }
  async insertCode(code: AuthCode): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.oauth_codes(id,app_id,user_id,redirect_uri,scopes,challenge,created_at,expires_at,used_at,family_id)
      VALUES($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10)`, [code.hash, code.appId, code.userId, code.redirectUri, code.scopes, code.challenge, code.createdAt, code.expiresAt, code.usedAt, code.familyId]);
  }
  async takeCode(hash: string, at: number): Promise<AuthCode | null> {
    return (await this.db.query<AuthCode>(`WITH original AS MATERIALIZED (SELECT * FROM meldiq.oauth_codes WHERE id=$1 FOR UPDATE),
      marked AS (UPDATE meldiq.oauth_codes c SET used_at=$2 FROM original o WHERE c.id=o.id AND o.used_at IS NULL)
      SELECT ${codeColumns} FROM original`, [hash, at])).rows[0] ?? null;
  }
  async setCodeFamily(hash: string, familyId: string): Promise<void> {
    await this.db.query("UPDATE meldiq.oauth_codes SET family_id=$2 WHERE id=$1", [hash, familyId]);
  }
  async upsertGrant(appId: string, userId: string, scopes: readonly OAuthScope[], at: number): Promise<Grant> {
    const row = (await this.db.query<Grant>(`WITH app AS MATERIALIZED (SELECT id FROM meldiq.oauth_apps WHERE id=$2 FOR UPDATE)
      INSERT INTO meldiq.oauth_grants(id,app_id,user_id,scopes,created_at,updated_at)
      SELECT $1,$2,$3,$4::text[],$5,$5 FROM app
      ON CONFLICT(app_id,user_id) DO UPDATE SET scopes=ARRAY(
        SELECT value FROM unnest(oauth_grants.scopes || excluded.scopes) WITH ORDINALITY AS scope(value,position)
        GROUP BY value ORDER BY min(position)),updated_at=excluded.updated_at RETURNING ${grantColumns}`,
    [`${appId}|${userId}`, appId, userId, [...new Set(scopes)], at])).rows[0];
    if (!row) throw new Error("OAuth app no longer exists");
    return row;
  }
  async grant(appId: string, userId: string): Promise<Grant | null> {
    return (await this.db.query<Grant>(`SELECT ${grantColumns} FROM meldiq.oauth_grants WHERE app_id=$1 AND user_id=$2`, [appId, userId])).rows[0] ?? null;
  }
  async grantsOf(userId: string): Promise<Grant[]> {
    return (await this.db.query<Grant>(`SELECT ${grantColumns} FROM meldiq.oauth_grants WHERE user_id=$1 ORDER BY updated_at DESC,id DESC`, [userId])).rows;
  }
  async revokeGrant(appId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async () => {
      // Wait for in-flight exchanges before taking a fresh snapshot for token/code deletion.
      await this.db.query("SELECT id FROM meldiq.oauth_apps WHERE id=$1 FOR UPDATE", [appId]);
      const result = await this.db.query("DELETE FROM meldiq.oauth_grants WHERE app_id=$1 AND user_id=$2", [appId, userId]);
      await this.db.query("DELETE FROM meldiq.oauth_codes WHERE app_id=$1 AND user_id=$2", [appId, userId]);
      await this.db.query("DELETE FROM meldiq.oauth_tokens WHERE app_id=$1 AND user_id=$2", [appId, userId]);
      return result.rowCount === 1;
    });
  }
  async insertFamily(family: TokenFamily): Promise<void> { await this.families.insert(family); }
  async family(id: string): Promise<TokenFamily | null> {
    const row = (await this.db.query("SELECT * FROM meldiq.oauth_tokens WHERE id=$1 FOR UPDATE", [id])).rows[0];
    return row ? decode<TokenFamily>(row) : null;
  }
  async familyByAccess(accessHash: string): Promise<TokenFamily | null> { return (await this.families.find({accessHash}, {limit: 1}))[0] ?? null; }
  async rotateFamily(id: string, expected: string, next: Rotation): Promise<boolean> {
    return !!(await this.families.update(id, {refreshHash: expected}, {accessHash: next.accessHash, accessExpiresAt: next.accessExpiresAt,
      refreshHash: next.refreshHash, previousRefreshHash: expected, refreshExpiresAt: next.refreshExpiresAt, scopes: next.scopes, rotatedAt: next.at}));
  }
  async deleteFamily(id: string): Promise<void> { await this.families.take(id); }
  async deleteForUser(userId: string): Promise<void> {
    await this.db.query(`WITH owned_apps AS (DELETE FROM meldiq.oauth_apps WHERE owner_id=$1),codes AS (DELETE FROM meldiq.oauth_codes WHERE user_id=$1),
      grants AS (DELETE FROM meldiq.oauth_grants WHERE user_id=$1) DELETE FROM meldiq.oauth_tokens WHERE user_id=$1`, [userId]);
  }
  async purgeExpired(at: number): Promise<number> {
    return (await this.db.query<{count: number}>(`WITH codes AS (DELETE FROM meldiq.oauth_codes WHERE expires_at<=$1 RETURNING id),
      families AS (DELETE FROM meldiq.oauth_tokens WHERE refresh_expires_at<=$1 RETURNING id)
      SELECT (SELECT count(*) FROM codes)+(SELECT count(*) FROM families) AS count`, [at])).rows[0].count;
  }
}
