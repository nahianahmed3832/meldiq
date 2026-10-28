import type { AppContext } from "../../app/context.js";
import { REPORT_RETENTION_MS } from "../organizations/reports/routes.js";
import { expireDirectUploads, processAbandonedUploads, processBlobDeletes, purgeExpiredAttachments } from "../files/routes.js";
import { purgeRevokedPushEndpoints } from "../notifications/service.js";
import { purgeHistory } from "../messaging/history/routes.js";
import { broadcastCall, type CallRow, endCallRow, evictFromCall, loadCall, scheduleLost } from "../calls/routes.js";
import { removeFromWorkspace } from "../organizations/orgsRoutes.js";
import { now } from "../../shared/utilities/util.js";
import { PlatformAdminStore } from "../platformAdmin/index.js";

export interface CleanupResult {
  queue: number;
  submitted: number;
  challenges: number;
  sessions: number;
  pairing: number;
  /** @everyone counters older than a day (only the last hour is ever consulted). */
  mentionAll: number;
  attachments: number;
  /** Stored files (disk or S3) removed after their rows were deleted. */
  blobsDeleted: number;
  /** Direct uploads that ran out of time, and abandoned uploads whose object or parts were removed from the store. */
  uploadsExpired: number;
  uploadsCleaned: number;
  /** History deletion markers older than HISTORY_TOMBSTONE_DAYS. */
  historyTombstones: number;
  /** Expired federation nonces, inbox dedupe keys and outbox items. */
  federation: number;
  /** Push endpoints of revoked devices. */
  pushEndpoints: number;
  /** Orbit 2.0 account sessions, email codes and legacy tickets past their time. */
  accountRows: number;
  callsTimedOut: number;
  callEvictions: number;
  /** Call participant records of devices LiveKit no longer has (a missed "left" webhook). */
  callStaleParticipants: number;
  disabledDisconnected: number;
  callRecordsPruned: number;
  auditPruned: number;
  /** Platform Admin Console sessions, passkey ceremonies and enrolment codes past their time (its audit is never pruned). */
  platformAdmin: number;
  /** Quota reservations of operations that never finished, given back (docs/QUOTAS.md). */
  quotaReservations: number;
  /** Failed billing provider events retried, and checkouts past their time closed (docs/BILLING.md). */
  billing: number;
  /** Batch B4: closed reports past their 90 days. */
  reportsPurged: number;
  /** Expired sign-in flows, webhook delivery ids, channel notifications from apps and old finished jobs. */
  /** Old reminder occurrence records and reminders finished more than 30 days ago. */
  reminders: number;
  /** Guests whose membership end date passed, taken out of the workspace (round 7, docs/WORKSPACE_C5.md). */
  guestsExpired: number;
}

/**
 * Enforces retention. Runs on a timer and can be invoked directly (admin CLI / tests).
 * Reads also filter on expires_at, so an item is never served after expiry even between runs.
 */
