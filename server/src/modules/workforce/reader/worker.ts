import { openEnvelope, type QueuedEnvelope } from "../../../infrastructure/crypto/envelope.js";
import { ApiError } from "../../../shared/errors.js";
import { senderKeys } from "../../accounts/index.js";
import { conversationMemberIds } from "../../messaging/index.js";
import type { Deps } from "../access.js";
import { findAgent } from "../catalog/index.js";
import { readsMessages, type SharedMessage } from "../sharedMessages.js";
import type { Workforce } from "../service.js";
import type { ChannelReaders, ReaderRow } from "./service.js";

/**
 * The readers' worker (docs/AI_WORKFORCE_2_PLAN.md phase 5): drains each reader device's queue like a client, verifies
 * and decrypts what members chose to share, keeps it (sealed), applies edits and deletes, and decides once per message
 * whether the agent acts: a mention of the agent, its command, a reply in the thread of one of its posts, or any message
 * in a direct conversation with it. Messages are untrusted input: they start a job as the person who wrote them, under
 * every check a job from the Ask form gets, and nothing in them changes permissions. Agents' own output never arrives
 * here (agent posts aren't messages), and messages from agent identities are ignored, so agents can't loop.
 */
const BATCH = 200;
/** At most this many jobs per reader in this window (a channel's cooldown). */
const COOLDOWN_JOBS = 6;
const COOLDOWN_MS = 60_000;
/** Messages handed to a job as context: the latest ones the reader kept. */
const CONTEXT_FOR_JOB = 30;
const MAX_TEXT = 4000;

interface TextPayload {
  type?: string;
  text?: string;
  threadRoot?: string;
  mentions?: string[];
  target?: string;
}

/** Refusals worth telling the person in the conversation (others, like permissions, stay silent). */
const TELL: ReadonlySet<string> = new Set(["ai_not_configured", "agent_unavailable", "quota_exceeded", "ai_paused", "ai_disabled", "bad_request"]);

export class ReaderWorker {
  constructor(
    private readonly d: Deps,
    private readonly readers: ChannelReaders,
    private readonly service: Workforce,
  ) {}

  private running = false;

