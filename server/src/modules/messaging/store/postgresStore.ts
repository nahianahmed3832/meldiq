import { randomUUID } from "node:crypto";
import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import { type ConversationSummary, type HistoryPage, type MessageActivity, type MessageEvent, type MessageStore, PAGE_READERS, pageChanges } from "./messageStore.js";

const columns = "id, conversation_id, sender_user_id, sender_device_id, cls, type, target, audience, payload, sent_at, server_ts, mention_all, imported_by";
const visible = "(audience = 'all' OR sender_user_id = $2)";

/** Released event contract in relational columns. Authorization stays in the existing Fastify service.
 * Native delivery commits recoverable Realtime/push work with the event. The database-only
 * compatibility release retains the existing durable relay and push path without queuing duplicate fanout.
 */
export class PostgresMessageStore implements MessageStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async get(id: string): Promise<MessageEvent | null> {
    return (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE id = $1`, [id])).rows[0] ?? null;
  }
  private async insert(event: MessageEvent): Promise<boolean> {
    const values = columns.split(", ").map(c => event[c as keyof MessageEvent]);
    const result = await this.db.query(`INSERT INTO meldiq.message_events (${columns}) VALUES (${values.map((_,i)=>`$${i+1}`)}) ON CONFLICT(id) DO NOTHING`, values);
    if (!result.rowCount) return false;
    if (event.imported_by === null && this.db.config.deliveryMode !== "legacy") {
      const id = randomUUID();
      const topic = event.audience === "self" ? `user:${event.sender_user_id}` : `conversation:${event.conversation_id}`;
      const payload = JSON.stringify({ messageId: event.id, conversationId: event.conversation_id });
      await this.db.query(`INSERT INTO meldiq_private.outbox(event_id,aggregate_id,destination,topic,event_type,payload)
        VALUES ($1,$2,'realtime',$3,'message.changed',$4::jsonb)`, [id,event.conversation_id,topic,payload]);
      if (event.cls === "message" && event.audience === "all") await this.db.query(`INSERT INTO meldiq_private.outbox(event_id,aggregate_id,destination,topic,event_type,payload)
        VALUES ($1,$2,'push',$3,'message.created',$4::jsonb)`, [id,event.conversation_id,topic,payload]);
    }
    return true;
  }
  async add(event: MessageEvent): Promise<boolean> {
    // Compatibility delivery inserts one statement; PostgreSQL already commits that statement atomically.
    return this.db.config.deliveryMode==="legacy"?this.insert(event):this.db.transaction(() => this.insert(event));
  }
  async addMany(events: MessageEvent[]): Promise<number> {
    return this.db.transaction(async () => { let count = 0; for (const event of events) if (await this.insert(event)) count++; return count; });
  }
  async page(conversationId: string, viewer: string, before: number | null, limit: number, beforeId?: string): Promise<HistoryPage> {
    const rows = (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id = $1 AND ${visible} AND cls = 'message'
      AND (server_ts < $3 OR (server_ts = $3 AND id < $4)) ORDER BY server_ts DESC, id DESC LIMIT $5`, [conversationId,viewer,before??Number.MAX_SAFE_INTEGER,beforeId??"",limit+1])).rows;
    const messages = rows.slice(0,limit);
    return { messages, changes: await this.changesFor(conversationId,viewer,messages), more: rows.length > limit };
  }
  async around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null> {
    const at = await this.get(messageId);
    if (!at || at.conversation_id !== conversationId || at.cls !== "message" || (at.audience === "self" && at.sender_user_id !== viewer)) return null;
    const args = [conversationId,viewer,at.server_ts,at.id,limit+1];
    const older = (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=$1 AND ${visible} AND cls='message'
      AND (server_ts,id) < ($3,$4) ORDER BY server_ts DESC,id DESC LIMIT $5`, args)).rows;
    const newer = (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=$1 AND ${visible} AND cls='message'
      AND (server_ts,id) > ($3,$4) ORDER BY server_ts,id LIMIT $5`, [...args.slice(0,4),limit])).rows;
    const messages = [...newer.reverse(),at,...older.slice(0,limit)];
    return { messages,changes:await this.changesFor(conversationId,viewer,messages),more:older.length>limit };
  }
  private async changesFor(conversationId: string, viewer: string, messages: MessageEvent[]): Promise<MessageEvent[]> {
    if (!messages.length) return [];
    const targeted = (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=$1 AND ${visible}
      AND cls='control' AND target=ANY($3::text[]) ORDER BY server_ts,id`, [conversationId,viewer,messages.map(m=>m.id)])).rows;
    return pageChanges(targeted,await this.readReceipts(conversationId,viewer));
  }
  async readReceipts(conversationId: string, viewer: string): Promise<MessageEvent[]> {
    return (await this.db.query<MessageEvent>(`SELECT ${columns} FROM (
      SELECT DISTINCT ON(sender_user_id) * FROM meldiq.message_events WHERE conversation_id=$1 AND sender_user_id<>$2
      AND cls='control' AND type='read' AND audience='all' ORDER BY sender_user_id,server_ts DESC,id DESC
      ) latest ORDER BY server_ts DESC,id DESC LIMIT $3`, [conversationId,viewer,PAGE_READERS])).rows;
  }
  async search(ids: readonly string[], query: string, limit: number): Promise<MessageEvent[]> {
    if (!ids.length || !query.trim()) return [];
    return (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=ANY($1::text[]) AND cls='message' AND type='text'
      AND audience='all' AND strpos(lower(meldiq_private.event_payload(payload)->>'text'),lower($2))>0 ORDER BY server_ts DESC,id DESC LIMIT $3`, [ids,query.trim(),limit])).rows;
  }
  async summaries(ids: readonly string[], userId: string, cap: number): Promise<ConversationSummary[]> {
    return Promise.all(ids.map(async id => {
      const last = (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=$1 AND ${visible} AND cls='message' ORDER BY server_ts DESC,id DESC LIMIT 1`,[id,userId])).rows[0]??null;
      const read = await this.db.query<{up: number}>(`SELECT coalesce(max(meldiq_private.read_position(payload)),0) AS up FROM meldiq.message_events WHERE conversation_id=$1 AND sender_user_id=$2 AND cls='control' AND type='read'`,[id,userId]);
      const up = read.rows[0].up;
      const unread = await this.db.query<{ mention_all: number; payload: string }>(`SELECT mention_all,payload FROM meldiq.message_events WHERE conversation_id=$1 AND sender_user_id<>$2 AND audience='all'
        AND cls='message' AND server_ts>$3 AND imported_by IS NULL ORDER BY server_ts DESC,id DESC LIMIT $4`,[id,userId,up,cap]);
      return { conversation_id:id,last,read_up_to:up,unread:unread.rows.length,mentions:unread.rows.filter(r=>r.mention_all===1 || (JSON.parse(r.payload).mentions??[]).includes(userId)).length };
    }));
  }
  async changesTo(id: string, target: string, type: string): Promise<MessageEvent[]> {
    return (await this.db.query<MessageEvent>(`SELECT ${columns} FROM meldiq.message_events WHERE conversation_id=$1 AND target=$2 AND type=$3 AND cls='control' AND audience='all' ORDER BY server_ts,id`,[id,target,type])).rows;
  }
  async threadHasReplies(id: string, root: string, since: number): Promise<boolean> {
    return !!(await this.db.query(`SELECT 1 FROM meldiq.message_events WHERE conversation_id=$1 AND cls='message' AND server_ts >= $2 AND meldiq_private.event_payload(payload)->>'threadRoot'=$3 LIMIT 1`,[id,since,root])).rowCount;
  }
  async deleteConversation(id: string): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.message_events WHERE conversation_id=$1",[id])).rowCount??0;
  }
  async stats(): Promise<{messages:number;changes:number}> {
    return (await this.db.query<{messages:number;changes:number}>("SELECT count(*) FILTER (WHERE cls='message') AS messages,count(*) FILTER (WHERE cls='control') AS changes FROM meldiq.message_events")).rows[0];
  }
  async activitySince(ids: readonly string[], since: number, top: number): Promise<MessageActivity> {
    const base = "FROM meldiq.message_events WHERE conversation_id=ANY($1::text[]) AND cls='message' AND imported_by IS NULL AND server_ts >= $2";
    const per = await this.db.query<{id:string;n:number}>(`SELECT conversation_id AS id,count(*) AS n ${base} GROUP BY conversation_id`,[ids,since]);
    const senders = await this.db.query<{userId:string;count:number}>(`SELECT sender_user_id AS "userId",count(*) AS count ${base} GROUP BY sender_user_id ORDER BY count DESC,sender_user_id LIMIT $3`,[ids,since,top]);
    return {perConversation:Object.fromEntries(per.rows.map(r=>[r.id,r.n])),topSenders:senders.rows};
  }
  async lastMessageAt(ids: readonly string[]): Promise<Record<string,number>> {
    const result = await this.db.query<{id:string;at:number}>("SELECT conversation_id AS id,max(server_ts) AS at FROM meldiq.message_events WHERE conversation_id=ANY($1::text[]) AND cls='message' GROUP BY conversation_id",[ids]);
    return Object.fromEntries(result.rows.map(r=>[r.id,r.at]));
  }
}
