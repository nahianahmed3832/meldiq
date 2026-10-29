import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { FileStore } from "../modules/files/store.js";
import type { RelayStore } from "../modules/messaging/relay/store.js";
import type { Accounts } from "../modules/accounts/index.js";
import type { Authz } from "../modules/organizations/authz.js";
import type { Config } from "./config.js";
import type { DB } from "../infrastructure/database/db.js";
import type { Hub } from "../modules/realtime/hub.js";
import type { Federation } from "../modules/federation/service.js";
import type { Entitlements } from "../modules/administration/entitlements.js";
import type { LiveKitService } from "../modules/calls/livekit.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import type { HistoryStore } from "../modules/messaging/history/store.js";
import type { MessageStore } from "../modules/messaging/store/messageStore.js";
import type { ReportSealer } from "../modules/organizations/reports/seal.js";
import type { CommunityRules } from "../modules/organizations/rules/service.js";
import type { CommunitySettings } from "../modules/organizations/settings/service.js";
import type { RelationshipStore } from "../modules/accounts/relationships/store.js";
import type { CallStore } from "../modules/calls/store.js";
import type { Rows } from "../infrastructure/database/rows/index.js";
import type { ReportStore } from "../modules/organizations/reports/store.js";
import type { PreferenceStore } from "../modules/accounts/preferences/store.js";
import type { ActivityService } from "../modules/accounts/activity/service.js";
import type { DecorationService } from "../modules/accounts/decorations/service.js";
import type { PinService } from "../modules/accounts/pins/service.js";
import type { PrivacyStore } from "../modules/accounts/relationships/privacyStore.js";
import type { UsernameHolds } from "../modules/accounts/usernameHolds.js";
import type { PointsService } from "../modules/points/index.js";
import type { CreatorService } from "../modules/accounts/creators/service.js";
import type { LinkedAccountsService } from "../modules/linkedAccounts/index.js";
import type { OAuthService } from "../modules/oauth/index.js";
import type { BotService } from "../modules/bots/index.js";
import type { PushService } from "../modules/notifications/service.js";
import type { FcmService } from "../modules/notifications/fcm.js";
import type { Metrics } from "../modules/administration/ops/metrics.js";
import type { UsageMeter } from "../modules/administration/usage/meter.js";
import type { MeetingService } from "../modules/calls/meetings.js";
import type { ReminderService } from "../modules/accounts/reminders/service.js";
import type { BlobStore } from "../infrastructure/storage/index.js";
import type { Telemetry } from "../modules/telemetry/index.js";
import type { QuotaEngine } from "../modules/quotas/index.js";
import type { Billing, Gifts, Mojo, PlayBilling } from "../modules/billing/index.js";