export async function runCleanup(ctx: AppContext): Promise<CleanupResult> {
  const t = now();
  const { db } = ctx;
  // First, before anything waits: accounts disabled with the admin CLI (a separate process) keep receive-only sockets
  // open, because sessions are only re-checked on client frames. Close them here (T3.3).
  let disabledDisconnected = 0;
  const online = ctx.hub.connectedUserIds();
  for (let i = 0; i < online.length; i += 500) {
    const chunk = online.slice(i, i + 500);
    const disabled = db
      .prepare(`SELECT id FROM users WHERE disabled_at IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as { id: string }[];
    for (const u of disabled) {
      ctx.hub.disconnectUser(u.id, "account disabled");
      disabledDisconnected++;
    }
  }
  const relay = await ctx.relay.purgeExpired(t);
  const r: CleanupResult = {
    queue: relay.queue,
    submitted: relay.submitted,
    challenges: db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").run(t).changes,
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(t).changes,
    pairing: db.prepare("DELETE FROM pairing_requests WHERE expires_at <= ?").run(t).changes,
    mentionAll: await ctx.ws.write((w) => w.delete("mention_all_events", { at: { lte: t - 86_400_000 } })),
    attachments: await purgeExpiredAttachments(ctx),
    blobsDeleted: 0,
    uploadsExpired: await expireDirectUploads(ctx),
    uploadsCleaned: 0,
    // History may live in MongoDB: an unreachable store mustn't stop the rest of retention.
    historyTombstones: await purgeHistory(ctx, t).catch((e) => {
      ctx.log.error({ err: e }, "history retention failed");
      return 0;
    }),
    federation: ctx.federation ? Object.values(ctx.federation.cleanup(t)).reduce((a, b) => a + b, 0) : 0,
    pushEndpoints: purgeRevokedPushEndpoints(db),
    // An unreachable account store (MongoDB) mustn't stop the rest of retention.
    accountRows: await ctx.accounts.purgeExpired().catch((e) => {
      ctx.log.error({ err: e }, "account retention failed");
      return 0;
    }),
    reminders: (() => {
      try {
        return ctx.reminders.purge();
      } catch (e) {
        ctx.log.error({ err: e }, "reminder retention failed");
        return 0;
      }
    })(),
    callsTimedOut: 0,
    callEvictions: 0,
    callStaleParticipants: 0,
    disabledDisconnected,
    callRecordsPruned: 0,
    auditPruned: 0,
    platformAdmin: new PlatformAdminStore(db).purgeExpired(t),
    quotaReservations: ctx.quotas ? ctx.quotas.expireReservations() : 0,
    billing: ctx.billing ? (await ctx.billing.sweep()) + (ctx.gifts ? await ctx.gifts.sweep() : 0) + (ctx.play ? await ctx.play.reconcile() : 0) : 0,
    reportsPurged: 0,
    guestsExpired: 0,
  };
  // Usage gauges (seats, stored bytes, call minutes), at most every ten minutes (docs/USAGE_AND_PLANS.md).
  try {
    await ctx.usage?.snapshot();
  } catch (e) {
    ctx.log.error({ errorType: (e as Error).name }, "usage snapshot failed");
  }
  // Guests past their end date leave the workspace the same way a removal does (round 7).
  const expired = ctx.ws.all<{ org_id: string; user_id: string }>("org_members", { where: { role: "GUEST", expires_at: { lte: t } }, limit: 200 });
  for (const g of expired) {
    try {
      await removeFromWorkspace(ctx, g.org_id, g.user_id, null, "expired");
      r.guestsExpired++;
    } catch (e) {
      ctx.log.error({ errorType: (e as Error).name }, "guest expiry failed");
    }
  }
  // Operational history (RETENTION.md, D16): ended calls and old audit rows don't accumulate forever.
  const callCutoff = t - ctx.config.callRecordRetentionDays * 86_400_000;
  r.callRecordsPruned = await ctx.calls.pruneEnded(callCutoff);
  r.auditPruned = await ctx.ws.write((w) => w.delete("audit_log", { at: { lte: t - ctx.config.auditRetentionDays * 86_400_000 } }));
  // Reports may live in MongoDB: an unreachable store mustn't stop the rest of retention.
  r.reportsPurged = await (async () => ctx.reports.purgeClosed(t - REPORT_RETENTION_MS))().catch((e) => {
    ctx.log.error({ err: e }, "report retention failed");
    return 0;
  });
  r.blobsDeleted = await processBlobDeletes(ctx);
  r.uploadsCleaned = await processAbandonedUploads(ctx);
  // Call membership: anyone no longer admitted (removed from the conversation, revoked device,
  // disabled account) is removed from the room. This repairs evictions missed while LiveKit was
  // unreachable, rejoins with a token issued before removal, and `admin disable` from the CLI process.
  for (const c of await ctx.calls.live(true)) {
    r.callEvictions += await evictFromCall(ctx, c);
  }
  // Calls hosted by another server are that server's to time out. If it vanished mid-call, close the local mirror
  // instead of showing a call forever (no relay: the host is gone or will send its own end).
  const ringCutoff = t - 2 * ctx.config.ringTimeoutSeconds * 1000;
  const mirrorCutoff = t - 12 * 3_600_000;
  for (const c of await ctx.calls.live(false)) {
    if (!((c.state === "RINGING" && c.created_at <= ringCutoff) || c.created_at <= mirrorCutoff)) continue;
    if (await ctx.calls.end(c.id, t, c.state === "RINGING" ? "missed" : "lost")) r.callsTimedOut++;
  }
  // Reconcile live calls with LiveKit (authoritative participant list) once they are past the
  // ring window: unanswered 1:1 calls become "missed", empty rooms are closed.
  const ringWindowEnd = t - ctx.config.ringTimeoutSeconds * 1000;
  const live = (await ctx.calls.live(true)).filter((c) => c.created_at <= ringWindowEnd);
  for (const c of live) {
    const fromLiveKit = ctx.livekit ? await ctx.livekit.participantUsers(c.room_name) : null;
    const users = fromLiveKit ?? new Set((await ctx.calls.present(c.id)).map((p) => p.user_id));
    const type = ctx.ws.get<{ type: string }>("conversations", { id: c.conversation_id })?.type;
    const needed = type === "DM" ? 2 : 1;
    if (c.state === "RINGING") {
      if (users.size < needed) {
        await endCallRow(ctx, c, "missed");
        r.callsTimedOut++;
      } else {
        await ctx.calls.markAnswered(c.id, t);
        await broadcastCall(ctx, (await loadCall(ctx, c.id))!, "updated");
      }
    } else if (users.size === 0) {
      await endCallRow(ctx, c, "empty");
    } else if (fromLiveKit) {
      r.callStaleParticipants += await reconcileParticipants(ctx, c, type === "DM", t);
    }
  }
  return r;
}

/**
 * A live call against LiveKit's participant list (UI-003): a device the server still counts as connected but LiveKit no
 * longer has (its "left" webhook was lost, or the server restarted meanwhile) is marked as left once it's been gone
 * longer than the reconnect grace; a 1:1 call left with one person gets the same grace timer a "left" webhook starts,
 * so it ends as "lost" instead of staying open. Returns the records corrected.
 */
async function reconcileParticipants(ctx: AppContext, c: CallRow, isDm: boolean, t: number): Promise<number> {
  const identities = new Set((ctx.livekit && (await ctx.livekit.participantIdentities(c.room_name))) ?? []);
  let stale = 0;
  for (const p of await ctx.calls.present(c.id)) {
    if (identities.has(`${p.user_id}.${p.device_id}`) || t - p.joined_at < ctx.config.callPeerGraceMs) continue;
    if (await ctx.calls.leave(c.id, p.device_id, t)) stale++;
  }
  if (stale > 0) await broadcastCall(ctx, (await loadCall(ctx, c.id))!, "updated");
  const users = new Set([...identities].map((i) => i.split(".")[0]));
  if (isDm && c.state === "ACTIVE" && users.size < 2) scheduleLost(ctx, c);
  return stale;
}

export function startJobs(ctx: AppContext): () => void {
  let running = false; // a slow LiveKit can make one run outlast the interval; never overlap runs
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    (ctx.metrics ? ctx.metrics.timeJob("retention.cleanup", () => runCleanup(ctx)) : runCleanup(ctx))
      .then((r) => {
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        if (total > 0) ctx.log.info({ cleanup: r }, "retention cleanup");
      })
      .catch((e) => ctx.log.error({ err: e }, "cleanup failed"))
      .finally(() => {
        running = false;
      });
  }, ctx.config.cleanupIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
