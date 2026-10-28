import type { Collection, Filter } from "mongodb";
import type { MeldiqMongo } from "../../infrastructure/database/mongo/client.js";
import type { CallDay, CallHandRow, CallParticipantRow, CallRow, CallStore } from "./store.js";

/**
 * The SQLite rows (same field names, docs/MONGODB.md §3) keyed by their primary keys: a call by its id, a participant by
 * { call_id, device_id } and a hand by { call_id, user_id }, in the tables' key order, as the migration writes them.
 */
type CallDoc = Required<CallRow> & { _id: string };
type ParticipantDoc = CallParticipantRow & { _id: { call_id: string; device_id: string } };
type HandDoc = CallHandRow & { call_id: string; _id: { call_id: string; user_id: string } };

const DAY_MS = 86_400_000;

function row(d: CallDoc): CallRow {
  const { _id: _ignored, ...r } = d;
  return r;
}

function participant(d: ParticipantDoc): CallParticipantRow {
  return { call_id: d.call_id, user_id: d.user_id, device_id: d.device_id, joined_at: d.joined_at, left_at: d.left_at ?? null };
}

function doc(r: CallRow): CallDoc {
  return {
    _id: r.id,
    id: r.id,
    conversation_id: r.conversation_id,
    room_name: r.room_name,
    created_by: r.created_by,
    video: r.video,
    state: r.state,
    created_at: r.created_at,
    answered_at: r.answered_at,
    ended_at: r.ended_at,
    end_reason: r.end_reason,
    alerted_at: r.alerted_at,
    host_server_id: r.host_server_id,
    room: r.room ?? 0,
  };
}

/** Calls in MongoDB (MONGODB_DOMAINS includes "calls"). Steps that touch several documents run in one transaction. */
export class MongoCallStore implements CallStore {
  readonly backend = "mongodb" as const;
  private readonly calls: Collection<CallDoc>;
  private readonly people: Collection<ParticipantDoc>;
  private readonly handsCol: Collection<HandDoc>;

  constructor(private readonly mongo: MeldiqMongo) {
    this.calls = mongo.db.collection<CallDoc>("calls");
    this.people = mongo.db.collection<ParticipantDoc>("call_participants");
    this.handsCol = mongo.db.collection<HandDoc>("call_hands");
  }

  private get s() {
    return { session: this.mongo.session() };
  }

  private async find(filter: Filter<CallDoc>, sort: Record<string, 1 | -1>): Promise<CallRow[]> {
    return (await this.calls.find(filter, { ...this.s, sort }).toArray()).map(row);
  }

  async get(id: string): Promise<CallRow | null> {
    const d = await this.calls.findOne({ _id: id }, this.s);
    return d ? row(d) : null;
  }

  async byRoom(roomName: string): Promise<CallRow | null> {
    const d = await this.calls.findOne({ room_name: roomName }, this.s);
    return d ? row(d) : null;
  }

  async liveIn(conversationIds: readonly string[]): Promise<CallRow[]> {
    if (conversationIds.length === 0) return [];
    return this.find({ conversation_id: { $in: [...conversationIds] }, state: { $ne: "ENDED" } }, { created_at: -1 });
  }

  async liveWithParticipant(userId: string): Promise<CallRow[]> {
    const ids = await this.people.distinct("call_id", { user_id: userId, left_at: null }, this.s);
    if (ids.length === 0) return [];
    return this.find({ _id: { $in: ids }, state: { $ne: "ENDED" } }, { created_at: -1 });
  }

  async live(hosted: boolean): Promise<CallRow[]> {
    return this.find({ state: { $ne: "ENDED" }, host_server_id: hosted ? null : { $ne: null } }, { created_at: 1 });
  }

  async history(conversationId: string, since: number, before: number, limit: number): Promise<CallRow[]> {
    return (
      await this.calls
        .find({ conversation_id: conversationId, created_at: { $gte: since, $lt: before } }, { ...this.s, sort: { created_at: -1 }, limit })
        .toArray()
    ).map(row);
  }

  async countIn(conversationIds: readonly string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    return this.calls.countDocuments({ conversation_id: { $in: [...conversationIds] } }, this.s);
  }

