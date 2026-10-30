import type { z } from "zod/v4";
import type { WordyGame } from "../../shared/contracts/http/officialBotTools.js";
import { ApiError } from "../../shared/errors.js";
import type { Command } from "./commands.js";
import type { MessagePosted } from "./events.js";
import type { ActiveBot, OfficialBots } from "./runtime.js";
import { board, dailyWord, dayBefore, dayOf, isWord, MAX_TRIES, puzzleNumber, score, squares, WORD_LENGTH } from "./wordyGame.js";

export const WORDY_COMMANDS: readonly string[] = ["wordy"];
/** Games are kept this long (the recap reads yesterday's). */
const KEEP_DAYS = 7;
const TOP = 5;
const BAR_MAX = 10;

type Bot = ActiveBot<"wordy">;

/** A member's game of one day (bot_wordy_games, migration 076). */
interface GameRow {
  org_id: string;
  day: string;
  user_id: string;
  /** JSON: the words guessed, in order. */
  guesses: string;
  solved: number;
  started_at: number;
  finished_at: number | null;
}

/** A member's record in a community (bot_wordy_stats). */
interface StatsRow {
  org_id: string;
  user_id: string;
  played: number;
  won: number;
  streak: number;
  best_streak: number;
  last_day: string;
  last_won_day: string | null;
  /** JSON: wins in 1..6 tries. */
  distribution: string;
}

type Outcome = { kind: "invalid"; reason: "length" | "word" } | { kind: "done"; game: GameRow } | { kind: "played"; game: GameRow; finished: boolean };

const guessesOf = (g: GameRow | undefined): string[] => (g ? (JSON.parse(g.guesses) as string[]) : []);
const tries = (g: GameRow): string => `${g.solved ? guessesOf(g).length : "X"}/${MAX_TRIES}`;

/** The streak still counts while the last win was today or yesterday. */
function liveStreak(s: StatsRow | undefined, today: string): number {
  return s && (s.last_won_day === today || s.last_won_day === dayBefore(today)) ? s.streak : 0;
}

/** [s] after finishing [day]'s game (solved in [n] tries, or not). */
function afterGame(s: StatsRow | undefined, orgId: string, userId: string, day: string, solved: boolean, n: number): StatsRow {
  const dist = s ? (JSON.parse(s.distribution) as number[]) : Array<number>(MAX_TRIES).fill(0);
  const streak = solved ? (s?.last_won_day === dayBefore(day) ? s.streak : 0) + 1 : 0;
  return {
    org_id: orgId,
    user_id: userId,
    played: (s?.played ?? 0) + 1,
    won: (s?.won ?? 0) + (solved ? 1 : 0),
    streak,
    best_streak: Math.max(s?.best_streak ?? 0, streak),
    last_day: day,
    last_won_day: solved ? day : (s?.last_won_day ?? null),
    distribution: JSON.stringify(dist.map((x, i) => (solved && i === n - 1 ? x + 1 : x))),
  };
}

/** Starts [userId]'s game of the day in [orgId] when there's none yet; returns it. */
async function startGame(rt: OfficialBots, orgId: string, userId: string, at: number): Promise<GameRow> {
  const key = { org_id: orgId, day: dayOf(at), user_id: userId };
  return rt.ctx.ws.write((w) => {
    const known = w.get<GameRow>("bot_wordy_games", key);
    if (known) return known;
    const row: GameRow = { ...key, guesses: "[]", solved: 0, started_at: at, finished_at: null };
    w.insert("bot_wordy_games", { ...row });
    return row;
  });
}

/**
 * One guess at today's word (started on the first one). Words that aren't five letters or aren't in Wordy's list don't
 * use up a try. The sixth miss, or the answer, finishes the game and updates the member's record in the same write.
 */
