import type { AppContext } from "../../app/context.js";
import type { BotSettings, LiveBotKey, OfficialBotKey } from "../../shared/contracts/http/officialBots.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { createBotIdentity, namesOf } from "../accounts/index.js";
import { sendServerMessage } from "../messaging/index.js";
import { catalogEntry } from "./catalog.js";
import { handle } from "./dispatch.js";
import { type BotEvent, fromAudit, fromMessage, type NotedAudit, type NotedMessage } from "./events.js";
import { runningGiveaways } from "./giveaways.js";
import { BotScheduler } from "./scheduler.js";
import { DEFAULT_SETTINGS, effectiveSettings, isLiveBot, storedSettings } from "./settings.js";
import { BotRows, type LevelRow } from "./store.js";
import { TicketsSeam } from "./ticketsBot.js";
import { type VideoSource, youtubeSource } from "./youtube.js";
import { protectStarboardHistory } from "./starboard.js";
import type { StoredEvent } from "../../shared/contracts/http/serverMessages.js";

/** An official bot that is on in a community, with the settings it acts on now. */
export interface ActiveBot<K extends LiveBotKey = LiveBotKey> {
  key: K;
  orgId: string;
  userId: string;
  /** Its name in this community. */
  name: string;
  settings: BotSettings<K>;
  plus: boolean;
}
export type ActiveBots = { [K in LiveBotKey]?: ActiveBot<K> };

type Payload = Record<string, unknown> & { type: string };

/**
 * The official bots' runtime (community parity batch D, feature "community-bots", docs/COMMUNITY_PARITY_API.md ›
 * Official bots). The hooks only queue events; one queue handles them in order after the write that caused them, so a
 * bot never holds up or fails anyone's request: a bot that errs is logged and the next event goes on. Bots post through
 * the one message path as their community's bot account: in the chat they answer in with the rules every bot follows,
 * and in a channel a manager picked for them (welcome, log, starboard) with a grant for that channel.
 */
export class OfficialBots {
  readonly rows: BotRows;
  readonly scheduler: BotScheduler;
  /** Batch C's tickets as the Tickets bot extends them (ctx.tickets asks through here). */
  readonly tickets: TicketsSeam;
  /** Where Alerts reads YouTube (YOUTUBE_API_KEY); null: Alerts is unavailable. Tests put a fake here. */
  videoSource: VideoSource | null;
  private tail: Promise<void> = Promise.resolve();

  protectStarboardHistory(viewer: string, messages: StoredEvent[], changes?: StoredEvent[]) {
    return protectStarboardHistory(this, viewer, messages, changes);
  }

