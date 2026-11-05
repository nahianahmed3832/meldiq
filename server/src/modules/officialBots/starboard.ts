import { botsAmong } from "../accounts/index.js";
import { memberIds } from "../messaging/index.js";
import { publicTextChannel } from "../organizations/index.js";
import type { ReactionChanged } from "./events.js";
import { unping } from "./logger.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import type { StarRow } from "./store.js";
import type { StoredEvent } from "../../shared/contracts/http/serverMessages.js";
import { MessageAttachment } from "../../shared/contracts/attachments.js";
import type { z } from "zod/v4";

/** The star emoji everyone may use; a community with Bots+ may pick its own instead. */
export const STAR_EMOJI: readonly string[] = ["⭐", "🌟"];
const TEXT_MAX = 1500;

interface Original {
  id: string;
  channelId: string;
  author: string;
  serverTs: number;
  payload: Record<string, unknown>;
}

class StarboardScopeChanged extends Error {}

type Image = z.infer<typeof MessageAttachment>;
function uploadedImage(payload: Record<string, unknown>): Image | null {
  for (const raw of Array.isArray(payload.attachments) ? payload.attachments : []) {
    const file = MessageAttachment.safeParse(raw);
    if (file.success && file.data.mime.toLowerCase().startsWith("image/")) return file.data;
  }
  return null;
}

function sourceImage(payload: string): Image | null {
  try {
    return uploadedImage(JSON.parse(payload));
  } catch {
    return null;
  }
}

function mayReadSource(rt: OfficialBots, source: NonNullable<ReturnType<OfficialBots["ctx"]["authz"]["conversation"]>>, id: string, serverTs: number): boolean {
  if (!source.org_id || !rt.ctx.authz.isMember(source.id, id)) return false;
  // A permission write can precede membership reconciliation for ordinary channel members.
  if (rt.ctx.authz.orgRole(source.org_id, id) !== "GUEST" && !rt.ctx.authz.scopeEligible(source, id)) return false;
  const since = rt.ctx.authz.historySince(source, id);
  return since === null || serverTs >= since;
}

/** Preserve a page's order/cursor while withholding a copy and its old edits from an unauthorized reader. */
export async function protectStarboardHistory(rt: OfficialBots, viewer: string, messages: StoredEvent[], changes: StoredEvent[] = []) {
  const hidden = new Set<string>();
  const images = new Map<string, Image>();
  const copies: { event: StoredEvent; row: StarRow }[] = [];
  for (const event of messages) {
    const origin = event.payload.starboard;
    if (origin === undefined || event.senderDeviceId !== null || event.importedBy != null) continue;
    const bot = rt.rows.byAccount(event.senderUserId);
    if (bot?.bot_key !== "starboard") continue;
    const pointer = origin && typeof origin === "object" && !Array.isArray(origin) ? origin as Record<string, unknown> : null;
    const row = typeof pointer?.messageId === "string" ? rt.ctx.ws.get<StarRow>("bot_starboard", { message_id: pointer.messageId }) : undefined;
    if (!row || row.star_message_id !== event.id || row.star_channel_id !== event.conversationId || row.channel_id !== pointer?.channelId || row.org_id !== bot.org_id) hidden.add(event.id);
    else copies.push({ event, row });
  }
  if (copies.length) {
    const ids = [...new Set(copies.map(({ row }) => row.message_id))];
    const origins = await rt.ctx.messages.activeOrigins(ids);
    const originalById = new Map(origins.map((o) => [o.id, o]));
    const visibleOrigin = (event: StoredEvent, row: StarRow) => {
      const origin = originalById.get(row.message_id);
      const source = rt.ctx.authz.conversation(row.channel_id);
      return origin && origin.conversation_id === row.channel_id && origin.sender_user_id !== event.senderUserId
        && publicTextChannel(rt.ctx, source, row.org_id) && rt.ctx.authz.isMember(row.star_channel_id, viewer)
        && mayReadSource(rt, source, viewer, origin.server_ts) ? origin : null;
    };
    const candidates = new Map<string, Image>();
    for (const { event, row } of copies) {
      const origin = visibleOrigin(event, row);
      const image = origin ? sourceImage(origin.payload) : null;
      if (image) candidates.set(event.id, image);
    }
    const fileIds = [...new Set([...candidates.values()].flatMap((image) => [image.id, ...(image.thumbnail ? [image.thumbnail.id] : [])]))];
    const files = new Map((fileIds.length ? await rt.ctx.files.attachmentRows(fileIds) : []).map((file) => [file.id, file]));
    if (fileIds.length) {
      // Access or deletion can change while checking storage. Check the original again before returning any bytes or keys.
      const fresh = await rt.ctx.messages.activeOrigins(ids);
      originalById.clear();
      for (const origin of fresh) originalById.set(origin.id, origin);
    }
    const at = rt.clock();
    const usable = (sourceId: string, ref: Omit<Image, "thumbnail">) => {
      const file = files.get(ref.id);
      const size = ref.size + (ref.chunk ? 16 * Math.max(1, Math.ceil(ref.size / ref.chunk)) : 16);
      return !!file && file.conversation_id === sourceId && file.pending_message_until == null && file.expires_at > at
        && file.size === size && (file.sha256 == null || file.sha256 === ref.sha256);
    };
    for (const { event, row } of copies) {
      if (!visibleOrigin(event, row)) {
        hidden.add(event.id);
        continue;
      }
      const image = candidates.get(event.id);
      if (!image || !usable(row.channel_id, image)) continue;
      const { thumbnail, ...ref } = image;
      images.set(event.id, thumbnail && usable(row.channel_id, thumbnail) ? image : ref);
    }
  }
  if (!hidden.size && !images.size && !copies.some(({ event }) => event.payload.attachments !== undefined)) return { messages, changes };
  const copyIds = new Set(copies.map(({ event }) => event.id));
  return {
    messages: messages.map((event) => {
      if (hidden.has(event.id)) return { ...event, mentionAll: false, payload: { type: "text", text: "Original message unavailable." } };
      const image = images.get(event.id);
      if (!copyIds.has(event.id) || (!image && event.payload.attachments === undefined)) return event;
      const { attachments: _stored, ...payload } = event.payload;
      return { ...event, payload: image ? { ...payload, attachments: [image] } : payload };
    }),
    changes: changes.filter(({ payload }) => typeof payload.target !== "string" || !hidden.has(payload.target) || payload.type === "delete"),
  };
}

