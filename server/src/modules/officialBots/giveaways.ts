import crypto from "node:crypto";
import { newId } from "../../shared/utilities/util.js";
import { botsAmong } from "../accounts/index.js";
import { activeRoleName, holdsRole } from "../organizations/index.js";
import type { Command } from "./commands.js";
import type { MessagePosted, ReactionChanged } from "./events.js";
import { draw, endsText, type GiveawayRequest, parseGiveaway } from "./giveawayParse.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import type { GiveawayRow } from "./store.js";

export const GIVEAWAY_COMMANDS: readonly string[] = ["giveaway", "gend", "greroll"];
/** The reaction that enters a giveaway. */
export const ENTER = "🎉";
/** Giveaways running at once in one community. */
const RUNNING_MAX = 25;
const COLOR = 0xec4899;

type Bot = ActiveBot<"giveaways">;

const winnersOf = (g: GiveawayRow): string[] => JSON.parse(g.winner_ids) as string[];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "@ana, @ben": mentions of [ids], with the ids to ping. */
function mentionsOf(rt: OfficialBots, ids: readonly string[]): { text: string; mentions: string[] } {
  const people = rt.people(ids);
  const known = ids.filter((id) => people.has(id));
  return { text: known.map((id) => `@${people.get(id)!.username}`).join(", "), mentions: known };
}

/** The card's text and box: running (how to enter, when it ends) or ended (who won). */
function card(rt: OfficialBots, g: GiveawayRow, at: number): Record<string, unknown> & { type: string; text: string } {
  const host = rt.nameOf(g.host_id);
  const role = g.required_role_id ? activeRoleName(rt.ctx, g.org_id, g.required_role_id) : null;
  const roleLine = role ? `\nOnly members with ${role} can win.` : "";
  const meta = { id: g.id, endsAt: g.ends_at, winners: g.winners, ended: g.ended_at !== null };
  if (g.ended_at === null) {
    const line = `React with ${ENTER} to enter · ${plural(g.winners, "winner")} · ends ${endsText(g.ends_at, at)} · hosted by ${host}`;
    const description = `React with ${ENTER} to enter.\n${plural(g.winners, "winner")} · ends ${endsText(g.ends_at, at)}\nHosted by ${host}${roleLine}`;
    return { type: "text", text: `🎉 Giveaway: ${g.prize}\n${line}`, textFromEmbeds: true, embeds: [{ title: `🎉 ${g.prize}`, description, color: COLOR }], giveaway: meta };
  }
  const won = mentionsOf(rt, winnersOf(g)).text || "nobody entered";
  const description = `Winners: ${won}\nHosted by ${host}${roleLine}`;
  return {
    type: "text",
    text: `🎉 Giveaway ended: ${g.prize}\nWinners: ${won} · hosted by ${host}`,
    textFromEmbeds: true,
    embeds: [{ title: `🎉 ${g.prize}`, description, color: COLOR, footer: { text: "Ended" } }],
    giveaway: { ...meta, winnerIds: winnersOf(g) },
  };
}

/**
 * Who may win [g] now: people (not bots) whose latest 🎉 on its card is still on, who are still in the community and,
 * when it asks for one, hold its role.
 */
async function entrants(rt: OfficialBots, g: GiveawayRow): Promise<string[]> {
  if (!g.message_id) return [];
  const on = new Map<string, boolean>();
  for (const r of await rt.ctx.messages.changesTo(g.channel_id, g.message_id, "reaction")) {
    const p = JSON.parse(r.payload) as { emoji?: unknown; add?: unknown };
    if (p.emoji === ENTER) on.set(r.sender_user_id, p.add !== false);
  }
  const people = new Set([...on].filter(([, yes]) => yes).map(([id]) => id));
  for (const b of botsAmong(rt.ctx, people)) people.delete(b);
  return [...people].filter((id) => rt.ctx.authz.orgRole(g.org_id, id) !== null && (!g.required_role_id || holdsRole(rt.ctx, g.org_id, g.required_role_id, id)));
}

