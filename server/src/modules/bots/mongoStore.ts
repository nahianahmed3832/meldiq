import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../infrastructure/database/mongo/client.js";
import type { BotCommand } from "../../shared/contracts/http/bots.js";
import type { AnswerOutcome, Bot, BotStore, Interaction, InteractionState, OptionValue } from "./store.js";

/** bots: one document per bot, keyed by its account's user id. */
interface BotDoc {
  _id: string;
  owner_id: string;
  token_hash: string;
  public: boolean;
  commands: BotCommand[];
  created_at: number;
  token_rotated_at: number;
}

/** bot_interactions: slash commands people ran, kept until a while after they expire. */
interface InteractionDoc {
  _id: string;
  bot_id: string;
  user_id: string;
  org_id: string | null;
  conversation_id: string;
  command: string;
  options: Record<string, OptionValue>;
  state: InteractionState;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
  replied_at: number | null;
}

const fromBot = (d: BotDoc): Bot => ({ id: d._id, ownerId: d.owner_id, tokenHash: d.token_hash, public: d.public, commands: d.commands, createdAt: d.created_at, tokenRotatedAt: d.token_rotated_at });
const fromInteraction = (d: InteractionDoc): Interaction => ({
  id: d._id,
  botId: d.bot_id,
  userId: d.user_id,
  orgId: d.org_id,
  conversationId: d.conversation_id,
  command: d.command,
  options: d.options,
  state: d.state,
  createdAt: d.created_at,
  expiresAt: d.expires_at,
  deliveredAt: d.delivered_at,
  repliedAt: d.replied_at,
});
const BOT_FIELDS = { public: "public", tokenHash: "token_hash", tokenRotatedAt: "token_rotated_at", commands: "commands" } as const;

/** Bots in MongoDB (API 0.65.0). New data: no domain migration, no validators. Times are epoch milliseconds. */
export class MongoBotStore implements BotStore {
  readonly backend = "mongodb" as const;
  private readonly bots: Collection<BotDoc>;
  private readonly interactions: Collection<InteractionDoc>;

  constructor(mongo: MeldiqMongo) {
    this.bots = mongo.db.collection<BotDoc>("bots");
    this.interactions = mongo.db.collection<InteractionDoc>("bot_interactions");
  }

  async ensureIndexes(): Promise<void> {
    await this.bots.createIndex({ owner_id: 1, created_at: 1 }, { name: "owner_created" });
    await this.bots.createIndex({ token_hash: 1 }, { name: "token_hash", unique: true });
    await this.interactions.createIndex({ bot_id: 1, state: 1, created_at: 1 }, { name: "bot_state_created" });
    await this.interactions.createIndex({ user_id: 1 }, { name: "user_id" });
    await this.interactions.createIndex({ expires_at: 1 }, { name: "expires_at" });
  }

  async bot(id: string): Promise<Bot | null> {
    const d = await this.bots.findOne({ _id: id });
    return d ? fromBot(d) : null;
  }

  async botsOf(ownerId: string): Promise<Bot[]> {
    return (await this.bots.find({ owner_id: ownerId }).sort({ created_at: 1 }).toArray()).map(fromBot);
  }

  async botsByIds(ids: readonly string[]): Promise<Bot[]> {
    if (!ids.length) return [];
    return (await this.bots.find({ _id: { $in: [...ids] } }).toArray()).map(fromBot);
  }

  async botByToken(tokenHash: string): Promise<Bot | null> {
    const d = await this.bots.findOne({ token_hash: tokenHash });
    return d ? fromBot(d) : null;
  }

  async insertBot(b: Bot): Promise<void> {
    await this.bots.insertOne({ _id: b.id, owner_id: b.ownerId, token_hash: b.tokenHash, public: b.public, commands: b.commands, created_at: b.createdAt, token_rotated_at: b.tokenRotatedAt });
  }

  async updateBot(id: string, patch: Partial<Pick<Bot, "public" | "tokenHash" | "tokenRotatedAt" | "commands">>): Promise<Bot | null> {
    const set: Record<string, unknown> = {};
    for (const [k, field] of Object.entries(BOT_FIELDS)) {
      const v = patch[k as keyof typeof BOT_FIELDS];
      if (v !== undefined) set[field] = v;
    }
    const d = Object.keys(set).length
      ? await this.bots.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" })
      : await this.bots.findOne({ _id: id });
    return d ? fromBot(d) : null;
  }

  async deleteBot(id: string): Promise<void> {
    await this.bots.deleteOne({ _id: id });
    await this.interactions.deleteMany({ bot_id: id });
  }

  async addInteraction(i: Interaction, admit?: () => void): Promise<void> {
    admit?.();
    await this.interactions.insertOne({
      _id: i.id,
      bot_id: i.botId,
      user_id: i.userId,
      org_id: i.orgId,
      conversation_id: i.conversationId,
      command: i.command,
      options: i.options,
      state: i.state,
      created_at: i.createdAt,
      expires_at: i.expiresAt,
      delivered_at: i.deliveredAt,
      replied_at: i.repliedAt,
    });
  }

  async openCount(botId: string, at: number): Promise<number> {
    return this.interactions.countDocuments({ bot_id: botId, state: { $ne: "replied" }, expires_at: { $gt: at } });
  }

  async claim(botId: string, at: number, redeliverBefore: number, limit: number): Promise<Interaction[]> {
    const due = { bot_id: botId, expires_at: { $gt: at }, $or: [{ state: "pending" as const }, { state: "delivered" as const, delivered_at: { $lte: redeliverBefore } }] };
    const out: Interaction[] = [];
    // One at a time, each a conditional update: a concurrent poll can't take the same one.
    while (out.length < limit) {
      const d = await this.interactions.findOneAndUpdate(due, { $set: { state: "delivered", delivered_at: at } }, { sort: { created_at: 1 }, returnDocument: "after" });
      if (!d) break;
      out.push(fromInteraction(d));
    }
    return out;
  }

  async interaction(id: string): Promise<Interaction | null> {
    const d = await this.interactions.findOne({ _id: id });
    return d ? fromInteraction(d) : null;
  }

  async answer(id: string, botId: string, at: number): Promise<AnswerOutcome> {
    const r = await this.interactions.updateOne({ _id: id, bot_id: botId, state: { $ne: "replied" }, expires_at: { $gt: at } }, { $set: { state: "replied", replied_at: at } });
    if (r.modifiedCount === 1) return "ok";
    const i = await this.interactions.findOne({ _id: id, bot_id: botId });
    if (!i) return "missing";
    return i.state === "replied" ? "answered" : "expired";
  }

  async reopen(id: string): Promise<void> {
    await this.interactions.updateOne({ _id: id }, { $set: { state: "delivered", replied_at: null } });
  }

  async deleteInteractionsOf(userId: string): Promise<void> {
    await this.interactions.deleteMany({ user_id: userId });
  }
  async deleteInteractionsBetween(botId: string, userId: string): Promise<void> {
    await this.interactions.deleteMany({ bot_id: botId, user_id: userId });
  }

  async purgeExpired(at: number): Promise<number> {
    return (await this.interactions.deleteMany({ expires_at: { $lte: at } })).deletedCount;
  }
}
