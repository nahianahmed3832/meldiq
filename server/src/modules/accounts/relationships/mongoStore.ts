import type { Collection } from "mongodb";
import {
  type ConnectionRow,
  type DmRequestRow,
  type MessagingSettings,
  pairOf,
  type RelationshipStore,
} from "./store.js";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";

/** The SQLite rows (same field names, docs/MONGODB.md §3) keyed by their primary keys. */
type ConnectionDoc = ConnectionRow & { _id: string };
type RequestDoc = DmRequestRow & { _id: string };
type SettingsDoc = MessagingSettings & {
  _id: string;
  user_id: string;
  updated_at: number;
};

/** Relationships in MongoDB (MONGODB_DOMAINS includes "relationships"). Every write is one document, except account deletion. */
export class MongoRelationshipStore implements RelationshipStore {
  readonly backend = "mongodb" as const;
  private readonly connections: Collection<ConnectionDoc>;
  private readonly requests: Collection<RequestDoc>;
  private readonly settingsCol: Collection<SettingsDoc>;

  constructor(private readonly mongo: MeldiqMongo) {
    this.connections = mongo.db.collection<ConnectionDoc>("connections");
    this.requests = mongo.db.collection<RequestDoc>("dm_requests");
    this.settingsCol = mongo.db.collection<SettingsDoc>("messaging_settings");
  }

  private strip<T extends { _id: string }>(d: T | null): Omit<T, "_id"> | null {
    if (!d) return null;
    const { _id: _ignored, ...r } = d;
    return r;
  }

  async connection(x: string, y: string): Promise<ConnectionRow | null> {
    return this.strip(
      await this.connections.findOne(
        { _id: pairOf(x, y).pair },
        { session: this.mongo.session() },
      ),
    );
  }

  async connectionsOf(userId: string): Promise<ConnectionRow[]> {
    const docs = await this.connections
      .find(
        { $or: [{ a: userId }, { b: userId }] },
        { session: this.mongo.session(), sort: { created_at: -1 } },
      )
      .toArray();
    return docs.map((d) => this.strip(d)!);
  }