export async function guess(rt: OfficialBots, orgId: string, userId: string, raw: string, at: number): Promise<Outcome> {
  const word = raw.trim().toLowerCase();
  if (!new RegExp(`^[a-z]{${WORD_LENGTH}}$`).test(word)) return { kind: "invalid", reason: "length" };
  if (!isWord(word)) return { kind: "invalid", reason: "word" };
  const day = dayOf(at);
  const answer = dailyWord(orgId, day);
  return rt.ctx.ws.write((w): Outcome => {
    const key = { org_id: orgId, day, user_id: userId };
    const before = w.get<GameRow>("bot_wordy_games", key);
    if (before?.finished_at != null) return { kind: "done", game: before };
    const guesses = [...guessesOf(before), word];
    const solved = word === answer;
    const finished = solved || guesses.length >= MAX_TRIES;
    const game: GameRow = { ...key, guesses: JSON.stringify(guesses), solved: solved ? 1 : 0, started_at: before?.started_at ?? at, finished_at: finished ? at : null };
    w.upsert("bot_wordy_games", { ...game }, "replace");
    if (finished) w.upsert("bot_wordy_stats", { ...afterGame(w.get<StatsRow>("bot_wordy_stats", { org_id: orgId, user_id: userId }), orgId, userId, day, solved, guesses.length) }, "replace");
    return { kind: "played", game, finished };
  });
}

/** The line Wordy posts for a finished game: the board, never the letters. */
function resultLine(rt: OfficialBots, g: GameRow): string {
  const name = rt.nameOf(g.user_id);
  const rows = board(guessesOf(g), dailyWord(g.org_id, g.day));
  const n = puzzleNumber(g.day);
  if (!g.solved) return `🔤 ${name} is out of tries on Wordy #${n} (${tries(g)}).\n${rows}\nThe word stays secret until tomorrow's recap.`;
  const s = rt.ctx.ws.get<StatsRow>("bot_wordy_stats", { org_id: g.org_id, user_id: g.user_id });
  return `🎉 ${name} solved Wordy #${n} in ${tries(g)}!\n${rows}\nStreak: ${liveStreak(s, g.day)} 🔥`;
}

/** What Wordy answers in its channel to [outcome]. */
function reply(rt: OfficialBots, outcome: Outcome): string {
  if (outcome.kind === "invalid") return outcome.reason === "length" ? "🔤 Wordy only takes five-letter words." : "🔤 That's not in Wordy's word list, so it doesn't use up a try.";
  const g = outcome.game;
  if (outcome.kind === "done") return `🔤 ${rt.nameOf(g.user_id)} has played Wordy #${puzzleNumber(g.day)} already (${tries(g)}). A new word comes at 00:00 UTC.`;
  if (outcome.finished) return resultLine(rt, g);
  const rows = board(guessesOf(g), dailyWord(g.org_id, g.day));
  return `🔤 ${rt.nameOf(g.user_id)} · Wordy #${puzzleNumber(g.day)} · ${guessesOf(g).length}/${MAX_TRIES}\n${rows}`;
}

/** "!wordy stats": yours, then the best solvers here (current members, most wins first). */
function statsLine(rt: OfficialBots, orgId: string, userId: string, today: string): string {
  const mine = rt.ctx.ws.get<StatsRow>("bot_wordy_stats", { org_id: orgId, user_id: userId });
  const name = rt.nameOf(userId);
  const own = mine
    ? `📊 ${name}: ${mine.played} played · ${mine.won} won (${Math.round((100 * mine.won) / mine.played)}%) · streak ${liveStreak(mine, today)} (best ${mine.best_streak})`
    : `📊 ${name} hasn't finished a Wordy here yet.`;
  const top = rt.ctx.ws
    .all<StatsRow>("bot_wordy_stats", { where: { org_id: orgId, won: { gt: 0 } }, orderBy: [["won", "desc"], ["best_streak", "desc"], ["user_id", "asc"]], limit: TOP * 4 })
    .filter((s) => rt.ctx.authz.orgRole(orgId, s.user_id) !== null)
    .slice(0, TOP);
  if (top.length === 0) return own;
  const names = rt.people(top.map((s) => s.user_id));
  const lines = top.map((s, i) => `${i + 1}. ${names.get(s.user_id)?.displayName ?? "Someone"} · ${s.won} won · streak ${liveStreak(s, today)}`);
  return `${own}\nBest solvers here:\n${lines.join("\n")}`;
}

