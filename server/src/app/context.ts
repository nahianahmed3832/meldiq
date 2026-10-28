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
import type { ReportSealer } from "../modules/organizations/reports/seal.js";
import type { RelationshipStore } from "../modules/accounts/relationships/store.js";
import type { CallStore } from "../modules/calls/store.js";
import type { Rows } from "../infrastructure/database/rows/index.js";
import type { ReportStore } from "../modules/organizations/reports/store.js";
import type { PreferenceStore } from "../modules/accounts/preferences/store.js";
import type { PushService } from "../modules/notifications/service.js";
import type { FcmService } from "../modules/notifications/fcm.js";
import type { Metrics } from "../modules/administration/ops/metrics.js";
import type { UsageMeter } from "../modules/administration/usage/meter.js";
import type { MeetingService } from "../modules/calls/meetings.js";
import type { ReminderService } from "../modules/accounts/reminders/service.js";
import type { BlobStore } from "../infrastructure/storage/index.js";
import type { Telemetry } from "../modules/telemetry/index.js";
import type { QuotaEngine } from "../modules/quotas/index.js";
import type { Billing, Gifts, Mojo } from "../modules/billing/index.js";

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
  /** Reports (batch B4): SQLite, or MongoDB when MONGODB_DOMAINS includes "reports"; their content sealed by [reportSealer]. */
  reports: ReportStore;
  reportSealer: ReportSealer;
  /** Connections, message requests and messaging settings (batch B6): SQLite, or MongoDB with the "relationships" domain. */
  relationships: RelationshipStore;
  /** Calls, their participants and raised hands: SQLite, or MongoDB when MONGODB_DOMAINS includes "calls". */
  calls: CallStore;
  /**
   * Communities and conversations (orgs, members, roles, channels, their members, invitations, audit…): SQLite, or
   * MongoDB with an in-memory copy when MONGODB_DOMAINS includes "workspace" and "conversations" (app/workspaceRows.ts).
   */
  ws: Rows;
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
  /** Display names of users by id (identity), for billing's views. */
  userNames: (ids: readonly string[]) => Map<string, string>;
  log: FastifyBaseLogger;
  audit: (e: { actorId?: string | null; orgId?: string | null; action: string; target?: string | null; detail?: string | null }) => void;
}