/** Whether [userId] may run giveaways in [conversationId]: its managers and people who manage messages there. */
function isStaff(rt: OfficialBots, conversationId: string, userId: string): boolean {
  const conv = rt.ctx.authz.conversation(conversationId);
  return !!conv && rt.ctx.authz.moderatesMessages(conv, userId);
}

async function start(rt: OfficialBots, bot: Bot, ev: MessagePosted, req: GiveawayRequest): Promise<void> {
  if (!rt.textChannel(bot.orgId, ev.conversationId)) return;
  if (rt.ctx.ws.count("bot_giveaways", { org_id: bot.orgId, ended_at: null }) >= RUNNING_MAX) {
    await rt.chat(bot, ev.conversationId, `🎉 This community has ${RUNNING_MAX} giveaways running already. End one first.`);
    return;
  }
  const g: GiveawayRow = {
    id: newId("gw"),
    org_id: bot.orgId,
    channel_id: ev.conversationId,
    message_id: null,
    prize: req.prize,
    winners: req.winners,
    host_id: ev.userId,
    required_role_id: bot.settings.requiredRoleId && rt.ctx.authz.roleGrant(bot.settings.requiredRoleId, bot.orgId) ? bot.settings.requiredRoleId : null,
    entrants: 0,
    ends_at: ev.at + req.durationMs,
    ended_at: null,
    winner_ids: "[]",
    created_at: ev.at,
  };
  await rt.ctx.ws.write((w) => w.insert("bot_giveaways", { ...g }));
  const sent = await rt.post(bot, ev.conversationId, card(rt, g, ev.at));
  if (!sent) return;
  await rt.ctx.ws.write((w) => w.update("bot_giveaways", { id: g.id }, { message_id: sent.messageId }));
  await rt.react(bot, ev.conversationId, sent.messageId, ENTER);
  rt.scheduler.wake(g.ends_at);
}

/**
 * Ends [g] at [at] (on time, or early with !gend): draws the winners, turns the card into the result and calls the
 * winners out. Claimed first, so it ends once however many ticks or commands get there.
 */
export async function endGiveaway(rt: OfficialBots, g: GiveawayRow, at: number): Promise<void> {
  const claimed = await rt.ctx.ws.write((w) => w.update("bot_giveaways", { id: g.id, ended_at: null }, { ended_at: at }) > 0);
  if (!claimed) return;
  const pool = await entrants(rt, g);
  const winners = draw(pool, g.winners, (max) => crypto.randomInt(max));
  const ended: GiveawayRow = { ...g, ended_at: at, entrants: pool.length, winner_ids: JSON.stringify(winners) };
  await rt.ctx.ws.write((w) => w.update("bot_giveaways", { id: g.id }, { entrants: pool.length, winner_ids: ended.winner_ids }));
  const bot = rt.account(g.org_id, "giveaways");
  if (!bot || !g.message_id) return;
  const { text: result, type: _type, ...boxes } = card(rt, ended, at);
  await rt.editPost(bot, g.channel_id, g.message_id, result, boxes);
  const won = mentionsOf(rt, winners);
  const text = won.mentions.length ? `🎉 Congratulations ${won.text}! You won ${g.prize}.` : `🎉 Nobody could win ${g.prize}: no one entered in time.`;
  await rt.post(bot, g.channel_id, { type: "text", text, ...(won.mentions.length ? { mentions: won.mentions } : {}) });
}

