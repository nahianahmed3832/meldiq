import { ApiError } from "../../../shared/errors.js";
import { newId } from "../../../shared/utilities/util.js";
import { addBotDevice, botDevice, createBotUser, identityKeyOf, isBot, namesOf, revokeBotDevice } from "../../accounts/index.js";
import type { Deps } from "../access.js";
import type { ReaderKeys } from "./keys.js";

/**
 * Agents reading conversations (docs/AI_WORKFORCE_2_PLAN.md phase 5; AI_AGENT_CHANNEL_READ_PROPOSAL.md §5–§6): each
 * installed agent has one bot identity (a users row of kind 'agent'); each reader is that identity's device in one
 * conversation. Senders' clients decide, per member, whether to wrap their messages to it: the server only accepts
 * such wraps (never requires them) and serves the reader device to clients that implement the notice and the choice.
 * Every check is live: the platform setting, the install, the reader's state.
 */
export interface ReaderRow {
  id: string;
  org_id: string;
  install_id: string;
  conversation_id: string;
  device_id: string;
  reader_key: string | null;
  device_keys: string | null;
  state: "on" | "off";
  mode: "channel" | "direct";
  turned_on_by: string;
  reason: string;
  created_at: number;
  turned_off_at: number | null;
  turned_off_by: string | null;
  off_reason: string | null;
}

/** What a reader keeps: at most this many days, and this many messages. */
export const CONTEXT_DAYS = 30;
export const CONTEXT_MESSAGES = 2000;
const DAY_MS = 86_400_000;

export interface ContextMessage {
  messageId: string;
  senderUserId: string;
  author: string;
  text: string;
  sentAt: number;
  threadRoot: string | null;
}

export class ChannelReaders {
  constructor(
    private readonly d: Deps,
    readonly keys: ReaderKeys,
  ) {}

  private get db() {
    return this.d.ctx.db;
  }

  /** Whether readers work at all right now (the platform setting, and a key to hold them). */
  get enabled(): boolean {
    return this.d.settings.channelReading() && this.keys.available;
  }

  row(id: string): ReaderRow | null {
    return (this.db.prepare("SELECT * FROM ai_channel_readers WHERE id = ?").get(id) as ReaderRow | undefined) ?? null;
  }

  active(): ReaderRow[] {
    if (!this.enabled) return [];
    return this.db.prepare("SELECT * FROM ai_channel_readers WHERE state = 'on' ORDER BY created_at").all() as ReaderRow[];
  }

  /** Readers switched on in [conversationId] (whatever the platform setting says: for showing state). */
  of(conversationId: string): ReaderRow[] {
    return this.db.prepare("SELECT * FROM ai_channel_readers WHERE conversation_id = ? AND state = 'on' ORDER BY created_at").all(conversationId) as ReaderRow[];
  }

  ofInstall(installId: string): ReaderRow[] {
    return this.db.prepare("SELECT * FROM ai_channel_readers WHERE install_id = ? AND state = 'on' ORDER BY created_at").all(installId) as ReaderRow[];
  }

  /** The reader of [installId] in [conversationId], if on and the platform allows reading. */
  readerOf(installId: string, conversationId: string): ReaderRow | null {
    if (!this.enabled) return null;
    return (this.db.prepare("SELECT * FROM ai_channel_readers WHERE install_id = ? AND conversation_id = ? AND state = 'on'").get(installId, conversationId) as ReaderRow | undefined) ?? null;
  }

  /** The bot identity of [installId]: created on first use (a users row of kind 'agent', its seed sealed). */
  identity(installId: string): { userId: string; identityKey: string } {
    const have = this.db.prepare("SELECT user_id FROM ai_agent_identities WHERE install_id = ?").get(installId) as { user_id: string } | undefined;
    const key = have ? identityKeyOf(this.db, have.user_id) : null;
    if (have && key) return { userId: have.user_id, identityKey: key };
    const install = this.d.store.install(installId);
    if (!install) throw new ApiError(404, "not_found", "No such agent.");
    const { sealedSeed, pair } = this.keys.newIdentity(installId);
    const userId = newId("u");
    const t = this.d.clock();
    this.db.transaction(() => {
      createBotUser(this.db, { id: userId, username: `agent-${installId.toLowerCase()}`, displayName: install.displayName.slice(0, 60), identityKey: pair.pub.toString("base64"), at: t });
      this.db.prepare("INSERT INTO ai_agent_identities (install_id, user_id, identity_seed, created_at) VALUES (?, ?, ?, ?)").run(installId, userId, sealedSeed, t);
    })();
    return { userId, identityKey: pair.pub.toString("base64") };
  }

