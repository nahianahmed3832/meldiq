import crypto from "node:crypto";
import { communityFacts, publicTextChannel } from "../organizations/index.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";

/** The channel Welcomer greets in: the one picked, else the community's #general, else its first public text channel. */
export function welcomeChannel(rt: OfficialBots, orgId: string, picked: string | null): string | null {
  const chosen = rt.textChannel(orgId, picked);
  if (chosen) return chosen;
  const channels = rt.ctx.authz
    .conversationIdsOf(orgId)
    .map((id) => rt.ctx.authz.conversation(id))
    .filter((c) => publicTextChannel(rt.ctx, c, orgId))
    .sort((a, b) => (a!.position ?? 0) - (b!.position ?? 0) || a!.created_at - b!.created_at);
  return (channels.find((c) => c!.name?.toLowerCase() === "general") ?? channels[0])?.id ?? null;
}

/** A greeting with its placeholders filled: {user} (as given), {name}, {server}, {count}. */
export function fillGreeting(template: string, v: { user: string; name: string; server: string; count: number }): string {
  return template.replaceAll("{user}", v.user).replaceAll("{name}", v.name).replaceAll("{server}", v.server).replaceAll("{count}", v.count.toLocaleString("en-US"));
}

/** Greets [userId] with one of the community's greetings (picked at random), mentioning them. */
export async function welcome(rt: OfficialBots, bot: ActiveBot<"welcomer">, userId: string): Promise<{ messageId: string; channelId: string } | null> {
  const channelId = welcomeChannel(rt, bot.orgId, bot.settings.channelId);
  const person = rt.people([userId]).get(userId);
  if (!channelId || !person) return null;
  const facts = communityFacts(rt.ctx, bot.orgId);
  const lines = bot.settings.messages;
  const text = fillGreeting(lines[crypto.randomInt(0, lines.length)]!, { user: `@${person.username}`, name: person.displayName, server: facts.name, count: facts.people });
  return rt.post(bot, channelId, { type: "text", text, mentions: [userId] });
}

/** Bots+: says goodbye in the same channel when someone leaves (by name: they can't be mentioned any more). */
export async function sayGoodbye(rt: OfficialBots, bot: ActiveBot<"welcomer">, userId: string): Promise<void> {
  const goodbye = bot.settings.goodbye;
  if (!goodbye) return;
  const channelId = welcomeChannel(rt, bot.orgId, bot.settings.channelId);
  const person = rt.people([userId]).get(userId);
  if (!channelId || !person) return;
  const facts = communityFacts(rt.ctx, bot.orgId);
  await rt.post(bot, channelId, { type: "text", text: fillGreeting(goodbye, { user: person.displayName, name: person.displayName, server: facts.name, count: facts.people }) });
}
