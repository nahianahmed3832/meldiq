import rateLimit from "@fastify/rate-limit";
import { MongoRelayStore } from "../modules/messaging/relay/mongoStore.js";
import { SqliteRelayStore } from "../modules/messaging/relay/store.js";
import { MongoFileStore } from "../modules/files/mongoStore.js";
import { SqliteFileStore } from "../modules/files/store.js";
import { type ContractObserver, observeContracts } from "./contractObserver.js";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoNetworkError, MongoServerSelectionError } from "mongodb";
import { networkKey } from "./middleware/abuse.js";
import { Accounts } from "../modules/accounts/index.js";
import type { Mailer } from "../infrastructure/mail/mailer.js";
import accountRoutes from "../modules/accounts/routes.js";
import { Authz } from "../modules/organizations/authz.js";
import { orgMemberIds } from "../modules/organizations/index.js";
import { openBillingRows } from "./billingRows.js";
import { openDomainRows } from "./domainRows.js";
import { Gifts, Mojo, PlayBilling } from "../modules/billing/index.js";
import { availableUser, blockedEitherWay, namesOf } from "../modules/accounts/index.js";
import { type Config, effectiveFileMaxBytes } from "./config.js";
import { federationClientRoutes, federationPeerRoutes } from "../modules/federation/routes.js";
import { Federation } from "../modules/federation/service.js";
import { type AppContext } from "./context.js";
import { authenticateRequest } from "../modules/auth/index.js";
import { type DB, openDatabase } from "../infrastructure/database/db.js";
import { Hub } from "../modules/realtime/hub.js";
import { LiveKitService } from "../modules/calls/livekit.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import { openMongo } from "../infrastructure/database/mongo/index.js";
import { MongoHistoryStore } from "../modules/messaging/history/mongoStore.js";
import { MongoRelationshipStore } from "../modules/accounts/relationships/mongoStore.js";
import { MongoReportStore } from "../modules/organizations/reports/mongoStore.js";
import { ReportSealer } from "../modules/organizations/reports/seal.js";
import { SqliteRelationshipStore } from "../modules/accounts/relationships/store.js";
import { MongoCallStore } from "../modules/calls/mongoStore.js";
import { SqliteCallStore } from "../modules/calls/store.js";
import { openWorkspaceRows } from "./workspaceRows.js";
import { SqliteReportStore } from "../modules/organizations/reports/store.js";
import reportRoutes from "../modules/organizations/reports/routes.js";
import applicationRoutes from "../modules/organizations/applicationsRoutes.js";
import connectionRoutes from "../modules/accounts/relationships/routes.js";
import onboardingRoutes from "../modules/organizations/onboardingRoutes.js";
import guideRoutes from "../modules/organizations/guideRoutes.js";
import expressionRoutes from "../modules/organizations/expressionsRoutes.js";
import { MongoPreferenceStore } from "../modules/accounts/preferences/mongoStore.js";
import { type PushDeps, PushService } from "../modules/notifications/service.js";
import { createBlobStore } from "../infrastructure/storage/index.js";
import attachmentRoutes from "../modules/files/routes.js";
import authRoutes from "../modules/auth/routes.js";
import callRoutes from "../modules/calls/routes.js";
import conversationRoutes from "../modules/messaging/conversationsRoutes.js";
import historyRoutes from "../modules/messaging/history/routes.js";
import serverMessagesRoutes from "../modules/messaging/serverMessagesRoutes.js";
import { MongoMessageStore } from "../modules/messaging/store/mongoStore.js";
import { SqliteMessageStore } from "../modules/messaging/store/messageStore.js";
import messageRoutes from "../modules/messaging/messagesRoutes.js";
import orgRoutes from "../modules/organizations/orgsRoutes.js";
import addMembersRoutes from "../modules/organizations/addMembers.js";
import discordRoutes from "../modules/organizations/discord/routes.js";
import roleRoutes from "../modules/organizations/rolesRoutes.js";
import { Entitlements } from "../modules/administration/entitlements.js";
import opsRoutes from "../modules/administration/ops/routes.js";
import { platformSetting, registerPlatformAdmin } from "../modules/platformAdmin/index.js";
import { Telemetry } from "../modules/telemetry/index.js";
import { QuotaEngine, scopesFor } from "../modules/quotas/index.js";
import searchRoutes from "../modules/messaging/search/routes.js";
import experimentRoutes from "../modules/administration/experiments/routes.js";
import { UsageMeter } from "../modules/administration/usage/meter.js";
import { MeetingService } from "../modules/calls/meetings.js";
import meetingRoutes from "../modules/calls/meetingsRoutes.js";
import communityRoutes from "../modules/organizations/communityRoutes.js";
import { runCommunityMigration } from "../modules/organizations/communityMigration.js";
import preferenceRoutes from "../modules/accounts/preferences/routes.js";
import activityRoutes from "../modules/accounts/activity/routes.js";
import { ActivityService } from "../modules/accounts/activity/service.js";
import { MemoryActivityStore } from "../modules/accounts/activity/store.js";
import { MongoActivityStore } from "../modules/accounts/activity/mongoStore.js";
import { announceActivity } from "../modules/accounts/activity/visibility.js";
import reminderRoutes from "../modules/accounts/reminders/routes.js";
import { ReminderService } from "../modules/accounts/reminders/service.js";
import { FcmService } from "../modules/notifications/fcm.js";
import { SqlitePreferenceStore } from "../modules/accounts/preferences/store.js";
import { SqliteHistoryStore } from "../modules/messaging/history/store.js";
import pushRoutes from "../modules/notifications/routes.js";
import userRoutes from "../modules/accounts/usersRoutes.js";
import profileMediaRoutes from "../modules/accounts/profileMediaRoutes.js";
import gifRoutes from "../modules/messaging/gifsRoutes.js";
import bugReportRoutes from "../modules/accounts/bugReports.js";
import { Metrics } from "../modules/administration/ops/metrics.js";
import { ApiError } from "../shared/errors.js";
import { now } from "../shared/utilities/util.js";
import wsRoutes from "../modules/realtime/ws.js";
import { Billing, billingRoutes } from "../modules/billing/index.js";

