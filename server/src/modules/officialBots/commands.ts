import type { LiveBotKey } from "../../shared/contracts/http/officialBots.js";
import { commandList } from "./catalog.js";
import type { MessagePosted } from "./events.js";
import { HELPER_COMMANDS, runCustomCommand, runHelperCommand } from "./helper.js";
import { LEVELS_COMMANDS, runLevelsCommand } from "./levels.js";
import type { ActiveBot, ActiveBots, OfficialBots } from "./runtime.js";

/** A "!name args" message. */
export interface Command {
  name: string;
  args: string;
}

const COMMAND = /^!([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i;

/** Names no community command may take: the official bots' own, including part 2's. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(["help", ...HELPER_COMMANDS, ...LEVELS_COMMANDS, "giveaway", "gend", "greroll", "wordy"]);

export function parseCommand(text: string): Command | null {
  const m = COMMAND.exec(text);
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** "!help": every command the bots on here know, answered by Helper (or the first bot that has commands). */
async function help(rt: OfficialBots, bots: ActiveBots, ev: MessagePosted): Promise<void> {
  const keys = (Object.keys(bots) as LiveBotKey[]).filter((k) => k === "helper" || k === "levels");
  const custom = bots.helper?.settings.commands.map((c) => `!${c.name}`) ?? [];
  const usages = [...commandList(keys), ...custom];
  const answerer: ActiveBot | undefined = bots.helper ?? bots.levels;
  if (!answerer || usages.length === 0) return;
  await rt.chat(answerer, ev.conversationId, `🧰 Commands here: ${usages.join(" · ")}`);
}

/** Runs a "!" command with whichever bot on here knows it; unknown commands are left alone. */
export async function runCommand(rt: OfficialBots, bots: ActiveBots, ev: MessagePosted, cmd: Command): Promise<void> {
  if (cmd.name === "help") {
    await rt.safely(bots.helper ? "helper" : "levels", ev, () => help(rt, bots, ev));
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
