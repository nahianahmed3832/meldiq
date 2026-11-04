import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { WEBHOOK_LIMITS, type WebhookMessageBody, type WebhookView } from "../../../shared/contracts/http/webhooks.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { matchesHash, newSecret, secretHash } from "../../../shared/utilities/secrets.js";
import { newId, now } from "../../../shared/utilities/util.js";
import { namesOf, photoBlobId, renameBotIdentity, storePhoto } from "../../accounts/index.js";
import { deleteBlobNow } from "../../files/index.js";
import type { ConversationRow } from "../authz.js";
import { readCommunityImage } from "../communityImages.js";
import { createSenderAccount, postAs } from "./senders.js";
import { friendlyWebhookName, webhookPayload } from "./webhookPayload.js";

/** Webhook tokens: "mqw_" and 43 base64url characters (shared/utilities/secrets.ts). */
export const WEBHOOK_TOKEN_PREFIX = "mqw";

export interface WebhookRow {
  id: string;
  org_id: string;
  channel_id: string;
  user_id: string;
  name: string;
  avatar_rev: number | null;
  token_hash: string;
  token_rotated_at: number;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
}

/** A channel that takes webhooks: a live text, announcement or forum channel (voice channels don't take messages). */
export function webhookChannel(conv: ConversationRow | undefined, orgId: string): conv is ConversationRow {
  return !!conv && conv.type === "CHANNEL" && conv.org_id === orgId && conv.voice !== 1 && !conv.archived_at;
}

/** The picture a webhook shows: its own (fetched with a session), or null for the standard one. */
const avatarUrlOf = (w: Pick<WebhookRow, "id" | "avatar_rev">) => (w.avatar_rev ? `/v1/webhooks/${w.id}/avatar?rev=${w.avatar_rev}` : null);

/**
 * Channel webhooks (community parity batch C, feature "channel-webhooks", docs/COMMUNITY_PARITY_API.md): up to 10 per
 * channel, managed by holders of `webhooks.manage`. Only a token's hash is stored, so a token is shown once (on making
 * the webhook or a new address). Each webhook posts as its own sender account (senders.ts).
 */
