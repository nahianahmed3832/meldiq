import type { FastifyRequest } from "fastify";
import type { z } from "zod/v4";
import {
  BOT_SETTINGS,
  type BotSettings,
  type CommunityOfficialBots,
  type LiveBotKey,
  OFFICIAL_BOT_KEYS,
  type OfficialBotBody,
  type OfficialBotKey,
  type OfficialBotView,
} from "../../shared/contracts/http/officialBots.js";
import { ApiError, badRequest } from "../../shared/errors.js";
import { personCards, readJpegBody, renameBotIdentity, setBotPhoto } from "../accounts/index.js";
import { addBotMember, botRoleGivableBy, removeBotMember } from "../organizations/index.js";
import { catalogEntry } from "./catalog.js";
import { RESERVED_COMMANDS } from "./commands.js";
import { privateLoggerChannel } from "./logger.js";
import type { OfficialBots } from "./runtime.js";
import { isLiveBot, plusFeatures, storedSettings } from "./settings.js";
import type { BotRow } from "./store.js";
import { saveTicketsSettings, ticketsPlusPaused, ticketsSettingsView } from "./ticketsBot.js";
import { welcome, welcomeChannel } from "./welcomer.js";

type View = z.infer<typeof OfficialBotView>;
type Body = z.infer<typeof OfficialBotBody>;

/** Settings fields that name channels: each must be a text channel of the community its editor can see. */
const CHANNEL_FIELDS = ["channelId", "memberChannelId", "announceChannelId", "excludeChannelIds"] as const;

const unavailable = (reason: string) => new ApiError(409, "official_bot_unavailable", `This bot can't be turned on here: ${reason.toLowerCase()}.`);

/**
 * The Bots page and each bot's detail window (community parity batch D): what's on in a community, turning bots on and
 * off, their settings (Plus extras only with Bots+) and their look in the community. Changing anything needs the Edit
 * community permission and is in the audit log.
 */
export class BotManager {
  constructor(private readonly rt: OfficialBots) {}

  private get ctx() {
    return this.rt.ctx;
  }

  private view(orgId: string, key: OfficialBotKey, editor: boolean, plus: boolean): View {
    const row = this.rt.rows.bot(orgId, key);
    const reason = this.rt.unavailableReason(key);
    const live = isLiveBot(key) && reason === null;
    const card = row?.user_id ? personCards(this.ctx, [row.user_id]).get(row.user_id) : undefined;
    const settings = live ? storedSettings(key, row?.settings) : null;
    const tickets = key === "tickets" && live;
    return {
      key,
      name: catalogEntry(key).name,
      available: live,
      unavailableReason: reason,
      // The Tickets bot is the community's tickets switch.
      enabled: live && (tickets ? this.ctx.tickets.settings(orgId)?.enabled === 1 : row?.enabled === 1),
      userId: row?.user_id ?? null,
      look: { name: row?.look_name ?? null, displayName: card?.displayName ?? row?.look_name ?? catalogEntry(key).name, photoRev: card?.photoRev ?? null },
      settings: editor && settings ? (tickets ? ticketsSettingsView(this.rt, orgId) : (settings as Record<string, unknown>)) : null,
      plusPaused: live && settings && !plus ? (tickets ? ticketsPlusPaused(this.rt, orgId) : plusFeatures(key, settings)) : [],
      updatedAt: row?.updated_at ?? null,
    };
  }

  private canEdit(orgId: string, userId: string): boolean {
    return this.ctx.authz.can(orgId, userId, "workspace.edit");
  }

  list(orgId: string, userId: string): z.infer<typeof CommunityOfficialBots> {
    this.rt.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    const plus = this.rt.hasPlus(orgId);
    const editor = this.canEdit(orgId, userId);
    return { botsPlus: plus, botsPlusUntil: plus ? this.rt.plusGrant(orgId).expiresAt : null, canEdit: editor, bots: OFFICIAL_BOT_KEYS.map((k) => this.view(orgId, k, editor, plus)) };
  }