/** !wordy (start or show), !wordy stats, !wordy word; /wordy reads the same. Played in Wordy's channel only. */
export async function runWordyCommand(rt: OfficialBots, bot: Bot, ev: MessagePosted, cmd: Command): Promise<void> {
  const channelId = bot.settings.channelId;
  if (!channelId || !rt.textChannel(bot.orgId, channelId)) return;
  if (ev.conversationId !== channelId) {
    await rt.chat(bot, ev.conversationId, `🔤 Wordy is played in #${rt.ctx.authz.conversation(channelId)?.name ?? "its channel"}.`);
    return;
  }
  const arg = cmd.args.trim().toLowerCase();
  const say = (text: string) => rt.post(bot, channelId, { type: "text", text });
  if (arg === "stats") {
    await say(statsLine(rt, bot.orgId, ev.userId, dayOf(ev.at)));
    return;
  }
  if (arg) {
    await say(reply(rt, await guess(rt, bot.orgId, ev.userId, arg, ev.at)));
    return;
  }
  const g = await startGame(rt, bot.orgId, ev.userId, ev.at);
  if (g.finished_at !== null) await say(reply(rt, { kind: "done", game: g }));
  else if (guessesOf(g).length) await say(reply(rt, { kind: "played", game: g, finished: false }));
  else await say(`🔤 Wordy #${puzzleNumber(g.day)} is on, ${rt.nameOf(ev.userId)}: six tries at today's five-letter word. Type a word here, or !wordy word.`);
}

/** A bare five-letter word in Wordy's channel from someone with a game running is a guess. True when it was one. */
export async function maybeGuess(rt: OfficialBots, bot: Bot, ev: MessagePosted, text: string): Promise<boolean> {
  if (ev.conversationId !== bot.settings.channelId || !new RegExp(`^[a-z]{${WORD_LENGTH}}$`, "i").test(text)) return false;
  const g = rt.ctx.ws.get<GameRow>("bot_wordy_games", { org_id: bot.orgId, day: dayOf(ev.at), user_id: ev.userId });
  if (!g || g.finished_at !== null) return false;
  await rt.post(bot, ev.conversationId, { type: "text", text: reply(rt, await guess(rt, bot.orgId, ev.userId, text, ev.at)) });
  return true;
}

// ───────────── Playing from the apps (/wordy), privately ─────────────

function requireWordy(rt: OfficialBots, orgId: string, userId: string): Bot {
  rt.requireEnabled();
  rt.ctx.authz.requireOrgMember(orgId, userId);
  const bot = rt.active(orgId).wordy;
  if (!bot) throw new ApiError(409, "official_bot_off", "Wordy isn't on in this community.");
  return bot;
}

/** The viewer's game of the day with its letters (theirs alone), and their record. */
export function gameView(rt: OfficialBots, orgId: string, userId: string, at: number): z.infer<typeof WordyGame> {
  const bot = requireWordy(rt, orgId, userId);
  const day = dayOf(at);
  const g = rt.ctx.ws.get<GameRow>("bot_wordy_games", { org_id: orgId, day, user_id: userId });
  const answer = dailyWord(orgId, day);
  const s = rt.ctx.ws.get<StatsRow>("bot_wordy_stats", { org_id: orgId, user_id: userId });
  return {
    day,
    number: puzzleNumber(day),
    rows: guessesOf(g).map((x) => ({ guess: x, marks: squares(score(x, answer)) })),
    maxTries: MAX_TRIES,
    finished: g?.finished_at != null,
    solved: g?.solved === 1,
    channelId: bot.settings.channelId,
    stats: {
      played: s?.played ?? 0,
      won: s?.won ?? 0,
      streak: liveStreak(s, day),
      bestStreak: s?.best_streak ?? 0,
      distribution: s ? (JSON.parse(s.distribution) as number[]) : Array<number>(MAX_TRIES).fill(0),
    },
  };
}

