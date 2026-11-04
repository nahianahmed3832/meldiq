import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import {
  type ConnectionRow,
  type DmRequestRow,
  type MessagingSettings,
  pairOf,
  type RelationshipStore,
} from "./store.js";

export class PostgresRelationshipStore implements RelationshipStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async connection(x: string, y: string): Promise<ConnectionRow | null> {
    return (
      (
        await this.db.query<ConnectionRow>(
          "SELECT * FROM meldiq.connections WHERE pair=$1",
          [pairOf(x, y).pair],
        )
      ).rows[0] ?? null
    );
  }
  async connectionsOf(userId: string): Promise<ConnectionRow[]> {
    return (
      await this.db.query<ConnectionRow>(
        "SELECT * FROM meldiq.connections WHERE a=$1 OR b=$1 ORDER BY created_at DESC,pair DESC",
        [userId],
      )
    ).rows;
  }
  async putConnection(row: ConnectionRow): Promise<void> {
    const key = pairOf(row.a, row.b);
    if (key.pair !== row.pair || key.a !== row.a || key.b !== row.b)
      throw new Error("Invalid connection pair");
    await this.db.query(
      `INSERT INTO meldiq.connections(pair,a,b,state,requested_by,created_at,accepted_at,request_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(pair) DO UPDATE SET state=excluded.state,requested_by=excluded.requested_by,created_at=excluded.created_at,accepted_at=excluded.accepted_at,request_note=excluded.request_note`,
      [
        row.pair,
        row.a,
        row.b,
        row.state,
        row.requested_by,
        row.created_at,
        row.accepted_at,
        row.state === "accepted" ? null : (row.request_note ?? null),
      ],
    );
  }
  async requestConnection(
    row: ConnectionRow,
  ): Promise<{ row: ConnectionRow | null; changed: boolean }> {
    const changed = (
      await this.db.query<ConnectionRow>(
        `INSERT INTO meldiq.connections(pair,a,b,state,requested_by,created_at,accepted_at,request_note)
      VALUES($1,$2,$3,'pending',$4,$5,NULL,$6) ON CONFLICT(pair) DO UPDATE SET state='accepted',accepted_at=excluded.created_at,request_note=NULL
      WHERE connections.state='pending' AND connections.requested_by<>excluded.requested_by RETURNING *`,
        [
          row.pair,
          row.a,
          row.b,
          row.requested_by,
          row.created_at,
          row.request_note ?? null,
        ],
      )
    ).rows[0];
    return {
      row: changed ?? (await this.connection(row.a, row.b)),
      changed: !!changed,
    };
  }
  async deleteConnection(x: string, y: string): Promise<boolean> {
    return (
      (
        await this.db.query("DELETE FROM meldiq.connections WHERE pair=$1", [
          pairOf(x, y).pair,
        ])
      ).rowCount === 1
    );
  }
  async deletePendingConnection(x: string, y: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          "DELETE FROM meldiq.connections WHERE pair=$1 AND state='pending'",
          [pairOf(x, y).pair],
        )
      ).rowCount === 1
    );
  }
  async acceptConnection(
    recipient: string,
    from: string,
    at: number,
  ): Promise<boolean> {
    return (
      (
        await this.db.query(
          "UPDATE meldiq.connections SET state='accepted',accepted_at=$3,request_note=NULL WHERE pair=$1 AND state='pending' AND requested_by=$2",
          [pairOf(recipient, from).pair, from, at],
        )
      ).rowCount === 1
    );
  }
  async request(conversationId: string): Promise<DmRequestRow | null> {
    return (
      (
        await this.db.query<DmRequestRow>(
          "SELECT * FROM meldiq.dm_requests WHERE conversation_id=$1",
          [conversationId],
        )
      ).rows[0] ?? null
    );
  }
  async createRequest(row: DmRequestRow): Promise<void> {
    await this.db.query(
      `INSERT INTO meldiq.dm_requests(conversation_id,recipient,sender,state,sent,created_at,answered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(conversation_id) DO NOTHING`,
      [
        row.conversation_id,
        row.recipient,
        row.sender,
        row.state,
        row.sent,
        row.created_at,
        row.answered_at,
      ],
    );
  }
  async requestsFor(
    recipient: string,
    state: DmRequestRow["state"],
  ): Promise<DmRequestRow[]> {
    return (
      await this.db.query<DmRequestRow>(
        "SELECT * FROM meldiq.dm_requests WHERE recipient=$1 AND state=$2 ORDER BY created_at DESC,conversation_id DESC",
        [recipient, state],
      )
    ).rows;
  }
  async requestsIn(conversationIds: string[]): Promise<DmRequestRow[]> {
    if (!conversationIds.length) return [];
    return (
      await this.db.query<DmRequestRow>(
        "SELECT * FROM meldiq.dm_requests WHERE conversation_id=ANY($1::text[])",
        [conversationIds],
      )
    ).rows;
  }
  async countSent(conversationId: string): Promise<number> {
    return (
      (
        await this.db.query<{ sent: number }>(
          "UPDATE meldiq.dm_requests SET sent=sent+1 WHERE conversation_id=$1 RETURNING sent",
          [conversationId],
        )
      ).rows[0]?.sent ?? 0
    );
  }
  async declineRequest(conversationId: string, at: number): Promise<void> {
    await this.db.query(
      "UPDATE meldiq.dm_requests SET state='declined',answered_at=$2 WHERE conversation_id=$1",
      [conversationId, at],
    );
  }
  async deleteRequest(conversationId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM meldiq.dm_requests WHERE conversation_id=$1",
      [conversationId],
    );
  }
  async countStartedSince(userId: string, since: number): Promise<number> {
    return (
      await this.db.query<{ count: number }>(
        `SELECT (SELECT count(*) FROM meldiq.connections WHERE requested_by=$1 AND created_at>=$2)
      +(SELECT count(*) FROM meldiq.dm_requests WHERE sender=$1 AND created_at>=$2) AS count`,
        [userId, since],
      )
    ).rows[0].count;
  }
  async settings(userId: string): Promise<MessagingSettings | null> {
    return (
      (
        await this.db.query<MessagingSettings>(
          "SELECT dm_policy,request_policy FROM meldiq.messaging_settings WHERE user_id=$1",
          [userId],
        )
      ).rows[0] ?? null
    );
  }
  async putSettings(
    userId: string,
    settings: MessagingSettings,
    at: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO meldiq.messaging_settings(user_id,dm_policy,request_policy,updated_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET dm_policy=excluded.dm_policy,request_policy=excluded.request_policy,updated_at=excluded.updated_at`,
      [userId, settings.dm_policy, settings.request_policy, at],
    );
  }
  async deleteForUser(userId: string): Promise<void> {
    await this.db.query(
      `WITH connections AS (DELETE FROM meldiq.connections WHERE a=$1 OR b=$1),
      requests AS (DELETE FROM meldiq.dm_requests WHERE recipient=$1 OR sender=$1)
      DELETE FROM meldiq.messaging_settings WHERE user_id=$1`,
      [userId],
    );
  }
}