  one(orgId: string, key: OfficialBotKey, userId: string): { bot: View } {
    this.rt.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    return { bot: this.view(orgId, key, this.canEdit(orgId, userId), this.rt.hasPlus(orgId)) };
  }

  private requireEditor(orgId: string, userId: string, key: OfficialBotKey): asserts key is LiveBotKey {
    this.rt.requireEnabled();
    this.ctx.authz.requirePermission(orgId, userId, "workspace.edit", "Your role doesn't include changing the community's bots");
    const reason = this.rt.unavailableReason(key);
    if (!isLiveBot(key) || reason) throw unavailable(reason ?? "coming soon");
  }

  private account(orgId: string, key: LiveBotKey, actorId: string, lookName: string | null): Promise<string> {
    return this.rt.ensureAccount(orgId, key, actorId, lookName);
  }

  /** Checks the settings sent (merged over the stored ones): their shape, Plus extras, channels and roles. */
  private mergeSettings(orgId: string, key: LiveBotKey, userId: string, before: BotSettings<LiveBotKey>, sent: Record<string, unknown>): BotSettings<LiveBotKey> {
    const schema = BOT_SETTINGS[key];
    const parsed = schema.safeParse({ ...before, ...sent });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`Bot settings: ${issue?.path.join(".") || "settings"}: ${issue?.message ?? "not valid"}`, { field: issue?.path.join(".") ?? null });
    }
    const next = parsed.data as BotSettings<LiveBotKey>;
    const plusOnly = plusFeatures(key, next).filter((f) => f in sent);
    if (plusOnly.length && !this.rt.hasPlus(orgId)) {
      throw new ApiError(403, "bots_plus_required", "That's a Bots+ extra. This community needs Bots+ to use it.", { bot: key, settings: plusOnly });
    }
    const n = next as Record<string, unknown>;
    for (const field of CHANNEL_FIELDS.filter((f) => f in sent && f in n)) {
      const ids = ([] as unknown[]).concat(n[field] ?? []).filter((x): x is string => typeof x === "string");
      for (const id of ids) {
        const conv = this.rt.textChannel(orgId, id) ? this.ctx.authz.conversation(id) : undefined;
        if (!conv || !this.ctx.authz.canViewChannel(conv, userId)) {
          throw new ApiError(400, "official_bot_channel_invalid", "Pick a text channel of this community that you can see.", { field, channelId: id });
        }
        if (key === "logger" && (field === "channelId" || field === "memberChannelId") && !privateLoggerChannel(this.rt, orgId, id))
          throw new ApiError(400, "official_bot_channel_invalid", "Choose a private text channel for Logger.", { field, channelId: id });
      }
    }
    if (key === "giveaways" && "requiredRoleId" in sent) {
      const roleId = (next as BotSettings<"giveaways">).requiredRoleId;
      if (roleId && !this.ctx.authz.roleGrant(roleId, orgId)) throw badRequest("Pick a role of this community", { field: "requiredRoleId" });
    }
    if (key === "levels" && "roleRewards" in sent) {
      const rewards = (next as BotSettings<"levels">).roleRewards;
      if (new Set(rewards.map((r) => r.roleId)).size !== rewards.length) throw badRequest("Each role can be a reward for one level", { field: "roleRewards" });
      const bad = rewards.find((r) => !botRoleGivableBy(this.ctx, orgId, userId, r.roleId));
      if (bad) throw new ApiError(403, "bot_role_not_givable", "Bots can only give roles that are just for show, or that you could assign yourself without administrative powers.", { roleId: bad.roleId });
    }
    if (key === "helper" && "commands" in sent) {
      const names = (next as BotSettings<"helper">).commands.map((c) => c.name);
      const clash = names.find((x, i) => RESERVED_COMMANDS.has(x) || names.indexOf(x) !== i);
      if (clash) throw badRequest(`!${clash} is taken: pick another name`, { field: "commands", name: clash });
    }
    return next;
  }

  /** Turns a bot on or off, changes its settings and its name in [orgId]. */
  async update(orgId: string, key: OfficialBotKey, userId: string, body: Body): Promise<{ bot: View }> {
    this.requireEditor(orgId, userId, key);
    const row = this.rt.rows.bot(orgId, key);
    const before = storedSettings(key, row?.settings);
    const tickets = key === "tickets";
    const settings = !body.settings ? before : tickets ? await saveTicketsSettings(this.rt, orgId, userId, body.settings) : this.mergeSettings(orgId, key, userId, before, body.settings);
    const lookName = body.look ? body.look.name : (row?.look_name ?? null);
    // The Tickets bot is on while the community takes tickets (Settings › Tickets is the same switch).
    const wasOn = row?.enabled === 1 || (tickets && this.ctx.tickets.settings(orgId)?.enabled === 1);
    const on = body.enabled ?? wasOn;
    const needsAccount = on || body.look !== undefined || !!row?.user_id;
    const accountId = needsAccount ? await this.account(orgId, key, userId, lookName) : null;
    if (accountId && body.look && lookName !== (row?.look_name ?? null)) await renameBotIdentity(this.ctx, accountId, lookName ?? catalogEntry(key).name);
    // On: in the community first (a ban or the member limit refuses it, and nothing is saved).
    if (on && accountId) await addBotMember(this.ctx, orgId, accountId, userId);
    const current = this.rt.rows.bot(orgId, key);
    const next: BotRow = { org_id: orgId, bot_key: key, enabled: on ? 1 : 0, settings: JSON.stringify(settings), look_name: lookName, user_id: current?.user_id ?? accountId, updated_by: userId, updated_at: this.rt.clock() };
    await this.rt.rows.save(next);
    if (tickets && on !== wasOn) await this.ctx.tickets.setSwitch(orgId, on, userId);
    if (!on && wasOn && accountId) await removeBotMember(this.ctx, orgId, accountId, userId);
    const changed = [
      ...(on !== wasOn ? [on ? "on" : "off"] : []),
      ...(body.settings ? [`settings ${Object.keys(body.settings).join(",")}`] : []),
      ...(body.look ? [`name ${lookName ?? "(standard)"}`] : []),
    ];
    if (changed.length) {
      const action = on !== wasOn ? (on ? "official_bot.on" : "official_bot.off") : "official_bot.update";
      this.ctx.audit({ actorId: userId, orgId, action, target: key, detail: `${key}: ${changed.join("; ")}` });
    }
    return this.one(orgId, key, userId);
  }

  /** The bot's picture in [orgId] (a JPEG), or back to the standard one. */
  async setAvatar(orgId: string, key: OfficialBotKey, userId: string, req: FastifyRequest | null): Promise<{ bot: View }> {
    this.requireEditor(orgId, userId, key);
    const jpeg = req ? await readJpegBody(req, "Bot pictures") : null;
    const accountId = await this.account(orgId, key, userId, this.rt.rows.bot(orgId, key)?.look_name ?? null);
    await setBotPhoto(this.ctx, accountId, jpeg);
    this.ctx.audit({ actorId: userId, orgId, action: "official_bot.update", target: key, detail: `${key}: ${jpeg ? "picture" : "picture removed"}` });
    return this.one(orgId, key, userId);
  }

  /** "Send a test": Welcomer greets the caller in its channel, as it would a newcomer. */
  async testWelcome(orgId: string, userId: string): Promise<{ messageId: string; channelId: string }> {
    this.requireEditor(orgId, userId, "welcomer");
    const bot = this.rt.active(orgId).welcomer;
    if (!bot) throw new ApiError(409, "official_bot_off", "Turn Welcomer on first.");
    if (!welcomeChannel(this.rt, orgId, bot.settings.channelId)) throw new ApiError(400, "official_bot_channel_invalid", "Pick a channel for Welcomer first.", { field: "channelId", channelId: null });
    const sent = await welcome(this.rt, bot, userId);
    if (!sent) throw new ApiError(400, "official_bot_channel_invalid", "Pick a channel for Welcomer first.", { field: "channelId", channelId: null });
    return sent;
  }
}
