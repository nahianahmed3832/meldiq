import { BOT_LIMITS, BOT_SETTINGS, type BotSettings, LIVE_BOT_KEYS, type LiveBotKey } from "../../shared/contracts/http/officialBots.js";

/** Meldiq's own greeting, used until a community writes its own. */
export const DEFAULT_WELCOME = "Hey {user}, welcome to {server}! You're member number {count}. 🎉";
/** Levels' line when someone goes up a level, until a community with Bots+ writes its own. */
export const DEFAULT_LEVEL_UP = "🎉 {user} just reached level {level}!";

type AnySettings = { [K in LiveBotKey]: BotSettings<K> };

/** What a bot starts with when a community first turns it on. */
export const DEFAULT_SETTINGS: AnySettings = {
  welcomer: { channelId: null, messages: [DEFAULT_WELCOME], goodbye: null },
  helper: { commands: [] },
  levels: { announce: true, announceChannelId: null, boost: 1, roleRewards: [], levelUpMessage: null },
  logger: { channelId: null, memberChannelId: null, excludeChannelIds: [] },
  starboard: { channelId: null, threshold: BOT_LIMITS.defaultStarThreshold, emoji: null, selfStar: false, excludeChannelIds: [] },
  giveaways: { requiredRoleId: null },
  tickets: { panels: {}, transcripts: false },
  alerts: {},
  wordy: { channelId: null },
};

export const isLiveBot = (key: string): key is LiveBotKey => (LIVE_BOT_KEYS as readonly string[]).includes(key);

/** A bot's stored settings (JSON), over its defaults; anything that no longer reads well falls back to them. */
export function storedSettings<K extends LiveBotKey>(key: K, json: string | null | undefined): BotSettings<K> {
  const defaults = DEFAULT_SETTINGS[key];
  if (!json) return defaults;
  try {
    const parsed = BOT_SETTINGS[key].safeParse({ ...defaults, ...(JSON.parse(json) as object) });
    return (parsed.success ? parsed.data : defaults) as BotSettings<K>;
  } catch {
    return defaults;
  }
}

/** The settings in [s] that only Bots+ unlocks (field names), so the routes can refuse them and views can flag them. */
export function plusFeatures(key: LiveBotKey, s: BotSettings<LiveBotKey>): string[] {
  const on: [string, boolean][] = (() => {
    switch (key) {
      case "welcomer": {
        const w = s as BotSettings<"welcomer">;
        return [["messages", w.messages.length > BOT_LIMITS.welcomeLines.free], ["goodbye", w.goodbye !== null]];
      }
      case "helper":
        return [["commands", (s as BotSettings<"helper">).commands.length > 0]];
      case "levels": {
        const l = s as BotSettings<"levels">;
        return [["boost", l.boost !== 1], ["roleRewards", l.roleRewards.length > 0], ["levelUpMessage", l.levelUpMessage !== null]];
      }
      case "logger": {
        const g = s as BotSettings<"logger">;
        return [["memberChannelId", g.memberChannelId !== null], ["excludeChannelIds", g.excludeChannelIds.length > 0]];
      }
      case "starboard": {
        const b = s as BotSettings<"starboard">;
        return [["emoji", b.emoji !== null], ["selfStar", b.selfStar], ["excludeChannelIds", b.excludeChannelIds.length > 0]];
      }
      case "giveaways":
        return [["requiredRoleId", (s as BotSettings<"giveaways">).requiredRoleId !== null]];
      case "tickets": {
        // Batch C's own limits (panels, per person) are checked by the tickets config itself.
        const t = s as BotSettings<"tickets">;
        return [["panels", Object.values(t.panels).some((p) => p.supportRoleId !== null || p.welcomeMessage !== null)], ["transcripts", t.transcripts]];
      }
      case "alerts":
      case "wordy":
        return [];
    }
  })();
  return on.filter(([, used]) => used).map(([name]) => name);
}

/**
 * The settings a bot acts on: with Bots+, as stored; without it, the free version of each Plus extra (stored extras
 * are kept for when Bots+ is back).
 */
export function effectiveSettings<K extends LiveBotKey>(key: K, s: BotSettings<K>, plus: boolean): BotSettings<K> {
  if (plus) return s;
  const free = DEFAULT_SETTINGS[key];
  switch (key) {
    case "welcomer": {
      const w = s as BotSettings<"welcomer">;
      return { ...w, messages: w.messages.slice(0, BOT_LIMITS.welcomeLines.free), goodbye: null } as BotSettings<K>;
    }
    case "helper":
      return { ...s, commands: [] } as BotSettings<K>;
    case "levels": {
      const f = free as BotSettings<"levels">;
      return { ...s, boost: f.boost, roleRewards: [], levelUpMessage: null } as BotSettings<K>;
    }
    case "logger":
      return { ...s, memberChannelId: null, excludeChannelIds: [] } as BotSettings<K>;
    case "starboard":
      return { ...s, emoji: null, selfStar: false, excludeChannelIds: [] } as BotSettings<K>;
    case "giveaways":
      return { ...s, requiredRoleId: null } as BotSettings<K>;
    case "tickets":
      return { ...s, panels: {}, transcripts: false } as BotSettings<K>;
  }
  return s;
}
