import { createdBefore } from "../accounts/index.js";
import type { MemberChanged, MessageDeleted, MessageEdited, RoleChanged } from "./events.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import { conflict } from "../../shared/errors.js";

/** Accounts younger than this are flagged when they join. */
export const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
/** Quoted text is cut to this many characters. */
const QUOTE_MAX = 300;

const clip = (s: string) => ([...s].length > QUOTE_MAX ? `${[...s].slice(0, QUOTE_MAX - 1).join("")}…` : s);
const quote = (s: string) => (s.trim() ? `“${clip(s.trim())}”` : "(no text)");

/** A message's text with its mentions written as names, so a log line never pings anyone. */
export function unping(rt: OfficialBots, text: string, mentions: unknown): string {
  const ids = Array.isArray(mentions) ? mentions.filter((m): m is string => typeof m === "string") : [];
  let out = text;
  for (const [, p] of rt.people(ids)) out = out.replaceAll(`@${p.username}`, p.displayName);
  return out.replaceAll("@everyone", "everyone");
}

function payloadOf(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Channels Logger stays out of: its own, and the ones a community with Bots+ left out. */
function ignored(bot: ActiveBot<"logger">, channelId: string): boolean {
  const s = bot.settings;
  return channelId === s.channelId || channelId === s.memberChannelId || s.excludeChannelIds.includes(channelId);
}

/** Logger copies retained content and moderation details only into an explicitly private destination. */
export function privateLoggerChannel(rt: OfficialBots, orgId: string, channelId: string | null): boolean {
  const id = rt.textChannel(orgId, channelId);
  return !!id && rt.ctx.authz.conversation(id)?.kind === "PRIVATE";
}

function publicationGuard(rt: OfficialBots, bot: ActiveBot<"logger">, channelId: string, source?: string): () => void {
  return () => {
    const current = rt.active(bot.orgId).logger;
    const destination = source ? current?.settings.channelId : current?.settings.memberChannelId ?? current?.settings.channelId;
    if (!current || current.userId !== bot.userId || destination !== channelId || (source && ignored(current, source)) || !privateLoggerChannel(rt, bot.orgId, channelId))
      throw conflict("Choose a private text channel for Logger. This event was not published.");
  };
}

/** An edited message (its text before and after) or a deleted one (its last text), from the server's message store. */
export async function logMessageChange(rt: OfficialBots, bot: ActiveBot<"logger">, ev: MessageEdited | MessageDeleted): Promise<void> {
  if (!bot.settings.channelId || ignored(bot, ev.conversationId)) return;
  const beforeCommit = publicationGuard(rt, bot, bot.settings.channelId, ev.conversationId);
  beforeCommit();
  const original = await rt.ctx.messages.get(ev.target);
  if (!original || original.conversation_id !== ev.conversationId || original.cls !== "message") return;
  const edits = await rt.ctx.messages.changesTo(ev.conversationId, ev.target, "edit");
  const upTo = ev.kind === "edit" ? edits.findIndex((e) => e.id === ev.eventId) : -1;
  const earlier = (ev.kind === "edit" && upTo >= 0 ? edits.slice(0, upTo) : edits).filter((e) => e.sender_user_id === original.sender_user_id);
  const last = earlier.length ? payloadOf(earlier[earlier.length - 1]!.payload) : payloadOf(original.payload);
  const before = unping(rt, typeof last.text === "string" ? last.text : "", last.mentions ?? payloadOf(original.payload).mentions);
  const channel = `#${rt.ctx.authz.conversation(ev.conversationId)?.name ?? "a channel"}`;
  const author = rt.nameOf(original.sender_user_id);
  let line: string;
  if (ev.kind === "edit") {
    const current = upTo >= 0 ? payloadOf(edits[upTo]!.payload) : {};
    line = `✏️ ${author} edited a message in ${channel}: ${quote(before)} → ${quote(unping(rt, ev.text, current.mentions))}`;
  } else {
    const by = ev.userId === original.sender_user_id ? `${author} deleted their message` : `${rt.nameOf(ev.userId)} deleted a message by ${author}`;
    line = `🗑️ ${by} in ${channel}: ${quote(before)}`;
  }
  await rt.post(bot, bot.settings.channelId, { type: "text", text: line }, beforeCommit);
}

/** "2026-11-02 18:00 UTC" from an ISO time, as timeouts' audit entries carry it. */
function utc(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? "later" : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function memberLine(rt: OfficialBots, ev: MemberChanged): string {
  const person = rt.people([ev.userId]).get(ev.userId);
  const name = person ? `${person.displayName} (@${person.username})` : "Someone";
  const by = rt.nameOf(ev.actorId);
  switch (ev.change) {
    case "join": {
      const young = !createdBefore(rt.ctx, ev.userId, ev.at - NEW_ACCOUNT_MS);
      return `📥 ${name} joined.${young ? " ⚠️ New account: made in the last 7 days." : ""}`;
    }
    case "leave":
      return `📤 ${name} left.`;
    case "remove":
      return `👢 ${name} was removed by ${by}.`;
    case "expire":
      return `⌛ ${name}'s membership ran out.`;
    case "ban":
      return `🔨 ${name} was banned by ${by}.`;
    case "unban":
      return `🕊️ ${name} was unbanned by ${by}.`;
    case "timeout": {
      const [until, ...reason] = (ev.detail ?? "").split(" ");
      return `⏳ ${name} was timed out by ${by} until ${utc(until)}.${reason.length ? ` Reason: ${clip(reason.join(" "))}` : ""}`;
    }
    case "timeout_end":
      return `✅ ${by} ended ${name}'s timeout.`;
  }
}

/** Joins (new accounts flagged), leaves, kicks, bans, unbans and timeouts, with who did it. */
export async function logMember(rt: OfficialBots, bot: ActiveBot<"logger">, ev: MemberChanged): Promise<void> {
  const channelId = bot.settings.memberChannelId ?? bot.settings.channelId;
  if (!channelId) return;
  const beforeCommit = publicationGuard(rt, bot, channelId);
  beforeCommit();
  await rt.post(bot, channelId, { type: "text", text: memberLine(rt, ev) }, beforeCommit);
}

/** A role given or taken, and by whom. */
export async function logRole(rt: OfficialBots, bot: ActiveBot<"logger">, ev: RoleChanged): Promise<void> {
  const channelId = bot.settings.memberChannelId ?? bot.settings.channelId;
  if (!channelId) return;
  const beforeCommit = publicationGuard(rt, bot, channelId);
  beforeCommit();
  const name = rt.nameOf(ev.userId);
  const self = ev.actorId === ev.userId;
  const by = rt.nameOf(ev.actorId);
  const text = ev.given
    ? self
      ? `🏷️ ${name} took the ${ev.roleName} role.`
      : `🏷️ ${by} gave ${name} the ${ev.roleName} role.`
    : self
      ? `🏷️ ${name} gave up the ${ev.roleName} role.`
      : `🏷️ ${by} took the ${ev.roleName} role from ${name}.`;
  await rt.post(bot, channelId, { type: "text", text }, beforeCommit);
}
