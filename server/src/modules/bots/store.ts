import type { BotCommand } from "../../shared/contracts/http/bots.js";

/** A bot people made. Its id is its account's user id; only its token's hash is kept. */
export interface Bot {
  id: string;
  ownerId: string;
  tokenHash: string;
  public: boolean;
  commands: BotCommand[];
  createdAt: number;
  tokenRotatedAt: number;
}

export type OptionValue = string | number | boolean;
export type InteractionState = "pending" | "delivered" | "replied";

/** Someone ran one of a bot's slash commands in a channel: waiting for the bot to take it and answer. */
export interface Interaction {
  id: string;
  botId: string;
  userId: string;
  orgId: string;
  conversationId: string;
  command: string;
  options: Record<string, OptionValue>;
  state: InteractionState;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  repliedAt: number | null;
}

export type AnswerOutcome = "ok" | "missing" | "expired" | "answered";

/**
 * Where bots and their interactions live (API 0.65.0): MongoDB whenever the server has one (bots, bot_interactions:
 * new data goes to MongoDB), otherwise this process's memory (development and tests). Handing an interaction out and
 * answering it are single conditional updates, so two polls never get the same one at once and it's answered once.
 */
export interface BotStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  bot(id: string): Promise<Bot | null>;
  botsOf(ownerId: string): Promise<Bot[]>;
  botsByIds(ids: readonly string[]): Promise<Bot[]>;
  botByToken(tokenHash: string): Promise<Bot | null>;
  insertBot(bot: Bot): Promise<void>;
  updateBot(id: string, patch: Partial<Pick<Bot, "public" | "tokenHash" | "tokenRotatedAt" | "commands">>): Promise<Bot | null>;
  /** Removes the bot and its interactions. */
  deleteBot(id: string): Promise<void>;
  addInteraction(i: Interaction): Promise<void>;
  /** Interactions of [botId] still waiting to be answered. */
  openCount(botId: string, at: number): Promise<number>;
  /**
   * Hands out up to [limit] of [botId]'s interactions, oldest first: those never handed out, and those handed out
   * before [redeliverBefore] and still unanswered. Each is marked delivered at [at].
   */
  claim(botId: string, at: number, redeliverBefore: number, limit: number): Promise<Interaction[]>;
  interaction(id: string): Promise<Interaction | null>;
  /** Marks it replied if it's [botId]'s, unanswered and not expired at [at]. */
  answer(id: string, botId: string, at: number): Promise<AnswerOutcome>;
  /** Back to delivered (its answer couldn't be posted), so the bot can answer again. */
  reopen(id: string): Promise<void>;
  deleteInteractionsOf(userId: string): Promise<void>;
  purgeExpired(at: number): Promise<number>;
}

const copyBot = (b: Bot): Bot => ({ ...b, commands: structuredClone(b.commands) });
const copyInteraction = (i: Interaction): Interaction => ({ ...i, options: { ...i.options } });

export class MemoryBotStore implements BotStore {
  readonly backend = "memory" as const;
  private readonly bots = new Map<string, Bot>();
  private readonly interactions = new Map<string, Interaction>();

  async bot(id: string): Promise<Bot | null> {
    const b = this.bots.get(id);
    return b ? copyBot(b) : null;
  }

  async botsOf(ownerId: string): Promise<Bot[]> {
    return [...this.bots.values()].filter((b) => b.ownerId === ownerId).sort((a, b) => a.createdAt - b.createdAt).map(copyBot);
  }

  async botsByIds(ids: readonly string[]): Promise<Bot[]> {
    return ids.flatMap((id) => (this.bots.has(id) ? [copyBot(this.bots.get(id)!)] : []));
  }

  async botByToken(tokenHash: string): Promise<Bot | null> {
    const b = [...this.bots.values()].find((x) => x.tokenHash === tokenHash);
    return b ? copyBot(b) : null;
  }

  async insertBot(bot: Bot): Promise<void> {
    this.bots.set(bot.id, copyBot(bot));
  }

  async updateBot(id: string, patch: Partial<Pick<Bot, "public" | "tokenHash" | "tokenRotatedAt" | "commands">>): Promise<Bot | null> {
    const b = this.bots.get(id);
    if (!b) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = copyBot({ ...b, ...defined });
    this.bots.set(id, next);
    return copyBot(next);
  }

  async deleteBot(id: string): Promise<void> {
    this.bots.delete(id);
    for (const [k, i] of this.interactions) if (i.botId === id) this.interactions.delete(k);
  }

  async addInteraction(i: Interaction): Promise<void> {
    this.interactions.set(i.id, copyInteraction(i));
  }

  async openCount(botId: string, at: number): Promise<number> {
    return [...this.interactions.values()].filter((i) => i.botId === botId && i.state !== "replied" && i.expiresAt > at).length;
  }

  async claim(botId: string, at: number, redeliverBefore: number, limit: number): Promise<Interaction[]> {
    const due = [...this.interactions.values()]
      .filter((i) => i.botId === botId && i.expiresAt > at && (i.state === "pending" || (i.state === "delivered" && (i.deliveredAt ?? 0) <= redeliverBefore)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    for (const i of due) this.interactions.set(i.id, { ...i, state: "delivered", deliveredAt: at });
    return due.map((i) => copyInteraction({ ...i, state: "delivered", deliveredAt: at }));
  }

  async interaction(id: string): Promise<Interaction | null> {
    const i = this.interactions.get(id);
    return i ? copyInteraction(i) : null;
  }

  async answer(id: string, botId: string, at: number): Promise<AnswerOutcome> {
    const i = this.interactions.get(id);
    if (!i || i.botId !== botId) return "missing";
    if (i.state === "replied") return "answered";
    if (i.expiresAt <= at) return "expired";
    this.interactions.set(id, { ...i, state: "replied", repliedAt: at });
    return "ok";
  }

  async reopen(id: string): Promise<void> {
    const i = this.interactions.get(id);
    if (i) this.interactions.set(id, { ...i, state: "delivered", repliedAt: null });
  }

  async deleteInteractionsOf(userId: string): Promise<void> {
    for (const [k, i] of this.interactions) if (i.userId === userId) this.interactions.delete(k);
  }

  async purgeExpired(at: number): Promise<number> {
    let n = 0;
    for (const [k, i] of this.interactions) if (i.expiresAt <= at) n += Number(this.interactions.delete(k));
    return n;
  }
}
