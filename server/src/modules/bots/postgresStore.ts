import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import { PostgresDocuments } from "../../infrastructure/database/postgres/documents.js";
import type { AnswerOutcome, Bot, BotStore, Interaction } from "./store.js";
import { MAX_PENDING_BOT_INTERACTIONS } from "../../shared/contracts/http/bots.js";
import { ApiError } from "../../shared/errors.js";
import { DuplicateDocument } from "../../infrastructure/database/documents.js";

const decode = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])) as T;

export class PostgresBotStore implements BotStore {
  readonly backend = "postgres" as const;
  private readonly bots: PostgresDocuments<Bot>;
  private readonly interactions: PostgresDocuments<Interaction>;
  constructor(private readonly db: MeldiqPostgres) {
    this.bots = new PostgresDocuments(db, "bots");
    this.interactions = new PostgresDocuments(db, "bot_interactions");
  }
  bot(id: string): Promise<Bot | null> { return this.bots.get(id); }
  async botsOf(ownerId: string): Promise<Bot[]> { return (await this.bots.find({ownerId})).sort((a, b) => a.createdAt - b.createdAt); }
  async botsByIds(ids: readonly string[]): Promise<Bot[]> {
    return (await this.db.query("SELECT * FROM meldiq.bots WHERE id=ANY($1::text[])", [[...ids]])).rows.map(row => decode<Bot>(row));
  }
  async botByToken(tokenHash: string): Promise<Bot | null> { return (await this.bots.find({tokenHash}, {limit: 1}))[0] ?? null; }
  async insertBot(bot: Bot): Promise<void> { await this.bots.insert(bot); }
  updateBot(id: string, patch: Partial<Pick<Bot, "public" | "tokenHash" | "tokenRotatedAt" | "commands">>): Promise<Bot | null> {
    return this.bots.update(id, {}, patch);
  }
  async deleteBot(id: string): Promise<void> { await this.bots.take(id); }
  async addInteraction(interaction: Interaction, admit?: () => void): Promise<void> { await this.db.transaction(async () => {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`meldiq-bot-pending:${interaction.botId}`]);
    if (await this.interactions.get(interaction.id)) throw new DuplicateDocument("Duplicate interaction");
    if (await this.openCount(interaction.botId, interaction.createdAt) >= MAX_PENDING_BOT_INTERACTIONS) throw new ApiError(429, "rate_limited", "This bot has too many interactions waiting");
    admit?.();
    await this.interactions.insert(interaction);
  }); }
  async openCount(botId: string, at: number): Promise<number> {
    return (await this.db.query<{count: number}>("SELECT count(*) AS count FROM meldiq.bot_interactions WHERE bot_id=$1 AND state<>'replied' AND expires_at>$2", [botId, at])).rows[0].count;
  }
  async claim(botId: string, at: number, redeliverBefore: number, limit: number): Promise<Interaction[]> {
    const rows = (await this.db.query(`WITH due AS (
      SELECT id FROM meldiq.bot_interactions WHERE bot_id=$1 AND expires_at>$2
      AND (state='pending' OR (state='delivered' AND delivered_at<=$3)) ORDER BY created_at,id LIMIT $4 FOR UPDATE SKIP LOCKED
    ) UPDATE meldiq.bot_interactions i SET state='delivered',delivered_at=$2 FROM due WHERE i.id=due.id RETURNING i.*`, [botId, at, redeliverBefore, limit])).rows;
    return rows.map(row => decode<Interaction>(row)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  interaction(id: string): Promise<Interaction | null> { return this.interactions.get(id); }
  async answer(id: string, botId: string, at: number): Promise<AnswerOutcome> {
    const result = await this.db.query("UPDATE meldiq.bot_interactions SET state='replied',replied_at=$3 WHERE id=$1 AND bot_id=$2 AND state<>'replied' AND expires_at>$3", [id, botId, at]);
    if (result.rowCount === 1) return "ok";
    const row = (await this.db.query<{state: string}>("SELECT state FROM meldiq.bot_interactions WHERE id=$1 AND bot_id=$2", [id, botId])).rows[0];
    return !row ? "missing" : row.state === "replied" ? "answered" : "expired";
  }
  async reopen(id: string): Promise<void> { await this.interactions.update(id, {}, {state: "delivered", repliedAt: null}); }
  async deleteInteractionsOf(userId: string): Promise<void> { await this.interactions.deleteMany({userId}); }
  async deleteInteractionsBetween(botId: string, userId: string): Promise<void> { await this.db.transaction(async () => {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`meldiq-bot-pending:${botId}`]);
    await this.interactions.deleteMany({botId, userId});
  }); }
  async purgeExpired(at: number): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.bot_interactions WHERE id IN (SELECT id FROM meldiq.bot_interactions WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 10000)", [at])).rowCount ?? 0;
  }
}
