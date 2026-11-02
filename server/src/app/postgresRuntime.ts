import type { DB } from "../infrastructure/database/db.js";
import type { MeldiqPostgres } from "../infrastructure/database/postgres/client.js";
import { tableSpecs } from "../infrastructure/database/mongo/catalog.js";
import { PostgresRows } from "../infrastructure/database/rows/postgresRows.js";
import { PostgresAccountStore } from "../modules/accounts/postgresStore.js";
import { PostgresRecoveryStore } from "../modules/accounts/postgresRecoveryStore.js";
import { PostgresKeyBackupStore } from "../modules/accounts/postgresKeyBackupStore.js";
import { PostgresRelayStore } from "../modules/messaging/relay/postgresStore.js";
import { PostgresFileStore } from "../modules/files/postgresStore.js";
import { PostgresPreferenceStore } from "../modules/accounts/preferences/postgresStore.js";
import { PostgresHistoryStore } from "../modules/messaging/history/postgresStore.js";
import { PostgresMessageStore } from "../modules/messaging/store/postgresStore.js";
import { PostgresReportStore } from "../modules/organizations/reports/postgresStore.js";
import { PostgresRelationshipStore } from "../modules/accounts/relationships/postgresStore.js";
import { PostgresCallStore } from "../modules/calls/postgresStore.js";
import { PostgresActivityStore } from "../modules/accounts/activity/postgresStore.js";
import { PostgresDecorationStore } from "../modules/accounts/decorations/postgresStore.js";
import { PostgresFavoriteStore } from "../modules/accounts/decorations/postgresFavoritesStore.js";
import { PostgresPinStore } from "../modules/accounts/pins/postgresStore.js";
import { PostgresPrivacyStore } from "../modules/accounts/relationships/postgresPrivacyStore.js";
import { PostgresUsernameHoldStore } from "../modules/accounts/postgresUsernameHoldStore.js";
import { PostgresPointsStore } from "../modules/points/postgresStore.js";
import { PostgresOAuthStore } from "../modules/oauth/postgresStore.js";
import { PostgresBotStore } from "../modules/bots/postgresStore.js";
import { PostgresRulesStore } from "../modules/organizations/rules/postgresStore.js";
import { NATIVE_TABLES } from "../infrastructure/database/postgres/nativeCatalog.js";

const asyncDomains = new Set(["files", "preferences", "history", "reports", "relationships", "calls"]);
const asyncAccountTables = new Set(["account_recovery_codes", "account_recovery_tickets", "account_key_backups", "account_key_unlocks"]);

/** Explicit staging composition. No alternative store fallback and no schema creation on application startup. */
export async function openPostgresRuntime(database: MeldiqPostgres) {
  if (database.config.environment === "production") throw new Error("Production PostgreSQL activation awaits migration acceptance");
  if ((database.config.maxConnections ?? 5) < 2) throw new Error("PostgreSQL runtime needs one writer lease and at least one query connection");
  const endpoint = new URL(database.config.url), local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (!local) {
    const ref = database.config.projectRef;
    if (database.config.environment !== "staging" || !ref || !/^[a-z]{20}$/.test(ref)) throw new Error("Remote application runtime requires an explicit staging project reference");
    const matching = endpoint.hostname === `db.${ref}.supabase.co` ||
      (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(endpoint.hostname) && decodeURIComponent(endpoint.username).endsWith(`.${ref}`));
    if (!matching) throw new Error("Staging PostgreSQL connection does not match the expected project");
    const role = (await database.query<{privileged: boolean; api: boolean}>(`SELECT
      (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS privileged,
      pg_has_role(current_user,'meldiq_api','USAGE') AS api FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!role || role.privileged || !role.api) throw new Error("Application runtime requires its restricted meldiq_api login, not an operator role");
  }
  const rows = await PostgresRows.open(database, [...tableSpecs().filter(table => !asyncDomains.has(table.domain) && !asyncAccountTables.has(table.name)),
    ...NATIVE_TABLES.filter(table => table.name === "auth_device_sessions")]);
  const files = new PostgresFileStore(database), relay = new PostgresRelayStore(rows);
  const removeGuard = database.installRuntimeGuard(() => rows.assertAvailable());
  return {
    database, rows, files, relay, legacySqlAttempts: 0,
    accounts: new PostgresAccountStore(rows), recovery: new PostgresRecoveryStore(database), keys: new PostgresKeyBackupStore(database),
    preferences: new PostgresPreferenceStore(database), history: new PostgresHistoryStore(database), messages: new PostgresMessageStore(database),
    reports: new PostgresReportStore(database), relationships: new PostgresRelationshipStore(database), calls: new PostgresCallStore(database),
    activity: new PostgresActivityStore(database), decorations: new PostgresDecorationStore(database), favorites: new PostgresFavoriteStore(database),
    pins: new PostgresPinStore(database), privacy: new PostgresPrivacyStore(database), holds: new PostgresUsernameHoldStore(database),
    points: new PostgresPointsStore(database), oauth: new PostgresOAuthStore(database), bots: new PostgresBotStore(database), rules: new PostgresRulesStore(database),
    async close() {
      const drained = await Promise.allSettled([files.settled(), relay.settled()]);
      removeGuard();
      await rows.close();
      const failed = drained.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(item => item.reason), "PostgreSQL repository shutdown failed");
    },
  };
}

export type PostgresRuntime = Awaited<ReturnType<typeof openPostgresRuntime>>;

/** Only the in-memory compatibility handle may remain. Any unported SQL read/write fails visibly during staging. */
export function blockLegacySql(database: DB, attempted: () => void): DB {
  return new Proxy(database, {
    get(target, property) {
      if (["prepare", "exec", "pragma", "transaction", "backup", "loadExtension"].includes(String(property))) return () => {
        attempted();
        throw new Error("Legacy SQL access is not implemented in the staged PostgreSQL runtime");
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
