import { isBotUser } from "../accounts/index.js";
import { parseCommand, runCommand } from "./commands.js";
import type { BotEvent, MemberChanged, MessagePosted } from "./events.js";
import { noteAway } from "./helper.js";
import { gainXp } from "./levels.js";
import { logMember, logMessageChange, logRole } from "./logger.js";
import type { ActiveBots, OfficialBots } from "./runtime.js";
import { countEntries } from "./giveaways.js";
import { countStars } from "./starboard.js";
import { maybeGuess } from "./wordy.js";
import { sayGoodbye, welcome } from "./welcomer.js";

/** Changes that take a member out: if it was one of the community's official bots, that bot is off from now on. */
const TAKEN_OUT = new Set(["remove", "ban", "expire"]);

/**
 * An official bot's account left the community some other way than its switch (a manager removed or banned it from
 * the member list): the bot is off, its settings kept. Returns true for any official bot's account, whose own
 * comings and goings no bot reports.
 */
async function officialBotMoved(rt: OfficialBots, ev: MemberChanged): Promise<boolean> {
  const row = rt.rows.byAccount(ev.userId);
  if (!row || row.org_id !== ev.orgId) return false;
  if (TAKEN_OUT.has(ev.change) && row.enabled === 1) {
    await rt.rows.save({ ...row, enabled: 0, updated_by: ev.actorId ?? row.updated_by, updated_at: ev.at });
    rt.ctx.audit({ actorId: ev.actorId, orgId: ev.orgId, action: "official_bot.off", target: row.bot_key, detail: `${row.bot_key}: taken out of the community` });
  }
  return true;
}

async function onMessage(rt: OfficialBots, bots: ActiveBots, ev: MessagePosted): Promise<void> {
  // Bots (official or not) don't run commands, earn XP or clear away notes.
  if (isBotUser(rt.ctx, ev.userId)) return;
  const text = typeof ev.payload.text === "string" ? ev.payload.text.trim() : "";
  const command = parseCommand(text);
  if (bots.helper) await rt.safely("helper", ev, () => noteAway(rt, bots.helper!, ev, command?.name === "afk"));
  if (command) {
    await runCommand(rt, bots, ev, command);
    return;
  }
  // A bare five-letter word in Wordy's channel is a guess while its sender has a game running (no XP for it).
  let guessed = false;
  if (bots.wordy) await rt.safely("wordy", ev, async () => (guessed = await maybeGuess(rt, bots.wordy!, ev, text)));
  if (guessed) return;
  if (bots.levels) await rt.safely("levels", ev, () => gainXp(rt, bots.levels!, ev, text));
}

async function onMember(rt: OfficialBots, bots: ActiveBots, ev: MemberChanged): Promise<void> {
  if (isBotUser(rt.ctx, ev.userId)) return;
  if (ev.change === "join" && bots.welcomer) await rt.safely("welcomer", ev, () => welcome(rt, bots.welcomer!, ev.userId));
  if (ev.change === "leave" && bots.welcomer) await rt.safely("welcomer", ev, () => sayGoodbye(rt, bots.welcomer!, ev.userId));
  if (bots.logger) await rt.safely("logger", ev, () => logMember(rt, bots.logger!, ev));
}

/** Hands one event to the bots that care about it, each on its own (one failing doesn't stop the others). */
export async function handle(rt: OfficialBots, ev: BotEvent): Promise<void> {
  if (ev.kind === "member" && (await officialBotMoved(rt, ev))) return;
  const bots = rt.active(ev.orgId);
  if (Object.keys(bots).length === 0) return;
  switch (ev.kind) {
    case "message":
      return onMessage(rt, bots, ev);
    case "edit":
    case "delete":
      if (bots.logger) await rt.safely("logger", ev, () => logMessageChange(rt, bots.logger!, ev));
      return;
    case "reaction":
      if (bots.starboard) await rt.safely("starboard", ev, () => countStars(rt, bots.starboard!, ev));
      if (bots.giveaways) await rt.safely("giveaways", ev, () => countEntries(rt, ev));
      return;
    case "member":
      return onMember(rt, bots, ev);
    case "role":
      if (bots.logger && !isBotUser(rt.ctx, ev.userId)) await rt.safely("logger", ev, () => logRole(rt, bots.logger!, ev));
      return;
  }
}