  async putConnection(row: ConnectionRow): Promise<void> {
    await this.connections.replaceOne(
      { _id: row.pair },
      {
        ...row,
        request_note:
          row.state === "accepted" ? null : (row.request_note ?? null),
      },
      { upsert: true, session: this.mongo.session() },
    );
  }
  async requestConnection(
    row: ConnectionRow,
  ): Promise<{ row: ConnectionRow | null; changed: boolean }> {
    const crossed = {
      $and: [
        { $eq: ["$state", "pending"] },
        { $ne: ["$requested_by", row.requested_by] },
      ],
    };
    const fresh = { $eq: [{ $type: "$state" }, "missing"] };
    const previous = await this.connections.findOneAndUpdate(
      { _id: row.pair },
      [
        {
          $set: {
            pair: { $literal: row.pair },
            a: { $literal: row.a },
            b: { $literal: row.b },
            state: {
              $cond: [crossed, "accepted", { $ifNull: ["$state", "pending"] }],
            },
            requested_by: {
              $ifNull: ["$requested_by", { $literal: row.requested_by }],
            },
            created_at: { $ifNull: ["$created_at", row.created_at] },
            accepted_at: {
              $cond: [
                crossed,
                row.created_at,
                { $ifNull: ["$accepted_at", null] },
              ],
            },
            request_note: {
              $cond: [
                fresh,
                { $literal: row.request_note ?? null },
                {
                  $cond: [
                    { $or: [crossed, { $eq: ["$state", "accepted"] }] },
                    null,
                    { $ifNull: ["$request_note", null] },
                  ],
                },
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "before", session: this.mongo.session() },
    );
    const cross =
      previous?.state === "pending" &&
      previous.requested_by !== row.requested_by;
    return {
      row: previous
        ? {
            ...previous,
            ...(cross
              ? {
                  state: "accepted",
                  accepted_at: row.created_at,
                  request_note: null,
                }
              : {}),
          }
        : { ...row, request_note: row.request_note ?? null },
      changed: !previous || cross,
    };
  }

  async deleteConnection(x: string, y: string): Promise<boolean> {
    return (
      (
        await this.connections.deleteOne(
          { _id: pairOf(x, y).pair },
          { session: this.mongo.session() },
        )
      ).deletedCount > 0
    );
  }
  async deletePendingConnection(x: string, y: string): Promise<boolean> {
    return (
      (
        await this.connections.deleteOne(
          { _id: pairOf(x, y).pair, state: "pending" },
          { session: this.mongo.session() },
        )
      ).deletedCount > 0
    );
  }
  async acceptConnection(
    recipient: string,
    from: string,
    at: number,
  ): Promise<boolean> {
    return (
      (
        await this.connections.updateOne(
          {
            _id: pairOf(recipient, from).pair,
            state: "pending",
            requested_by: from,
          },
          { $set: { state: "accepted", accepted_at: at, request_note: null } },
          { session: this.mongo.session() },
        )
      ).modifiedCount === 1
    );
  }

  async request(conversationId: string): Promise<DmRequestRow | null> {
    return this.strip(
      await this.requests.findOne(
        { _id: conversationId },
        { session: this.mongo.session() },
      ),
    );
  }

  async createRequest(row: DmRequestRow): Promise<void> {
    await this.requests.updateOne(
      { _id: row.conversation_id },
      { $setOnInsert: { ...row } },
      { upsert: true, session: this.mongo.session() },
    );
  }

  async requestsFor(
    recipient: string,
    state: DmRequestRow["state"],
  ): Promise<DmRequestRow[]> {
    const docs = await this.requests
      .find(
        { recipient, state },
        { session: this.mongo.session(), sort: { created_at: -1 } },
      )
      .toArray();
    return docs.map((d) => this.strip(d)!);
  }

  async requestsIn(conversationIds: string[]): Promise<DmRequestRow[]> {
    if (conversationIds.length === 0) return [];
    const docs = await this.requests
      .find(
        { _id: { $in: conversationIds } },
        { session: this.mongo.session() },
      )
      .toArray();
    return docs.map((d) => this.strip(d)!);
  }

  async countSent(conversationId: string): Promise<number> {
    const d = await this.requests.findOneAndUpdate(
      { _id: conversationId },
      { $inc: { sent: 1 } },
      { session: this.mongo.session(), returnDocument: "after" },
    );
    return d?.sent ?? 0;
  }

  async declineRequest(conversationId: string, at: number): Promise<void> {
    await this.requests.updateOne(
      { _id: conversationId },
      { $set: { state: "declined", answered_at: at } },
      { session: this.mongo.session() },
    );
  }

  async deleteRequest(conversationId: string): Promise<void> {
    await this.requests.deleteOne(
      { _id: conversationId },
      { session: this.mongo.session() },
    );
  }

  async countStartedSince(userId: string, since: number): Promise<number> {
    const s = this.mongo.session();
    const [c, r] = await Promise.all([
      this.connections.countDocuments(
        { requested_by: userId, created_at: { $gte: since } },
        { session: s },
      ),
      this.requests.countDocuments(
        { sender: userId, created_at: { $gte: since } },
        { session: s },
      ),
    ]);
    return c + r;
  }

  async settings(userId: string): Promise<MessagingSettings | null> {
    const d = await this.settingsCol.findOne(
      { _id: userId },
      { session: this.mongo.session() },
    );
    return d
      ? { dm_policy: d.dm_policy, request_policy: d.request_policy }
      : null;
  }

  async putSettings(
    userId: string,
    s: MessagingSettings,
    at: number,
  ): Promise<void> {
    await this.settingsCol.replaceOne(
      { _id: userId },
      { user_id: userId, ...s, updated_at: at },
      { upsert: true, session: this.mongo.session() },
    );
  }

  async deleteForUser(userId: string): Promise<void> {
    const s = this.mongo.session();
    await this.connections.deleteMany(
      { $or: [{ a: userId }, { b: userId }] },
      { session: s },
    );
    await this.requests.deleteMany(
      { $or: [{ recipient: userId }, { sender: userId }] },
      { session: s },
    );
    await this.settingsCol.deleteOne({ _id: userId }, { session: s });
  }
}
