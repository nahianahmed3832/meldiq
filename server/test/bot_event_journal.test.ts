import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "private commit-ordered bot journal",
  () => {
    let h: Harness, botId: string;
    beforeAll(async () => {
      h = await startServer();
      const owner = await h.client("eventjournalowner");
      botId = (
        await owner.req("POST", "/v2/developer/bots", { name: "Journal bot" })
      ).bot.id;
    });
    afterAll(async () => {
      await h?.close();
    });

    it("does not advance the visible watermark past an uncommitted event, and rolls back its sequence", async () => {
      const db = h.ctx.postgres!.database;
      const a = await db.pool.connect(),
        b = await db.pool.connect();
      try {
        const before = await db.query<{ seq: string }>(
          "SELECT last_seq::text AS seq FROM meldiq_private.bot_event_clock",
        );
        await a.query("BEGIN");
        await b.query("BEGIN");
        await a.query(
          "SELECT meldiq_private.emit_bot_event('test',NULL,NULL,NULL,NULL,'rolled-back',$1)",
          [botId],
        );
        let completed = false;
        const queued = b
          .query(
            "SELECT meldiq_private.emit_bot_event('test',NULL,NULL,NULL,NULL,'committed',$1)",
            [botId],
          )
          .then(() => {
            completed = true;
          });
        const visible = await db.query<{ seq: string }>(
          "SELECT last_seq::text AS seq FROM meldiq_private.bot_event_clock",
        );
        expect(visible.rows[0]!.seq).toBe(before.rows[0]!.seq);
        expect(completed).toBe(false);
        await a.query("ROLLBACK");
        await queued;
        await b.query("COMMIT");
        const events = await db.query<{ source_id: string; seq: string }>(
          "SELECT source_id,seq::text FROM meldiq_private.bot_event_journal ORDER BY seq",
        );
        expect(events.rows.map((row) => row.source_id)).toEqual(["committed"]);
        expect(BigInt(events.rows[0]!.seq)).toBe(
          BigInt(before.rows[0]!.seq) + 1n,
        );
      } finally {
        await a.query("ROLLBACK");
        await b.query("ROLLBACK");
        a.release();
        b.release();
      }
    });

    it("keeps direct authenticated clients out while the existing API role can read replay metadata", async () => {
      const db = h.ctx.postgres!.database;
      for (const table of ["bot_event_journal", "bot_installation_boundaries"]) {
        await expect(db.transaction(async () => {
          await db.query("SET LOCAL ROLE authenticated");
          await db.query(`SELECT 1 FROM meldiq_private.${table}`);
        })).rejects.toMatchObject({ code: "42501" });
      }
      const result = await db.transaction(async () => {
        await db.query("SET LOCAL ROLE meldiq_api");
        return db.query("SELECT id FROM meldiq_private.bot_event_journal");
      });
      expect(result.rows).toHaveLength(1);
    });
  },
);
