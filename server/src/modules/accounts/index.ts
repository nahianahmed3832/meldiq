import type { AppContext } from "../../app/context.js";
import type { AuthInfo } from "../auth/index.js";
import { now } from "../../shared/utilities/util.js";
import { IdentityService } from "./identity.js";
import { LegacyMigrationService } from "./legacy.js";
import { createMailer, type Mailer, meteredMailer } from "../../infrastructure/mail/mailer.js";
import { AccountService } from "./service.js";
import { MongoAccountStore, sqliteIdentityRows } from "./mongoStore.js";
import { type AccountStore, SqliteAccountStore } from "./store.js";
import { RecoveryService } from "./recovery.js";
import { type RecoveryStore, SqliteRecoveryStore } from "./recoveryStore.js";
import { MongoRecoveryStore } from "./mongoRecoveryStore.js";
import { WorkspaceService } from "./workspaces.js";
import { KeyBackupService } from "./keyBackup.js";
import { type KeyBackupStore, SqliteKeyBackupStore } from "./keyBackupStore.js";
import { MongoKeyBackupStore } from "./mongoKeyBackupStore.js";
import { PasskeyService } from "./passkeys.js";
import { TotpService } from "./totp.js";
import { EmailChangeService } from "./emailChange.js";

// API 0.46.0: what warnings from staff limit (docs/ACCOUNT_SAFETY.md).
export { requireStanding } from "./standing.js";
// For the Platform Admin Console (modules/platformAdmin), which signs admins in with their account password.
export type { AccountRow } from "./store.js";
export { burnPasswordCheck, verifyPassword } from "./passwords.js";
export {
  accountStateCounts,
  deviceCounts,
  type DeviceInventoryRow,
  deviceOf,
  devicesPage,
  latestSessionOfDevices,
  namesOf,
  type DeviceSummaryRow,
  searchUsers,
  signupsBetween,
  signupsPerDay,
  signupsSince,
  signupTimes,
  syntheticUserIds,
  setIdentitySuspended,
  type UserCounts,
  userCounts,
  userDevices,
  usernames,
  type UserStatus,
  type UserSummaryRow,
  userSummary,
} from "./platformQueries.js";
/** Who may reach whom (connections, blocks, messaging settings): for other modules' consent checks. */
export { availableUser, blockedEitherWay, dmDecision, sharesCommunity } from "./relationships/rules.js";

/**
 * Orbit 2.0 accounts (docs/ORBIT_2_ARCHITECTURE_2026-10-18.md): email-and-password sign-in, sessions, device setup,
 * workspaces and the legacy migration, as one module of the existing server.
 */
export class Accounts {
  readonly store: AccountStore;
  readonly mailer: Mailer;
  readonly service: AccountService;
  readonly identity: IdentityService;
  readonly legacy: LegacyMigrationService;
  readonly workspaces: WorkspaceService;
  readonly recovery: RecoveryService;
  readonly keyBackups: KeyBackupService;
  readonly passkeys: PasskeyService;
  /** API 0.46.0 (docs/ACCOUNT_SAFETY.md): two-step sign-in and changing the account's email. SQLite in either mode. */
  readonly totp: TotpService;
  readonly emailChange: EmailChangeService;

  private readonly db: AppContext["db"];

  constructor(ctx: AppContext, opts: { mailer?: Mailer; store?: AccountStore; recoveryStore?: RecoveryStore; keyBackupStore?: KeyBackupStore } = {}) {
    this.db = ctx.db;
    // MONGODB_DOMAINS includes "accounts": the account rows live in MongoDB (docs/MONGODB.md).
    this.store =
      opts.store ?? (ctx.mongo?.owns("accounts") ? new MongoAccountStore(ctx.mongo, sqliteIdentityRows(ctx.db)) : new SqliteAccountStore(ctx.db));
    this.mailer = opts.mailer ?? createMailer(ctx.config.accounts.mail);
    this.service = new AccountService(ctx, this.store, meteredMailer(this.mailer, ctx.metrics));
    this.identity = new IdentityService(ctx, this.service);
    this.legacy = new LegacyMigrationService(ctx, this.service);
    this.workspaces = new WorkspaceService(ctx, this.store);
    const recoveryStore = opts.recoveryStore ?? (ctx.mongo?.owns("accounts") ? new MongoRecoveryStore(ctx.mongo) : new SqliteRecoveryStore(ctx.db));
    this.recovery = new RecoveryService(ctx, this.service, recoveryStore);
    const keyBackupStore = opts.keyBackupStore ?? (ctx.mongo?.owns("accounts") ? new MongoKeyBackupStore(ctx.mongo) : new SqliteKeyBackupStore(ctx.db));
    this.keyBackups = new KeyBackupService(ctx, this.service, keyBackupStore);
    // Passkeys are kept in SQLite in either mode (migration 045 explains why there is no foreign key).
    this.passkeys = new PasskeyService(ctx, this.service);
    this.totp = new TotpService(ctx, ctx.config.platformSecretsKey);
    this.service.secondFactor = (accountId, code) => this.totp.checkSignIn(accountId, code);
    this.emailChange = new EmailChangeService(ctx, this.service);
  }

  /**
   * The messaging identity behind a v2 access token, for the v1 routes and the WebSocket: only a session bound to a
   * device (one that has set up encryption) may use them.
   */
  async deviceAuth(token: string | undefined): Promise<AuthInfo | null> {
    const s = await this.service.sessions.authenticate(token, now());
    if (!s || !s.device_id || !s.user_id) return null;
    return { userId: s.user_id, deviceId: s.device_id, sessionId: s.id };
  }

  /**
   * Whether a v2 session still may be used from [deviceId] (an open WebSocket re-checks this, not its first access
   * token): not revoked or expired, account and device in good standing, still bound to that device.
   */
  sessionStillValid(sessionId: string, deviceId: string): Promise<boolean> {
    return this.service.sessions.stillValid(sessionId, deviceId, now());
  }

  /**
   * Whether the encryption identity [userId] is disabled or deleted. The Platform Admin Console (another module) asks
   * this instead of reading the users table itself.
   */
  identityBlocked(userId: string): boolean {
    const u = this.db.prepare("SELECT disabled_at, deleted_at FROM users WHERE id = ?").get(userId) as { disabled_at: number | null; deleted_at: number | null } | undefined;
    return !!u && (u.disabled_at !== null || u.deleted_at !== null);
  }

  async purgeExpired(): Promise<number> {
    return (await this.store.purgeExpired(now())) + (await this.recovery.purgeExpired()) + (await this.keyBackups.purgeExpired());
  }
}

// Account deletion for the Platform Admin Console (the same erasure people trigger themselves; docs/ACCOUNT_DELETION.md).
export { eraseAccount, soleOwnedWorkspaces } from "./deletion.js";

// Load-test provisioning (docs/LOADTEST_PROVISIONING.md), used by auth, organizations and messaging.
export {
  admitLoadtestAccount, checkLoadtestRequest, createLoadtestInvite, findLoadtestInvite, isSynthetic, LOADTEST_INVITE_MAX_DAYS, LOADTEST_INVITE_MAX_USES,
  loadtestQuota, requireSyntheticScopeForPeople, type LoadtestPolicy, type QuotaState,
} from "./loadtest.js";
// Community photos made from a Discord server's icon (modules/organizations/discord).
export { MAX_PHOTO_BYTES, photoBlobId, storePhoto } from "./photos.js";