/** A public label can coexist with individual/category restrictions or a recent-join history boundary. */
function mayMirror(rt: OfficialBots, bot: ActiveBot<"starboard">, o: Original, destination: string, prepared: readonly string[] = []): boolean {
  const current = rt.active(bot.orgId).starboard;
  if (!current || current.userId !== bot.userId || current.settings.channelId !== destination || current.settings.excludeChannelIds.includes(o.channelId)) return false;
  if (current.settings.threshold !== bot.settings.threshold || current.settings.emoji !== bot.settings.emoji || current.settings.selfStar !== bot.settings.selfStar) return false;
  const source = rt.ctx.authz.conversation(o.channelId);
  if (!publicTextChannel(rt.ctx, source, bot.orgId) || !rt.textChannel(bot.orgId, destination)) return false;
  const readers = [...new Set([...memberIds(rt.ctx, destination), ...prepared])];
  return readers.length > 0 && readers.every((id) => mayReadSource(rt, source, id, o.serverTs));
}

function mirrorGuard(rt: OfficialBots, bot: ActiveBot<"starboard">, o: Original, destination: string): (audience: readonly string[]) => void {
  return (audience) => {
    if (!mayMirror(rt, bot, o, destination, audience)) throw new StarboardScopeChanged();
  };
}

/**
 * Who stars [messageId] now: everyone whose latest reaction with a star emoji is still on (people, not bots), without
 * its author unless self-stars are allowed.
 */
async function starrers(rt: OfficialBots, bot: ActiveBot<"starboard">, o: Original, emoji: readonly string[], ev: ReactionChanged): Promise<number> {
  const on = new Map<string, boolean>();
  for (const r of await rt.ctx.messages.changesTo(o.channelId, o.id, "reaction")) {
    // Resolve the reaction state at this queued event, even when later reactions arrived while a bot was busy.
    if (r.server_ts > ev.at || (r.server_ts === ev.at && r.id > ev.eventId)) continue;
    const p = JSON.parse(r.payload) as { emoji?: unknown; add?: unknown };
    if (typeof p.emoji === "string" && emoji.includes(p.emoji)) on.set(`${r.sender_user_id}|${p.emoji}`, p.add !== false);
  }
  const people = new Set([...on].filter(([, yes]) => yes).map(([k]) => k.split("|")[0]!));
  if (!bot.settings.selfStar) people.delete(o.author);
  for (const b of botsAmong(rt.ctx, people)) people.delete(b);
  return people.size;
}

/** The starboard post's text: the star count line, then the message. */
function postText(rt: OfficialBots, o: Original, emoji: string, stars: number): string {
  const channel = rt.ctx.authz.conversation(o.channelId)?.name ?? "a channel";
  const text = typeof o.payload.text === "string" ? unping(rt, o.payload.text, o.payload.mentions) : "";
  const body = [...text].length > TEXT_MAX ? `${[...text].slice(0, TEXT_MAX - 1).join("")}…` : text;
  return `${emoji} ${stars} · ${rt.nameOf(o.author)} in #${channel}${body ? `\n${body}` : ""}`;
}

