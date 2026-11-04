import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import type { CallRow } from "../calls/index.js";
import {
  admitBotKeySender,
  announceBotKeyRequest,
  closeBotMedia,
  confirmBotMedia,
  issueBotMedia,
  prepareBotMedia,
} from "../calls/index.js";
import type {
  BotVoiceKeyRequest,
  BotVoicePacket,
} from "../../shared/contracts/botVoice.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { blockedEitherWay } from "../accounts/index.js";
import { BotVoiceLedger } from "./voiceLedger.js";

const LEASE_MS = 60_000;
const MAX_LEASES = 128;
type Lease = {
  id: string;
  requestId: string;
  bot: Bot;
  call: CallRow;
  orgId: string;
  publicKey: string;
  fingerprint: string;
  revision: number;
  installation: string;
  expiresAt: number;
  revoked: boolean;
  canSpeak: boolean;
  packet?: BotVoicePacket & { senderUserId: string; at: number };
};

/** A separate media capability. Never a human device, account session, user socket or durable call key. */
export class BotVoice {
  private readonly leases = new Map<string, Lease>();
  private joining = false;
  private running?: Promise<void>;
  private recoveryAt = 0;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private warningAt = 0;
  private workCursor = 0;
  private stopping = false;
  constructor(private readonly bots: BotService) {}

