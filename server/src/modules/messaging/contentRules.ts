import type { AppContext } from "../../app/context.js";
import type { SendMessage } from "../../shared/contracts/http/serverMessages.js";
import { ApiError, type ErrorCode } from "../../shared/errors.js";
import { type MessageEvent, threadRootOf } from "./store/messageStore.js";

/**
 * What a message may carry in a community channel (community parity A1, feature "community-permissions",
 * docs/COMMUNITY_PERMISSIONS.md): the channel permissions for links, voice messages, other communities' emoji, polls,
 * headings, new reactions, threads and role mentions, and the channel's options (text only, no GIFs). Its moderators
 * (managers and holders of `messages.manage`) aren't held to the options. Only POST /v2/messages can be checked: the
 * server reads those payloads.
 */

type Conv = NonNullable<ReturnType<AppContext["authz"]["conversation"]>>;
type Payload = SendMessage["payload"];

export interface Refusal {
  code: ErrorCode;
  message: string;
}

/** A web address in a message's text. */
const WEB_LINK = /\bhttps?:\/\/[^\s<>]+/gi;
/** GIF hosts and .gif files: what "no GIFs" keeps out besides the GIF picker. */
const GIF_LINK =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:tenor\.com|giphy\.com|gfycat\.com)(?:[/:?#]|$)|\.gif(?:[?#].*)?$/i;
/** A line written as a heading: "#", "##" or "###" then a space (markdown's own rule, up to three spaces first). */
const HEADING = /^ {0,3}#{1,3}[ \t]+\S/m;

/** What the rules read from a payload, whatever a modified app sent. */
export interface Content {
  text: string;
  link: boolean;
  poll: boolean;
  gifUrl: string | null;
  sticker: boolean;
  attachments: number;
  voice: boolean;
  /** Communities whose emoji or sticker it uses. */
  emojiOrgs: string[];
  threadRoot: string | null;
  roleMentions: string[];
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function readContent(p: Payload): Content {
  const attachments = list(p.attachments).map(obj);
  const emoji = [...list(p.customEmoji), p.customSticker]
    .map(obj)
    .flatMap((e) => (e && str(e.orgId) ? [str(e.orgId)!] : []));
  return {
    text: str(p.text) ?? "",
    link: !!obj(p.link),
    poll: !!obj(p.poll) || !!obj(p.managedPoll),
    gifUrl: obj(p.gif) ? (str(obj(p.gif)!.url) ?? "") : null,
    sticker: !!obj(p.sticker) || !!obj(p.customSticker),
    attachments: attachments.length,
    voice: attachments.some((a) => a?.voice === true),
    emojiOrgs: [...new Set(emoji)],
    threadRoot: str(p.threadRoot),
    roleMentions: list(p.roleMentions).flatMap((r) =>
      typeof r === "string" ? [r] : [],
    ),
  };
}

/** The web links in [text], leaving out a GIF's own address (the text of a GIF message is that address). */
export function linksIn(text: string, gifUrl: string | null): string[] {
  return (text.match(WEB_LINK) ?? []).filter((u) => u !== gifUrl);
}

export const isGifLink = (url: string): boolean => GIF_LINK.test(url);
export const hasHeading = (text: string): boolean => HEADING.test(text);

/** Who is sending, as the pure rules need it. */
export interface Sender {
  perms: ReadonlySet<string>;
  orgId: string;
  moderates: boolean;
  textOnly: boolean;
  noGifs: boolean;
}

const no = (code: ErrorCode, message: string): Refusal => ({ code, message });

/** The channel's options: moderators are never held to them. */
function optionRefusal(
  c: Content,
  s: Sender,
  isMessage: boolean,
): Refusal | null {
  if (s.moderates) return null;
  const gifLinks = linksIn(c.text, null).some(isGifLink);
  if (
    s.textOnly &&
    ((isMessage && (c.attachments > 0 || c.gifUrl !== null || c.sticker)) ||
      gifLinks)
  ) {
    return no(
      "text_only_channel",
      "This channel is for text only: no files, GIFs or stickers",
    );
  }
  if (s.noGifs && (c.gifUrl !== null || gifLinks))
    return no("gifs_not_allowed", "This channel doesn't take GIFs");
  return null;
}

/**
 * Pure: why a message (or, with [isMessage] false, an edit of one) may not be sent, or null. Threads and new reactions
 * need the stored history and are checked by [admitChannelContent].
 */
export function contentRefusal(
  c: Content,
  s: Sender,
  isMessage: boolean,
): Refusal | null {
  const option = optionRefusal(c, s, isMessage);
  if (option) return option;
  const lacks = (p: string) => !s.perms.has(p);
  if (
    (c.link || linksIn(c.text, c.gifUrl).length > 0) &&
    lacks("messages.embed")
  )
    return no("links_not_allowed", "You can't post links here");
  if (isMessage && c.voice && lacks("messages.voice"))
    return no(
      "voice_messages_not_allowed",
      "You can't send voice messages here",
    );
  if (
    c.emojiOrgs.some((o) => o !== s.orgId) &&
    lacks("messages.external_emoji")
  ) {
    return no(
      "external_emoji_not_allowed",
      "You can't use emoji or stickers from other communities here",
    );
  }
  if (isMessage && c.poll && lacks("messages.polls"))
    return no("polls_not_allowed", "You can't create polls here");
  if (hasHeading(c.text) && lacks("messages.big_text"))
    return no(
      "headings_not_allowed",
      "You can't write headings (lines starting with #) here",
    );
  return null;
}

/**
 * Which emoji a message's reactions hold now, from its reaction changes (oldest first): each person's latest change
 * per emoji counts.
 */
export function reactionsOn(changes: readonly MessageEvent[]): Set<string> {
  const latest = new Map<string, { emoji: string; on: boolean }>();
  for (const e of changes) {
    const p = JSON.parse(e.payload) as { emoji?: unknown; add?: unknown };
    if (typeof p.emoji !== "string") continue;
    latest.set(`${e.sender_user_id}\u0000${p.emoji}`, {
      emoji: p.emoji,
      on: p.add !== false,
    });
  }
  return new Set([...latest.values()].filter((r) => r.on).map((r) => r.emoji));
}

const refuse = (r: Refusal | null): void => {
  if (r) throw new ApiError(403, r.code, r.message);
};

/** A new reaction needs `messages.react`; joining one already on the message doesn't. */
async function admitReaction(
  ctx: AppContext,
  conv: Conv,
  p: Payload,
  s: Sender,
): Promise<void> {
  const emoji = str(p.emoji);
  const target = str(p.target);
  if (!emoji || !target || p.add === false || s.perms.has("messages.react"))
    return;
  if (
    reactionsOn(await ctx.messages.changesTo(conv.id, target, "reaction")).has(
      emoji,
    )
  )
    return;
  refuse(
    no(
      "reactions_not_allowed",
      "You can't add new reactions here. You can still join one that's already there.",
    ),
  );
}

/**
 * Replying in a thread: the first reply starts it (`threads.create`), later ones need `threads.post`. In a forum the
 * post is the thread, so every reply is a later one.
 */
async function admitThread(
  ctx: AppContext,
  conv: Conv,
  root: string,
  s: Sender,
): Promise<void> {
  let started = (conv.format ?? "text") === "forum";
  if (!started) {
    const r = await ctx.messages.get(root);
    started =
      !!r &&
      r.conversation_id === conv.id &&
      (await ctx.messages.threadHasReplies(conv.id, root, r.server_ts));
  }
  if (started && !s.perms.has("threads.post"))
    refuse(no("thread_replies_not_allowed", "You can't reply in threads here"));
  if (!started && !s.perms.has("threads.create"))
    refuse(no("threads_not_allowed", "You can't start threads here"));
}

/** Role mentions: anyone may mention a role open to mentions; holders of `messages.mention_all` and moderators any. */
function admitRoleMentions(
  ctx: AppContext,
  conv: Conv,
  roleIds: readonly string[],
  s: Sender,
): void {
  if (!roleIds.length || s.moderates || s.perms.has("messages.mention_all"))
    return;
  const closed = roleIds.find(
    (r) => !ctx.communityPermissions.roleMentionable(conv.org_id!, r),
  );
  if (closed)
    refuse(no("role_mention_not_allowed", "That role isn't open to mentions"));
}

/**
 * Whether [userId] may delete or pin [t] (someone else's message) in channel [conv]: its moderators, and in a thread
 * also holders of `threads.manage`. Outside channels, and while the feature is off, nobody may.
 */
export function moderatesMessage(
  ctx: AppContext,
  conv: Conv,
  userId: string,
  t: MessageEvent | null,
): boolean {
  if (
    !ctx.communityPermissions.enabled ||
    conv.type !== "CHANNEL" ||
    !conv.org_id
  )
    return false;
  if (ctx.authz.moderatesMessages(conv, userId)) return true;
  return (
    !!t &&
    t.conversation_id === conv.id &&
    threadRootOf(t) !== null &&
    ctx.authz.channelPermissions(conv, userId).has("threads.manage")
  );
}

/** Every rule above for one submission in a community channel. Nothing while the feature is off. */
export async function admitChannelContent(
  ctx: AppContext,
  conv: Conv,
  userId: string,
  m: SendMessage,
): Promise<void> {
  if (
    !ctx.communityPermissions.enabled ||
    conv.type !== "CHANNEL" ||
    !conv.org_id
  )
    return;
  const { authz } = ctx;
  const options = authz.channelOptions(conv);
  const moderates = authz.moderatesMessages(conv, userId);
  const s: Sender = {
    perms: authz.channelPermissions(conv, userId),
    orgId: conv.org_id,
    moderates,
    textOnly: options.textOnly,
    noGifs: options.noGifs,
  };
  const type = m.payload.type;
  const isMessage = m.cls === "message";
  if (isMessage || type === "edit") {
    const c = readContent(m.payload);
    refuse(contentRefusal(c, s, isMessage));
    admitRoleMentions(ctx, conv, c.roleMentions, s);
    if (isMessage && c.threadRoot)
      await admitThread(ctx, conv, c.threadRoot, s);
    return;
  }
  if (type === "reaction") return admitReaction(ctx, conv, m.payload, s);
  if (type === "pin") {
    const target = str(m.payload.target);
    const t = target ? await ctx.messages.get(target) : null;
    if (!moderatesMessage(ctx, conv, userId, t))
      refuse(
        no(
          "manage_messages_required",
          "Only people who manage messages here can pin them",
        ),
      );
  }
}