/** "!greroll [n]": draws n more (1 by default) for the channel's last ended giveaway, never someone who won it already. */
async function reroll(rt: OfficialBots, bot: Bot, ev: MessagePosted, args: string): Promise<void> {
  const g = rt.ctx.ws.get<GiveawayRow>("bot_giveaways", { channel_id: ev.conversationId, ended_at: { ne: null } }, [["ended_at", "desc"]]);
  if (!g) {
    await rt.chat(bot, ev.conversationId, "🎉 There's no ended giveaway in this channel to reroll.");
    return;
  }
  const n = Math.min(Math.max(Number.parseInt(args, 10) || 1, 1), g.winners);
  const before = winnersOf(g);
  const pool = (await entrants(rt, g)).filter((id) => !before.includes(id));
  const extra = draw(pool, n, (max) => crypto.randomInt(max));
  if (extra.length === 0) {
    await rt.chat(bot, ev.conversationId, `🎉 Nobody else can win ${g.prize}: everyone who entered has won already.`);
    return;
  }
  await rt.ctx.ws.write((w) => w.update("bot_giveaways", { id: g.id }, { winner_ids: JSON.stringify([...before, ...extra]) }));
  const won = mentionsOf(rt, extra);
  await rt.post(bot, ev.conversationId, { type: "text", text: `🎉 New draw for ${g.prize}: congratulations ${won.text}!`, mentions: won.mentions });
}

/** !giveaway, !gend and !greroll: for people who manage messages in that channel. */
export async function runGiveawayCommand(rt: OfficialBots, bot: Bot, ev: MessagePosted, cmd: Command): Promise<void> {
  if (!isStaff(rt, ev.conversationId, ev.userId)) {
    await rt.chat(bot, ev.conversationId, "🎉 Only people who manage messages in this channel can run giveaways here.");
    return;
  }
  if (cmd.name === "giveaway") {
    const parsed = parseGiveaway(cmd.args, bot.plus);
    if ("error" in parsed) await rt.chat(bot, ev.conversationId, parsed.error);
    else await start(rt, bot, ev, parsed.ok);
    return;
  }
  if (cmd.name === "greroll") {
    await reroll(rt, bot, ev, cmd.args);
    return;
  }
  const running = rt.ctx.ws.get<GiveawayRow>("bot_giveaways", { channel_id: ev.conversationId, ended_at: null }, [["created_at", "desc"]]);
  if (!running) await rt.chat(bot, ev.conversationId, "🎉 No giveaway is running in this channel.");
  else await endGiveaway(rt, running, ev.at);
}

/** A 🎉 went on or off a running giveaway's card: its entrant count (the lobby's) follows. */
export async function countEntries(rt: OfficialBots, ev: ReactionChanged): Promise<void> {
  if (ev.emoji !== ENTER) return;
  const g = rt.ctx.ws.get<GiveawayRow>("bot_giveaways", { message_id: ev.target, ended_at: null });
  if (!g || g.channel_id !== ev.conversationId) return;
  const n = (await entrants(rt, g)).length;
  if (n !== g.entrants) await rt.ctx.ws.write((w) => w.update("bot_giveaways", { id: g.id }, { entrants: n }));
}

/** Giveaways that should have ended by [at] (the scheduler's minute tick). */
export function dueGiveaways(rt: OfficialBots, at: number): GiveawayRow[] {
  return rt.ctx.ws.all<GiveawayRow>("bot_giveaways", { where: { ended_at: null, ends_at: { lte: at } }, orderBy: [["ends_at", "asc"]] });
}

/** The lobby's card: running giveaways (posted) in channels [viewerId] can see, ending first first. */
export function runningGiveaways(rt: OfficialBots, orgId: string, viewerId: string): { id: string; title: string; endsAt: number; entrants: number }[] {
  return rt.ctx.ws
    .all<GiveawayRow>("bot_giveaways", { where: { org_id: orgId, ended_at: null, message_id: { ne: null } }, orderBy: [["ends_at", "asc"]] })
    .filter((g) => {
      const conv = rt.ctx.authz.conversation(g.channel_id);
      return !!conv && rt.ctx.authz.canViewChannel(conv, viewerId);
    })
    .map((g) => ({ id: g.id, title: g.prize, endsAt: g.ends_at, entrants: g.entrants }));
}