/** A guess from the apps: nobody sees the letters; the finished board (squares only) goes to Wordy's channel. */
export async function guessPrivately(rt: OfficialBots, orgId: string, userId: string, raw: string): Promise<z.infer<typeof WordyGame>> {
  const bot = requireWordy(rt, orgId, userId);
  const at = rt.clock();
  const outcome = await guess(rt, orgId, userId, raw, at);
  if (outcome.kind === "invalid") throw new ApiError(400, "wordy_not_a_word", outcome.reason === "length" ? "Wordy only takes five-letter words." : "That's not in Wordy's word list.");
  if (outcome.kind === "done") throw new ApiError(409, "wordy_finished", "You've played today's word. A new one comes at 00:00 UTC.");
  if (outcome.finished && bot.settings.channelId) await rt.post(bot, bot.settings.channelId, { type: "text", text: resultLine(rt, outcome.game) });
  return gameView(rt, orgId, userId, at);
}

// ───────────── The daily recap ─────────────

/** "2/6 ▏🟩🟩 2": one line of the recap's distribution. */
function bar(label: string, n: number, most: number): string {
  const len = most ? Math.round((n / most) * BAR_MAX) : 0;
  return `${label} ▏${"🟩".repeat(n ? Math.max(len, 1) : 0)} ${n}`;
}

async function recap(rt: OfficialBots, bot: Bot, channelId: string, day: string, at: number): Promise<void> {
  const claimed = await rt.ctx.ws.write((w) => w.insert("bot_wordy_recaps", { org_id: bot.orgId, day, posted_at: at }, { orIgnore: true }).inserted);
  if (!claimed) return;
  const games = rt.ctx.ws.all<GameRow>("bot_wordy_games", { where: { org_id: bot.orgId, day, finished_at: { ne: null } } });
  if (games.length === 0) return;
  const solved = games.filter((g) => g.solved === 1);
  const counts = Array.from({ length: MAX_TRIES }, (_, i) => solved.filter((g) => guessesOf(g).length === i + 1).length);
  const most = Math.max(...counts, games.length - solved.length);
  const lines = [...counts.map((n, i) => bar(`${i + 1}/${MAX_TRIES}`, n, most)), bar(`X/${MAX_TRIES}`, games.length - solved.length, most)];
  const text = `🔤 Wordy #${puzzleNumber(day)} recap: the word was ${dailyWord(bot.orgId, day).toUpperCase()}.\n${solved.length} of ${games.length} solved it.\n${lines.join("\n")}\nToday's word is up: type !wordy to play.`;
  await rt.post(bot, channelId, { type: "text", text });
}

/**
 * The minute tick (scheduler.ts): each community with Wordy on and a channel posts yesterday's recap once (the first tick
 * after 00:00 UTC, or after a restart that day); games older than a week go.
 */
export async function postRecaps(rt: OfficialBots, at: number): Promise<void> {
  const yesterday = dayBefore(dayOf(at));
  const orgs = rt.ctx.ws.all<{ org_id: string }>("official_bots", { where: { bot_key: "wordy", enabled: 1 } }).map((r) => r.org_id);
  for (const orgId of orgs) {
    if (rt.ctx.ws.get("bot_wordy_recaps", { org_id: orgId, day: yesterday })) continue;
    const bot = rt.active(orgId).wordy;
    const channelId = bot ? rt.textChannel(orgId, bot.settings.channelId) : null;
    if (!bot || !channelId) continue;
    try {
      await recap(rt, bot, channelId, yesterday, at);
    } catch (err) {
      rt.ctx.log.warn({ err, orgId }, "official bots: Wordy recap not posted");
    }
  }
  const cutoff = dayOf(at - KEEP_DAYS * 86_400_000);
  if (rt.ctx.ws.count("bot_wordy_games", { day: { lt: cutoff } }) > 0) {
    await rt.ctx.ws.write((w) => {
      w.delete("bot_wordy_games", { day: { lt: cutoff } });
      w.delete("bot_wordy_recaps", { day: { lt: cutoff } });
    });
  }
}