  constructor(
    readonly ctx: AppContext,
    readonly enabled: boolean,
    readonly clock: () => number = Date.now,
  ) {
    this.rows = new BotRows(ctx);
    this.scheduler = new BotScheduler(this);
    this.tickets = new TicketsSeam(this);
    this.videoSource = ctx.config.youtubeApiKey ? youtubeSource(ctx.config.youtubeApiKey) : null;
  }

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Official bots are switched off for now. Try again later.");
  }

  /** Why [key] can't be turned on on this server, or null when it can. */
  unavailableReason(key: OfficialBotKey): string | null {
    if (key === "alerts" && !this.videoSource) return "Needs a YouTube API key on this server";
    if (key === "tickets" && !this.ctx.tickets.enabled) return "Tickets are switched off on this server";
    return null;
  }

  /** Whether [orgId] has Bots+ now. */
  private paidPlus(orgId: string) {
    const subscription = this.ctx.billing.subscriptions.liveAddonForOwner({ kind: "org", orgId });
    if (!subscription || !this.ctx.billing.subscriptions.grants(subscription, this.clock())) return null;
    const version = this.ctx.billing.catalog.version(subscription.plan_version_id);
    return version && this.ctx.billing.catalog.plan(version.plan_id)?.key === "bots_plus" ? subscription : null;
  }

  hasPlus(orgId: string): boolean {
    const grant = this.rows.plus(orgId);
    return !!(grant && (grant.expires_at === null || grant.expires_at > this.clock())) || this.paidPlus(orgId) !== null;
  }

  /** Bots+ for [orgId] as the Platform Admin Console shows it. */
  plusGrant(orgId: string): {
    enabled: boolean;
    grantedAt: number | null;
    expiresAt: number | null;
    grantedBy: string | null;
    reason: string | null;
  } {
    const stored = this.rows.plus(orgId);
    const p = stored && (stored.expires_at === null || stored.expires_at > this.clock()) ? stored : null;
    const subscription = this.paidPlus(orgId);
    return {
      enabled: !!p || !!subscription,
      grantedAt: p ? p.granted_at : subscription?.created_at ?? null,
      expiresAt: p ? p.expires_at : subscription?.current_period_end ?? null,
      grantedBy: p?.granted_by ?? null,
      reason: p?.reason ?? (subscription ? "Active Bots+ subscription" : null),
    };
  }

  /**
   * Grants Bots+ to [orgId] until [expiresAt] (null: no end), or takes it away ([grant] null). Platform admins do this
   * while billing for Bots+ is off; settings using Plus extras are kept either way and apply again when it's back.
   */
  async setPlus(orgId: string, grant: { by: string; expiresAt: number | null; reason: string } | null): Promise<void> {
    await this.rows.setPlus(
      grant
        ? {
            org_id: orgId,
            granted_by: grant.by,
            granted_at: this.clock(),
            expires_at: grant.expiresAt,
            reason: grant.reason,
          }
        : null,
      orgId,
    );
  }

  /** [key]'s account in [orgId], made the first time it's needed (named as the community wants it). */
  async ensureAccount(orgId: string, key: LiveBotKey, actorId: string, lookName: string | null): Promise<string> {
    const known = this.rows.bot(orgId, key)?.user_id;
    if (known) return known;
    const made = await createBotIdentity(this.ctx, lookName ?? catalogEntry(key).name);
    return this.rows.claimAccount(orgId, key, made.userId, actorId, this.clock(), JSON.stringify(DEFAULT_SETTINGS[key]));
  }

  /**
   * [key]'s account in [orgId] with the settings it acts on, whether it's on or not (null before it had an account):
   * the scheduler finishes what a bot started (a giveaway) even after it was turned off.
   */
  account<K extends LiveBotKey>(orgId: string, key: K): ActiveBot<K> | null {
    const r = this.rows.bot(orgId, key);
    if (!r?.user_id) return null;
    const plus = this.hasPlus(orgId);
    return {
      key,
      orgId,
      userId: r.user_id,
      name: this.nameOf(r.user_id),
      settings: effectiveSettings(key, storedSettings(key, r.settings), plus),
      plus,
    };
  }

  /** The bots on in [orgId] whose account is still a member there. */
  active(orgId: string): ActiveBots {
    const plus = this.hasPlus(orgId);
    const out: ActiveBots = {};
    const rows = this.rows.bots(orgId).filter((r) => r.enabled === 1 && r.user_id && isLiveBot(r.bot_key) && this.ctx.authz.orgRole(orgId, r.user_id));
    const names = new Map(
      namesOf(
        this.ctx.identity,
        rows.map((r) => r.user_id!),
      ).map((n) => [n.id, n.displayName]),
    );
    for (const r of rows) {
      const key = r.bot_key as LiveBotKey;
      const settings = effectiveSettings(key, storedSettings(key, r.settings), plus);
      (out as Record<string, ActiveBot>)[key] = {
        key,
        orgId,
        userId: r.user_id!,
        name: names.get(r.user_id!) ?? catalogEntry(key).name,
        settings,
        plus,
      };
    }
    return out;
  }

  // ───────────── Hooks ─────────────

  /** messaging/serverSend.ts: a message or change was accepted in a community conversation. */
  noteMessage(m: NotedMessage): void {
    // Official bots' own posts and edits (a starboard count, a log line) are nothing for the bots to act on.
    if (!this.enabled || !this.rows.anyOn(m.orgId) || this.rows.byAccount(m.userId)) return;
    const ev = fromMessage(m);
    if (ev) this.enqueue(ev);
  }

  /** app/server.ts: an audit entry was written (joins, leaves, moderation, roles). */
  noteAudit(e: NotedAudit): void {
    if (!this.enabled || !e.orgId || !this.rows.anyOn(e.orgId)) return;
    const ev = fromAudit(e, this.clock());
    if (ev) this.enqueue(ev);
  }

  private enqueue(ev: BotEvent): void {
    this.tail = this.tail.then(() => this.run(ev));
  }

  /** Scheduled work (scheduler.ts) runs on the same queue as events, so the two never interleave. */
  later(what: string, fn: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      try {
        await this.ctx.ws.settled();
        await fn();
      } catch (err) {
        this.ctx.log.warn({ err, what }, "official bots: scheduled work failed");
      }
    });
    this.tail = run;
    return run;
  }

  private async run(ev: BotEvent): Promise<void> {
    try {
      // What caused it is durable and readable first (MongoDB publishes a unit to memory once it committed).
      await this.ctx.ws.settled();
      await handle(this, ev);
    } catch (err) {
      this.ctx.log.warn({ err, kind: ev.kind, orgId: ev.orgId }, "official bots: event not handled");
    }
  }

  /** Resolves once every queued event, and the ones they queued, has been handled (tests, shutting down). */
  async settled(): Promise<void> {
    let t: Promise<void>;
    do {
      t = this.tail;
      await t;
    } while (t !== this.tail);
  }

  /** Runs one bot's part of an event; its failure is logged and never stops the other bots. */
  async safely(key: LiveBotKey, ev: BotEvent, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      await this.recordOutcome(ev.orgId, key, ev.kind, "ok");
    } catch (err) {
      await this.recordOutcome(ev.orgId, key, ev.kind, "failed");
      this.ctx.log.warn({ err, bot: key, kind: ev.kind, orgId: ev.orgId }, "official bots: a bot failed");
    }
  }

  /** No message text, user identifiers, tokens or raw exception details enter the administrator-facing history. */
  async recordOutcome(orgId: string, key: OfficialBotKey, kind: string, outcome: "ok" | "failed"): Promise<void> {
    try {
      await this.ctx.ws.write((w) => {
        const old = this.ctx.ws.all<{ id: string }>("bot_runtime_events", {
          where: { org_id: orgId, bot_key: key },
          orderBy: [
            ["at", "desc"],
            ["id", "desc"],
          ],
        });
        if (old.length >= 50)
          w.delete("bot_runtime_events", {
            id: { in: old.slice(49).map((r) => r.id) },
          });
        w.insert("bot_runtime_events", {
          id: newId("be"),
          org_id: orgId,
          bot_key: key,
          kind: kind.slice(0, 40),
          outcome,
          at: this.clock(),
        });
      });
    } catch {
      this.ctx.log.warn({ orgId, bot: key }, "official bots: execution metadata could not be stored");
    }
  }

  // ───────────── Saying things ─────────────

  /** Display names and usernames of [ids]. */
  people(ids: readonly string[]): Map<string, { username: string; displayName: string }> {
    return new Map(namesOf(this.ctx.identity, [...new Set(ids)]).map((n) => [n.id, { username: n.username, displayName: n.displayName }]));
  }

  nameOf(userId: string | null): string {
    return (userId && this.people([userId]).get(userId)?.displayName) || "Someone";
  }

  /**
   * Answers in the chat [conversationId] as [bot], under the rules every bot follows there (membership, posting rights,
   * timeouts); quietly nothing when it may not post there. [mentions] are pinged.
   */
  async chat(bot: ActiveBot, conversationId: string, text: string, mentions: readonly string[] = []): Promise<string | null> {
    const conv = this.ctx.authz.conversation(conversationId);
    if (!conv || conv.org_id !== bot.orgId || !this.ctx.authz.canPost(conv, bot.userId)) return null;
    const payload: Payload = {
      type: "text",
      text,
      ...(mentions.length ? { mentions: [...new Set(mentions)] } : {}),
    };
    const sent = await sendServerMessage(
      this.ctx,
      { userId: bot.userId, deviceId: null },
      {
        conversationId,
        messageId: newId("m"),
        cls: "message",
        sentAt: this.clock(),
        payload,
      },
      this.ctx.log,
    );
    return sent.messageId;
  }

  /** A live text channel of [orgId], or null. */
  textChannel(orgId: string, channelId: string | null): string | null {
    const c = channelId ? this.ctx.authz.conversation(channelId) : undefined;
    return c && c.type === "CHANNEL" && c.org_id === orgId && !c.archived_at && c.voice !== 1 && (c.format ?? "text") === "text" ? c.id : null;
  }

  /** Posts [payload] as [bot] in the channel a manager picked for it (checked here to still be a text channel). */
  async post(bot: ActiveBot, channelId: string | null, payload: Payload, beforeCommit?: (audience: readonly string[]) => void): Promise<{ messageId: string; channelId: string } | null> {
    const id = this.textChannel(bot.orgId, channelId);
    if (!id) return null;
    const sent = await sendServerMessage(
      this.ctx,
      { userId: bot.userId, deviceId: null, channelGrant: id, beforeCommit },
      {
        conversationId: id,
        messageId: newId("m"),
        cls: "message",
        sentAt: this.clock(),
        payload,
      },
      this.ctx.log,
    );
    return { messageId: sent.messageId, channelId: id };
  }

  /** Changes the text (and with [extra], the boxes) of [bot]'s own post in a channel it was given. */
  async editPost(bot: ActiveBot, channelId: string, messageId: string, text: string, extra: Record<string, unknown> = {}, beforeCommit?: (audience: readonly string[]) => void): Promise<void> {
    if (!this.textChannel(bot.orgId, channelId)) return;
    const payload: Payload = {
      ...extra,
      type: "edit",
      target: messageId,
      text,
    };
    await sendServerMessage(
      this.ctx,
      { userId: bot.userId, deviceId: null, channelGrant: channelId, beforeCommit },
      {
        conversationId: channelId,
        messageId: newId("m"),
        cls: "control",
        sentAt: this.clock(),
        payload,
      },
      this.ctx.log,
    );
  }

  // ───────────── Seams for other modules ─────────────

  /** The lobby's Levels board (organizations/lobby/boards.ts): the most XP first, while Levels is on. */
  levelsTop(orgId: string, limit: number): { userId: string; count: number }[] {
    if (!this.enabled || !this.rows.bot(orgId, "levels")?.enabled) return [];
    return this.ctx.ws
      .all<LevelRow>("bot_levels", {
        where: { org_id: orgId },
        orderBy: [
          ["xp", "desc"],
          ["user_id", "asc"],
        ],
        limit,
      })
      .map((r) => ({ userId: r.user_id, count: r.xp }));
  }

  /**
   * Reacts with [emoji] as [bot] on a message, when it is in that channel and may react there like anyone (otherwise
   * nothing: the reaction is a nicety).
   */
  async react(bot: ActiveBot, conversationId: string, target: string, emoji: string): Promise<void> {
    const conv = this.ctx.authz.conversation(conversationId);
    if (!conv || !this.ctx.authz.isMember(conv.id, bot.userId) || !this.ctx.authz.canReact(conv, bot.userId)) return;
    const payload: Payload = { type: "reaction", target, emoji, add: true };
    await sendServerMessage(
      this.ctx,
      { userId: bot.userId, deviceId: null },
      {
        conversationId,
        messageId: newId("m"),
        cls: "control",
        sentAt: this.clock(),
        payload,
      },
      this.ctx.log,
    ).catch(() => undefined);
  }

  /** The lobby's running giveaways (organizations/lobby/view.ts) in channels [viewerId] can see, ending first first. */
  giveaways(orgId: string, viewerId: string): { id: string; title: string; endsAt: number; entrants: number }[] {
    return this.enabled ? runningGiveaways(this, orgId, viewerId) : [];
  }

  /** Account deletion: their XP, away notes and Wordy games. */
  async deleteForUser(userId: string): Promise<void> {
    await this.rows.forgetUser(userId);
  }
}
