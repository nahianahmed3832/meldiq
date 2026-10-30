import type { LiveBotKey } from "../../shared/contracts/http/officialBots.js";
import { commandList } from "./catalog.js";
import type { MessagePosted } from "./events.js";
import { GIVEAWAY_COMMANDS, runGiveawayCommand } from "./giveaways.js";
import { HELPER_COMMANDS, runCustomCommand, runHelperCommand } from "./helper.js";
import { LEVELS_COMMANDS, runLevelsCommand } from "./levels.js";
import { runWordyCommand, WORDY_COMMANDS } from "./wordy.js";
import type { ActiveBot, ActiveBots, OfficialBots } from "./runtime.js";

/** A "!name args" message. */
export interface Command {
  name: string;
  args: string;
}

const COMMAND = /^!([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i;
/** "/wordy …" typed as a message reads like "!wordy …" (official bots have no slash commands of their own). */
const SLASH_WORDY = /^\/(wordy)(?:\s+([\s\S]*))?$/i;

/** Names no community command may take: the official bots' own. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(["help", ...HELPER_COMMANDS, ...LEVELS_COMMANDS, ...GIVEAWAY_COMMANDS, ...WORDY_COMMANDS]);

export function parseCommand(text: string): Command | null {
  const m = COMMAND.exec(text) ?? SLASH_WORDY.exec(text);
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** The bots that answer commands, in the order !help lists them. */
const WITH_COMMANDS: readonly LiveBotKey[] = ["helper", "levels", "giveaways", "wordy"];

/** "!help": every command the bots on here know, answered by Helper (or the first bot that has commands). */
async function help(rt: OfficialBots, bots: ActiveBots, ev: MessagePosted): Promise<void> {
  const keys = WITH_COMMANDS.filter((k) => bots[k]);
  const custom = bots.helper?.settings.commands.map((c) => `!${c.name}`) ?? [];
  const usages = [...commandList(keys), ...custom];
  const answerer: ActiveBot | undefined = bots.helper ?? bots.levels ?? bots.giveaways ?? bots.wordy;
  if (!answerer || usages.length === 0) return;
  await rt.chat(answerer, ev.conversationId, `🧰 Commands here: ${usages.join(" · ")}`);
}

/** Runs a "!" command with whichever bot on here knows it; unknown commands are left alone. */
export async function runCommand(rt: OfficialBots, bots: ActiveBots, ev: MessagePosted, cmd: Command): Promise<void> {
  if (cmd.name === "help") {
    await rt.safely(WITH_COMMANDS.find((k) => bots[k]) ?? "helper", ev, () => help(rt, bots, ev));
    return;
  }
  if (bots.giveaways && GIVEAWAY_COMMANDS.includes(cmd.name)) {
    await rt.safely("giveaways", ev, () => runGiveawayCommand(rt, bots.giveaways!, ev, cmd));
    return;
  }
  if (bots.wordy && WORDY_COMMANDS.includes(cmd.name)) {
    await rt.safely("wordy", ev, () => runWordyCommand(rt, bots.wordy!, ev, cmd));
    return;
  }
  if (bots.helper && HELPER_COMMANDS.includes(cmd.name)) {
    await rt.safely("helper", ev, () => runHelperCommand(rt, bots.helper!, ev, cmd));
    return;
  }
  if (bots.levels && LEVELS_COMMANDS.includes(cmd.name)) {
    await rt.safely("levels", ev, () => runLevelsCommand(rt, bots.levels!, ev, cmd));
    return;
  }
  const custom = bots.helper?.settings.commands.find((c) => c.name === cmd.name);
  if (custom) await rt.safely("helper", ev, () => runCustomCommand(rt, bots.helper!, ev, custom.response));
}
