import type { AppContext } from "../../app/context.js";
import type { PointsView } from "../../shared/contracts/http/points.js";
import { ApiError } from "../../shared/errors.js";
import {
  accountFacts,
  announceProfileChange,
  createdBefore,
  isBotUser,
} from "../accounts/index.js";
import { communityCount } from "../organizations/index.js";
import {
  entryId,
  monthStart,
  nextDayStart,
  POINTS,
  previousDay,
  type QuestId,
  QUESTS,
  type QuestSpec,
  questSpec,
  scaled,
  utcDay,
} from "./rules.js";
import type { InviteJoin, PointsAccount, PointsKind, PointsStore } from "./store.js";
import {
  ACHIEVEMENTS,
  type AchievementAward,
  type AchievementProgress,
} from "./achievements.js";

/** What a sent message or control tells the points module (from POST /v2/messages, after it was accepted). */
export interface SentMessage {
  userId: string;
  conversationId: string;
  messageId: string;
  cls: "message" | "control";
  payload: Record<string, unknown>;
  at: number;
}

/**
 * Points, quests and levels (API 0.65.0, docs/SETTINGS_PARITY_API.md). Everything is decided here from what the
 * server saw: a check-in, messages it stored, joins through invites, the profile and account as they are. Each earning
 * has an id (rules.ts entryId), so it counts once however often it's reported. Levels are kept in memory as well, for
 * profiles (built synchronously); every change goes to the store first.
 */
export class PointsService {
  private readonly levels = new Map<string, number>();
  private readonly achievements = new Map<string, Map<string, number>>();

  constructor(
    private readonly ctx: AppContext,
    readonly store: PointsStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    // Apply the same rule to Embers earned before automatic levels were introduced.
    const t = this.clock();
    for (const userId of await this.store.readyToLevel(POINTS.levelCost)) {
      if (this.earning(userId, t)) await this.advanceLevels(userId, t, false);
    }
    for (const [userId, level] of await this.store.levels())
      this.levels.set(userId, Math.max(level, this.levelOf(userId)));
    this.keepAwards(await this.store.achievementAwards());
  }

  achievementCatalog() {
    return ACHIEVEMENTS;
  }

  earnedAchievements(userId: string) {
    const held = this.achievements.get(userId);
    return ACHIEVEMENTS.flatMap((a) =>
      held?.has(a.id) ? [{ ...a, earnedAt: held.get(a.id)! }] : [],
    );
  }

  private keepAwards(awards: AchievementAward[]): void {
    for (const award of awards) {
      if (!ACHIEVEMENTS.some((a) => a.id === award.achievementId)) continue;
      const held =
        this.achievements.get(award.userId) ?? new Map<string, number>();
      held.set(award.achievementId, award.at);
      this.achievements.set(award.userId, held);
    }
  }

  private async unlockAchievements(
    userId: string,
    progress: AchievementProgress,
    at: number,
  ): Promise<void> {
    const held = this.achievements.get(userId) ?? new Map<string, number>();
    let changed = false;
    for (const a of ACHIEVEMENTS) {
      if (held.has(a.id) || progress[a.metric] < a.goal) continue;
      const earned = await this.store.earn({
        id: `achievement:${userId}:${a.id}`,
        userId,
        kind: "quest",
        amount: 0,
        detail: `achievement:${a.id}`,
        day: utcDay(at),
        at,
      });
      if (earned) {
        held.set(a.id, at);
        changed = true;
      } else this.keepAwards(await this.store.achievementAwards(userId));
    }
    const merged = this.achievements.get(userId) ?? new Map<string, number>();
    for (const [id, when] of held) merged.set(id, when);
    this.achievements.set(userId, merged);
    if (changed) announceProfileChange(this.ctx, userId);
  }

  /** [userId]'s account level (1 until they earn the first level). */
  levelOf(userId: string): number {
    return this.levels.get(userId) ?? 1;
  }

  /** Counts today's visit once a UTC day, and the streak bonus every 7th day in a row. */
  async checkin(
    userId: string,
  ): Promise<{ counted: boolean; points: PointsView }> {
    const t = this.clock();
    const day = utcDay(t);
    const counted =
      this.earning(userId, t) &&
      (await this.award(
        userId,
        entryId.visit(userId, day),
        "visit",
        POINTS.visit,
        null,
        t,
      ));
    if (counted) {
      const a = await this.store.account(userId);
      const streak = a?.lastVisitDay === previousDay(day) ? a.streak + 1 : 1;
      await this.store.setStreak(userId, day, streak);
      if (streak % POINTS.streakDays === 0)
        await this.award(
          userId,
          entryId.streak(userId, day),
          "streak",
          POINTS.streakBonus,
          String(streak),
          t,
        );
    }
    return { counted, points: await this.view(userId) };
  }

