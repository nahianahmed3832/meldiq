import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import { ApiError } from "../../shared/errors.js";

export type BotMediaRemoval = {
  lease_id: string;
  bot_id: string;
  call_id: string;
  room_name: string;
  created_at: number;
};
/** Durable denial/removal metadata only. Independent of identity and call deletion. */
export class BotVoiceLedger {
  constructor(private readonly db: MeldiqPostgres) {}
  async remember(row: BotMediaRemoval) {
    await this.db.transaction(async () => {
      await this.db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('meldiq-bot-voice-leases',0))",
      );
      const count = await this.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM meldiq_private.bot_media_evictions",
      );
      if (Number(count.rows[0].count) >= 128)
        throw new ApiError(
          429,
          "rate_limited",
          "Bot media cleanup must finish before another voice lease can start",
        );
      await this.db.query(
        "INSERT INTO meldiq_private.bot_media_evictions(lease_id,bot_id,call_id,room_name,created_at) VALUES($1,$2,$3,$4,$5)",
        [row.lease_id, row.bot_id, row.call_id, row.room_name, row.created_at],
      );
    });
  }
  async pending(): Promise<BotMediaRemoval[]> {
    return (
      await this.db.query<BotMediaRemoval>(
        "SELECT * FROM meldiq_private.bot_media_evictions ORDER BY created_at,lease_id LIMIT 128",
      )
    ).rows;
  }
  async forget(id: string) {
    await this.db.query(
      "DELETE FROM meldiq_private.bot_media_evictions WHERE lease_id=$1",
      [id],
    );
  }
}