/** Native uploads are projected on read from the original, never published into another channel. */
function externalImage(payload: Record<string, unknown>): { embeds?: unknown[] } {
  if (uploadedImage(payload)) return {};
  const embeds = Array.isArray(payload.embeds) ? (payload.embeds as { image?: { url?: unknown } }[]) : [];
  const url = embeds.find((e) => typeof e?.image?.url === "string")?.image?.url;
  return typeof url === "string" ? { embeds: [{ image: { url } }] } : {};
}

/** Copies a message to the starboard once (its text, author, channel, a way back and its first picture). */
async function copy(rt: OfficialBots, bot: ActiveBot<"starboard">, o: Original, emoji: string, stars: number, at: number): Promise<void> {
  const starChannel = bot.settings.channelId!;
  // Claimed first, so a message never goes up twice, however the stars arrive.
  const claimed = await rt.ctx.ws.write((w) => {
    if (!mayMirror(rt, bot, o, starChannel)) return false;
    if (w.get("bot_starboard", { message_id: o.id })) return false;
    w.insert("bot_starboard", {
      message_id: o.id,
      org_id: bot.orgId,
      channel_id: o.channelId,
      star_channel_id: starChannel,
      star_message_id: null,
      stars,
      created_at: at,
    });
    return true;
  });
  if (!claimed) return;
  const origin = rt.ctx.config.webOrigins[0];
  const link = origin ? `${origin}/m/${o.channelId}/${o.id}` : null;
  const sent = await rt.post(bot, starChannel, {
    type: "text",
    text: postText(rt, o, emoji, stars),
    starboard: { channelId: o.channelId, messageId: o.id },
    ...externalImage(o.payload),
    ...(link
      ? {
          buttons: [{ kind: "link", label: "Jump to message", emoji: null, url: link }],
        }
      : {}),
  }, mirrorGuard(rt, bot, o, starChannel)).catch((error: unknown) => {
    if (error instanceof StarboardScopeChanged) return null; // The acceptance guard ran before publication.
    throw error; // Preserve the claim when publication outcome is unknown.
  });
  if (sent) await rt.ctx.ws.write((w) => w.update("bot_starboard", { message_id: o.id }, { star_message_id: sent.messageId }));
  else await rt.ctx.ws.write((w) => w.delete("bot_starboard", { message_id: o.id, star_message_id: null }));
}

/**
 * A star went on or off a message: once enough people (not its author) star a message in a public channel, it is
 * copied to the starboard; after that, its count line follows the stars. The starboard channel itself, private
 * channels and (with Bots+) channels left out are skipped.
 */
export async function countStars(rt: OfficialBots, bot: ActiveBot<"starboard">, ev: ReactionChanged): Promise<void> {
  const s = bot.settings;
  const emoji = s.emoji ? [s.emoji] : STAR_EMOJI;
  if (!s.channelId || !emoji.includes(ev.emoji) || ev.conversationId === s.channelId || s.excludeChannelIds.includes(ev.conversationId)) return;
  if (!publicTextChannel(rt.ctx, rt.ctx.authz.conversation(ev.conversationId), bot.orgId)) return;
  const m = await rt.ctx.messages.get(ev.target);
  if (!m || m.conversation_id !== ev.conversationId || m.cls !== "message" || m.sender_user_id === bot.userId) return;
  const o: Original = {
    id: m.id,
    channelId: m.conversation_id,
    author: m.sender_user_id,
    serverTs: m.server_ts,
    payload: JSON.parse(m.payload) as Record<string, unknown>,
  };
  const stars = await starrers(rt, bot, o, emoji, ev);
  const known = rt.ctx.ws.get<StarRow>("bot_starboard", { message_id: o.id });
  if (!known) {
    if (stars >= s.threshold && (await rt.ctx.messages.activeOrigins([o.id])).length) await copy(rt, bot, o, emoji[0]!, stars, ev.at);
    return;
  }
  if (known.stars === stars || !known.star_message_id) return;
  if (!mayMirror(rt, bot, o, known.star_channel_id) || !(await rt.ctx.messages.activeOrigins([o.id])).length) return;
  try {
    await rt.editPost(bot, known.star_channel_id, known.star_message_id, postText(rt, o, emoji[0]!, stars), {}, mirrorGuard(rt, bot, o, known.star_channel_id));
  } catch (error) {
    if (error instanceof StarboardScopeChanged) return;
    throw error;
  }
  await rt.ctx.ws.write((w) => w.update("bot_starboard", { message_id: o.id }, { stars }));
}