  /** Chat minutes and the daily chat, reaction and reply quests, from a message the server stored. */
  async noteMessage(m: SentMessage): Promise<void> {
    if (!this.earning(m.userId, m.at)) return;
    const day = utcDay(m.at);
    if (m.cls === "message") {
      const minutes = await this.store.addToDay(
        m.userId,
        day,
        "minutes",
        Math.floor(m.at / 60_000),
        POINTS.chatDailyMinutes,
      );
      if (minutes !== null && minutes % POINTS.chatBlockMinutes === 0) {
        const block = minutes / POINTS.chatBlockMinutes;
        await this.award(
          m.userId,
          entryId.chat(m.userId, day, block),
          "chat",
          POINTS.chatBlock,
          String(block),
          m.at,
        );
      }
      if (minutes !== null && minutes >= questSpec("daily-active").goal)
        await this.claim(m.userId, questSpec("daily-active"), m.at);
      await this.progressDaily(
        m.userId,
        "daily-chats",
        "chats",
        m.conversationId,
        m.at,
      );
      const replyTo =
        typeof m.payload.replyTo === "string" ? m.payload.replyTo : null;
      if (replyTo && (await this.fromSomeoneElse(replyTo, m)))
        await this.progressDaily(
          m.userId,
          "daily-reply",
          "replied",
          replyTo,
          m.at,
        );
    } else if (
      m.payload.type === "reaction" &&
      m.payload.add !== false &&
      typeof m.payload.target === "string"
    ) {
      if (await this.fromSomeoneElse(m.payload.target, m))
        await this.progressDaily(
          m.userId,
          "daily-reactions",
          "reacted",
          m.payload.target,
          m.at,
        );
    }
  }

  /** Someone joined [orgId] through [inviterId]'s invite: credited once they've been there 7 days. */
  async noteInviteJoin(
    inviterId: string,
    joinerId: string,
    orgId: string,
    at: number,
  ): Promise<void> {
    if (inviterId === joinerId) return;
    await this.store.addInvite({
      id: `${orgId}|${joinerId}`,
      inviterId,
      joinerId,
      orgId,
      joinedAt: at,
      state: "pending",
      settledAt: null,
    });
  }

  /** Legacy endpoint: settle any eligible levels and return the current result. */
  async levelUp(
    userId: string,
  ): Promise<{ level: number; balance: number; nextLevelCost: number }> {
    const t = this.clock();
    const cost = POINTS.levelCost;
    const a = this.earning(userId, t)
      ? await this.advanceLevels(userId, t)
      : await this.store.account(userId);
    if (!a || a.level === 1) {
      const balance = a?.balance ?? 0;
      throw new ApiError(
        409,
        "not_enough_points",
        `The next level costs ${cost} Embers; you have ${balance}.`,
        { cost, balance },
      );
    }
    return { level: a.level, balance: a.balance, nextLevelCost: cost };
  }

  private async advanceLevels(userId: string, t: number, announce = true): Promise<PointsAccount | null> {
    const cost = POINTS.levelCost;
    let account = await this.store.account(userId);
    while (account && account.balance >= cost) {
      const next = await this.store.levelUp(userId, cost, (level) => ({
        id: entryId.level(userId, level),
        userId,
        kind: "level",
        amount: -cost,
        detail: String(level),
        day: utcDay(t),
        at: t,
      }));
      if (!next) {
        // Another award or device can finish the same advancement first.
        account = await this.store.account(userId);
        break;
      }
      account = next;
    }
    if (account && account.level > this.levelOf(userId)) {
      this.levels.set(userId, account.level);
      if (announce) announceProfileChange(this.ctx, userId);
    }
    return account;
  }