export interface AppContext {
  db: DB;
  config: Config;
  authz: Authz;
  hub: Hub;
  livekit: LiveKitService | null;
  /** Attachment and profile-photo bytes: the server's disk or S3 (docs/STORAGE_AND_DATA.md). */
  blobs: BlobStore;
  /** Present when FEDERATION_DOMAIN is configured (docs/FEDERATION_PROTOCOL.md). */
  federation?: Federation;
  /** Present when PUSH_UNIFIEDPUSH_HOSTS is configured (docs/BACKGROUND_DELIVERY.md). */
  push?: PushService;
  /** Present when FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE are configured (docs/PUSH_FCM.md). */
  fcm?: FcmService;
  /** Orbit 2.0 email-and-password accounts (src/accounts). Set by buildApp right after the context is made. */
  accounts: Accounts;
  /** Personal navigation preferences (src/preferences): SQLite, or MongoDB when MONGODB_DOMAINS includes "preferences". */
  prefs: PreferenceStore;
  /** Attachment records, upload sessions and pending blob deletions (src/modules/files): SQLite, or MongoDB with "files". */
  files: FileStore;
  /** Queued ciphertext and accepted-message records (src/modules/messaging/relay): SQLite, or MongoDB with the "relay" domain. */
  relay: RelayStore;
  /** Encrypted message history (docs/MESSAGE_HISTORY.md): SQLite, or MongoDB when MONGODB_DOMAINS includes "history". */
  history: HistoryStore;
  /** Messages stored and served by the server (API 0.57.0, docs/SERVER_MESSAGES.md). */
  messages: MessageStore;
  /** Reports (batch B4): SQLite, or MongoDB when MONGODB_DOMAINS includes "reports"; their content sealed by [reportSealer]. */
  reports: ReportStore;
  reportSealer: ReportSealer;
  /** Connections, message requests and messaging settings (batch B6): SQLite, or MongoDB with the "relationships" domain. */
  relationships: RelationshipStore;
  /** What people are playing (API 0.56.0, docs/ACTIVITY_STATUS.md): MongoDB when the server has one, memory otherwise. */
  activity: ActivityService;
  /** Profile decorations: Meldiq's own and reviewed community ones (API 0.61.0, docs/PROFILE_DECORATIONS.md). */
  decorations: DecorationService;
  /** Profile pins: Meldiq's own for milestones, and the ones communities make and give (API 0.64.0, docs/PROFILE_PINS.md). */
  pins: PinService;
  /** API 0.65.0: who may add someone to group chats and whether they're suggested (MongoDB when there is one, memory otherwise). */
  privacyChoices: PrivacyStore;
  /** API 0.65.0: old usernames held 7 days for their last owner. */
  usernames: UsernameHolds;
  /** API 0.65.0: points, quests and account levels (modules/points, docs/SETTINGS_PARITY_API.md). */
  points: PointsService;
  /** API 0.65.0 batch B: creator verification (the Creator badge) and the creator programme. */
  creators: CreatorService;
  /** API 0.65.0 batch B: Steam, AniList, Last.fm and Trakt on profiles (feature connections-v2). */
  linkedAccounts: LinkedAccountsService;
  /** API 0.65.0 batch B: "Log in with Meldiq" apps and OAuth (modules/oauth, docs/SETTINGS_PARITY_API.md). */
  oauth: OAuthService;
  /** API 0.65.0 batch B: bots, their slash commands and interactions (modules/bots, docs/SETTINGS_PARITY_API.md). */
  bots: BotService;
  /** API 0.65.0: rules channels, the communities' rules and who agreed (feature rules-channel, docs/SETTINGS_PARITY_API.md). */
  communityRules: CommunityRules;
  /** Community parity A3: invite links, links, background tint and the onboarding gate (feature community-settings). */
  communitySettings: CommunitySettings;
  /** Calls, their participants and raised hands: SQLite, or MongoDB when MONGODB_DOMAINS includes "calls". */
  calls: CallStore;
  /**
   * Communities and conversations (orgs, members, roles, channels, their members, invitations, audit…): SQLite, or
   * MongoDB with an in-memory copy when MONGODB_DOMAINS includes "workspace" and "conversations" (app/workspaceRows.ts).
   */
  ws: Rows;
  /**
   * The rest of the data, one rows store per domain (docs/MONGODB.md › Retiring SQLite): SQLite, or MongoDB with an
   * in-memory copy when MONGODB_DOMAINS includes it. identity: people and devices; platform: the console, quotas and
   * telemetry; federation; safety: passkeys, two-step, warnings, bug reports; ephemeral: sessions and other short-lived
   * sign-in material and samples.
   */
  identity: Rows;
  platform: Rows;
  fed: Rows;
  safety: Rows;
  ephemeral: Rows;
  /** Present when MONGODB_URI is set: the domains in MONGODB_DOMAINS live there (docs/MONGODB.md). */
  mongo?: MeldiqMongo;
  /** Plan-based limits (src/entitlements.ts, docs/PLANS.md): none by default. */
  entitlements: Entitlements;
  /** Reminders kept and fired by the server (src/reminders, docs/REMINDERS.md). */
  reminders: ReminderService;
  /** In-process operational metrics for the platform health view (src/ops, docs/OPERATIONS.md). */
  metrics: Metrics;
  /** Scheduled meetings in voice rooms, shown as community events (src/workspace, docs/WORKSPACE_C5.md). */
  meetings: MeetingService;
  /** Usage metering per community and day (src/usage, docs/USAGE_AND_PLANS.md). */
  usage: UsageMeter;
  /** Activity, traffic, concurrency and resource telemetry (modules/telemetry, docs/ANALYTICS_DEFINITIONS.md). */
  telemetry: Telemetry;
  /** The unified quota engine (modules/quotas, docs/QUOTAS.md): no policies, so nothing enforced, until an operator sets one. */
  quotas: QuotaEngine;
  /** Plans, subscriptions, invoices and provider webhooks (modules/billing, docs/BILLING.md). */
  billing: Billing;
  /** Meldiq Mojo's perks, Meldiq Spark levels and badges (modules/billing/mojo.ts, docs/MOJO.md). */
  mojo: Mojo;
  /** Gifts of Meldiq Mojo (modules/billing/gifts.ts). */
  gifts: Gifts;
  /** Google Play purchases for the Android app (API 0.55.0); null when GOOGLE_PLAY_PACKAGE isn't set. */
  play: PlayBilling | null;
  /** Display names of users by id (identity), for billing's views. */
  userNames: (ids: readonly string[]) => Map<string, string>;
  log: FastifyBaseLogger;
  audit: (e: { actorId?: string | null; orgId?: string | null; action: string; target?: string | null; detail?: string | null }) => void;
}