export class Webhooks {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
  ) {}

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Webhooks are switched off for now. Try again later.");
  }

  /** A holder of `webhooks.manage` who can see [channelId], a channel of [orgId]. */
  private channelFor(orgId: string, channelId: string, userId: string): ConversationRow {
    this.requireEnabled();
    const { authz } = this.ctx;
    authz.requirePermission(orgId, userId, "webhooks.manage", "Your role doesn't include managing webhooks");
    const conv = authz.conversation(channelId);
    if (!conv || conv.type !== "CHANNEL" || conv.org_id !== orgId || !authz.canViewChannel(conv, userId)) throw notFound("Channel not found");
    return conv;
  }

  private row(channelId: string, webhookId: string): WebhookRow {
    const w = this.ctx.ws.get<WebhookRow>("channel_webhooks", { id: webhookId, channel_id: channelId });
    if (!w) throw notFound("No webhook with that id in this channel");
    return w;
  }

  private views(rows: readonly WebhookRow[]): z.infer<typeof WebhookView>[] {
    const names = new Map(namesOf(this.ctx.identity, [...new Set(rows.map((r) => r.created_by))]).map((n) => [n.id, n.displayName]));
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      name: r.name,
      avatarUrl: avatarUrlOf(r),
      createdBy: names.has(r.created_by) ? { id: r.created_by, displayName: names.get(r.created_by)! } : null,
      createdAt: r.created_at,
      tokenRotatedAt: r.token_rotated_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  private one(r: WebhookRow) {
    return { webhook: this.views([r])[0]! };
  }

  list(orgId: string, channelId: string, userId: string) {
    this.channelFor(orgId, channelId, userId);
    const rows = this.ctx.ws.all<WebhookRow>("channel_webhooks", { where: { channel_id: channelId }, orderBy: [["created_at", "asc"]] });
    return { webhooks: this.views(rows), limit: WEBHOOK_LIMITS.perChannel };
  }

  async create(orgId: string, channelId: string, userId: string, wanted?: string, botCredentialHash?: string) {
    const conv = this.channelFor(orgId, channelId, userId);
    const binding = await this.ctx.bots.permissions.prepareCredential(userId, orgId, botCredentialHash);
    if (!webhookChannel(conv, orgId)) throw new ApiError(400, "webhook_channel", "Webhooks post in text, announcement and forum channels");
    const full = () => this.ctx.ws.count("channel_webhooks", { channel_id: channelId }) >= WEBHOOK_LIMITS.perChannel;
    const limit = () => new ApiError(409, "webhook_limit", `A channel can have up to ${WEBHOOK_LIMITS.perChannel} webhooks. Delete one to make another.`, { limit: WEBHOOK_LIMITS.perChannel });
    if (full()) throw limit();
    const name = wanted ?? friendlyWebhookName();
    const senderId = await createSenderAccount(this.ctx, name);
    const token = newSecret(WEBHOOK_TOKEN_PREFIX);
    const t = now();
    const row: WebhookRow = { id: newId("wh"), org_id: orgId, channel_id: channelId, user_id: senderId, name, avatar_rev: null, token_hash: secretHash(token), token_rotated_at: t, created_by: userId, created_at: t, last_used_at: null };
    await this.ctx.ws.write((w) => {
      // Checked again inside the unit, so two requests can't both take the last place.
      if (w.count("channel_webhooks", { channel_id: channelId }) >= WEBHOOK_LIMITS.perChannel) throw limit();
      w.insert("channel_webhooks", { ...row });
      this.ctx.bots.permissions.bindCredential(w, row.id, binding);
    });
    this.ctx.audit({ actorId: userId, orgId, action: "webhook.create", target: row.id, detail: `${name} in ${channelId}` });
    return { ...this.one(row), token };
  }

  async rename(orgId: string, channelId: string, webhookId: string, userId: string, name: string) {
    this.channelFor(orgId, channelId, userId);
    const before = this.row(channelId, webhookId);
    await this.ctx.ws.write((w) => w.update("channel_webhooks", { id: webhookId }, { name }));
    await renameBotIdentity(this.ctx, before.user_id, name);
    this.ctx.audit({ actorId: userId, orgId, action: "webhook.update", target: webhookId, detail: `${before.name} → ${name}` });
    return this.one(this.row(channelId, webhookId));
  }

  async setAvatar(orgId: string, channelId: string, webhookId: string, userId: string, req: FastifyRequest) {
    this.channelFor(orgId, channelId, userId);
    const before = this.row(channelId, webhookId);
    const buf = await readCommunityImage(req, "icon", "Webhook pictures");
    const rev = Math.max(now(), (before.avatar_rev ?? 0) + 1);
    await storePhoto(this.ctx, photoBlobId(webhookId, rev), buf);
    if ((await this.ctx.ws.write((w) => w.update("channel_webhooks", { id: webhookId }, { avatar_rev: rev }))) === 0) {
      await deleteBlobNow(this.ctx, "profile-photos", photoBlobId(webhookId, rev));
      throw notFound("No webhook with that id in this channel");
    }
    if (before.avatar_rev) await deleteBlobNow(this.ctx, "profile-photos", photoBlobId(webhookId, before.avatar_rev));
    this.ctx.audit({ actorId: userId, orgId, action: "webhook.update", target: webhookId, detail: "picture" });
    return this.one(this.row(channelId, webhookId));
  }

  async clearAvatar(orgId: string, channelId: string, webhookId: string, userId: string) {
    this.channelFor(orgId, channelId, userId);
    const before = this.row(channelId, webhookId);
    if (before.avatar_rev) {
      await this.ctx.ws.write((w) => w.update("channel_webhooks", { id: webhookId }, { avatar_rev: null }));
      await deleteBlobNow(this.ctx, "profile-photos", photoBlobId(webhookId, before.avatar_rev));
      this.ctx.audit({ actorId: userId, orgId, action: "webhook.update", target: webhookId, detail: "picture removed" });
    }
    return this.one(this.row(channelId, webhookId));
  }

  /** The stored picture, for members of the webhook's channel (messages name it in `webhook.avatarUrl`). */
  async avatar(webhookId: string, viewerId: string) {
    const w = this.ctx.ws.get<WebhookRow>("channel_webhooks", { id: webhookId });
    if (!w?.avatar_rev || !this.ctx.authz.isMember(w.channel_id, viewerId)) throw notFound("No picture");
    const stream = await this.ctx.blobs.get("profile-photos", photoBlobId(webhookId, w.avatar_rev));
    if (!stream) throw notFound("No picture");
    return { stream, rev: w.avatar_rev };
  }

  async rotate(orgId: string, channelId: string, webhookId: string, userId: string, botCredentialHash?: string) {
    this.channelFor(orgId, channelId, userId);
    this.row(channelId, webhookId);
    const token = newSecret(WEBHOOK_TOKEN_PREFIX);
    const binding = await this.ctx.bots.permissions.prepareCredential(userId, orgId, botCredentialHash);
    await this.ctx.ws.write((w) => {
      w.update("channel_webhooks", { id: webhookId }, { token_hash: secretHash(token), token_rotated_at: now() });
      this.ctx.bots.permissions.bindCredential(w, webhookId, binding);
    });
    this.ctx.audit({ actorId: userId, orgId, action: "webhook.token_rotate", target: webhookId });
    return { ...this.one(this.row(channelId, webhookId)), token };
  }

  /** Its address stops working; what it posted stays, under its sender account. */
  async remove(orgId: string, channelId: string, webhookId: string, userId: string) {
    this.channelFor(orgId, channelId, userId);
    const w = this.row(channelId, webhookId);
    await this.ctx.ws.write((x) => x.delete("channel_webhooks", { id: webhookId }));
    if (w.avatar_rev) this.ctx.files.queueBlobDelete("profile-photos", photoBlobId(webhookId, w.avatar_rev));
    this.ctx.audit({ actorId: userId, orgId, action: "webhook.delete", target: webhookId, detail: w.name });
    return { deleted: true as const };
  }

  /** POST /v1/webhooks/:webhookId/:token: the token is the only credential. */
  async execute(webhookId: string, token: string, body: WebhookMessageBody, log: FastifyBaseLogger) {
    this.requireEnabled();
    const w = this.ctx.ws.get<WebhookRow>("channel_webhooks", { id: webhookId });
    if (!w || !token.startsWith(`${WEBHOOK_TOKEN_PREFIX}_`) || !matchesHash(token, w.token_hash)) throw notFound("No webhook at that address");
    return this.post(w, body, log);
  }

  /** "Make a post": a holder of `webhooks.manage` posts through one of the channel's webhooks. */
  async postFor(orgId: string, channelId: string, webhookId: string, userId: string, body: WebhookMessageBody, log: FastifyBaseLogger) {
    this.channelFor(orgId, channelId, userId);
    return this.post(this.row(channelId, webhookId), body, log);
  }

  private async post(w: WebhookRow, body: WebhookMessageBody, log: FastifyBaseLogger) {
    try {
      const botActor = await this.ctx.bots.permissions.credentialActor(w.id);
      if (botActor) this.channelFor(w.org_id, w.channel_id, botActor);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode < 500) throw notFound("No webhook at that address");
      throw error;
    }
    const conv = this.ctx.authz.conversation(w.channel_id);
    if (!conv) throw notFound("No webhook at that address");
    const payload = webhookPayload(body, { id: w.id, name: w.name, avatarUrl: avatarUrlOf(w) }, conv.format === "forum");
    const sent = await postAs(this.ctx, w.user_id, w.channel_id, payload, log);
    await this.ctx.ws.write((x) => x.update("channel_webhooks", { id: w.id }, { last_used_at: sent.serverTs }));
    return { id: sent.messageId, channelId: w.channel_id, serverTs: sent.serverTs };
  }
}