  /** Everything the points page shows; finished one-time quests and invites that are due are credited first. */
  async view(userId: string): Promise<PointsView> {
    const t = this.clock();
    const day = utcDay(t);
    const earning = this.earning(userId, t);
    const once = await this.onceProgress(userId);
    if (earning) {
      await this.claimOnce(userId, once, t);
      await this.settleInvites(userId, t);
      await this.advanceLevels(userId, t);
    }
    const [
      account,
      today,
      ledger,
      invites,
      visits,
      completedQuests,
      chatBlocks,
    ] = await Promise.all([
      this.store.account(userId),
      this.store.day(userId, day),
      this.store.history(userId, POINTS.historyRows + ACHIEVEMENTS.length),
      this.store.invitesBy(userId),
      this.store.countSince(userId, "visit", 0),
      this.store.countSince(userId, "quest", 0),
      this.store.countSince(userId, "chat", 0),
    ]);
    const history = ledger
      .filter((e) => !e.detail?.startsWith("achievement:"))
      .slice(0, POINTS.historyRows);
    const claimed = await this.store.recorded(
      QUESTS.map((q) => entryId.quest(userId, q, day)),
    );
    const multiplier = this.multiplier(userId);
    const daily: Record<string, number> = {
      "daily-chats": today?.chats.length ?? 0,
      "daily-reactions": today?.reacted.length ?? 0,
      "daily-reply": today?.replied.length ?? 0,
      "daily-conversations": today?.chats.length ?? 0,
      "daily-appreciation": today?.reacted.length ?? 0,
      "daily-thoughtful": today?.replied.length ?? 0,
      "daily-active": today?.minutes.length ?? 0,
    };
    const chatMinutes = today?.minutes.length ?? 0;
    const perBlock = scaled(POINTS.chatBlock, multiplier);
    const since = monthStart(t);
    const streak =
      account &&
      (account.lastVisitDay === day ||
        account.lastVisitDay === previousDay(day))
        ? account.streak
        : 0;
    const progress: AchievementProgress = {
      visits,
      streak,
      earned: account?.earnedTotal ?? 0,
      level: account?.level ?? 1,
      quests: completedQuests,
      invites: invites.filter((i) => i.state === "credited").length,
      communities: once.get("communities") ?? 0,
      chatBlocks,
    };
    if (earning) await this.unlockAchievements(userId, progress, t);
    const held = this.achievements.get(userId);
    return {
      balance: account?.balance ?? 0,
      earnedToday: today?.earned ?? 0,
      earnedTotal: account?.earnedTotal ?? 0,
      level: account?.level ?? 1,
      nextLevelCost: POINTS.levelCost,
      multiplier,
      streak,
      chatMinutesToday: chatMinutes,
      chatPointsToday:
        Math.floor(chatMinutes / POINTS.chatBlockMinutes) * perBlock,
      chatDailyCap:
        (POINTS.chatDailyMinutes / POINTS.chatBlockMinutes) * perBlock,
      earning,
      day,
      resetsAt: nextDayStart(t),
      quests: QUESTS.map((q) => {
        const done = claimed.has(entryId.quest(userId, q, day));
        const progress =
          q.kind === "daily" ? (daily[q.id] ?? 0) : (once.get(q.id) ?? 0);
        return {
          id: q.id,
          kind: q.kind,
          reward: scaled(q.reward, multiplier),
          progress: done ? q.goal : Math.min(progress, q.goal),
          goal: q.goal,
          state: done ? ("claimed" as const) : ("open" as const),
        };
      }),
      invites: {
        pending: invites.filter((i) => i.state === "pending").length,
        credited: invites.filter((i) => i.state === "credited").length,
        creditedThisMonth: invites.filter(
          (i) => i.state === "credited" && (i.settledAt ?? 0) >= since,
        ).length,
        monthlyLimit: POINTS.invitesPerMonth,
      },
      history: history.map((e) => ({
        kind: e.kind,
        amount: e.amount,
        detail: e.detail,
        at: e.at,
      })),
      achievements: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        category: a.metric,
        tier: a.tier,
        icon: a.icon,
        goal: a.goal,
        progress: held?.has(a.id)
          ? a.goal
          : Math.min(a.goal, progress[a.metric]),
        earnedAt: held?.get(a.id) ?? null,
      })),
    };
  }

  /** An account was deleted: its points, history and invites go. */
  async deleteForUser(userId: string): Promise<void> {
    await this.store.deleteForUser(userId);
    this.levels.delete(userId);
    this.achievements.delete(userId);
  }

  /** Whether [userId] earns now: a local, enabled person whose account is at least a day old. */
  private earning(userId: string, t: number): boolean {
    return createdBefore(this.ctx, userId, t - POINTS.newAccountMs + 1);
  }

  /** Mojo Plus members earn 1.5 times. */
  private multiplier(userId: string): number {
    return this.ctx.mojo?.planOf(userId) === "plus" ? POINTS.plusMultiplier : 1;
  }

  private async award(
    userId: string,
    id: string,
    kind: PointsKind,
    base: number,
    detail: string | null,
    t: number,
  ): Promise<boolean> {
    const earned = await this.store.earn({
      id,
      userId,
      kind,
      amount: scaled(base, this.multiplier(userId)),
      detail,
      day: utcDay(t),
      at: t,
    });
    if (earned) await this.advanceLevels(userId, t);
    return earned;
  }

  /** Whether [messageId] is a stored message in [m]'s conversation that someone other than [m]'s sender sent. */
  private async fromSomeoneElse(
    messageId: string,
    m: SentMessage,
  ): Promise<boolean> {
    const target = await this.ctx.messages.get(messageId);
    // API 0.65.0 batch B: bots never count for quests (reacting to or replying to a bot earns nothing).
    return (
      !!target &&
      target.conversation_id === m.conversationId &&
      target.sender_user_id !== m.userId &&
      !isBotUser(this.ctx, target.sender_user_id)
    );
  }

  /** Counts [value] toward a daily quest, and gives its reward the moment it's complete. */
  private async progressDaily(
    userId: string,
    id: QuestId,
    set: "chats" | "reacted" | "replied",
    value: string,
    t: number,
  ): Promise<void> {
    const extra: Record<typeof set, QuestId> = {
      chats: "daily-conversations",
      reacted: "daily-appreciation",
      replied: "daily-thoughtful",
    };
    const quests = [questSpec(id), questSpec(extra[set])];
    const count = await this.store.addToDay(
      userId,
      utcDay(t),
      set,
      value,
      Math.max(...quests.map((q) => q.goal)),
    );
    if (count !== null)
      for (const q of quests)
        if (count >= q.goal) await this.claim(userId, q, t);
  }

  private claim(userId: string, q: QuestSpec, t: number): Promise<boolean> {
    return this.award(
      userId,
      entryId.quest(userId, q, utcDay(t)),
      "quest",
      q.reward,
      q.id,
      t,
    );
  }

  /** Where each one-time quest stands, from the account as it is now. */
  private async onceProgress(userId: string): Promise<Map<QuestId, number>> {
    const f = await accountFacts(this.ctx, userId);
    if (!f) return new Map();
    return new Map<QuestId, number>([
      ["profile", Number(f.avatar) + Number(f.aboutMe)],
      ["friend", Number(f.friend)],
      ["communities", communityCount(this.ctx, userId)],
      ["decoration", Number(f.decoration)],
      ["two-step", Number(f.twoStep)],
      ["avatar", Number(f.avatar)],
      ["bio", Number(f.aboutMe)],
      ["banner", Number(f.banner)],
      ["pronouns", Number(f.pronouns)],
      ["first-community", communityCount(this.ctx, userId)],
      ["community-explorer", communityCount(this.ctx, userId)],
      ["close-circle", f.friends],
    ]);
  }

  private async claimOnce(
    userId: string,
    progress: Map<QuestId, number>,
    t: number,
  ): Promise<void> {
    const due = QUESTS.filter(
      (q) => q.kind === "once" && (progress.get(q.id) ?? 0) >= q.goal,
    );
    const done = await this.store.recorded(
      due.map((q) => entryId.quest(userId, q, utcDay(t))),
    );
    for (const q of due)
      if (!done.has(entryId.quest(userId, q, utcDay(t))))
        await this.claim(userId, q, t);
  }

  /** Joins through [userId]'s invites that are 7 days old: credited if the person stayed (10 a month at most). */
  private async settleInvites(userId: string, t: number): Promise<void> {
    const due = (await this.store.invitesBy(userId)).filter(
      (i) => i.state === "pending" && i.joinedAt + POINTS.inviteStayMs <= t,
    );
    for (const i of due) await this.settleInvite(userId, i, t);
  }

  private async settleInvite(
    userId: string,
    i: InviteJoin,
    t: number,
  ): Promise<void> {
    if (!this.ctx.authz.orgRole(i.orgId, i.joinerId)) {
      await this.store.settleInvite(i.id, "lapsed", t);
      return;
    }
    if (
      (await this.store.countSince(userId, "invite", monthStart(t))) >=
      POINTS.invitesPerMonth
    ) {
      await this.store.settleInvite(i.id, "capped", t);
      return;
    }
    if (await this.store.settleInvite(i.id, "credited", t))
      await this.award(
        userId,
        entryId.invite(i.id),
        "invite",
        POINTS.invite,
        i.orgId,
        t,
      );
  }
}