export const VERSION = "0.57.1";
/**
 * The client API this server speaks and the oldest client API it accepts. Clients refuse a server whose
 * minClientApi is newer than theirs; servers from before these fields existed count as API 1.
 */
export const API_VERSION = 2;
export const MIN_CLIENT_API = 1;
/** Version of the /v1/server-info document itself (fields are only ever added). */
export const SERVER_INFO_VERSION = 1;

/**
 * The URL as logged. The Platform Admin Console searches people by name or email in query strings
 * (/admin/v1/users?q=…): its query strings are never logged, so no address or search ends up in the logs.
 */
export function logUrl(url: string): string {
  return url.startsWith("/admin/") ? url.split("?")[0] : url;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(
  config: Config,
  opts: {
    db?: DB;
    logger?: boolean;
    push?: PushDeps;
    mailer?: Mailer;
    mongo?: MeldiqMongo;
    /** Tests only: checks routes, answers and frames against the contracts (src/app/contractObserver.ts). */
    contracts?: ContractObserver;
  } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            // Never log credentials. Request bodies are not logged at all (default), so
            // message ciphertext and keys never reach the logs either.
            redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
            serializers: {
              req: (r: { method: string; url: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
                method: r.method,
                url: logUrl(r.url),
                hostname: r.hostname,
                remoteAddress: r.ip,
                remotePort: r.socket?.remotePort,
              }),
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });
  if (opts.contracts) observeContracts(app, opts.contracts);

  const db = opts.db ?? openDatabase(config.databasePath);
  // `accounts` needs the finished context; it is set right below, before any route can run.
  const ctx = {
    db,
    config,
    livekit: config.livekit ? new LiveKitService(config.livekit) : null,
    blobs: createBlobStore(config),
    log: app.log,
    metrics: new Metrics(),
    audit: (e) => {
      // Part of the write unit running now, if any (as it was part of the SQLite transaction); its own unit otherwise.
      ctx.ws
        .write((w) =>
          w.insert("audit_log", { at: now(), actor_id: e.actorId ?? null, org_id: e.orgId ?? null, action: e.action, target: e.target ?? null, detail: e.detail ?? null }),
        )
        .catch((err) => app.log.error({ err, action: e.action }, "audit: entry not stored"));
    },
  } as AppContext;
  // MongoDB holds the domains in MONGODB_DOMAINS; it refuses to start if that would split a domain between stores.
  if (config.mongo) {
    const mongo = opts.mongo ?? (await openMongo(config.mongo, db, app.log));
    ctx.mongo = mongo;
    // Write units still committing finish first: one cut off mid-transaction would hold its locks until it times out.
    if (!opts.mongo)
      app.addHook("onClose", async () => {
        await ctx.ws?.settled();
        await ctx.billing?.rows.settled();
        for (const r of [ctx.identity, ctx.platform, ctx.fed, ctx.safety, ctx.ephemeral]) await r?.settled();
        await mongo.close();
      });
  }
  // Communities and conversations: authorisation reads them synchronously, wherever they live.
  ctx.ws = await openWorkspaceRows(db, ctx.mongo, app.log);
  ctx.authz = new Authz(ctx.ws);
  ctx.identity = await openDomainRows(db, "identity", ctx.mongo, app.log);
  ctx.platform = await openDomainRows(db, "platform", ctx.mongo, app.log);
  ctx.fed = await openDomainRows(db, "federation", ctx.mongo, app.log);
  ctx.safety = await openDomainRows(db, "safety", ctx.mongo, app.log);
  ctx.ephemeral = await openDomainRows(db, "ephemeral", ctx.mongo, app.log);
  // Registered after the MongoDB client's own hook, so it runs before it (onClose hooks run last-in first-out): the rows
  // stop following other processes' writes while the client is still open.
  app.addHook("onClose", async () => {
    for (const r of [ctx.ws, ctx.billing?.rows, ctx.identity, ctx.platform, ctx.fed, ctx.safety, ctx.ephemeral]) {
      await r?.settled();
      await r?.close();
    }
  });
  for (const r of [ctx.identity, ctx.platform, ctx.fed, ctx.safety, ctx.ephemeral]) {
    if (r.backend !== "mongodb") continue;
    app.addHook("onSend", async (_req, _reply, payload) => {
      await r.settled();
      return payload;
    });
  }
  // A response leaves once the units its request queued are durable (audit entries, metering), as when they were part
  // of SQLite's transaction: a client that reads right after sees them. SQLite's units are durable already.
  if (ctx.ws.backend === "mongodb") {
    app.addHook("onSend", async (_req, _reply, payload) => {
      await ctx.ws.settled();
      return payload;
    });
  }
  ctx.relay = ctx.mongo?.owns("relay") ? new MongoRelayStore(ctx.mongo, db, app.log) : new SqliteRelayStore(db);
  ctx.hub = new Hub(ctx.relay, config.abuse.wsMaxSocketsPerDevice, config.presence);
  ctx.files = ctx.mongo?.owns("files") ? new MongoFileStore(ctx.mongo, app.log) : new SqliteFileStore(db);
  if (opts.contracts) {
    const observer = opts.contracts;
    ctx.hub.observe = (e) => observer.frame(e);
  }
  ctx.accounts = new Accounts(ctx, { mailer: opts.mailer });
  ctx.prefs = ctx.mongo?.owns("preferences") ? new MongoPreferenceStore(ctx.mongo) : new SqlitePreferenceStore(db);
  ctx.history = ctx.mongo?.owns("history") ? new MongoHistoryStore(ctx.mongo) : new SqliteHistoryStore(db);
  // Server-stored messages live with message history (the "history" domain).
  ctx.messages = ctx.mongo?.owns("history") ? new MongoMessageStore(ctx.mongo) : new SqliteMessageStore(db);
  ctx.reports = ctx.mongo?.owns("reports") ? new MongoReportStore(ctx.mongo) : new SqliteReportStore(db);
  ctx.relationships = ctx.mongo?.owns("relationships") ? new MongoRelationshipStore(ctx.mongo) : new SqliteRelationshipStore(db);
  ctx.calls = ctx.mongo?.owns("calls") ? new MongoCallStore(ctx.mongo) : new SqliteCallStore(db);
  // API 0.56.0: new data, so MongoDB whenever the server has one (no domain to migrate).
  const activityStore = ctx.mongo ? new MongoActivityStore(ctx.mongo) : new MemoryActivityStore();
  if (activityStore instanceof MongoActivityStore) await activityStore.ensureIndexes();
  ctx.activity = new ActivityService(activityStore, app.log);
  ctx.activity.onChange = (userId) => announceActivity(ctx, userId);
  await ctx.activity.start();
  app.addHook("onClose", async () => ctx.activity.stop());
  ctx.reportSealer = ReportSealer.load(process.env, config.dataDir);
  // Billing (plans, subscriptions, Meldiq Spark, gifts): rows in SQLite, or MongoDB when MONGODB_DOMAINS includes it.
  ctx.billing = new Billing(await openBillingRows(db, ctx.mongo, app.log), config.billing, app.log, Date.now, (id) => ctx.quotas.planExists(id));
  if (ctx.billing.rows.backend === "mongodb") {
    app.addHook("onSend", async (_req, _reply, payload) => {
      await ctx.billing.rows.settled();
      return payload;
    });
  }
  // Entitlement changes reach every signed-in device at once (they also refresh on their own): the account's own
  // sessions for a personal subscription, every member for an organization's.
  ctx.userNames = (ids) => new Map(namesOf(ctx.identity, ids).map((u) => [u.id, u.displayName]));
  ctx.mojo = new Mojo(ctx.billing, ctx.billing.rows, {
    isMember: (orgId, userId) => !!ctx.authz.orgRole(orgId, userId),
    enforce: config.mojoEnforce,
    // Mojo on sale in Google Play counts as on sale (MOJO_ENFORCE=auto).
    storeOnSale: () => ctx.play?.onSale() ?? false,
    notifyOrg: (orgId) => ctx.hub.sendToUsers(orgMemberIds(ctx.ws, orgId), { t: "entitlements.changed", scope: "org", orgId }),
  });
  ctx.gifts = new Gifts(
    ctx.billing,
    ctx.billing.rows,
    {
      // A local, enabled person who hasn't blocked the buyer (nor been blocked by them): the same answer for anyone else.
      canReceive: (recipient, buyer) => {
        const u = availableUser(ctx, recipient);
        return !!u && u.home_server_id === null && !(buyer && blockedEitherWay(ctx, recipient, buyer));
      },
      notify: (userId) => ctx.hub.sendToUser(userId, { t: "entitlements.changed", scope: "account" }),
    },
    app.log,
  );
  ctx.billing.webhooks.payments = ctx.gifts;
  ctx.play = config.billing.play ? new PlayBilling(ctx.billing, ctx.gifts, config.billing.play, app.log) : null;
  ctx.billing.onChange = (owner) => {
    if (owner.kind === "org") ctx.hub.sendToUsers(orgMemberIds(ctx.ws, owner.orgId), { t: "entitlements.changed", scope: "org", orgId: owner.orgId });
    else {
      const userIds = new Set([...ctx.billing.subscriptions.ownerUserIds(owner.accountId), ...ctx.billing.grants.userIdsOf(owner.accountId)]);
      for (const userId of userIds) ctx.hub.sendToUser(userId, { t: "entitlements.changed", scope: "account" });
    }
  };
  // A workspace's subscription adds its plan's limits between operator overrides and server-wide limits.
  ctx.entitlements = new Entitlements(config.entitlements, { db, rows: ctx.ws }, (orgId, t) => ctx.billing.subscriptions.planLimits(orgId, t));
  ctx.usage = new UsageMeter(ctx.identity, ctx.ws, ctx.files, ctx.calls);
  ctx.quotas = new QuotaEngine(ctx.platform, Date.now, (scope, t) => ctx.billing.quotaPlanFor(scope, t));
  // AI and AI Workforce were removed in API 0.47.0 (docs/AI_REMOVAL.md): their tables stay, unread.
  // Activity, traffic, concurrency and resources (docs/ANALYTICS_DEFINITIONS.md): written once a minute.
  ctx.telemetry = new Telemetry(ctx);
  await ctx.telemetry.init();
  await ctx.telemetry.recordVersion(VERSION);
  if (config.telemetryTickMs > 0) ctx.telemetry.start(config.telemetryTickMs);
  app.addHook("onClose", async () => ctx.telemetry.stop());
  ctx.reminders = new ReminderService(ctx);
  ctx.reminders.start(config.reminderTickMs);
  app.addHook("onClose", async () => ctx.reminders.stop());
  app.addHook("onClose", async () => ctx.hub.closePresence());
  ctx.meetings = new MeetingService(ctx);
  ctx.meetings.start(config.workflowTickMs > 0 ? 30_000 : 0);
  app.addHook("onClose", async () => ctx.meetings.stop());
  // Branches and teams become roles and categories once (docs/COMMUNITY_REBUILD_2026-10-21.md §6); idempotent. A
  // conversion of SQLite's data: with communities in MongoDB it ran long before, and SQLite's copy is left alone.
  if (ctx.ws.backend === "sqlite") {
    const migrated = runCommunityMigration(ctx);
    if (migrated.converted > 0) app.log.info({ ...migrated }, "community migration converted branches and teams");
  }

  if (config.fcm && !config.push) ctx.hub.onQueuedOffline = (deviceId) => ctx.fcm?.queued(deviceId);
  if (config.trustProxy === true) {
    app.log.warn("TRUST_PROXY=true believes X-Forwarded-For entries clients send themselves, so per-address limits can be dodged. Set the proxy's addresses instead, e.g. TRUST_PROXY=loopback,uniquelocal (docs/ABUSE_CONTROLS.md)");
  }
  if (config.federation) ctx.federation = new Federation(ctx, config.federation);
  if (config.fcm) {
    // Firebase wake-ups (docs/PUSH_FCM.md) beside UnifiedPush; the hub's hooks call both (set before UnifiedPush's).
    const fcm = new FcmService(ctx.identity, ctx.hub, config.fcm, app.log);
    fcm.metrics = ctx.metrics;
    ctx.fcm = fcm;
    app.addHook("preClose", (done) => {
      fcm.stop();
      done();
    });
  }
  if (config.push) {
    const push = new PushService(ctx, config.push, opts.push);
    ctx.push = push;
    ctx.hub.onQueuedOffline = (deviceId) => {
      push.queued(deviceId);
      ctx.fcm?.queued(deviceId);
    };
    ctx.hub.onDeviceOffline = (deviceId, openedAt) => push.disconnected(deviceId, openedAt);
    // Added before the WebSocket plugin's own preClose, which closes every socket: shutting down wakes nobody.
    app.addHook("preClose", (done) => {
      push.stop();
      done();
    });
  }

  // Every finished request, by route template (never the raw URL, which carries ids), for the health view.
  app.addHook("onResponse", async (req, reply) => {
    ctx.metrics.recordRequest(req.method, req.routeOptions?.url ?? "unmatched", reply.statusCode, reply.elapsedTime);
    ctx.telemetry.onResponse(req, reply);
    // Requests per person per day (docs/QUOTAS.md): observed and warned only, and only once an operator governs it.
    if (req.auth && ctx.quotas.hasPolicies("api.requests")) await ctx.quotas.charge("api.requests", scopesFor(req.auth.userId, null), 1);
  });

  // Attachment uploads are streamed to disk by their route (size and quota enforced while reading),
  // so the raw request stream is passed through instead of being buffered in memory.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  // LiveKit webhooks: keep the raw string, the signature covers the exact bytes.
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  // Cross-origin browser apps (WEB_ORIGINS): only the listed origins get CORS answers; everyone else gets none, so their
  // pages can't read this API's responses. No cookies are used, so CORS here never carries ambient credentials.
  if (config.webOrigins.length) {
    const allowed = new Set(config.webOrigins);
    app.addHook("onRequest", async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) return;
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
      if (req.method === "OPTIONS") {
        return reply
          .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE")
          .header("access-control-allow-headers", "authorization, content-type, x-meldiq-client")
          .header("access-control-max-age", "600")
          .code(204)
          .send();
      }
    });
  }

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: "1 minute",
    keyGenerator: async (req) => {
      // Unavailable account store: limit by network for now; the route's own check answers 503.
      const auth = await authenticateRequest(ctx, req).catch(() => null);
      // Without a session: per network, an IPv4 address or an IPv6 /64 (one phone or home holds a whole /64).
      return auth ? `d:${auth.deviceId}` : `ip:${networkKey(req.ip)}`;
    },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // MongoDB unreachable (its domains can't be served): a clear, retryable answer, details only in the log.
    if (err instanceof MongoNetworkError || err instanceof MongoServerSelectionError) {
      req.log.error({ err: { name: err.name, message: err.message } }, "MongoDB unavailable");
      return reply.code(503).send({ error: { code: "unavailable", message: "The server can't reach its database right now. Try again in a moment." } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests, slow down" } });
    if (status === 413) return reply.code(413).send({ error: { code: "too_large", message: "Request is too large" } });
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong on the server" } });
  });

  app.get("/healthz", async (_req, reply) => {
    db.prepare("SELECT 1").get();
    // MongoDB, when the server uses it: unreachable means the domains it holds can't be served.
    const mongodb = ctx.mongo ? await ctx.mongo.ping() : null;
    if (mongodb === false) reply.code(503);
    // Public: says nothing about usage (the online-device count was removed, D28).
    return { ok: mongodb !== false, version: VERSION, time: now(), livekit: !!ctx.livekit, mongodb };
  });

  // Public, non-sensitive server info for client setup screens. Additive only: clients ignore unknown fields.
  app.get("/v1/server-info", async () => ({
    name: "Meldiq relay",
    infoVersion: SERVER_INFO_VERSION,
    api: API_VERSION,
    minClientApi: MIN_CLIENT_API,
    instanceName: config.instanceName,
    registration: config.registrationMode,
    // Federation (additive): this server's global identity, if it federates.
    federation: ctx.federation ? { domain: ctx.federation.domain, serverId: ctx.federation.serverId, protocols: ["griip-fed/1"] } : null,
    version: VERSION,
    calling: !!ctx.livekit,
    queueTtlSeconds: config.queueTtlSeconds,
    attachmentMaxBytes: config.attachmentMaxBytes,
    // Orbit 2.0: the largest file a person may send, in bytes of the file itself (apps check it before encrypting).
    fileMaxBytes: effectiveFileMaxBytes(config),
    // Orbit 2.0 accounts: whether new accounts can be verified (an email transport is set up) and the migration window.
    accounts: {
      registration: ctx.accounts.mailer.available,
      legacyLogin: config.accounts.legacy.login,
      legacyRegistration: config.accounts.legacy.registration,
      legacyMigration: config.accounts.legacy.migration,
      // Only when codes can be emailed: a required move with no email would trap people at the code step.
      legacyMigrationRequired: config.accounts.legacy.migrationRequired && ctx.accounts.mailer.available,
    },
    attachmentTtlSeconds: config.attachmentTtlSeconds,
    encryption: "griip-envelope-v1 (HPKE X25519/HKDF-SHA256/AES-256-GCM + Ed25519)",
    // What this server supports beyond API 1, so apps can say "this server needs an update" instead of failing
    // (servers before 2026-10-17 have no list). Additive: names are never reused.
    features: serverFeatures(config, ctx.blobs.direct !== null),
    // Encrypted message history and kept files (docs/MESSAGE_HISTORY.md). Says nothing about where files are stored.
    history: config.history.enabled ? { maxItemBytes: config.history.maxItemBytes } : null,
    attachmentKeepDays: config.attachmentKeepDays,
    // Push wake-ups (docs/BACKGROUND_DELIVERY.md): the push servers a device's distributor app must use.
    push: config.push ? { unifiedPushHosts: config.push.unifiedPushHosts } : null,
    // Passkeys (docs/PASSKEYS.md): a web app shows them only when its own origin is listed (it is its own relying party).
    passkeys: ctx.accounts.passkeys.available ? { webOrigins: ctx.accounts.passkeys.webOrigins } : null,
  }));

  for (const r of [authRoutes, userRoutes, profileMediaRoutes, gifRoutes, bugReportRoutes, orgRoutes, addMembersRoutes, roleRoutes, conversationRoutes, messageRoutes, serverMessagesRoutes, callRoutes, attachmentRoutes, historyRoutes, pushRoutes, preferenceRoutes, activityRoutes, reminderRoutes, reportRoutes, applicationRoutes, connectionRoutes, onboardingRoutes, guideRoutes, expressionRoutes, discordRoutes, wsRoutes]) {
    await app.register(async (scope) => r(scope, ctx));
  }
  await app.register(async (scope) => opsRoutes(scope, ctx, VERSION));
  await app.register(async (scope) => searchRoutes(scope, ctx));
  await app.register(async (scope) => meetingRoutes(scope, ctx));
  await app.register(async (scope) => communityRoutes(scope, ctx));
  await app.register(async (scope) => experimentRoutes(scope, ctx));
  await app.register(async (scope) => accountRoutes(scope, ctx, ctx.accounts));
  await app.register(async (scope) => billingRoutes(scope, ctx));
  // The Platform Admin Console's /admin/v1 (only with ADMIN_CONSOLE_ORIGIN set; its own sessions, roles and audit).
  await registerPlatformAdmin(app, ctx, VERSION);
  const fed = ctx.federation;
  if (fed) {
    await app.register(async (scope) => federationPeerRoutes(scope, ctx, fed));
    await app.register(async (scope) => federationClientRoutes(scope, ctx, fed));
  }
  return { app, ctx };
}

