import type { z } from "zod/v4";
import type { CatalogBot, OfficialBotKey, OfficialBotsCatalog } from "../../shared/contracts/http/officialBots.js";
import { isLiveBot } from "./settings.js";

type Entry = Omit<z.infer<typeof CatalogBot>, "key" | "available">;

/**
 * The official bots as the Bots page and each bot's detail window show them (community parity batch D). Meldiq's own
 * names for what each does, its own words and its own sample lines. Giveaways, Tickets, Alerts and Wordy are listed but
 * can't be turned on until part 2.
 */
const ENTRIES: Record<OfficialBotKey, Entry> = {
  welcomer: {
    name: "Welcomer",
    tagline: "Greets every newcomer by name",
    description:
      "Welcomer says hello to each person who joins, in the channel you pick, so nobody arrives to silence. Write the greeting yourself and drop in their name, the community's name or how many people are here now.",
    color: "#22c55e",
    icon: "👋",
    features: ["Greets newcomers", "Your own words", "Name, community and count", "Try it on yourself"],
    sample: "Hey @ana, welcome to Night Owls! You're member number 42. 🎉",
    commands: [],
    limits: [
      { what: "Greetings", free: "1", plus: "Up to 10, one picked at random" },
      { what: "Goodbye when someone leaves", free: "—", plus: "Yes" },
    ],
  },
  helper: {
    name: "Helper",
    tagline: "Game-night tricks and away notes",
    description:
      "Helper keeps a few party tricks ready in every channel it can post in: dice, a coin, a fortune ball and a picker for when nobody can decide. People can leave an away note too, and Helper answers for them while they're gone. Nothing to set up.",
    color: "#0ea5e9",
    icon: "🎲",
    features: ["Dice and coins", "Fortune ball", "Picker", "Away notes", "No setup"],
    sample: "🎲 Ana rolled 2d6: 4 + 6 = 10",
    commands: [
      { usage: "!8ball question", description: "A yes-or-no question for the fortune ball" },
      { usage: "!roll or !roll 2d6", description: "Roll dice (a d6 unless you say otherwise)" },
      { usage: "!flip", description: "Heads or tails" },
      { usage: "!choose a | b | c", description: "Let Helper decide" },
      { usage: "!afk reason", description: "Leave an away note until you're back" },
      { usage: "!help", description: "Every command the bots here know" },
    ],
    limits: [{ what: "Your own commands (like !rules)", free: "—", plus: "Up to 25" }],
  },
  levels: {
    name: "Levels",
    tagline: "XP for chatting, levels for regulars",
    description:
      "Levels hands out a little XP when people chat (once a minute at most, so spamming gets nowhere) and cheers when someone goes up a level. !rank shows where you stand and !top the ten most active. Its leaderboard can go on your lobby too.",
    color: "#f59e0b",
    icon: "📈",
    features: ["XP for chatting", "Level-up cheers", "!rank and !top", "Lobby leaderboard"],
    sample: "🎉 @ana just reached level 5!",
    commands: [
      { usage: "!rank", description: "Your level, XP and place" },
      { usage: "!top", description: "The ten most active people" },
    ],
    limits: [
      { what: "XP boost", free: "—", plus: "1.5× or 2×" },
      { what: "Roles for reaching a level", free: "—", plus: "Up to 20 levels" },
      { what: "Your own level-up message", free: "—", plus: "Yes" },
    ],
  },
  logger: {
    name: "Logger",
    tagline: "A quiet record of what changed",
    description:
      "Logger writes one short line into the channel you choose for every edit, deletion, join, leave, kick, ban, timeout and role change, and never pings anyone. It stays quiet until you pick its channel: a private one is best, so only your team reads it.",
    color: "#64748b",
    icon: "📜",
    features: ["Edits and deletions", "Joins and leaves", "Kicks, bans and timeouts", "Role changes", "Never pings"],
    sample: "✏️ Ana edited a message in #general: “see you at 8” → “see you at 9”",
    commands: [],
    limits: [
      { what: "Member events in their own channel", free: "—", plus: "Yes" },
      { what: "Channels left out", free: "—", plus: "Up to 25" },
    ],
  },
  starboard: {
    name: "Starboard",
    tagline: "The best messages, picked by everyone",
    description:
      "When enough people react to a message with ⭐ or 🌟, Starboard copies it to your starboard channel with a link back and keeps its star count up to date. Your own stars don't count, private channels are skipped, and no message goes up twice.",
    color: "#eab308",
    icon: "⭐",
    features: ["Stars from everyone", "Pictures come along", "Link back", "Never twice"],
    sample: "⭐ 6 · Ana in #memes\nthis is the one",
    commands: [],
    limits: [
      { what: "Star emoji", free: "⭐ and 🌟", plus: "Any emoji" },
      { what: "Star your own messages", free: "—", plus: "Yes" },
      { what: "Channels left out", free: "—", plus: "Up to 25" },
    ],
  },
  giveaways: {
    name: "Giveaways",
    tagline: "Prize draws with one command",
    description:
      "Giveaways runs a prize draw from a single message: people react 🎉 to enter, and when time's up it picks the winners from people still in the community. Bots never win.",
    color: "#ec4899",
    icon: "🎉",
    features: ["React to enter", "Several winners", "Reroll", "Shows on your lobby"],
    sample: "🎉 Giveaway: a game key\nReact with 🎉 to enter · 1 winner · ends tomorrow · run by Ana",
    commands: [
      { usage: "!giveaway 1d Prize", description: "Start one (s, m, h, d or w)" },
      { usage: "!giveaway 2h 3w Prize", description: "Three winners in two hours" },
      { usage: "!gend", description: "End it now" },
      { usage: "!greroll", description: "Pick another winner" },
    ],
    limits: [
      { what: "Winners", free: "Up to 3", plus: "Up to 20" },
      { what: "Longest giveaway", free: "7 days", plus: "30 days" },
      { what: "Only some roles may enter", free: "—", plus: "Yes" },
    ],
  },
  tickets: {
    name: "Tickets",
    tagline: "Private help desks for your members",
    description:
      "Tickets posts a panel with an \"Open a ticket\" button. Each ticket is a private channel between the person who opened it and your moderators, closed by either side when it's sorted.",
    color: "#8b5cf6",
    icon: "🎫",
    features: ["Panels with a button", "Private channels", "Close from either side", "Logged"],
    sample: "🎫 Ticket #12 · Support opened by Ana",
    commands: [],
    limits: [
      { what: "Panels", free: "2", plus: "10" },
      { what: "Open tickets per person", free: "Up to 3", plus: "Up to 10" },
      { what: "Ping a support role", free: "—", plus: "Yes" },
      { what: "Welcome message per panel", free: "—", plus: "Yes" },
      { what: "Transcript in the log when closed", free: "—", plus: "Yes" },
    ],
  },
  alerts: {
    name: "Alerts",
    tagline: "New videos, posted for you",
    description: "Alerts watches the video channels you follow and posts each new upload in the channel you choose, with a ping for a role if you like.",
    color: "#ef4444",
    icon: "📣",
    features: ["New uploads only", "Your channel", "Optional role ping", "Your own message"],
    sample: "📣 Ana posted a new video: Speedrun night recap",
    commands: [],
    limits: [{ what: "Video channels followed", free: "3", plus: "25" }],
  },
  wordy: {
    name: "Wordy",
    tagline: "One five-letter word a day",
    description: "Wordy picks the same five-letter word for everyone each day. You get six tries, the board shows colours but never letters, and streaks and the best solvers are kept.",
    color: "#14b8a6",
    icon: "🔤",
    features: ["Daily word", "Six tries", "No spoilers", "Streaks"],
    sample: "🔤 Ana solved today's word in 3: 🟨⬛⬛🟩⬛ 🟩🟩⬛🟩🟨 🟩🟩🟩🟩🟩",
    commands: [
      { usage: "!wordy", description: "Today's board" },
      { usage: "!wordy guess", description: "Try a word" },
      { usage: "!wordy stats", description: "Your streak and the best solvers" },
    ],
    limits: [],
  },
};

export const BOTS_PLUS = {
  name: "Bots+",
  description: "Every official bot's Plus extras, for this whole community.",
  perks: ["Up to 10 greetings and a goodbye", "Your own Helper commands", "XP boosts and level roles", "A separate member log", "Any star emoji", "Bigger giveaways and more ticket panels"],
};

export function catalogEntry(key: OfficialBotKey): z.infer<typeof CatalogBot> {
  return { key, ...ENTRIES[key], available: isLiveBot(key) };
}

export function catalog(): z.infer<typeof OfficialBotsCatalog> {
  return { bots: (Object.keys(ENTRIES) as OfficialBotKey[]).map(catalogEntry), botsPlus: { ...BOTS_PLUS, perks: [...BOTS_PLUS.perks] } };
}

/** "!roll or !roll 2d6 · !flip · …": the commands of [keys], in catalog order, for !help. */
export function commandList(keys: readonly OfficialBotKey[]): string[] {
  return keys.flatMap((k) => ENTRIES[k].commands.map((c) => c.usage));
}
