import type { DB } from "../../infrastructure/database/db.js";

export interface CallRow {
  id: string;
  conversation_id: string;
  room_name: string;
  created_by: string;
  video: number;
  state: "RINGING" | "ACTIVE" | "ENDED";
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  /** First time a recipient device confirmed it is ringing (null: no recipient has been reached yet). */
  alerted_at: number | null;
  /** Set on a mirror of a call hosted by another server (federation); null when this server hosts it. */
  host_server_id: string | null;
  /** 1: the call of a voice room (docs/VOICE_ROOMS.md): nobody rings; it lasts while anyone is in it. */
  room?: number;
}

/** One device's time in a call (a reconnect on the same device reuses the row). */
export interface CallParticipantRow {
  call_id: string;
  user_id: string;
  device_id: string;
  joined_at: number;
  left_at: number | null;
}

export interface CallHandRow {
  user_id: string;
  raised_at: number;
}

/** What the host of a call says about it (federation): the mirror's state follows it. */
export interface CallMirrorState {
  state: CallRow["state"];
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  alerted_at: number | null;
}

export interface CallDay {
  day: string;
  started: number;
  answered: number;
  declined: number;
  lost: number;
}

/**
 * Where calls live (docs/MONGODB.md, the "calls" domain): SQLite, or MongoDB when MONGODB_DOMAINS includes "calls".
 * Every check-and-write is a single conditional update, so two requests racing on a call can't both win on either
 * store. Conversations stay where they are: callers pass conversation ids in.
 */
export interface CallStore {
  readonly backend: "sqlite" | "mongodb";
  get(id: string): Promise<CallRow | null>;
  byRoom(roomName: string): Promise<CallRow | null>;
  /** Live (not ended) calls of these conversations, newest first. */
  liveIn(conversationIds: readonly string[]): Promise<CallRow[]>;
  /** Live calls [userId] still has a device in. */
  liveWithParticipant(userId: string): Promise<CallRow[]>;
  /** Every live call: hosted here ([hosted] true) or mirrors of calls other servers host (false). */
  live(hosted: boolean): Promise<CallRow[]>;
  /** A conversation's calls created in [since, before), newest first. */
  history(conversationId: string, since: number, before: number, limit: number): Promise<CallRow[]>;
  countIn(conversationIds: readonly string[]): Promise<number>;
  insert(row: CallRow): Promise<void>;
  /** RINGING → ACTIVE (answered at [at] unless already answered); false if it wasn't ringing. */
  markAnswered(id: string, at: number): Promise<boolean>;
  /** The first recipient device ringing; false if one already had. */
  markAlerted(id: string, at: number): Promise<boolean>;
  /** Ends the call unless it already ended; true when this call ended it. Its devices are marked as left. */
  end(id: string, at: number, reason: string): Promise<boolean>;
  /** Creates or updates the mirror of a call another server hosts, with the participants it reports (federation). */
  applyMirror(row: CallRow, participants: Omit<CallParticipantRow, "call_id" | "left_at">[]): Promise<void>;
  /** Every device that was ever in the call, by when it joined. */
  participants(callId: string): Promise<CallParticipantRow[]>;
  /** The devices in the call now. */
  present(callId: string): Promise<CallParticipantRow[]>;
  /** A device joins (or rejoins: [resetJoinedAt] restarts its time, otherwise the first join is kept). */
  join(callId: string, userId: string, deviceId: string, at: number, resetJoinedAt: boolean): Promise<void>;
  /** A device leaves; false if it wasn't in the call. */
  leave(callId: string, deviceId: string, at: number): Promise<boolean>;
  /** The account's other devices leave (newest device wins); returns the devices moved out. */
  leaveOtherDevices(callId: string, userId: string, keepDeviceId: string, at: number): Promise<string[]>;
  raiseHand(callId: string, userId: string, at: number): Promise<void>;
  lowerHand(callId: string, userId: string): Promise<void>;
  /** Raised hands, oldest first (whoever raised them, in the call or not). */
  hands(callId: string): Promise<CallHandRow[]>;
  /** An account was deleted: its raised hands go. */
  forgetUserHands(userId: string): Promise<void>;
  /** Retention: ended calls older than [cutoff] go with their participants and hands. Returns how many. */
  pruneEnded(cutoff: number): Promise<number>;
  /** Conversations were deleted: their calls go (SQLite does this by cascade). */
  forgetConversations(conversationIds: readonly string[]): Promise<void>;
  /** Platform Admin Console: calls in progress, their people and how many are video (counts only). */
  activeCounts(): Promise<{ calls: number; participants: number; video: number }>;
  /** Calls started per UTC day since [from]: answered, declined or busy, lost. */
  days(from: number): Promise<CallDay[]>;
  /** Minutes devices spent in calls of these conversations within [from, to) (usage meter); [now] closes open spans. */
  participantMinutes(conversationIds: readonly string[], from: number, to: number, now: number): Promise<number>;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export class SqliteCallStore implements CallStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async get(id: string): Promise<CallRow | null> {
    return (this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | undefined) ?? null;
  }

