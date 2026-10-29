import type { AppContext } from "../../app/context.js";
import type { BotSettings, LiveBotKey } from "../../shared/contracts/http/officialBots.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { namesOf } from "../accounts/index.js";
import { sendServerMessage } from "../messaging/index.js";
import { catalogEntry } from "./catalog.js";
import { handle } from "./dispatch.js";
import { type BotEvent, fromAudit, fromMessage, type NotedAudit, type NotedMessage } from "./events.js";
import { effectiveSettings, isLiveBot, storedSettings } from "./settings.js";
import { BotRows, type LevelRow } from "./store.js";

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
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly ctx: AppContext,
    readonly enabled: boolean,
    readonly clock: () => number = Date.now,
  ) {
    this.rows = new BotRows(ctx);
  }

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Official bots are switched off for now. Try again later.");
  }

  /** Whether [orgId] has Bots+ now. */
  hasPlus(orgId: string): boolean {
    const p = this.rows.plus(orgId);
    return !!p && (p.expires_at === null || p.expires_at > this.clock());
  }

  /** Bots+ for [orgId] as the Platform Admin Console shows it. */
  plusGrant(orgId: string): { enabled: boolean; grantedAt: number | null; expiresAt: number | null; grantedBy: string | null; reason: string | null } {
    const p = this.rows.plus(orgId);
    return { enabled: this.hasPlus(orgId), grantedAt: p?.granted_at ?? null, expiresAt: p?.expires_at ?? null, grantedBy: p?.granted_by ?? null, reason: p?.reason ?? null };
  }

  /**
   * Grants Bots+ to [orgId] until [expiresAt] (null: no end), or takes it away ([grant] null). Platform admins do this
   * while billing for Bots+ is off; settings using Plus extras are kept either way and apply again when it's back.
   */
  async setPlus(orgId: string, grant: { by: string; expiresAt: number | null; reason: string } | null): Promise<void> {
    await this.rows.setPlus(grant ? { org_id: orgId, granted_by: grant.by, granted_at: this.clock(), expires_at: grant.expiresAt, reason: grant.reason } : null, orgId);
  }

  /** The bots on in [orgId] whose account is still a member there. */
  active(orgId: string): ActiveBots {
    const plus = this.hasPlus(orgId);
    const out: ActiveBots = {};
    const rows = this.rows.bots(orgId).filter((r) => r.enabled === 1 && r.user_id && isLiveBot(r.bot_key) && this.ctx.authz.orgRole(orgId, r.user_id));
    const names = new Map(namesOf(this.ctx.identity, rows.map((r) => r.user_id!)).map((n) => [n.id, n.displayName]));
    for (const r of rows) {
      const key = r.bot_key as LiveBotKey;
      const settings = effectiveSettings(key, storedSettings(key, r.settings), plus);
      (out as Record<string, ActiveBot>)[key] = { key, orgId, userId: r.user_id!, name: names.get(r.user_id!) ?? catalogEntry(key).name, settings, plus };
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
    } catch (err) {
      this.ctx.log.warn({ err, bot: key, kind: ev.kind, orgId: ev.orgId }, "official bots: a bot failed");
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
    const payload: Payload = { type: "text", text, ...(mentions.length ? { mentions: [...new Set(mentions)] } : {}) };
    const sent = await sendServerMessage(this.ctx, { userId: bot.userId, deviceId: null }, { conversationId, messageId: newId("m"), cls: "message", sentAt: this.clock(), payload }, this.ctx.log);
    return sent.messageId;
  }

  /** A live text channel of [orgId], or null. */
  textChannel(orgId: string, channelId: string | null): string | null {
    const c = channelId ? this.ctx.authz.conversation(channelId) : undefined;
    return c && c.type === "CHANNEL" && c.org_id === orgId && !c.archived_at && c.voice !== 1 && (c.format ?? "text") === "text" ? c.id : null;
  }

  /** Posts [payload] as [bot] in the channel a manager picked for it (checked here to still be a text channel). */
  async post(bot: ActiveBot, channelId: string | null, payload: Payload): Promise<{ messageId: string; channelId: string } | null> {
    const id = this.textChannel(bot.orgId, channelId);
    if (!id) return null;
    const sent = await sendServerMessage(this.ctx, { userId: bot.userId, deviceId: null, channelGrant: id }, { conversationId: id, messageId: newId("m"), cls: "message", sentAt: this.clock(), payload }, this.ctx.log);
    return { messageId: sent.messageId, channelId: id };
  }

  /** Changes the text of [bot]'s own post in a channel it was given. */
  async editPost(bot: ActiveBot, channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.textChannel(bot.orgId, channelId)) return;
    const payload: Payload = { type: "edit", target: messageId, text };
    await sendServerMessage(this.ctx, { userId: bot.userId, deviceId: null, channelGrant: channelId }, { conversationId: channelId, messageId: newId("m"), cls: "control", sentAt: this.clock(), payload }, this.ctx.log);
  }

  // ───────────── Seams for other modules ─────────────

  /** The lobby's Levels board (organizations/lobby/boards.ts): the most XP first, while Levels is on. */
  levelsTop(orgId: string, limit: number): { userId: string; count: number }[] {
    if (!this.enabled || !this.rows.bot(orgId, "levels")?.enabled) return [];
    return this.ctx.ws.all<LevelRow>("bot_levels", { where: { org_id: orgId }, orderBy: [["xp", "desc"], ["user_id", "asc"]], limit }).map((r) => ({ userId: r.user_id, count: r.xp }));
  }

  /** The lobby's running giveaways (organizations/lobby/view.ts): the Giveaways bot (part 2) fills this. */
  giveaways(_orgId: string): { id: string; title: string; endsAt: number; entrants: number }[] {
    return [];
  }

  /** Account deletion: their XP and away notes. */
  async deleteForUser(userId: string): Promise<void> {
    await this.rows.forgetUser(userId);
  }
}