  /** Creates a reader device for [installId] in [conversationId] (callers check who may). Idempotent while on. */
  create(p: { orgId: string; installId: string; conversationId: string; actorId: string; reason: string; mode: ReaderRow["mode"] }): ReaderRow {
    if (!this.enabled) throw new ApiError(409, "ai_reading_not_allowed", "Reading channels is switched off on this platform.");
    const existing = this.readerOf(p.installId, p.conversationId);
    if (existing) return existing;
    const id = newId("rdr");
    const { userId } = this.identity(p.installId);
    const seed = this.db.prepare("SELECT identity_seed FROM ai_agent_identities WHERE install_id = ?").get(p.installId) as { identity_seed: string };
    const dev = this.keys.newDevice(id, this.keys.identity(p.installId, seed.identity_seed));
    const deviceId = newId("d");
    const t = this.d.clock();
    this.db.transaction(() => {
      addBotDevice(this.db, { id: deviceId, userId, name: `AI reader ${id}`, signingKey: dev.signingKey, encryptionKey: dev.encryptionKey, certificate: dev.certificate, at: t });
      this.db
        .prepare(
          `INSERT INTO ai_channel_readers (id, org_id, install_id, conversation_id, device_id, reader_key, device_keys, state, mode, turned_on_by, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'on', ?, ?, ?, ?)`,
        )
        .run(id, p.orgId, p.installId, p.conversationId, deviceId, dev.wrappedKey, dev.sealedKeys, p.mode, p.actorId, p.reason, t);
    })();
    return this.row(id)!;
  }

  /**
   * Switches a reader off: the per-reader key is deleted (what it kept can't be opened), the device is revoked and its
   * queue dropped, what it kept and decided is erased, and every member's choice with it.
   */
  shred(readerId: string, actorId: string | null, reason: string): ReaderRow | null {
    const r = this.row(readerId);
    if (!r || r.state !== "on") return null;
    const t = this.d.clock();
    this.db.transaction(() => {
      this.db.prepare("UPDATE ai_channel_readers SET state = 'off', reader_key = NULL, device_keys = NULL, turned_off_at = ?, turned_off_by = ?, off_reason = ? WHERE id = ?").run(t, actorId, reason, readerId);
      revokeBotDevice(this.db, r.device_id, t);
      this.db.prepare("DELETE FROM ai_channel_context WHERE reader_id = ?").run(readerId);
      this.db.prepare("DELETE FROM ai_reader_events WHERE reader_id = ?").run(readerId);
      this.db.prepare("DELETE FROM ai_reader_choices WHERE reader_id = ?").run(readerId);
    })();
    this.d.ctx.relay.forgetDevice(r.device_id);
    return this.row(readerId);
  }

  // ───────────── The recipient rule (messagesRoutes.ts) and the key list ─────────────

  /** Reader devices a sender may wrap to in [conversationId] (never required). Empty while reading is off. */
  optionalDevices(conversationId: string): { deviceId: string; userId: string }[] {
    if (!this.enabled) return [];
    return this.of(conversationId).flatMap((r) => {
      const d = botDevice(this.db, r.device_id);
      return d ? [{ deviceId: r.device_id, userId: d.userId }] : [];
    });
  }

  /** Key-list entries for [conversationId]'s readers: each agent identity with only its device there. */
  directory(conversationId: string): { userId: string; identityKey: string; devices: { id: string; signingKey: string; encryptionKey: string; certificate: string }[]; revokedDevices: []; agent: { installId: string; readerId: string; name: string } }[] {
    if (!this.enabled) return [];
    return this.of(conversationId).flatMap((r) => {
      const d = botDevice(this.db, r.device_id);
      if (!d) return [];
      return [
        {
          userId: d.userId,
          identityKey: d.identityKey,
          devices: [{ id: r.device_id, signingKey: d.signingKey, encryptionKey: d.encryptionKey, certificate: d.certificate }],
          revokedDevices: [] as [],
          agent: { installId: r.install_id, readerId: r.id, name: this.d.store.install(r.install_id)?.displayName ?? d.displayName },
        },
      ];
    });
  }

  // ───────────── Members' choices ─────────────

  choice(readerId: string, userId: string): "share" | "keep" | null {
    const r = this.db.prepare("SELECT choice FROM ai_reader_choices WHERE reader_id = ? AND user_id = ?").get(readerId, userId) as { choice: "share" | "keep" } | undefined;
    return r?.choice ?? null;
  }

