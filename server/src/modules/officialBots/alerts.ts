import type { z } from "zod/v4";
import type { AlertWatch, AlertWatchBody, AlertWatchPatch, AlertWatches } from "../../shared/contracts/http/officialBotTools.js";
import { BOT_LIMITS } from "../../shared/contracts/http/officialBots.js";
import { ApiError, badRequest, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { activeRoleName } from "../organizations/index.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import { parseChannelRef, type Upload } from "./youtube.js";

/** Meldiq's line for a new upload, until a community writes its own. */
export const DEFAULT_ALERT = "{role} 📣 {creator} just posted a new video: {title}\n{url}";
/** Video ids remembered per followed channel (more than one check ever returns). */
const SEEN_MAX = 50;

/** A YouTube channel a community follows (bot_alert_watches, migration 076). */
export interface WatchRow {
  id: string;
  org_id: string;
  source: string;
  yt_channel_id: string;
  creator: string;
  uploads_id: string;
  channel_id: string;
  role_id: string | null;
  message: string | null;
  /** JSON: the newest video ids already handled. */
  seen: string;
  checked_at: number | null;
  created_by: string;
  created_at: number;
}

type Watch = z.infer<typeof AlertWatch>;

/** A watch's line with its placeholders filled; {role} is the role's mention, or nothing. */
export function fillAlert(template: string, v: { creator: string; title: string; url: string; role: string | null }): string {
  const role = v.role ? `@${v.role}` : "";
  const withRole = v.role && !template.includes("{role}") ? `${role} ${template}` : template;
  return withRole
    .replaceAll("{creator}", v.creator)
    .replaceAll("{title}", v.title)
    .replaceAll("{url}", v.url)
    .replaceAll("{role}", role)
    .replace(/^[ \t]+/gm, "")
    .trim();
}

/** How many channels [orgId] may follow now. */
const limitFor = (rt: OfficialBots, orgId: string) => (rt.hasPlus(orgId) ? BOT_LIMITS.alertWatches.plus : BOT_LIMITS.alertWatches.free);

/** [orgId]'s watches, oldest first: without Bots+ only the first three are checked. */
function watchesOf(rt: OfficialBots, orgId: string): WatchRow[] {
  return rt.ctx.ws.all<WatchRow>("bot_alert_watches", { where: { org_id: orgId }, orderBy: [["created_at", "asc"], ["id", "asc"]] });
}

/**
 * Settings › Bots › Alerts (community parity batch D part 2): the YouTube channels a community follows, where each
 * one's uploads go, the role pinged and the line. People who can edit the community manage them; a server without a
 * YouTube API key refuses (503 alerts_unconfigured).
 */
export class AlertWatchManager {
  constructor(private readonly rt: OfficialBots) {}

  private requireEditor(orgId: string, userId: string, needsYoutube = true): void {
    this.rt.requireEnabled();
    this.rt.ctx.authz.requirePermission(orgId, userId, "workspace.edit", "Your role doesn't include changing the community's bots");
    if (needsYoutube && !this.rt.videoSource) throw new ApiError(503, "alerts_unconfigured", "Alerts needs a YouTube API key on this server.");
  }

  private view(w: WatchRow, active: boolean): Watch {
    return { id: w.id, source: w.source, youtubeChannelId: w.yt_channel_id, creator: w.creator, channelId: w.channel_id, roleId: w.role_id, message: w.message, checkedAt: w.checked_at, createdAt: w.created_at, active };
  }

  private views(orgId: string): Watch[] {
    const limit = limitFor(this.rt, orgId);
    return watchesOf(this.rt, orgId).map((w, i) => this.view(w, i < limit));
  }

  private one(orgId: string, watchId: string): { watch: Watch } {
    const watch = this.views(orgId).find((w) => w.id === watchId);
    if (!watch) throw notFound("No such YouTube channel here");
    return { watch };
  }

  /** The post channel must be a text channel of the community the editor can see; the role an active one of it. */
  private check(orgId: string, userId: string, channelId: string | undefined, roleId: string | null | undefined): void {
    const { authz } = this.rt.ctx;
    if (channelId !== undefined) {
      const conv = this.rt.textChannel(orgId, channelId) ? authz.conversation(channelId) : undefined;
      if (!conv || !authz.canViewChannel(conv, userId)) throw new ApiError(400, "official_bot_channel_invalid", "Pick a text channel of this community that you can see.", { field: "channelId", channelId });
    }
    if (roleId && !authz.roleGrant(roleId, orgId)) throw badRequest("Pick a role of this community to ping", { field: "roleId" });
  }

  list(orgId: string, userId: string): z.infer<typeof AlertWatches> {
    this.requireEditor(orgId, userId);
    return { watches: this.views(orgId), limit: limitFor(this.rt, orgId), defaultMessage: DEFAULT_ALERT };
  }

  async add(orgId: string, userId: string, body: z.infer<typeof AlertWatchBody>): Promise<{ watch: Watch }> {
    this.requireEditor(orgId, userId);
    this.check(orgId, userId, body.channelId, body.roleId);
    const count = watchesOf(this.rt, orgId).length;
    const limit = limitFor(this.rt, orgId);
    if (count >= limit) {
      if (limit < BOT_LIMITS.alertWatches.plus) throw new ApiError(403, "bots_plus_required", `Follow more than ${limit} YouTube channels with Bots+.`, { bot: "alerts", settings: ["watches"] });
      throw new ApiError(409, "limit_reached", `A community can follow up to ${limit} YouTube channels.`, { limit });
    }
    const ref = parseChannelRef(body.source);
    const channel = ref ? await this.rt.videoSource!.channel(ref) : null;
    if (!channel) throw new ApiError(400, "alerts_source_unknown", "YouTube doesn't know that channel. Paste its link or @handle.");
    if (this.rt.ctx.ws.get("bot_alert_watches", { org_id: orgId, yt_channel_id: channel.id, channel_id: body.channelId })) throw conflict(`${channel.title} is posted in that channel already`);
    const row: WatchRow = {
      id: newId("aw"),
      org_id: orgId,
      source: body.source,
      yt_channel_id: channel.id,
      creator: channel.title,
      uploads_id: channel.uploadsId,
      channel_id: body.channelId,
      role_id: body.roleId ?? null,
      message: body.message ?? null,
      seen: "[]",
      checked_at: null,
      created_by: userId,
      created_at: this.rt.clock(),
    };
    await this.rt.ctx.ws.write((w) => w.insert("bot_alert_watches", { ...row }));
    this.rt.ctx.audit({ actorId: userId, orgId, action: "official_bot.update", target: "alerts", detail: `alerts: follow ${channel.title}` });
    return this.one(orgId, row.id);
  }

  async change(orgId: string, watchId: string, userId: string, patch: z.infer<typeof AlertWatchPatch>): Promise<{ watch: Watch }> {
    this.requireEditor(orgId, userId);
    const row = this.rt.ctx.ws.get<WatchRow>("bot_alert_watches", { id: watchId, org_id: orgId });
    if (!row) throw notFound("No such YouTube channel here");
    this.check(orgId, userId, patch.channelId, patch.roleId);
    const channelId = patch.channelId ?? row.channel_id;
    if (channelId !== row.channel_id && this.rt.ctx.ws.get("bot_alert_watches", { org_id: orgId, yt_channel_id: row.yt_channel_id, channel_id: channelId })) throw conflict(`${row.creator} is posted in that channel already`);
    const set = { channel_id: channelId, role_id: patch.roleId === undefined ? row.role_id : patch.roleId, message: patch.message === undefined ? row.message : patch.message };
    await this.rt.ctx.ws.write((w) => w.update("bot_alert_watches", { id: watchId }, set));
    this.rt.ctx.audit({ actorId: userId, orgId, action: "official_bot.update", target: "alerts", detail: `alerts: ${row.creator} changed` });
    return this.one(orgId, watchId);
  }

  async remove(orgId: string, watchId: string, userId: string): Promise<{ deleted: boolean }> {
    this.requireEditor(orgId, userId, false);
    const row = this.rt.ctx.ws.get<WatchRow>("bot_alert_watches", { id: watchId, org_id: orgId });
    if (!row) return { deleted: false };
    await this.rt.ctx.ws.write((w) => w.delete("bot_alert_watches", { id: watchId }));
    this.rt.ctx.audit({ actorId: userId, orgId, action: "official_bot.update", target: "alerts", detail: `alerts: unfollow ${row.creator}` });
    return { deleted: true };
  }
}

/** Posts [w]'s uploads published since it was added that weren't handled yet, oldest first (claimed before posting). */
async function checkWatch(rt: OfficialBots, bot: ActiveBot<"alerts">, w: WatchRow, uploads: readonly Upload[], at: number): Promise<number> {
  const seen = JSON.parse(w.seen) as string[];
  const fresh = uploads.filter((u) => u.publishedAt > w.created_at && !seen.includes(u.videoId)).sort((a, b) => a.publishedAt - b.publishedAt);
  const remembered = [...fresh.map((u) => u.videoId).reverse(), ...seen].slice(0, SEEN_MAX);
  await rt.ctx.ws.write((x) => x.update("bot_alert_watches", { id: w.id }, { seen: JSON.stringify(remembered), checked_at: at }));
  const role = w.role_id ? activeRoleName(rt.ctx, w.org_id, w.role_id) : null;
  for (const u of fresh) {
    const text = fillAlert(w.message ?? DEFAULT_ALERT, { creator: w.creator, title: u.title, url: `https://www.youtube.com/watch?v=${u.videoId}`, role });
    await rt.post(bot, w.channel_id, { type: "text", text, ...(role ? { roleMentions: [w.role_id] } : {}) });
  }
  return fresh.length;
}

/** Every ten minutes (scheduler.ts): each community with Alerts on, each channel it may follow now. */
export async function checkAlerts(rt: OfficialBots, at: number): Promise<number> {
  const source = rt.videoSource;
  if (!rt.enabled || !source) return 0;
  let posted = 0;
  const orgs = rt.ctx.ws.all<{ org_id: string }>("official_bots", { where: { bot_key: "alerts", enabled: 1 } }).map((r) => r.org_id);
  for (const orgId of orgs) {
    const bot = rt.active(orgId).alerts;
    if (!bot) continue;
    for (const w of watchesOf(rt, orgId).slice(0, limitFor(rt, orgId))) {
      try {
        posted += await checkWatch(rt, bot, w, await source.uploads(w.uploads_id), at);
      } catch (err) {
        rt.ctx.log.warn({ err, watchId: w.id, orgId }, "official bots: a YouTube channel wasn't checked");
      }
    }
  }
  return posted;
}
