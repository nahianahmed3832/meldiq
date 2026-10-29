import type { AppContext } from "../../app/context.js";
import type { OfficialBotKey } from "../../shared/contracts/http/officialBots.js";

/** A community's official bot (official_bots, migration 074). */
export interface BotRow {
  org_id: string;
  bot_key: OfficialBotKey;
  enabled: number;
  /** JSON, read with settings.ts storedSettings. */
  settings: string;
  look_name: string | null;
  /** Its hidden account in this community (null until it was first needed). */
  user_id: string | null;
  updated_by: string;
  updated_at: number;
}

export interface PlusRow {
  org_id: string;
  granted_by: string;
  granted_at: number;
  expires_at: number | null;
  reason: string;
}

export interface LevelRow {
  org_id: string;
  user_id: string;
  xp: number;
  last_xp_at: number;
}

export interface AfkRow {
  org_id: string;
  user_id: string;
  reason: string;
  since: number;
  /** JSON: who was told already. */
  notified: string;
}

export interface StarRow {
  message_id: string;
  org_id: string;
  channel_id: string;
  star_channel_id: string;
  star_message_id: string | null;
  stars: number;
  created_at: number;
}

/** Reads and writes of the official bots' tables (workspace rows: SQLite or MongoDB). */
export class BotRows {
  constructor(private readonly ctx: Pick<AppContext, "ws">) {}

  bot(orgId: string, key: OfficialBotKey): BotRow | undefined {
    return this.ctx.ws.get<BotRow>("official_bots", { org_id: orgId, bot_key: key });
  }

  bots(orgId: string): BotRow[] {
    return this.ctx.ws.all<BotRow>("official_bots", { where: { org_id: orgId } });
  }

  /** Whether [orgId] has any bot on: the hooks' one cheap check before queueing anything. */
  anyOn(orgId: string): boolean {
    return this.ctx.ws.count("official_bots", { org_id: orgId, enabled: 1 }) > 0;
  }

  /** The bot whose account [userId] is, if any. */
  byAccount(userId: string): BotRow | undefined {
    return this.ctx.ws.get<BotRow>("official_bots", { user_id: userId });
  }

  async save(row: BotRow): Promise<void> {
    const { org_id: _o, bot_key: _k, ...set } = row;
    await this.ctx.ws.write((w) => w.upsert("official_bots", { ...row }, set));
  }

  /** Records [userId] as the bot's account unless another one got there first; returns the one kept. */
  async claimAccount(orgId: string, key: OfficialBotKey, userId: string, actorId: string, at: number, defaults: string): Promise<string> {
    return this.ctx.ws.write((w) => {
      const row = w.get<BotRow>("official_bots", { org_id: orgId, bot_key: key });
      if (row?.user_id) return row.user_id;
      if (row) w.update("official_bots", { org_id: orgId, bot_key: key }, { user_id: userId });
      else w.insert("official_bots", { org_id: orgId, bot_key: key, enabled: 0, settings: defaults, look_name: null, user_id: userId, updated_by: actorId, updated_at: at });
      return userId;
    });
  }

  plus(orgId: string): PlusRow | undefined {
    return this.ctx.ws.get<PlusRow>("official_bots_plus", { org_id: orgId });
  }

  async setPlus(row: PlusRow | null, orgId: string): Promise<void> {
    await this.ctx.ws.write((w) => {
      if (row) w.upsert("official_bots_plus", { ...row }, "replace");
      else w.delete("official_bots_plus", { org_id: orgId });
    });
  }

  /** Account deletion: their XP and away notes everywhere. */
  async forgetUser(userId: string): Promise<void> {
    if (this.ctx.ws.count("bot_levels", { user_id: userId }) + this.ctx.ws.count("bot_afk", { user_id: userId }) === 0) return;
    await this.ctx.ws.write((w) => {
      w.delete("bot_levels", { user_id: userId });
      w.delete("bot_afk", { user_id: userId });
    });
  }
}