  async insert(r: CallRow): Promise<void> {
    await this.calls.insertOne(doc(r), this.s);
  }

  async markAnswered(id: string, at: number): Promise<boolean> {
    // answered_at stays if it was already set (COALESCE in SQLite): a pipeline update reads the current value.
    const res = await this.calls.updateOne({ _id: id, state: "RINGING" }, [{ $set: { state: "ACTIVE", answered_at: { $ifNull: ["$answered_at", at] } } }], this.s);
    return res.modifiedCount > 0;
  }

  async markAlerted(id: string, at: number): Promise<boolean> {
    return (await this.calls.updateOne({ _id: id, alerted_at: null }, { $set: { alerted_at: at } }, this.s)).modifiedCount > 0;
  }

  async end(id: string, at: number, reason: string): Promise<boolean> {
    return this.mongo.transaction(async () => {
      const res = await this.calls.updateOne({ _id: id, state: { $ne: "ENDED" } }, { $set: { state: "ENDED", ended_at: at, end_reason: reason } }, this.s);
      if (res.modifiedCount === 0) return false;
      await this.people.updateMany({ call_id: id, left_at: null }, { $set: { left_at: at } }, this.s);
      return true;
    });
  }

  async applyMirror(r: CallRow, participants: Omit<CallParticipantRow, "call_id" | "left_at">[]): Promise<void> {
    await this.mongo.transaction(async () => {
      const existing = await this.calls.findOne({ _id: r.id }, { ...this.s, projection: { state: 1 } });
      if (!existing) await this.calls.insertOne(doc(r), this.s);
      else if (existing.state !== "ENDED") {
        await this.calls.updateOne(
          { _id: r.id },
          [{ $set: { state: r.state, answered_at: r.answered_at, ended_at: r.ended_at, end_reason: r.end_reason, alerted_at: { $ifNull: ["$alerted_at", r.alerted_at] } } }],
          this.s,
        );
      }
      await this.people.deleteMany({ call_id: r.id }, this.s);
      // One row per device, the first reported wins (INSERT OR IGNORE in SQLite).
      const byDevice = new Map<string, ParticipantDoc>();
      for (const p of participants) {
        if (byDevice.has(p.device_id)) continue;
        byDevice.set(p.device_id, { _id: { call_id: r.id, device_id: p.device_id }, call_id: r.id, user_id: p.user_id, device_id: p.device_id, joined_at: p.joined_at, left_at: null });
      }
      if (byDevice.size) await this.people.insertMany([...byDevice.values()], this.s);
    });
  }

  async participants(callId: string): Promise<CallParticipantRow[]> {
    return (await this.people.find({ call_id: callId }, { ...this.s, sort: { joined_at: 1 } }).toArray()).map(participant);
  }

  async present(callId: string): Promise<CallParticipantRow[]> {
    return (await this.people.find({ call_id: callId, left_at: null }, { ...this.s, sort: { joined_at: 1 } }).toArray()).map(participant);
  }

  async join(callId: string, userId: string, deviceId: string, at: number, resetJoinedAt: boolean): Promise<void> {
    // A rejoin keeps the row's user (as SQLite's ON CONFLICT does) and, unless [resetJoinedAt], its first join time.
    await this.people.updateOne(
      { _id: { call_id: callId, device_id: deviceId } },
      resetJoinedAt
        ? { $set: { left_at: null, joined_at: at }, $setOnInsert: { call_id: callId, user_id: userId, device_id: deviceId } }
        : { $set: { left_at: null }, $setOnInsert: { call_id: callId, user_id: userId, device_id: deviceId, joined_at: at } },
      { ...this.s, upsert: true },
    );
  }

  async leave(callId: string, deviceId: string, at: number): Promise<boolean> {
    return (await this.people.updateOne({ _id: { call_id: callId, device_id: deviceId }, left_at: null }, { $set: { left_at: at } }, this.s)).modifiedCount > 0;
  }

  async leaveOtherDevices(callId: string, userId: string, keepDeviceId: string, at: number): Promise<string[]> {
    const candidates = await this.people.find({ call_id: callId, user_id: userId, device_id: { $ne: keepDeviceId }, left_at: null }, this.s).toArray();
    const moved: string[] = [];
    for (const p of candidates) {
      // Conditional per device: of two requests racing, only one reports a device as moved out.
      if (await this.leave(callId, p.device_id, at)) moved.push(p.device_id);
    }
    return moved;
  }