  start() {
    this.stopping = false;
    this.unsubscribe = this.bots.events.onInvalidate((id) => {
      for (const lease of this.leases.values())
        if (lease.bot.id === id) lease.revoked = true;
      void this.maintain();
    });
    this.timer = setInterval(() => {
      void this.maintain();
    }, 1_000);
    this.timer.unref();
    void this.maintain();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
    for (const lease of this.leases.values()) lease.revoked = true;
    await this.maintain();
  }
  withdraw(userId: string, participantId: string) {
    const lease = this.leases.get(participantId);
    if (lease?.bot.id === userId) {
      lease.revoked = true;
      delete lease.packet;
      void this.maintain();
    }
  }
  revokeCall(callId: string) {
    for (const lease of this.leases.values())
      if (lease.call.id === callId) {
        lease.revoked = true;
        delete lease.packet;
      }
    void this.maintain();
  }
  private supported() {
    if (!this.bots.ctx.postgres)
      throw new ApiError(
        503,
        "bot_events_unavailable",
        "Bot media leases require the authoritative PostgreSQL adapter",
      );
  }
  private ledger() {
    this.supported();
    return new BotVoiceLedger(this.bots.ctx.postgres!.database);
  }
  private current(lease: Lease) {
    if (
      this.stopping ||
      lease.revoked ||
      lease.expiresAt <= this.bots.clock() ||
      !this.bots.permissions.currentCredential(
        lease.bot.id,
        lease.bot.tokenHash,
      )
    )
      return false;
    try {
      const key = this.bots.permissions.approvedVoiceKey(
        lease.bot,
        lease.orgId,
      );
      const conv = this.bots.ctx.authz.requireMember(
        lease.call.conversation_id,
        lease.bot.id,
      );
      return (
        !conv.archived_at &&
        conv.voice === 1 &&
        this.bots.ctx.authz.canConnectVoice(conv, lease.bot.id) &&
        key.publicKey === lease.publicKey &&
        key.revision === lease.revision &&
        key.installationKey === lease.installation
      );
    } catch (error) {
      if (error instanceof ApiError && error.statusCode < 500) return false;
      throw error;
    }
  }
  private speaking(lease: Lease) {
    const conv = this.bots.ctx.authz.conversation(lease.call.conversation_id);
    return (
      !!conv &&
      this.current(lease) &&
      this.bots.permissions.allows(lease.bot, lease.orgId, "voice.speak") &&
      this.bots.ctx.authz.canSpeakInVoice(conv, lease.bot.id)
    );
  }
  maySpeak(userId: string, participantId: string) {
    const lease = this.leases.get(participantId);
    return !!lease && lease.bot.id === userId && this.speaking(lease);
  }
  admitted(userId: string, participantId: string, channelId: string) {
    const lease = this.leases.get(participantId);
    return (
      !!lease &&
      lease.bot.id === userId &&
      lease.call.conversation_id === channelId &&
      !!lease.packet &&
      this.current(lease)
    );
  }
  reserved(callId: string) {
    return [...this.leases.values()]
      .filter((lease) => lease.call.id === callId && this.current(lease))
      .map((lease) => `${lease.bot.id}.${lease.id}`);
  }
  requests(call: CallRow): BotVoiceKeyRequest[] {
    if (call.state !== "ACTIVE") return [];
    return [...this.leases.values()]
      .filter(
        (lease) =>
          lease.call.id === call.id && !lease.packet && this.current(lease),
      )
      .map((lease) => ({
        leaseId: lease.id,
        botId: lease.bot.id,
        publicKey: lease.publicKey,
        fingerprint: lease.fingerprint,
        manifestRev: lease.revision,
        expiresAt: lease.expiresAt,
      }));
  }
  private of(bot: Bot, id: string) {
    const lease = this.leases.get(id);
    if (
      !lease ||
      lease.bot.id !== bot.id ||
      lease.bot.tokenHash !== bot.tokenHash ||
      !this.current(lease)
    )
      throw notFound("This bot voice lease is no longer available");
    return lease;
  }
  private view(lease: Lease) {
    return {
      leaseId: lease.id,
      botId: lease.bot.id,
      callId: lease.call.id,
      channelId: lease.call.conversation_id,
      manifestRev: lease.revision,
      expiresAt: lease.expiresAt,
    };
  }
  async join(bot: Bot, channelId: string, requestId: string) {
    this.supported();
    if (this.stopping)
      throw new ApiError(503, "media_unavailable", "Bot media is stopping");
    if (this.joining)
      throw new ApiError(
        429,
        "rate_limited",
        "A bot voice admission is in progress. Retry shortly.",
      );
    this.joining = true;
    try {
      const destination = this.bots.ctx.authz.requireMember(channelId, bot.id);
      if (!destination.org_id) throw notFound("No community voice room");
      this.bots.permissions.approvedVoiceKey(bot, destination.org_id);
      await this.bots.permissions.ensureCredentials(bot);
      const prior = [...this.leases.values()].find(
        (lease) => lease.bot.id === bot.id,
      );
      if (prior) {
        if (
          prior.requestId !== requestId ||
          prior.call.conversation_id !== channelId ||
          !this.current(prior)
        )
          throw new ApiError(
            409,
            "conflict",
            "This bot has an existing voice lease. Leave it before joining another.",
          );
        const media = await issueBotMedia(
          this.bots.ctx,
          prior.call,
          bot.id,
          prior.id,
          this.speaking(prior),
        );
        this.of(bot, prior.id);
        return { ...this.view(prior), media };
      }
      if (this.leases.size >= MAX_LEASES)
        throw new ApiError(
          429,
          "rate_limited",
          "The bot voice lease limit is reached",
        );
      const id = newId("botvoice");
      const call = await prepareBotMedia(this.bots.ctx, bot.id, channelId, id);
      await this.bots.events.fresh(bot);
      const conv = this.bots.ctx.authz.requireMember(channelId, bot.id);
      if (!conv.org_id) throw notFound("No community voice room");
      const key = this.bots.permissions.approvedVoiceKey(bot, conv.org_id);
      if (this.stopping)
        throw new ApiError(503, "media_unavailable", "Bot media is stopping");
      const lease: Lease = {
        id,
        requestId,
        bot,
        call,
        orgId: conv.org_id,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        revision: key.revision,
        installation: key.installationKey,
        expiresAt: this.bots.clock() + LEASE_MS,
        revoked: false,
        canSpeak: false,
      };
      this.leases.set(id, lease);
      try {
        await this.ledger().remember({
          lease_id: id,
          bot_id: bot.id,
          call_id: call.id,
          room_name: call.room_name,
          created_at: this.bots.clock(),
        });
        this.of(bot, id);
        lease.canSpeak = this.speaking(lease);
        const media = await issueBotMedia(
          this.bots.ctx,
          call,
          bot.id,
          id,
          lease.canSpeak,
        );
        const live = await this.bots.ctx.calls.get(call.id);
        this.of(bot, id);
        if (live?.state !== "ACTIVE") throw notFound("This voice call ended");
        await announceBotKeyRequest(this.bots.ctx, call);
        this.of(bot, id);
        return { ...this.view(lease), media };
      } catch (error) {
        lease.revoked = true;
        await this.maintain();
        throw error;
      }
    } finally {
      this.joining = false;
    }
  }
  async share(
    callId: string,
    leaseId: string,
    userId: string,
    deviceId: string,
    packet: BotVoicePacket,
  ) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.call.id !== callId || !this.current(lease))
      throw notFound("No pending bot voice key request");
    if (blockedEitherWay(this.bots.ctx, userId, lease.bot.id))
      throw forbidden("This bot voice key is unavailable");
    const admitSender = await admitBotKeySender(
      this.bots.ctx,
      callId,
      userId,
      deviceId,
    );
    admitSender();
    if (
      !this.current(lease) ||
      blockedEitherWay(this.bots.ctx, userId, lease.bot.id)
    )
      throw notFound("This bot voice key request changed");
    // First accepted packet wins, matching native call-key semantics. Never store or log a plaintext key.
    lease.packet ??= { ...packet, senderUserId: userId, at: this.bots.clock() };
    return { accepted: true as const };
  }
  key(bot: Bot, id: string) {
    const lease = this.of(bot, id);
    return { ...this.view(lease), key: lease.packet ?? null };
  }
  async heartbeat(bot: Bot, id: string) {
    const lease = this.of(bot, id);
    lease.expiresAt = this.bots.clock() + LEASE_MS;
    if (!lease.packet) await announceBotKeyRequest(this.bots.ctx, lease.call);
    this.of(bot, id);
    return this.view(lease);
  }
  async connected(bot: Bot, id: string) {
    const lease = this.of(bot, id);
    if (!lease.packet)
      throw forbidden("Wait for the encrypted voice key before connecting");
    await confirmBotMedia(this.bots.ctx, lease.call.id, bot.id, id);
    this.of(bot, id);
    return { ...this.view(lease), canSpeak: this.speaking(lease) };
  }
  async leave(bot: Bot, id: string) {
    const lease = this.of(bot, id);
    lease.revoked = true;
    delete lease.packet;
    await closeBotMedia(this.bots.ctx, lease.call, bot.id, id);
    await this.ledger().forget(id);
    this.leases.delete(id);
    return { left: true as const };
  }
  async maintain() {
    if (this.running) return this.running;
    this.running = (async () => {
      const media = this.bots.ctx.livekit;
      if (!media || !this.bots.ctx.postgres) return;
      const live = this.leases.size
        ? new Set((await this.bots.ctx.calls.live(true)).map((call) => call.id))
        : null;
      for (const lease of this.leases.values()) {
        if (!live?.has(lease.call.id) || !this.current(lease))
          lease.revoked = true;
        if (lease.revoked) delete lease.packet;
      }
      const snapshot = [...this.leases.values()];
      const deadline = Date.now() + 2000;
      let failed = false;
      const process = async (lease: Lease) => {
        if (lease.revoked) {
          await closeBotMedia(
            this.bots.ctx,
            lease.call,
            lease.bot.id,
            lease.id,
          );
          await this.ledger().forget(lease.id);
          this.leases.delete(lease.id);
        } else {
          const speak = this.speaking(lease);
          if (speak !== lease.canSpeak) {
            if (
              (await media.setCanPublish(
                lease.call.room_name,
                `${lease.bot.id}.${lease.id}`,
                speak,
                false,
              )) === "error"
            )
              throw new Error("Media permission update unavailable");
            lease.canSpeak = speak;
          }
        }
      };
      for (let at = 0; at < snapshot.length; at += 8) {
        const batch: Lease[] = [];
        for (let n = 0; n < Math.min(8, snapshot.length - at); n++) {
          batch.push(snapshot[this.workCursor % snapshot.length]);
          this.workCursor = (this.workCursor + 1) % snapshot.length;
        }
        const outcomes = await Promise.allSettled(batch.map(process));
        failed ||= outcomes.some((result) => result.status === "rejected");
        if (Date.now() >= deadline) break;
      }
      if (
        (this.stopping || Date.now() - this.recoveryAt >= 10_000) &&
        Date.now() < deadline
      ) {
        this.recoveryAt = Date.now();
        const pending = (await this.ledger().pending()).filter(
          (row) => !this.leases.has(row.lease_id),
        );
        for (let at = 0; at < pending.length; at += 8) {
          const outcomes = await Promise.allSettled(
            pending.slice(at, at + 8).map(async (row) => {
              await closeBotMedia(
                this.bots.ctx,
                { id: row.call_id, room_name: row.room_name },
                row.bot_id,
                row.lease_id,
              );
              await this.ledger().forget(row.lease_id);
            }),
          );
          failed ||= outcomes.some((result) => result.status === "rejected");
          if (Date.now() >= deadline) break;
        }
      }
      if (failed) throw new Error("Bot media cleanup pending");
    })()
      .catch(() => {
        if (Date.now() - this.warningAt >= 60_000) {
          this.warningAt = Date.now();
          this.bots.ctx.log.warn(
            { component: "bot_voice" },
            "Bot voice maintenance failed; retry scheduled",
          );
        }
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
