import { botsAmong } from "../accounts/index.js";
import { publicTextChannel } from "../organizations/index.js";
import type { ReactionChanged } from "./events.js";
import { unping } from "./logger.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import type { StarRow } from "./store.js";

/** The star emoji everyone may use; a community with Bots+ may pick its own instead. */
export const STAR_EMOJI: readonly string[] = ["⭐", "🌟"];
const TEXT_MAX = 1500;

interface Original {
  id: string;
  channelId: string;
  author: string;
  payload: Record<string, unknown>;
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

/** The first picture of the message: an image attachment, or a webhook box's image. */
function firstImage(payload: Record<string, unknown>): {
  attachments?: unknown[];
  embeds?: unknown[];
} {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const image = attachments.find((a) => typeof (a as { mime?: unknown })?.mime === "string" && (a as { mime: string }).mime.startsWith("image/"));
  if (image) return { attachments: [image] };
  const embeds = Array.isArray(payload.embeds) ? (payload.embeds as { image?: { url?: unknown } }[]) : [];
  const url = embeds.find((e) => typeof e?.image?.url === "string")?.image?.url;
  return typeof url === "string" ? { embeds: [{ image: { url } }] } : {};
}

/** Copies a message to the starboard once (its text, author, channel, a way back and its first picture). */
async function copy(rt: OfficialBots, bot: ActiveBot<"starboard">, o: Original, emoji: string, stars: number, at: number): Promise<void> {
  const starChannel = bot.settings.channelId!;
  // Claimed first, so a message never goes up twice, however the stars arrive.
  const claimed = await rt.ctx.ws.write((w) => {
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
    ...firstImage(o.payload),
    ...(link
      ? {
          buttons: [{ kind: "link", label: "Jump to message", emoji: null, url: link }],
        }
      : {}),
  });
  if (sent) await rt.ctx.ws.write((w) => w.update("bot_starboard", { message_id: o.id }, { star_message_id: sent.messageId }));
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
  if (!m || m.conversation_id !== ev.conversationId || m.cls !== "message") return;
  const o: Original = {
    id: m.id,
    channelId: m.conversation_id,
    author: m.sender_user_id,
    payload: JSON.parse(m.payload) as Record<string, unknown>,
  };
  const stars = await starrers(rt, bot, o, emoji, ev);
  const known = rt.ctx.ws.get<StarRow>("bot_starboard", { message_id: o.id });
  if (!known) {
    if (stars >= s.threshold) await copy(rt, bot, o, emoji[0]!, stars, ev.at);
    return;
  }
  if (known.stars === stars || !known.star_message_id) return;
  await rt.ctx.ws.write((w) => w.update("bot_starboard", { message_id: o.id }, { stars }));
  await rt.editPost(bot, known.star_channel_id, known.star_message_id, postText(rt, o, emoji[0]!, stars));
}