  /** One pass over every active reader; never runs twice at once. */
  async drain(): Promise<{ read: number; jobs: number }> {
    if (this.running) return { read: 0, jobs: 0 };
    this.running = true;
    const stats = { read: 0, jobs: 0 };
    try {
      for (const r of this.readers.active()) {
        // One reader's trouble (a key that won't open, the relay) never stops the others or the worker.
        try {
          await this.drainOne(r, stats);
        } catch (e) {
          this.d.ctx.log.error({ err: e instanceof Error ? e.message : String(e), reader: r.id }, "ai reader drain failed");
        }
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async drainOne(r: ReaderRow, stats: { read: number; jobs: number }): Promise<void> {
    const items = await this.d.ctx.relay.backlog(r.device_id, this.d.clock(), BATCH);
    if (!items.length) return;
    const keys = this.readers.deviceKeys(r);
    const done: number[] = [];
    for (const it of items) {
      done.push(it.id);
      if (it.kind !== "envelope" || it.conversation_id !== r.conversation_id) continue;
      if (this.readers.isAgent(it.sender_user_id)) continue;
      const sender = senderKeys(this.d.ctx.db, it.sender_device_id, it.sender_user_id);
      if (!sender) continue;
      let opened;
      try {
        const env: QueuedEnvelope = { messageId: it.message_id, conversationId: it.conversation_id, senderUserId: it.sender_user_id, senderDeviceId: it.sender_device_id, payload: JSON.parse(it.payload) as QueuedEnvelope["payload"] };
        opened = await openEnvelope(env, sender, { deviceId: r.device_id, encPriv: keys.encPriv });
      } catch {
        continue; // Not verifiable or not decryptable: dropped, never kept or acted on.
      }
      const p = (opened.payload ?? {}) as TextPayload;
      if (opened.cls === "control") {
        // Edits and deletes of what this reader kept; everything else (calls, reactions, receipts) is ignored.
        if (p.type === "edit" && typeof p.target === "string" && typeof p.text === "string") this.readers.amend(r, keys.key, opened.senderUserId, p.target, p.text.slice(0, MAX_TEXT));
        if (p.type === "delete" && typeof p.target === "string") this.readers.amend(r, keys.key, opened.senderUserId, p.target, null);
        continue;
      }
      if (opened.cls !== "message" || p.type !== "text" || typeof p.text !== "string" || !p.text.trim()) continue;
      const text = p.text.slice(0, MAX_TEXT);
      this.readers.keep(r, keys.key, { messageId: opened.messageId, senderUserId: opened.senderUserId, sentAt: opened.sentAt, threadRoot: p.threadRoot ?? null, text });
      stats.read++;
      if (await this.act(r, { messageId: opened.messageId, senderUserId: opened.senderUserId, sentAt: opened.sentAt, text, threadRoot: p.threadRoot ?? null, mentions: p.mentions ?? [] })) stats.jobs++;
    }
    await this.d.ctx.relay.take(r.device_id, done);
    this.readers.trim(r);
  }

  /** Whether [m] calls on the reader's agent: its mention, its command, a reply to its post, or a direct conversation. */
  private calledOn(r: ReaderRow, m: { text: string; threadRoot: string | null; mentions: string[] }, name: string, agentUserId: string): { brief: string } | null {
    if (r.mode === "direct") return { brief: m.text };
    const assignment = this.d.store.assignment(r.install_id, r.conversation_id);
    if (!assignment || assignment.activation === "explicit") return null;
    const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s,.:;!?])`, "i");
    const command = new RegExp(`^/${handle}(?=$|\\s)`, "i");
    const strip = (t: string) => t.replace(mention, " ").replace(command, " ").trim();
    const repliedTo = m.threadRoot !== null && this.d.ctx.db.prepare("SELECT 1 FROM ai_channel_posts WHERE id = ? AND install_id = ?").get(m.threadRoot, r.install_id) !== undefined;
    const mentioned = m.mentions.includes(agentUserId) || mention.test(m.text);
    const commanded = command.test(m.text);
    const called = assignment.activation === "command" ? commanded || repliedTo : mentioned || commanded || repliedTo;
    return called ? { brief: strip(m.text) || m.text } : null;
  }

  /** Decides once per message; a job it starts is an ordinary job, as the person who wrote the message. */
  private async act(r: ReaderRow, m: { messageId: string; senderUserId: string; sentAt: number; text: string; threadRoot: string | null; mentions: string[] }): Promise<boolean> {
    if (!this.readers.claim(r, m.messageId)) return false;
    const install = this.d.store.install(r.install_id);
    const def = install ? findAgent(install.agentId, install.version) : null;
    if (!install || !def || install.state !== "active") return this.readers.outcome(r, m.messageId, "agent_unavailable"), false;
    const { userId: agentUserId } = this.readers.identity(install.id);
    const call = this.calledOn(r, m, install.displayName, agentUserId);
    if (!call) return this.readers.outcome(r, m.messageId, "ignored"), false;
    if (this.readers.recentJobs(r, COOLDOWN_MS) >= COOLDOWN_JOBS) return this.readers.outcome(r, m.messageId, "cooldown"), false;
    const threadRoot = m.threadRoot ?? m.messageId;
    const context: SharedMessage[] = readsMessages(def)
      ? this.readers
          .context(r, CONTEXT_FOR_JOB + 1)
          .filter((c) => c.messageId !== m.messageId)
          .slice(-CONTEXT_FOR_JOB)
          .map((c) => ({ author: c.author.slice(0, 80) || "someone", text: c.text.slice(0, 4000), at: c.sentAt }))
      : [];
    try {
      const job = this.service.createJob({
        orgId: install.orgId,
        installId: install.id,
        userId: m.senderUserId,
        input: { brief: call.brief.slice(0, 4000) },
        conversationId: r.conversation_id,
        threadRoot,
        fileIds: [],
        idempotencyKey: `msg:${m.messageId}`,
        requestText: null,
        channelMessages: context.length ? context : null,
        origin: { readerId: r.id },
      });
      this.readers.outcome(r, m.messageId, "job", job.id);
      return true;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      this.readers.outcome(r, m.messageId, `refused:${code}`);
      if (e instanceof ApiError && TELL.has(code) && this.d.store.assignment(install.id, r.conversation_id)) {
        this.d.posts.add({ orgId: install.orgId, conversationId: r.conversation_id, threadRoot, installId: install.id, jobId: null, kind: "error", body: `I can't take this on: ${e.message}` });
        this.d.ctx.hub.sendToUsers(conversationMemberIds(this.d.ctx, r.conversation_id), { t: "ai.posts", conversationId: r.conversation_id });
      }
      return false;
    }
  }
}
