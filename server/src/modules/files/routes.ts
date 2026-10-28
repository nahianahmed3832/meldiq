import crypto from "node:crypto";
import { AsyncLock } from "../../shared/utilities/lock.js";
import type { UploadRow, UsageFilter } from "./store.js";
import { CompleteBody, ConversationQuery, PartsBody, UploadStartBody } from "../../shared/contracts/http/files.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { hasNewAccountLimits, HOUR_MS, limitedUserIds, SlidingWindow } from "../../app/middleware/abuse.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import type { BlobKind } from "../../infrastructure/storage/index.js";
import { ApiError, badRequest, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { refusal, scopesFor } from "../quotas/index.js";

/**
 * Encrypted attachment relay. Clients encrypt files locally (AES-256-GCM, key travels inside the
 * E2EE message), so the server only ever stores opaque ciphertext. Downloads require membership of
 * the conversation the blob was uploaded to; ids are 128-bit random and never listed.
 *
 * Bytes live in ctx.blobs (the server's disk or S3, docs/STORAGE_AND_DATA.md). An upload is received into a spool
 * file first (size and quota enforced while reading), then moved into the store; S3 checks it against its SHA-256.
 */
/** A file over the sender's plan (and the community's Spark level): says the limit, decimal as people read it. */
function uploadLimit(max: number): ApiError {
  const label = max >= 1_000_000_000 ? `${+(max / 1_000_000_000).toFixed(1)} GB` : `${Math.round(max / 1_000_000)} MB`;
  return new ApiError(413, "upload_limit", `Files can be up to ${label} on your plan here. Mojo raises it, and so do a community's Sparks.`, { maxBytes: max });
}

export default async function attachmentRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const cfg = ctx.config;
  const blobs = ctx.blobs;
  fs.mkdirSync(blobs.spoolDir, { recursive: true });
  removeStalePartials(blobs.spoolDir);
  const spoolFor = (id: string) => path.join(blobs.spoolDir, `${id.replace(/[^A-Za-z0-9_-]/g, "")}.part`);
  const files = ctx.files;
  /** Quota checks and the reservations that follow them run one at a time, so parallel uploads see each other. */
  const quotaLock = new AsyncLock();

  const abuse = cfg.abuse;
  // Uploads in progress: bounds concurrency and the temporary disk space they can claim. Their bytes also count for
  // their workspace and, for accounts under new-account limits, for those accounts together, so uploads running in
  // parallel can't pass those limits either.
  const inFlight = { count: 0, bytes: 0, users: new Map<string, { count: number; bytes: number }>(), orgs: new Map<string, number>(), newAccounts: 0 };
  // Uploads started per person per hour, finished or not (docs/ABUSE_CONTROLS.md › Uploads).
  const starts = new SlidingWindow(abuse.uploadStartsPerHour, HOUR_MS);
  /** A new-account allowance, never above the general one (0: no separate allowance; a general 0 means no limit). */
  const newAccountCap = (limit: number, general: number) => (limit > 0 ? (general > 0 ? Math.min(limit, general) : limit) : general);
  /** Whether [used] bytes pass a quota of [limit] bytes; 0 means no limit (the default since UI-003). */
  const exceeds = (limit: number, used: number) => limit > 0 && used > limit;

  interface Uploader {
    userId: string;
    /** The workspace of the conversation, if any. */
    orgId: string | null;
    /** Under new-account limits. */
    limited: boolean;
  }
  const uploaderOf = (userId: string, orgId: string | null): Uploader => ({ userId, orgId, limited: hasNewAccountLimits(ctx.identity, userId) });

  /**
   * The unified quotas (docs/QUOTAS.md), after the server's own limits above: the largest single upload, stored bytes
   * and this month's uploaded bytes, for the person, their community and the platform. Measured only for keys an
   * operator governs; this month's bytes are reserved under [uploadId] (committed when stored, released if not).
   */
  const quotaAdmit = async (who: Uploader, size: number, streaming: number, uploadId: string, ttlMs: number): Promise<void> => {
    const q = ctx.quotas;
    const scopes = scopesFor(who.userId, who.orgId);
    const one = await q.check("files.max_upload_bytes", scopes, size);
    if (!one.allowed) throw refusal(one);
    if (q.hasPolicies("storage.bytes")) {
      const t = now();
      const bytes = async (stored: UsageFilter, pending: Omit<UsageFilter, "kept">) => (await files.storedUsage(stored)).bytes + (await files.pendingUsage(pending)).bytes;
      const conversations = who.orgId ? ctx.authz.conversationIdsOf(who.orgId) : [];
      const measured = {
        user: (await bytes({ uploaders: [who.userId], liveAt: t }, { uploaders: [who.userId] })) + streaming,
        org: who.orgId ? (await bytes({ conversations, liveAt: t }, { conversations })) + (inFlight.orgs.get(who.orgId) ?? 0) : 0,
        global: (await bytes({ liveAt: t }, {})) + inFlight.bytes,
      };
      const stored = await q.check("storage.bytes", scopes, size, { measured });
      if (!stored.allowed) throw refusal(stored);
    }
    const month = await q.check("files.upload_bytes", scopes, size, { reserve: true, idempotencyKey: `upload:${uploadId}`, ttlMs });
    if (!month.allowed) throw refusal(month);
  };
  /** Never rejects: a reservation left open is released by the retention job when its time is up. */
  const quotaSettle = (uploadId: string, stored: number | null) =>
    ctx.quotas.settleByKey(`upload:${uploadId}`, stored === null ? "release" : "commit", stored ?? undefined).catch((e) => ctx.log.error({ err: e }, "quota reservation not settled"));

  /** Admits one more upload start this hour, or refuses with when to try again. */
  const admitStart = (userId: string, reply: { header: (k: string, v: string) => unknown }) => {
    if (starts.allows(userId)) return;
    reply.header("retry-after", String(Math.ceil(starts.retryAfterMs(userId) / 1000)));
    throw new ApiError(429, "too_many_uploads", "You've started a lot of uploads in the last hour. Try again later.");
  };

  /**
   * The upload quotas, checked before anything is received. [reserve] is the new upload's size; [streaming] the bytes
   * this server is receiving for the person right now. Open direct uploads count as if they were stored already.
   */
  const checkQuotas = async (who: Uploader, reserve: number, streaming: number): Promise<void> => {
    const t = now();
    const { userId } = who;
    const bytes = async (stored: UsageFilter, pending: Omit<UsageFilter, "kept">) =>
      (await files.storedUsage(stored)).bytes + (await files.pendingUsage(pending)).bytes;
    const today = await bytes({ uploaders: [userId], createdAfter: t - 86_400_000 }, { uploaders: [userId], createdAfter: t - 86_400_000 });
    const daily = who.limited ? newAccountCap(abuse.newAccountDailyBytes, cfg.attachmentUserDailyBytes) : cfg.attachmentUserDailyBytes;
    if (exceeds(daily, today + streaming + reserve)) {
      // UI-003: on the phone a new account's first 249 MB video got "today's upload limit" while the server advertised
      // 1 GB per file. Say which allowance it is, what's left, and what lifts it.
      if (who.limited) {
        const mb = (n: number) => `${Math.floor(Math.max(n, 0) / (1024 * 1024))} MB`;
        throw new ApiError(
          429,
          "quota_exceeded",
          `New accounts can upload ${mb(daily)} a day for their first ${abuse.newAccountDays} days (${mb(daily - today - streaming)} left today). ` +
            "An invitation from a member, or an administrator, lifts this limit.",
        );
      }
      throw new ApiError(429, "quota_exceeded", "You've reached today's upload limit. Try again tomorrow.");
    }
    if (who.limited) {
      // New accounts: kept files count too, and all new accounts together share one allowance.
      const stored = await bytes({ uploaders: [userId], liveAt: t }, { uploaders: [userId] });
      if (exceeds(newAccountCap(abuse.newAccountStoredBytes, cfg.attachmentUserStoredBytes), stored + streaming + reserve)) {
        throw new ApiError(429, "quota_exceeded", "You've reached your file storage limit. Older files expire after 7 days.");
      }
      const limited = limitedUserIds(ctx.identity, t);
      const pool = await bytes({ uploaders: limited, liveAt: t }, { uploaders: limited });
      if (exceeds(abuse.newAccountsTotalBytes, pool + inFlight.newAccounts + reserve)) {
        throw new ApiError(507, "storage_full", "File storage for new accounts is full right now. Try again later.");
      }
    } else {
      // Files kept for someone's history have their own quota (POST /v1/attachments/:id/keep).
      const stored = await bytes({ uploaders: [userId], liveAt: t, kept: false }, { uploaders: [userId] });
      if (exceeds(cfg.attachmentUserStoredBytes, stored + streaming + reserve)) {
        throw new ApiError(429, "quota_exceeded", "You've reached your file storage limit. Older files expire after 7 days.");
      }
    }
    const storageLimit = who.orgId ? ctx.entitlements.limitFor("storage.bytes", who.orgId).limit : null;
    if (who.orgId && (abuse.orgStoredBytes > 0 || storageLimit !== null)) {
      const conversations = ctx.authz.conversationIdsOf(who.orgId);
      const org = await bytes({ conversations, liveAt: t }, { conversations });
      if (abuse.orgStoredBytes > 0 && org + (inFlight.orgs.get(who.orgId) ?? 0) + reserve > abuse.orgStoredBytes) {
        throw new ApiError(429, "org_quota_exceeded", "This workspace has reached its file storage limit. Older files expire after 7 days.");
      }
      // Round 7: the workspace's plan limit for stored files, if one applies (docs/USAGE_AND_PLANS.md).
      ctx.entitlements.check("storage.bytes", org + (inFlight.orgs.get(who.orgId) ?? 0), who.orgId, reserve);
    }
    const total = await bytes({ liveAt: t }, {});
    if (exceeds(cfg.attachmentTotalBytes, total + inFlight.bytes + reserve)) {
      throw new ApiError(507, "storage_full", "The server's file storage is full. Try again later.");
    }
  };

  /** Counts an upload being received (+1) or finished (-1) everywhere checkQuotas looks. */
  const track = (who: Uploader, bytes: number, sign: 1 | -1) => {
    const mine = inFlight.users.get(who.userId) ?? { count: 0, bytes: 0 };
    mine.count += sign;
    mine.bytes += sign * bytes;
    if (mine.count === 0) inFlight.users.delete(who.userId);
    else inFlight.users.set(who.userId, mine);
    inFlight.count += sign;
    inFlight.bytes += sign * bytes;
    if (who.orgId) {
      const org = (inFlight.orgs.get(who.orgId) ?? 0) + sign * bytes;
      if (org === 0) inFlight.orgs.delete(who.orgId);
      else inFlight.orgs.set(who.orgId, org);
    }
    if (who.limited) inFlight.newAccounts += sign * bytes;
  };

  app.post("/v1/attachments", auth, async (req, reply) => {
    const { userId } = me(req);
    const { conversationId } = parse(ConversationQuery, req.query);
    const conv = ctx.authz.requireMember(conversationId, userId);
    if (!ctx.authz.canPost(conv, userId)) throw new ApiError(403, "forbidden", "You can't post in this conversation");
    if (!ctx.authz.canAttach(conv, userId)) throw new ApiError(403, "forbidden", "You can't share files in this channel");
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== "function") throw badRequest("Expected application/octet-stream body");
    const lengthHeader = req.headers["content-length"];
    const declared = lengthHeader === undefined ? null : Number(lengthHeader);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0)) throw badRequest("Expected a non-empty body");
    if (declared !== null && declared > cfg.attachmentMaxBytes) throw new ApiError(413, "too_large", "Attachment is too large");
    // The person's plan, or the community's Spark level, sets the largest file (docs/MOJO.md), within the server's own.
    const planMax = Math.min(cfg.attachmentMaxBytes, ctx.mojo.uploadBytes(userId, conv.org_id));
    if (declared !== null && declared > planMax) throw uploadLimit(planMax);

    // Quotas are checked before reading the body. A body of unknown length reserves the maximum size. Checking and
    // reserving run under the quota lock, so parallel uploads see each other's reservations.
    const t = now();
    const reserve = declared ?? planMax;
    const who = uploaderOf(userId, conv.org_id);
    admitStart(userId, reply);
    const id = newId("a");
    await quotaLock.run(async () => {
      const mine = inFlight.users.get(userId) ?? { count: 0, bytes: 0 };
      await checkQuotas(who, reserve, mine.bytes);
      if (mine.count >= cfg.attachmentMaxConcurrentPerUser || inFlight.count >= cfg.attachmentMaxConcurrent || exceeds(cfg.attachmentMaxPendingBytes, inFlight.bytes + reserve)) {
        throw new ApiError(429, "too_many_uploads", "Too many uploads at once. Try again in a moment.");
      }
      await quotaAdmit(who, reserve, mine.bytes, id, 60 * 60_000);
      starts.record(userId, t);
      track(who, reserve, 1);
    });
    let storedSize: number | null = null;
    const tmp = spoolFor(id);
    let size = 0;
    const hash = crypto.createHash("sha256");
    try {
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          hash.update(chunk);
          if (size > planMax) cb(uploadLimit(planMax));
          else if (size > cfg.attachmentMaxBytes || (declared !== null && size > declared)) cb(new ApiError(413, "too_large", "Attachment is too large"));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(body, limit, fs.createWriteStream(tmp, { mode: 0o600 }));
        if (size === 0) throw badRequest("Expected a non-empty body");
        if (declared !== null && size !== declared) throw badRequest("Upload ended early");
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        if (e instanceof ApiError) throw e;
        throw badRequest("Upload was interrupted");
      }
      try {
        await blobs.putFile("attachments", id, tmp, size, hash.digest("hex"));
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        ctx.log.error({ err: e }, "attachment store write failed");
        throw new ApiError(503, "storage_unavailable", "The server couldn't store the file. Try again in a moment.");
      }
      storedSize = size;
    } finally {
      track(who, reserve, -1);
      await quotaSettle(id, storedSize);
    }
    const expiresAt = t + cfg.attachmentTtlSeconds * 1000;
    await files.recordAttachment({ id, conversation_id: conv.id, uploader_user_id: userId, size, created_at: t, expires_at: expiresAt });
    ctx.usage?.add(conv.org_id, "files.upload_bytes", size);
    ctx.telemetry?.activity.addTraffic(userId, "files.upload", size, t);
    // Federated conversation: the ciphertext is pushed to the other people's servers, so they download it from
    // their own server. Queued before the message that references it, and delivered in order.
    await ctx.federation?.pushAttachment(conv.id, { id, conversationId: conv.id, uploaderUserId: userId, size, expiresAt });
    return { id, size, expiresAt };
  });

  app.get("/v1/attachments/:id", auth, async (req, reply) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const a = await files.attachment(id);
    // Same 404 for unknown, expired and unauthorised: no oracle for guessing ids.
    if (!a || a.expires_at <= now() || !ctx.authz.isMember(a.conversation_id, userId)) throw notFound("Attachment not found or expired");
    reply.header("cache-control", "private, no-store");
    // Usage (round 7): bytes asked for, whether served here or from S3 (a range counts its own length).
    const orgOf = (ctx.authz.conversation(a.conversation_id)?.org_id ?? null) as string | null;
    const askedRange = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    const asked = askedRange ? Math.max(0, (askedRange[2] === "" ? a.size - 1 : Math.min(Number(askedRange[2]), a.size - 1)) - Number(askedRange[1]) + 1) : a.size;
    const downloadQuota = await ctx.quotas.charge("files.download_bytes", scopesFor(userId, orgOf), asked);
    if (!downloadQuota.allowed) throw refusal(downloadQuota);
    ctx.usage?.add(orgOf, "files.download_bytes", asked);
    ctx.telemetry?.activity.addTraffic(userId, "files.download", asked, now());
    // S3 with presigned downloads: after the checks above, a link valid for a few minutes (the client follows it; its
    // Range header still applies). The bucket itself stays private.
    const direct = await blobs.presignedGet("attachments", a.id);
    if (direct) return reply.redirect(direct, 302);
    reply.header("accept-ranges", "bytes");
    // Resumable downloads (T2.6): a single "bytes=start-[end]" range, checked after membership.
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (req.headers.range !== undefined && range) {
      const start = Number(range[1]);
      const end = range[2] === "" ? a.size - 1 : Math.min(Number(range[2]), a.size - 1);
      if (start >= a.size || start > end) {
        reply.header("content-range", `bytes */${a.size}`);
        return reply.code(416).send({ error: { code: "range_not_satisfiable", message: "Requested range is outside the file" } });
      }
      const part = await blobs.get("attachments", a.id, { start, end });
      if (!part) throw notFound("Attachment not found or expired");
      reply.code(206);
      reply.header("content-type", "application/octet-stream");
      reply.header("content-range", `bytes ${start}-${end}/${a.size}`);
      reply.header("content-length", String(end - start + 1));
      return reply.send(part);
    }
    const all = await blobs.get("attachments", a.id);
    if (!all) throw notFound("Attachment not found or expired");
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(a.size));
    return reply.send(all);
  });

  // Keep a file for encrypted history (docs/MESSAGE_HISTORY.md): any member may ask for a file of their conversation to
  // stay beyond the 7-day relay window, for ATTACHMENT_KEEP_DAYS from now. It stays end-to-end encrypted; its key is
  // only in members' messages and history. Charged to the uploader's quota for kept files.
  app.post("/v1/attachments/:id/keep", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const a = await files.attachment(id);
    const t = now();
    if (!a || a.expires_at <= t || !ctx.authz.isMember(a.conversation_id, userId)) throw notFound("Attachment not found or expired");
    if (cfg.attachmentKeepDays === 0) return { kept: false, expiresAt: a.expires_at };
    const until = t + cfg.attachmentKeepDays * 86_400_000;
    if (!a.kept) {
      const kept = (await files.storedUsage({ uploaders: [a.uploader_user_id], kept: true, liveAt: t })).bytes;
      if (exceeds(cfg.attachmentUserKeptBytes, kept + a.size)) {
        throw new ApiError(429, "quota_exceeded", "This file can't be kept on the server: its sender's storage for kept files is full.");
      }
    }
    const expiresAt = Math.max(a.expires_at, until);
    await files.keep(a.id, expiresAt);
    return { kept: true, expiresAt };
  });

  // ───────────── Direct uploads to S3 (2026-10-17, docs/STORAGE_AND_DATA.md › Direct uploads) ─────────────
  // 1. The app asks to upload [size] bytes of ciphertext with SHA-256 [sha256] to a conversation it may post in.
  // 2. The server checks membership and quotas, picks a random id and presigns a PUT bound to that size and hash that
  //    can't overwrite anything (or, above the multipart threshold, starts a multipart upload with per-part hashes).
  // 3. The app sends the bytes straight to S3, then asks the server to complete. 4. The server checks the stored object
  //    (size, hash) and only then records the attachment. Apps on servers storing on disk keep using POST /v1/attachments.
  const direct = blobs.direct;
  const requireDirect = () => {
    if (!direct) throw new ApiError(409, "direct_upload_unavailable", "This server receives uploads itself: use POST /v1/attachments.");
    return direct;
  };
  const partCount = (u: UploadRow) => Math.ceil(u.size / (u.part_size ?? u.size));
  const partSizeOf = (u: UploadRow, n: number) => (n < partCount(u) ? u.part_size! : u.size - u.part_size! * (partCount(u) - 1));
  // Only the person who started an upload can see or continue it; anyone else gets the same 404 as for no upload.
  const loadUpload = async (id: string, userId: string): Promise<UploadRow> => {
    const u = await files.upload(id);
    if (!u || u.user_id !== userId) throw notFound("Upload not found");
    if (u.expires_at <= now()) throw new ApiError(410, "upload_expired", "This upload took too long. Start it again.");
    return u;
  };
  const storeFailure = (e: unknown, what: string): never => {
    ctx.log.error({ err: e, what }, "direct upload: store request failed");
    throw new ApiError(503, "storage_unavailable", "The server couldn't reach its file storage. Try again in a moment.");
  };

  app.post("/v1/attachments/uploads", auth, async (req, reply) => {
    const { userId, deviceId } = me(req);
    const d = requireDirect();
    const body = parse(UploadStartBody, req.body);
    const conv = ctx.authz.requireMember(body.conversationId, userId);
    if (!ctx.authz.canPost(conv, userId)) throw new ApiError(403, "forbidden", "You can't post in this conversation");
    if (!ctx.authz.canAttach(conv, userId)) throw new ApiError(403, "forbidden", "You can't share files in this channel");
    if (body.size > cfg.attachmentMaxBytes) throw new ApiError(413, "too_large", "Attachment is too large");
    // Direct uploads are bound to this size (each part's URL to its exact length): the plan's limit holds at S3 too.
    const planMax = Math.min(cfg.attachmentMaxBytes, ctx.mojo.uploadBytes(userId, conv.org_id));
    if (body.size > planMax) throw uploadLimit(planMax);
    admitStart(userId, reply);
    const id = newId("a");
    const multipart = body.size > d.multipartThreshold;
    const t = now();
    const expiresAt = t + cfg.directUploads.sessionSeconds * 1000;
    // The upload is recorded before S3 is asked for anything, under the quota lock: it then counts against the quotas
    // and the open-upload limit at once, so requests sent in parallel can't all pass the checks while S3 answers.
    await quotaLock.run(async () => {
      const open = (await files.pendingUsage({ uploaders: [userId], liveAt: now() })).count;
      if (open >= cfg.directUploads.maxPendingPerUser) throw new ApiError(429, "too_many_uploads", "Too many uploads at once. Try again in a moment.");
      await checkQuotas(uploaderOf(userId, conv.org_id), body.size, 0);
      await quotaAdmit(uploaderOf(userId, conv.org_id), body.size, 0, id, expiresAt - t + 60 * 60_000);
      starts.record(userId, t);
      await files.startUpload({
        id,
        user_id: userId,
        device_id: deviceId,
        conversation_id: conv.id,
        size: body.size,
        sha256: body.sha256,
        multipart_id: null,
        part_size: multipart ? d.partSize : null,
        created_at: t,
        expires_at: expiresAt,
      });
    });
    if (multipart) {
      const multipartId = await d.createMultipart("attachments", id).catch(async (e) => {
        await files.dropUpload(id);
        return storeFailure(e, "create-multipart");
      });
      await files.setMultipart(id, multipartId);
      return { uploadId: id, mode: "multipart", partSize: d.partSize, partCount: Math.ceil(body.size / d.partSize), expiresAt };
    }
    const upload = await d.presignPut("attachments", id, body.size, body.sha256, cfg.directUploads.urlTtlSeconds).catch((e) => storeFailure(e, "presign"));
    return { uploadId: id, mode: "single", upload, expiresAt };
  });

  // A fresh URL for a single upload whose URL expired before the app could start it.
  app.post("/v1/attachments/uploads/:id/url", auth, async (req) => {
    const d = requireDirect();
    const u = await loadUpload(parse(idParams, req.params).id, me(req).userId);
    if (u.multipart_id) throw badRequest("This is a multipart upload: ask for its parts");
    return { upload: await d.presignPut("attachments", u.id, u.size, u.sha256, cfg.directUploads.urlTtlSeconds).catch((e) => storeFailure(e, "presign")) };
  });

  // URLs for parts of a multipart upload: each bound to its exact size and SHA-256.
  app.post("/v1/attachments/uploads/:id/parts", auth, async (req) => {
    const d = requireDirect();
    const u = await loadUpload(parse(idParams, req.params).id, me(req).userId);
    if (!u.multipart_id) throw badRequest("This is a single upload: ask for its URL");
    const { parts } = parse(PartsBody, req.body);
    for (const p of parts) {
      if (p.n > partCount(u) || p.size !== partSizeOf(u, p.n)) throw badRequest(`Part ${p.n} must be ${p.n > partCount(u) ? "within the upload" : `${partSizeOf(u, p.n)} bytes`}`);
    }
    const signed = await Promise.all(
      parts.map(async (p) => ({ n: p.n, upload: await d.presignPart("attachments", u.id, u.multipart_id!, p.n, p.size, p.sha256, cfg.directUploads.urlTtlSeconds) })),
    ).catch((e) => storeFailure(e, "presign-part"));
    return { parts: signed };
  });

  // What the store already has of a multipart upload (an app resuming after an interruption).
  app.get("/v1/attachments/uploads/:id/parts", auth, async (req) => {
    const d = requireDirect();
    const u = await loadUpload(parse(idParams, req.params).id, me(req).userId);
    if (!u.multipart_id) throw badRequest("This is a single upload");
    const have = await d.listParts("attachments", u.id, u.multipart_id).catch((e) => storeFailure(e, "list-parts"));
    return { parts: have.map((p) => ({ n: p.partNumber, etag: p.etag, size: p.size, sha256: p.sha256 })) };
  });

  // Checks the stored object and records the attachment. Safe to repeat: a completed upload answers the same again.
  app.post("/v1/attachments/uploads/:id/complete", auth, async (req) => {
    const { userId } = me(req);
    const d = requireDirect();
    const { id } = parse(idParams, req.params);
    const done = await files.attachment(id);
    if (done && done.uploader_user_id === userId) return { id: done.id, size: done.size, expiresAt: done.expires_at };
    const u = await loadUpload(id, userId);
    const body = parse(CompleteBody, req.body ?? {});
    // Membership is checked again: someone removed while uploading can't add a file afterwards.
    const conv = ctx.authz.conversation(u.conversation_id);
    if (!conv || !ctx.authz.isMember(conv.id, userId) || !ctx.authz.canAttach(conv, userId)) {
      await files.abandonUpload(u);
      throw new ApiError(403, "forbidden", "You can't post in this conversation any more");
    }
    if (u.multipart_id) {
      const parts = body.parts ?? [];
      const expected = partCount(u);
      if (parts.length !== expected || parts.some((p, i) => p.n !== i + 1)) throw badRequest(`Send all ${expected} parts, in order`);
      const have = new Map((await d.listParts("attachments", u.id, u.multipart_id).catch((e) => storeFailure(e, "list-parts"))).map((p) => [p.partNumber, p]));
      for (const p of parts) {
        const s3 = have.get(p.n);
        if (!s3 || s3.etag !== p.etag || s3.size !== partSizeOf(u, p.n) || (s3.sha256 && s3.sha256 !== p.sha256)) {
          throw new ApiError(409, "upload_incomplete", `Part ${p.n} isn't uploaded yet, or differs. Upload it again.`);
        }
      }
      await d
        .completeMultipart("attachments", u.id, u.multipart_id, parts.map((p) => ({ partNumber: p.n, etag: p.etag, sha256: p.sha256 })))
        .catch((e) => storeFailure(e, "complete-multipart"));
    }
    const stored = await d.head("attachments", u.id).catch((e) => storeFailure(e, "head"));
    if (!stored) throw new ApiError(409, "not_uploaded", "The file hasn't reached the server's storage yet. Upload it again.");
    // The presigned request already bound size and hash; this catches anything else (a misbehaving store or app).
    if (stored.size !== u.size || (!u.multipart_id && stored.sha256 !== u.sha256)) {
      await files.abandonUpload(u);
      throw new ApiError(400, "upload_corrupt", "The stored file doesn't match what was announced. Send it again.");
    }
    const t = now();
    const expiresAt = t + cfg.attachmentTtlSeconds * 1000;
    // Exactly one of this and the expiry job wins: the attachment exists only if this upload session was still open.
    const recorded = await files.completeUpload(u.id, { id: u.id, conversation_id: conv.id, uploader_user_id: userId, size: u.size, created_at: t, expires_at: expiresAt });
    if (!recorded) {
      await quotaSettle(u.id, null);
      throw new ApiError(410, "upload_expired", "This upload took too long. Start it again.");
    }
    await quotaSettle(u.id, u.size);
    ctx.usage?.add(conv.org_id, "files.upload_bytes", u.size);
    ctx.telemetry?.activity.addTraffic(userId, "files.upload", u.size, t);
    await ctx.federation?.pushAttachment(conv.id, { id: u.id, conversationId: conv.id, uploaderUserId: userId, size: u.size, expiresAt });
    return { id: u.id, size: u.size, expiresAt };
  });

  // The app gave up (cancelled, or failed for good): whatever reached the store is removed.
  app.delete("/v1/attachments/uploads/:id", auth, async (req) => {
    const u = await loadUpload(parse(idParams, req.params).id, me(req).userId);
    await files.abandonUpload(u);
    await quotaSettle(u.id, null);
    await processAbandonedUploads(ctx).catch(() => 0);
    return { ok: true };
  });
}