  async raiseHand(callId: string, userId: string, at: number): Promise<void> {
    await this.handsCol.updateOne(
      { _id: { call_id: callId, user_id: userId } },
      { $setOnInsert: { call_id: callId, user_id: userId, raised_at: at } },
      { ...this.s, upsert: true },
    );
  }

  async lowerHand(callId: string, userId: string): Promise<void> {
    await this.handsCol.deleteOne({ _id: { call_id: callId, user_id: userId } }, this.s);
  }

  async hands(callId: string): Promise<CallHandRow[]> {
    return (await this.handsCol.find({ call_id: callId }, { ...this.s, sort: { raised_at: 1 } }).toArray()).map((h) => ({ user_id: h.user_id, raised_at: h.raised_at }));
  }

  async forgetUserHands(userId: string): Promise<void> {
    await this.handsCol.deleteMany({ user_id: userId }, this.s);
  }

  /** Removes these calls with their participants and hands. */
  private async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mongo.transaction(async () => {
      await this.people.deleteMany({ call_id: { $in: ids } }, this.s);
      await this.handsCol.deleteMany({ call_id: { $in: ids } }, this.s);
      await this.calls.deleteMany({ _id: { $in: ids } }, this.s);
    });
  }

  async pruneEnded(cutoff: number): Promise<number> {
    const ids = (
      await this.calls
        .find({ state: "ENDED", $or: [{ ended_at: { $lte: cutoff } }, { ended_at: null, created_at: { $lte: cutoff } }] }, { ...this.s, projection: { _id: 1 } })
        .toArray()
    ).map((d) => d._id);
    await this.remove(ids);
    return ids.length;
  }

  async forgetConversations(conversationIds: readonly string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    const ids = (await this.calls.find({ conversation_id: { $in: [...conversationIds] } }, { ...this.s, projection: { _id: 1 } }).toArray()).map((d) => d._id);
    await this.remove(ids);
  }

  async activeCounts(): Promise<{ calls: number; participants: number; video: number }> {
    const live = await this.calls.find({ state: { $in: ["RINGING", "ACTIVE"] } }, { ...this.s, projection: { _id: 1, video: 1 } }).toArray();
    if (live.length === 0) return { calls: 0, participants: 0, video: 0 };
    const people = await this.people.distinct("user_id", { call_id: { $in: live.map((c) => c._id) }, left_at: null }, this.s);
    return { calls: live.length, participants: people.length, video: live.reduce((n, c) => n + (c.video ? 1 : 0), 0) };
  }

  async days(from: number): Promise<CallDay[]> {
    const calls = await this.calls.find({ created_at: { $gte: from } }, { ...this.s, projection: { created_at: 1, answered_at: 1, end_reason: 1 } }).toArray();
    const byDay = new Map<string, CallDay>();
    for (const c of calls) {
      const day = new Date(Math.floor(c.created_at / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { day, started: 0, answered: 0, declined: 0, lost: 0 };
      d.started++;
      if (c.answered_at != null) d.answered++;
      if (c.end_reason === "declined" || c.end_reason === "busy") d.declined++;
      if (c.end_reason === "lost") d.lost++;
      byDay.set(day, d);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  async participantMinutes(conversationIds: readonly string[], from: number, to: number, now: number): Promise<number> {
    if (conversationIds.length === 0) return 0;
    const ids = await this.calls.distinct("_id", { conversation_id: { $in: [...conversationIds] } }, this.s);
    if (ids.length === 0) return 0;
    const spans = await this.people
      .find({ call_id: { $in: ids }, joined_at: { $lt: to }, $or: [{ left_at: null }, { left_at: { $gt: from } }] }, { ...this.s, projection: { joined_at: 1, left_at: 1 } })
      .toArray();
    let ms = 0;
    for (const p of spans) {
      const end = p.left_at ?? now;
      if (end <= from) continue;
      ms += Math.min(end, to) - Math.max(p.joined_at, from);
    }
    return ms / 60_000;
  }
}
