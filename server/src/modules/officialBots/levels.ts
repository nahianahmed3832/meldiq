import crypto from "node:crypto";
import { giveRoleAsBot } from "../organizations/index.js";
import type { Command } from "./commands.js";
import type { MessagePosted } from "./events.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import { DEFAULT_LEVEL_UP } from "./settings.js";
import type { LevelRow } from "./store.js";

export const LEVELS_COMMANDS: readonly string[] = ["rank", "top"];

/** XP per counted message (before a Bots+ boost), and how often a member's messages count in one community. */
export const XP = { min: 15, max: 25, cooldownMs: 60_000, minChars: 2 } as const;
const TOP = 10;

/** level = floor(√(XP / 100)): level 1 at 100 XP, 2 at 400, 3 at 900... */
export const levelOf = (xp: number): number => Math.floor(Math.sqrt(xp / 100));
/** The XP a level starts at. */
export const xpForLevel = (level: number): number => 100 * level * level;

const num = (n: number) => n.toLocaleString("en-US");

/** Current members' XP in [orgId], the most first. */
function standings(rt: OfficialBots, orgId: string): LevelRow[] {
  return rt.ctx.ws
    .all<LevelRow>("bot_levels", { where: { org_id: orgId }, orderBy: [["xp", "desc"], ["user_id", "asc"]] })
    .filter((r) => rt.ctx.authz.orgRole(orgId, r.user_id) !== null);
}

/** Says a level-up where the community wants it: where they were chatting, or its chosen channel. */
async function announce(rt: OfficialBots, bot: ActiveBot<"levels">, ev: MessagePosted, level: number): Promise<void> {
  const username = rt.people([ev.userId]).get(ev.userId)?.username;
  const text = (bot.settings.levelUpMessage ?? DEFAULT_LEVEL_UP).replaceAll("{user}", username ? `@${username}` : rt.nameOf(ev.userId)).replaceAll("{level}", String(level));
  const mentions = username ? [ev.userId] : [];
  if (bot.settings.announceChannelId) await rt.post(bot, bot.settings.announceChannelId, { type: "text", text, ...(mentions.length ? { mentions } : {}) });
  else await rt.chat(bot, ev.conversationId, text, mentions);
}

/**
 * A message earns 15–25 XP (times a Bots+ boost) when its sender hasn't earned any in this community for a minute and
 * it has some substance (commands and one-character messages don't count). Going up a level gives the role rewards of
 * the levels passed and is announced when the community wants it.
 */
export async function gainXp(rt: OfficialBots, bot: ActiveBot<"levels">, ev: MessagePosted, text: string): Promise<void> {
  if ([...text].length < XP.minChars) return;
  const gain = Math.round(crypto.randomInt(XP.min, XP.max + 1) * bot.settings.boost);
  const before = await rt.ctx.ws.write((w) => {
    const row = w.get<LevelRow>("bot_levels", { org_id: bot.orgId, user_id: ev.userId });
    if (row && ev.at - row.last_xp_at < XP.cooldownMs) return null;
    const xp = row?.xp ?? 0;
    w.upsert("bot_levels", { org_id: bot.orgId, user_id: ev.userId, xp: xp + gain, last_xp_at: ev.at }, { xp: xp + gain, last_xp_at: ev.at });
    return xp;
  });
  if (before === null) return;
  const from = levelOf(before);
  const to = levelOf(before + gain);
  if (to <= from) return;
  for (const reward of bot.settings.roleRewards.filter((r) => r.level > from && r.level <= to)) {
    await giveRoleAsBot(rt.ctx, bot.orgId, reward.roleId, ev.userId, bot.userId, bot.key);
  }
  if (bot.settings.announce) await announce(rt, bot, ev, to);
}

/** "!rank": your level, XP and place. "!top": the ten with the most XP. */
export async function runLevelsCommand(rt: OfficialBots, bot: ActiveBot<"levels">, ev: MessagePosted, cmd: Command): Promise<void> {
  const rows = standings(rt, bot.orgId);
  if (cmd.name === "rank") {
    const who = rt.nameOf(ev.userId);
    const i = rows.findIndex((r) => r.user_id === ev.userId);
    if (i < 0) {
      await rt.chat(bot, ev.conversationId, `📈 ${who} hasn't earned any XP here yet. Chat a little and ask again!`);
      return;
    }
    const xp = rows[i]!.xp;
    const level = levelOf(xp);
    await rt.chat(bot, ev.conversationId, `📈 ${who}: level ${level} · ${num(xp)} XP · #${i + 1} of ${rows.length}. ${num(xpForLevel(level + 1) - xp)} XP to level ${level + 1}.`);
    return;
  }
  const top = rows.slice(0, TOP);
  if (top.length === 0) {
    await rt.chat(bot, ev.conversationId, "🏆 Nobody has earned XP here yet. Be the first!");
    return;
  }
  const names = rt.people(top.map((r) => r.user_id));
  const lines = top.map((r, i) => `${i + 1}. ${names.get(r.user_id)?.displayName ?? "Someone"} · level ${levelOf(r.xp)} · ${num(r.xp)} XP`);
  await rt.chat(bot, ev.conversationId, `🏆 Most active here\n${lines.join("\n")}`);
}