/** Deletes `.part` files left by uploads interrupted by a restart. Called once at startup, before any upload runs. */
export function removeStalePartials(dir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".part")) continue;
    fs.rmSync(path.join(dir, f), { force: true });
    n++;
  }
  return n;
}

export async function purgeExpiredAttachments(ctx: AppContext): Promise<number> {
  return (await ctx.files.purgeExpired(now())).length;
}

/**
 * Schedules stored bytes for deletion once their row is gone (nobody can fetch them any more). The retention job
 * deletes them from the disk or S3 and retries failures with a growing delay.
 */
export function queueBlobDelete(ctx: AppContext, kind: BlobKind, id: string) {
  ctx.files.queueBlobDelete(kind, id);
}

/** Deletes stored bytes now; if the store can't be reached, the retention job retries. */
export async function deleteBlobNow(ctx: AppContext, kind: BlobKind, id: string): Promise<void> {
  try {
    await ctx.blobs.delete(kind, id);
  } catch {
    queueBlobDelete(ctx, kind, id);
  }
}

/** Retries grow from 30 s to an hour. */
const retryAt = (t: number, attempts: number) => t + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7));

export async function processBlobDeletes(ctx: AppContext, limit = 500): Promise<number> {
  // Deletions scheduled by a cascade that hasn't run yet (MongoDB runs them right after the caller's transaction).
  await ctx.files.settled();
  const t = now();
  let done = 0;
  for (const d of await ctx.files.dueBlobDeletes(t, limit)) {
    try {
      await ctx.blobs.delete(d.kind, d.blob_id);
      await ctx.files.blobDeleteDone(d.kind, d.blob_id);
      done++;
    } catch (e) {
      const attempts = d.attempts + 1;
      ctx.log.warn({ err: e, kind: d.kind, attempts }, "stored file not deleted yet; will retry");
      await ctx.files.blobDeleteRetry(d.kind, d.blob_id, attempts, retryAt(t, attempts));
    }
  }
  return done;
}

/** Direct uploads past their session time become abandoned: their object or parts are removed by [processAbandonedUploads]. */
export function expireDirectUploads(ctx: AppContext): Promise<number> {
  return ctx.files.expireUploads(now());
}

/** Aborts abandoned multipart uploads and deletes abandoned single uploads' objects (never a recorded attachment's). */
export async function processAbandonedUploads(ctx: AppContext, limit = 200): Promise<number> {
  const direct = ctx.blobs.direct;
  if (!direct) return 0;
  const t = now();
  let done = 0;
  for (const a of await ctx.files.dueAbandoned(t, limit)) {
    try {
      // A recorded attachment with this id owns the object: only an unfinished multipart upload is aborted then.
      const recorded = await ctx.files.attachment(a.id);
      if (a.multipart_id) await direct.abortMultipart("attachments", a.id, a.multipart_id);
      if (!recorded) await ctx.blobs.delete("attachments", a.id);
      await ctx.files.abandonedDone(a.id);
      done++;
    } catch (e) {
      const attempts = a.attempts + 1;
      ctx.log.warn({ err: e, attempts }, "abandoned upload not cleaned up yet; will retry");
      await ctx.files.abandonedRetry(a.id, attempts, retryAt(t, attempts));
    }
  }
  return done;
}