  async byRoom(roomName: string): Promise<CallRow | null> {
    return (this.db.prepare("SELECT * FROM calls WHERE room_name = ?").get(roomName) as CallRow | undefined) ?? null;
  }

  async liveIn(conversationIds: readonly string[]): Promise<CallRow[]> {
    if (conversationIds.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM calls WHERE conversation_id IN (${placeholders(conversationIds.length)}) AND state != 'ENDED' ORDER BY created_at DESC`)
      .all(...conversationIds) as CallRow[];
  }

  async liveWithParticipant(userId: string): Promise<CallRow[]> {
    return this.db
      .prepare(
        `SELECT c.* FROM calls c WHERE c.state != 'ENDED'
           AND c.id IN (SELECT call_id FROM call_participants WHERE user_id = ? AND left_at IS NULL)`,
      )
      .all(userId) as CallRow[];
  }

  async live(hosted: boolean): Promise<CallRow[]> {
    return this.db
      .prepare(`SELECT * FROM calls WHERE state != 'ENDED' AND host_server_id IS ${hosted ? "NULL" : "NOT NULL"} ORDER BY created_at`)
      .all() as CallRow[];
  }

  async history(conversationId: string, since: number, before: number, limit: number): Promise<CallRow[]> {
    return this.db
      .prepare("SELECT * FROM calls WHERE conversation_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, since, before, limit) as CallRow[];
  }

  async countIn(conversationIds: readonly string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    return (this.db.prepare(`SELECT COUNT(*) n FROM calls WHERE conversation_id IN (${placeholders(conversationIds.length)})`).get(...conversationIds) as { n: number }).n;
  }

  async insert(row: CallRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO calls (id, conversation_id, room_name, created_by, video, state, created_at, answered_at, ended_at, end_reason, alerted_at, host_server_id, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.conversation_id, row.room_name, row.created_by, row.video, row.state, row.created_at, row.answered_at, row.ended_at, row.end_reason, row.alerted_at, row.host_server_id, row.room ?? 0);
  }

  async markAnswered(id: string, at: number): Promise<boolean> {
    return this.db.prepare("UPDATE calls SET state = 'ACTIVE', answered_at = COALESCE(answered_at, ?) WHERE id = ? AND state = 'RINGING'").run(at, id).changes > 0;
  }

  async markAlerted(id: string, at: number): Promise<boolean> {
    return this.db.prepare("UPDATE calls SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL").run(at, id).changes > 0;
  }

  async end(id: string, at: number, reason: string): Promise<boolean> {
    return this.db.transaction(() => {
      const ended = this.db.prepare("UPDATE calls SET state = 'ENDED', ended_at = ?, end_reason = ? WHERE id = ? AND state != 'ENDED'").run(at, reason, id).changes > 0;
      if (ended) this.db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND left_at IS NULL").run(at, id);
      return ended;
    })();
  }

  async applyMirror(row: CallRow, participants: Omit<CallParticipantRow, "call_id" | "left_at">[]): Promise<void> {
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT state FROM calls WHERE id = ?").get(row.id) as { state: string } | undefined;
      if (!existing) this.insertSync(row);
      else if (existing.state !== "ENDED") {
        this.db
          .prepare("UPDATE calls SET state = ?, answered_at = ?, ended_at = ?, end_reason = ?, alerted_at = COALESCE(alerted_at, ?) WHERE id = ?")
          .run(row.state, row.answered_at, row.ended_at, row.end_reason, row.alerted_at, row.id);
      }
      this.db.prepare("DELETE FROM call_participants WHERE call_id = ?").run(row.id);
      const ins = this.db.prepare("INSERT OR IGNORE INTO call_participants (call_id, user_id, device_id, joined_at) VALUES (?, ?, ?, ?)");
      for (const p of participants) ins.run(row.id, p.user_id, p.device_id, p.joined_at);
    })();
  }

  private insertSync(row: CallRow): void {
    this.db
      .prepare(
        `INSERT INTO calls (id, conversation_id, room_name, created_by, video, state, created_at, answered_at, ended_at, end_reason, alerted_at, host_server_id, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.conversation_id, row.room_name, row.created_by, row.video, row.state, row.created_at, row.answered_at, row.ended_at, row.end_reason, row.alerted_at, row.host_server_id, row.room ?? 0);
  }

  async participants(callId: string): Promise<CallParticipantRow[]> {
    return this.db.prepare("SELECT * FROM call_participants WHERE call_id = ? ORDER BY joined_at").all(callId) as CallParticipantRow[];
  }

  async present(callId: string): Promise<CallParticipantRow[]> {
    return this.db.prepare("SELECT * FROM call_participants WHERE call_id = ? AND left_at IS NULL ORDER BY joined_at").all(callId) as CallParticipantRow[];
  }

  async join(callId: string, userId: string, deviceId: string, at: number, resetJoinedAt: boolean): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO call_participants (call_id, user_id, device_id, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(call_id, device_id) DO UPDATE SET left_at = NULL${resetJoinedAt ? ", joined_at = excluded.joined_at" : ""}`,
      )
      .run(callId, userId, deviceId, at);
  }

  async leave(callId: string, deviceId: string, at: number): Promise<boolean> {
    return this.db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL").run(at, callId, deviceId).changes > 0;
  }

  async leaveOtherDevices(callId: string, userId: string, keepDeviceId: string, at: number): Promise<string[]> {
    return (
      this.db
        .prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND device_id != ? AND left_at IS NULL RETURNING device_id")
        .all(at, callId, userId, keepDeviceId) as { device_id: string }[]
    ).map((r) => r.device_id);
  }

  async raiseHand(callId: string, userId: string, at: number): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO call_hands (call_id, user_id, raised_at) VALUES (?, ?, ?)").run(callId, userId, at);
  }

  async lowerHand(callId: string, userId: string): Promise<void> {
    this.db.prepare("DELETE FROM call_hands WHERE call_id = ? AND user_id = ?").run(callId, userId);
  }

  async hands(callId: string): Promise<CallHandRow[]> {
    return this.db.prepare("SELECT user_id, raised_at FROM call_hands WHERE call_id = ? ORDER BY raised_at").all(callId) as CallHandRow[];
  }

  async forgetUserHands(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM call_hands WHERE user_id = ?").run(userId);
  }

  async pruneEnded(cutoff: number): Promise<number> {
    const old = this.db.prepare("SELECT id FROM calls WHERE state = 'ENDED' AND COALESCE(ended_at, created_at) <= ?").all(cutoff) as { id: string }[];
    if (old.length === 0) return 0;
    this.db.transaction(() => {
      for (const c of old) {
        this.db.prepare("DELETE FROM call_participants WHERE call_id = ?").run(c.id);
        this.db.prepare("DELETE FROM calls WHERE id = ?").run(c.id);
      }
    })();
    return old.length;
  }

  async forgetConversations(_conversationIds: readonly string[]): Promise<void> {
    // Deleting a conversation cascades to its calls, their participants and hands.
  }

  async activeCounts(): Promise<{ calls: number; participants: number; video: number }> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(video), 0) video,
                (SELECT COUNT(DISTINCT p.user_id) FROM call_participants p JOIN calls c2 ON c2.id = p.call_id
                  WHERE c2.state IN ('RINGING','ACTIVE') AND p.left_at IS NULL) participants
           FROM calls WHERE state IN ('RINGING','ACTIVE')`,
      )
      .get() as { calls: number; video: number; participants: number };
    return { calls: r.calls, participants: r.participants, video: r.video };
  }

  async days(from: number): Promise<CallDay[]> {
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day, COUNT(*) started,
                SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) answered,
                SUM(CASE WHEN end_reason IN ('declined','busy') THEN 1 ELSE 0 END) declined,
                SUM(CASE WHEN end_reason = 'lost' THEN 1 ELSE 0 END) lost
           FROM calls WHERE created_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(from) as CallDay[];
  }

  async participantMinutes(conversationIds: readonly string[], from: number, to: number, now: number): Promise<number> {
    if (conversationIds.length === 0) return 0;
    const r = this.db
      .prepare(
        `SELECT SUM((MIN(COALESCE(p.left_at, ?), ?) - MAX(p.joined_at, ?)) / 60000.0) n FROM call_participants p
         JOIN calls k ON k.id = p.call_id
         WHERE k.conversation_id IN (${placeholders(conversationIds.length)}) AND p.joined_at < ? AND COALESCE(p.left_at, ?) > ?`,
      )
      .get(now, to, from, ...conversationIds, to, now, from) as { n: number | null };
    return r.n ?? 0;
  }
}