/** Feature names in /v1/server-info (2026-10-17 onwards). */
export function serverFeatures(config: Config, directUploads = false): string[] {
  const f = [
    "profiles",
    "profile-photos",
    "privacy",
    "phone-lookup",
    "chunked-attachments",
    "call-reconnect",
    "org-delete",
    // Deleting your own account, DELETE /v2/account (docs/ACCOUNT_DELETION.md).
    "account-delete",
    // Meldiq 2.0: communities as a kind of workspace, experiments and content-free analytics (docs/product/).
    "communities",
    "experiments",
    "analytics-events",
    // Round 3: statuses with an emoji and an end time, pausing notifications, and "N online" for a conversation.
    "status-expiry",
    "notifications-pause",
    "conversation-presence",
    "accounts-v2",
    "workspaces-v2",
    "files-1g",
    "workspace-admin",
    "nav-preferences",
    // Saved messages (Later) in the personal preferences document (2026-10-19).
    "saved-items",
    "org-photos",
    // 2026-10-19: custom workspace roles (docs/WORKSPACE_ROLES.md).
    "custom-roles",
    // Round 7: universal search over server-readable content (docs/SEARCH.md).
    "search",
    // Round 7: scheduled meetings in voice rooms, shown as community events (docs/WORKSPACE_C5.md).
    "meetings",
    // 2026-10-21 community rebuild (docs/COMMUNITY_REBUILD_2026-10-21.md): categories, channel order, forum channels and
    // per-role channel permissions; public discovery and open joining; bans.
    "community-channels",
    "community-discovery",
    "community-moderation",
    // 2026-10-21 Discord reference round (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md): forum tags, deleting a channel,
    // and voice channel permissions (voice.connect, voice.speak: listen-only tokens).
    "forum-tags",
    "channel-delete",
    "voice-permissions",
    // Batch B2 (docs/product/MELDIQ_IMPLEMENTATION_PLAN.md): a community's own notification settings and the rail order
    // in the preferences documents; starter templates for new communities (GET /v1/community-templates).
    "community-preferences",
    "community-templates",
    // Batch B3: slowmode (server-enforced), and timed mutes, category levels and hidden channels in the preferences.
    "slowmode",
    "channel-preferences",
    // Batch B4: reports to moderators and operators, pausing invites and new DMs, audit log filters.
    "reports",
    "security-actions",
    // Batch B4b: join applications, activity alerts, the public invite preview (meldiq.app/invite/CODE).
    "join-applications",
    "activity-alerts",
    "invite-links",
    // Batch B6: connections, message requests and who may message you (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md).
    "connections",
    "message-requests",
    // Batch B6b: a group's photo, and appearing idle, do not disturb or invisible.
    "group-photos",
    "presence-modes",
    // Batch B8: a forum's post guidelines (polls' end times and answer emoji live inside the encrypted message).
    "forum-guidelines",
    // Batch B8b: repeating events, onboarding questions, the community guide.
    "event-repeat",
    "onboarding",
    "community-guide",
    // Batch B9: a community's own emoji and stickers.
    "community-expressions",
    // Batch B12: pronouns on profiles, roles listed separately in the member list.
    "pronouns",
    "role-hoist",
    // Round 7: end dates for guests and a community's guest policy (routes/community.ts).
    "guest-expiry",
    // Round 6: recovery codes for a lost email address (docs/ACCOUNT_RECOVERY.md).
    "recovery-codes",
    // 2026-10-21: keys backed up under the password, unlocked on a new device by an emailed code (docs/KEY_BACKUP.md).
    "key-backup",
    // Round 6: reminders kept and fired by the server (docs/REMINDERS.md).
    "reminders",
    // Round 6: voice rooms (docs/VOICE_ROOMS.md).
    "voice-rooms",
    // API 0.43.0: importing a Discord server's structure (GET /v1/discord/status says whether it's set up), and
    // self-only encrypted controls (audience "self": a read in one browser clears the person's others).
    "discord-import",
    "self-controls",
    // API 0.44.0: a community's accent colour and banner (docs/COMMUNITY_BRANDING.md).
    "community-branding",
    // API 0.45.0: animated avatars, profile banners and profile style (docs/PROFILE_MEDIA.md).
    "profile-media",
    // API 0.45.0: GIF search through this server (GET /v1/gifs/status says whether a provider is set up; docs/GIFS.md).
    "gif-search",
    // API 0.46.0 (docs/PROFILE_MEDIA.md): name fonts, colours and effects; community tags worn by names; member lists
    // carry animated avatars; a whole community muted for a while; the invite page shows the community's icon.
    "name-styles",
    "community-tags",
    "community-mute",
    // API 0.46.0 (docs/ACCOUNT_SAFETY.md): two-step sign-in, changing the email, account standing, bug reports, and
    // About me and links on profiles. Two-step sign-in needs PLATFORM_SECRETS_KEY (GET /v2/account/totp says).
    "two-step",
    "email-change",
    "account-standing",
    "bug-reports",
    "profile-links",
    // API 0.56.0: what people are playing, reported by the Android app after they opt in (docs/ACTIVITY_STATUS.md).
    "activity-status",
    // API 0.50.0: folders of communities on the rail, in the personal preferences (railFolders).
    "rail-folders",
    // API 0.54.0 (docs/MOJO.md): Meldiq Mojo's catalog and perks, Meldiq Spark levels, gifts and badges.
    "mojo",
    // API 0.57.0 (docs/SERVER_MESSAGES.md): messages stored and served by the server (/v2/messages).
    "server-messages",
  ];
  if (config.accounts.legacy.migration) f.push("legacy-migration");
  if (directUploads) f.push("direct-upload");
  if (config.history.enabled) f.push("history");
  if (config.attachmentKeepDays > 0) f.push("attachment-keep");
  if (config.push) f.push("push-unifiedpush");
  if (config.fcm) f.push("push-fcm");
  return f;
}