  choose(readerId: string, userId: string, choice: "share" | "keep"): void {
    this.db
      .prepare("INSERT INTO ai_reader_choices (reader_id, user_id, choice, at) VALUES (?, ?, ?, ?) ON CONFLICT (reader_id, user_id) DO UPDATE SET choice = excluded.choice, at = excluded.at")
      .run(readerId, userId, choice, this.d.clock());
  }

  // ───────────── What a reader keeps ─────────────

  private openKeys(r: ReaderRow) {
    if (!r.reader_key || !r.device_keys) throw new ApiError(409, "ai_reading_not_allowed", "This reader is switched off.");
    return this.keys.open(r.id, r.reader_key, r.device_keys);
  }

  /** Opens [r]'s device keys (the worker decrypts with them). */
  deviceKeys(r: ReaderRow) {
    return this.openKeys(r);
  }

  keep(r: ReaderRow, key: Buffer, m: { messageId: string; senderUserId: string; sentAt: number; threadRoot: string | null; text: string }): boolean {
    const changes = this.db
      .prepare(
        `INSERT INTO ai_channel_context (reader_id, message_id, sender_user_id, sent_at, thread_root, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (reader_id, message_id) DO NOTHING`,
      )
      .run(r.id, m.messageId, m.senderUserId, m.sentAt, m.threadRoot, this.keys.sealText(key, r.id, m.messageId, m.text), this.d.clock()).changes;
    return changes > 0;
  }

  /** An edit or a delete, applied by its author only. */
  amend(r: ReaderRow, key: Buffer, senderUserId: string, target: string, text: string | null): void {
    if (text === null) {
      this.db.prepare("DELETE FROM ai_channel_context WHERE reader_id = ? AND message_id = ? AND sender_user_id = ?").run(r.id, target, senderUserId);
      return;
    }
    this.db
      .prepare("UPDATE ai_channel_context SET body = ?, edited_at = ? WHERE reader_id = ? AND message_id = ? AND sender_user_id = ?")
      .run(this.keys.sealText(key, r.id, target, text), this.d.clock(), r.id, target, senderUserId);
  }

  /** Drops what's older than the window, and the oldest beyond its size. */
  trim(r: ReaderRow): void {
    this.db.prepare("DELETE FROM ai_channel_context WHERE reader_id = ? AND sent_at < ?").run(r.id, this.d.clock() - CONTEXT_DAYS * DAY_MS);
    this.db
      .prepare(
        `DELETE FROM ai_channel_context WHERE reader_id = ? AND message_id IN (
           SELECT message_id FROM ai_channel_context WHERE reader_id = ? ORDER BY sent_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(r.id, r.id, CONTEXT_MESSAGES);
  }

  /** The latest [limit] messages [r] kept (oldest first), decrypted; [before] leaves out newer ones. */
  context(r: ReaderRow, limit: number, before?: number): ContextMessage[] {
    const key = this.openKeys(r).key;
    const rows = this.db
      .prepare(`SELECT * FROM ai_channel_context WHERE reader_id = ? ${before ? "AND sent_at < ?" : ""} ORDER BY sent_at DESC LIMIT ?`)
      .all(...(before ? [r.id, before, limit] : [r.id, limit])) as { message_id: string; sender_user_id: string; sent_at: number; thread_root: string | null; body: string }[];
    const names = new Map(namesOf(this.db, [...new Set(rows.map((x) => x.sender_user_id))]).map((u) => [u.id, u.displayName || u.username]));
    return rows.reverse().map((x) => ({ messageId: x.message_id, senderUserId: x.sender_user_id, author: names.get(x.sender_user_id) ?? "someone", text: this.keys.openText(key, r.id, x.message_id, x.body), sentAt: x.sent_at, threadRoot: x.thread_root }));
  }

  /** The dedupe record: false when [messageId] was already handled by [r]. */
  claim(r: ReaderRow, messageId: string): boolean {
    return this.db.prepare("INSERT INTO ai_reader_events (reader_id, message_id, outcome, at) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING").run(r.id, messageId, this.d.clock()).changes > 0;
  }

  outcome(r: ReaderRow, messageId: string, outcome: string, jobId: string | null = null): void {
    this.db.prepare("UPDATE ai_reader_events SET outcome = ?, job_id = ? WHERE reader_id = ? AND message_id = ?").run(outcome.slice(0, 60), jobId, r.id, messageId);
  }

  /** Jobs [r] started in the last [ms] (the per-channel cooldown). */
  recentJobs(r: ReaderRow, ms: number): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM ai_reader_events WHERE reader_id = ? AND outcome = 'job' AND at >= ?").get(r.id, this.d.clock() - ms) as { n: number }).n;
  }

  isAgent(userId: string): boolean {
    return isBot(this.db, userId);
  }
}
