import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { CallDay, CallHandRow, CallParticipantRow, CallRow, CallStore } from "./store.js";

const columns = "id,conversation_id,room_name,created_by,video,state,created_at,answered_at,ended_at,end_reason,alerted_at,host_server_id,room";

/** Relational call metadata only. LiveKit rooms, credentials, media and participant authorization stay in the service. */
export class PostgresCallStore implements CallStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async get(id: string): Promise<CallRow | null> { return (await this.db.query<CallRow>("SELECT * FROM meldiq.calls WHERE id=$1", [id])).rows[0] ?? null; }
  async byRoom(room: string): Promise<CallRow | null> { return (await this.db.query<CallRow>("SELECT * FROM meldiq.calls WHERE room_name=$1", [room])).rows[0] ?? null; }
  async liveIn(ids: readonly string[]): Promise<CallRow[]> {
    return (await this.db.query<CallRow>("SELECT * FROM meldiq.calls WHERE conversation_id=ANY($1::text[]) AND state<>'ENDED' ORDER BY created_at DESC,id DESC", [[...ids]])).rows;
  }
  async liveWithParticipant(userId: string): Promise<CallRow[]> {
    return (await this.db.query<CallRow>(`SELECT c.* FROM meldiq.calls c WHERE c.state<>'ENDED' AND EXISTS(
      SELECT 1 FROM meldiq.call_participants p WHERE p.call_id=c.id AND p.user_id=$1 AND p.left_at IS NULL)`, [userId])).rows;
  }
  async live(hosted: boolean): Promise<CallRow[]> {
    return (await this.db.query<CallRow>(`SELECT * FROM meldiq.calls WHERE state<>'ENDED' AND host_server_id IS ${hosted ? "NULL" : "NOT NULL"} ORDER BY created_at,id`)).rows;
  }
  async history(conversationId: string, since: number, before: number, limit: number): Promise<CallRow[]> {
    return (await this.db.query<CallRow>("SELECT * FROM meldiq.calls WHERE conversation_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC,id DESC LIMIT $4", [conversationId, since, before, limit])).rows;
  }
  async countIn(ids: readonly string[]): Promise<number> {
    return (await this.db.query<{count: number}>("SELECT count(*) AS count FROM meldiq.calls WHERE conversation_id=ANY($1::text[])", [[...ids]])).rows[0].count;
  }
  async insert(row: CallRow): Promise<void> {
    const value = {...row, room: row.room ?? 0};
    await this.db.query(`INSERT INTO meldiq.calls(${columns}) VALUES(${columns.split(",").map((_, n) => `$${n + 1}`).join(",")})`, columns.split(",").map(column => value[column as keyof typeof value]));
  }
  async markAnswered(id: string, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.calls SET state='ACTIVE',answered_at=coalesce(answered_at,$2) WHERE id=$1 AND state='RINGING'", [id, at])).rowCount === 1;
  }
  async markAlerted(id: string, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.calls SET alerted_at=$2 WHERE id=$1 AND alerted_at IS NULL", [id, at])).rowCount === 1;
  }
  async end(id: string, at: number, reason: string): Promise<boolean> {
    return (await this.db.query<{ended: boolean}>(`WITH ended AS (
      UPDATE meldiq.calls SET state='ENDED',ended_at=$2,end_reason=$3 WHERE id=$1 AND state<>'ENDED' RETURNING id
    ), left_devices AS (
      UPDATE meldiq.call_participants SET left_at=$2 WHERE call_id IN (SELECT id FROM ended) AND left_at IS NULL
    ) SELECT EXISTS(SELECT 1 FROM ended) AS ended`, [id, at, reason])).rows[0].ended;
  }
  async applyMirror(row: CallRow, participants: Omit<CallParticipantRow, "call_id" | "left_at">[]): Promise<void> {
    await this.db.transaction(async () => {
      const value = {...row, room: row.room ?? 0};
      await this.db.query(`INSERT INTO meldiq.calls(${columns}) VALUES(${columns.split(",").map((_, n) => `$${n + 1}`).join(",")})
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,answered_at=excluded.answered_at,ended_at=excluded.ended_at,
        end_reason=excluded.end_reason,alerted_at=coalesce(calls.alerted_at,excluded.alerted_at) WHERE calls.state<>'ENDED'`,
      columns.split(",").map(column => value[column as keyof typeof value]));
      await this.db.query("DELETE FROM meldiq.call_participants WHERE call_id=$1", [row.id]);
      for (const participant of participants) await this.db.query(`INSERT INTO meldiq.call_participants(call_id,user_id,device_id,joined_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(call_id,device_id) DO NOTHING`, [row.id, participant.user_id, participant.device_id, participant.joined_at]);
    });
  }
  async participants(callId: string): Promise<CallParticipantRow[]> {
    return (await this.db.query<CallParticipantRow>("SELECT * FROM meldiq.call_participants WHERE call_id=$1 ORDER BY joined_at,device_id", [callId])).rows;
  }
  async present(callId: string): Promise<CallParticipantRow[]> {
    return (await this.db.query<CallParticipantRow>("SELECT * FROM meldiq.call_participants WHERE call_id=$1 AND left_at IS NULL ORDER BY joined_at,device_id", [callId])).rows;
  }
  async join(callId: string, userId: string, deviceId: string, at: number, resetJoinedAt: boolean): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.call_participants(call_id,user_id,device_id,joined_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(call_id,device_id) DO UPDATE SET left_at=NULL${resetJoinedAt ? ",joined_at=excluded.joined_at" : ""}`, [callId, userId, deviceId, at]);
  }
  async leave(callId: string, deviceId: string, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.call_participants SET left_at=$3 WHERE call_id=$1 AND device_id=$2 AND left_at IS NULL", [callId, deviceId, at])).rowCount === 1;
  }
  async leaveOtherDevices(callId: string, userId: string, keepDeviceId: string, at: number): Promise<string[]> {
    return (await this.db.query<{device_id: string}>(`UPDATE meldiq.call_participants SET left_at=$4 WHERE call_id=$1 AND user_id=$2 AND device_id<>$3 AND left_at IS NULL RETURNING device_id`, [callId, userId, keepDeviceId, at])).rows.map(row => row.device_id);
  }
  async raiseHand(callId: string, userId: string, at: number): Promise<void> {
    await this.db.query("INSERT INTO meldiq.call_hands(call_id,user_id,raised_at) VALUES($1,$2,$3) ON CONFLICT(call_id,user_id) DO NOTHING", [callId, userId, at]);
  }
  async lowerHand(callId: string, userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.call_hands WHERE call_id=$1 AND user_id=$2", [callId, userId]); }
  async hands(callId: string): Promise<CallHandRow[]> {
    return (await this.db.query<CallHandRow>("SELECT user_id,raised_at FROM meldiq.call_hands WHERE call_id=$1 ORDER BY raised_at,user_id", [callId])).rows;
  }
  async forgetUserHands(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.call_hands WHERE user_id=$1", [userId]); }
  async pruneEnded(cutoff: number): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.calls WHERE state='ENDED' AND coalesce(ended_at,created_at)<=$1", [cutoff])).rowCount ?? 0;
  }
  async forgetConversations(ids: readonly string[]): Promise<void> {
    await this.db.query("DELETE FROM meldiq.calls WHERE conversation_id=ANY($1::text[])", [[...ids]]);
  }
  async activeCounts(): Promise<{calls: number; participants: number; video: number}> {
    return (await this.db.query<{calls: number; participants: number; video: number}>(`SELECT count(*) AS calls,coalesce(sum(video),0)::bigint AS video,
      (SELECT count(DISTINCT p.user_id) FROM meldiq.call_participants p JOIN meldiq.calls c ON c.id=p.call_id
        WHERE c.state IN ('RINGING','ACTIVE') AND p.left_at IS NULL) AS participants FROM meldiq.calls WHERE state IN ('RINGING','ACTIVE')`)).rows[0];
  }
  async days(from: number): Promise<CallDay[]> {
    return (await this.db.query<CallDay>(`SELECT to_char(to_timestamp(created_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*) AS started,
      count(*) FILTER(WHERE answered_at IS NOT NULL) AS answered,count(*) FILTER(WHERE end_reason IN ('declined','busy')) AS declined,
      count(*) FILTER(WHERE end_reason='lost') AS lost FROM meldiq.calls WHERE created_at>=$1 GROUP BY day ORDER BY day`, [from])).rows;
  }
  async leaderboardSpans(ids: readonly string[], since: number): Promise<CallParticipantRow[]> {
    return (await this.db.query<CallParticipantRow>(`SELECT p.* FROM meldiq.call_participants p JOIN meldiq.calls c ON c.id=p.call_id
      WHERE c.conversation_id=ANY($1::text[]) AND (p.left_at IS NULL OR p.left_at>$2)`, [[...ids], since])).rows;
  }
  async participantMinutes(ids: readonly string[], from: number, to: number, now: number): Promise<number> {
    return (await this.db.query<{minutes: number}>(`SELECT coalesce(sum((least(coalesce(p.left_at,$4),$3)-greatest(p.joined_at,$2))/60000.0),0)::double precision AS minutes
      FROM meldiq.call_participants p JOIN meldiq.calls c ON c.id=p.call_id WHERE c.conversation_id=ANY($1::text[])
      AND p.joined_at<$3 AND coalesce(p.left_at,$4)>$2`, [[...ids], from, to, now])).rows[0].minutes;
  }
}
