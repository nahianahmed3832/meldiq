import { ApiError } from "../../../shared/errors.js";
import { newId } from "../../../shared/utilities/util.js";
import { namesOf } from "../../accounts/index.js";
import { botDm, conversationMemberIds, openChannelIds } from "../../messaging/index.js";
import { type Deps, requireInvoke } from "../access.js";
import { CONTEXT_DAYS, type ReaderRow } from "./service.js";

/**
 * Who may switch a reader on or off, and what everyone is told (AI_AGENT_CHANNEL_READ_PROPOSAL.md §5, §6.3, §6.8).
 * On: the platform setting, an active agent of this community, an open channel of it (never a DM or group, except a
 * person's own direct conversation with the agent), and someone holding "Manage AI agents" who can also manage that
 * channel, with a reason. Off: the same people, the channel's managers, or the community's owner. Every change is told
 * in the conversation and written to the community's audit log.
 */
export type ReaderMode = ReaderRow["mode"];

export class ReaderControl {
  constructor(private readonly d: Deps) {}

  private get ctx() {
    return this.d.ctx;
  }

  private install(orgId: string, installId: string) {
    const i = this.d.store.install(installId);
    if (!i || i.orgId !== orgId || i.state === "uninstalled") throw new ApiError(404, "not_found", "No such agent in this community.");
    return i;
  }

  /** The AI provider(s) agents use now, named in notices. */
  private providers(): string {
    const names = [...new Set(this.ctx.ai.providers().filter((p) => p.enabled && p.credential.configured).map((p) => p.kindLabel))];
    return names.length ? names.join(" and ") : "the AI provider Meldiq uses";
  }

  private name(userId: string): string {
    const n = namesOf(this.ctx.db, [userId])[0];
    return n?.displayName || n?.username || "someone";
  }

  /** Switches [installId]'s reader on in channel [conversationId]. */
  turnOn(orgId: string, installId: string, conversationId: string, actorId: string, reason: string): ReaderRow {
    const install = this.install(orgId, installId);
    if (install.state !== "active") throw new ApiError(409, "agent_unavailable", `${install.displayName} is turned off in this community.`);
    this.ctx.authz.requirePermission(orgId, actorId, "ai.manage", 'Letting an agent read a channel needs "Manage AI agents".');
    const conv = this.ctx.authz.conversation(conversationId);
    if (!conv || conv.org_id !== orgId || conv.type !== "CHANNEL" || conv.archived_at) throw new ApiError(409, "ai_reading_not_allowed", "Only an open channel of this community can have a reader (never a DM or a group).");
    if (!this.ctx.authz.canManageConversation(conv, actorId)) throw new ApiError(403, "forbidden", "You need to be able to manage that channel to let an agent read it.");
    const had = this.d.readers.readerOf(installId, conversationId);
    const r = this.d.readers.create({ orgId, installId, conversationId, actorId, reason, mode: "channel" });
    if (!had) {
      this.tell(r, `${install.displayName} (AI agent) can now read new messages here, from members who choose to share theirs. Turned on by ${this.name(actorId)}: ${reason}. What it reads is processed on Meldiq's servers and by ${this.providers()}, and kept at most ${CONTEXT_DAYS} days. Earlier messages stay private.`);
      this.ctx.audit({ actorId, orgId, action: "ai.reader_on", target: conversationId, detail: `${installId}:${r.id}` });
    }
    return r;
  }

  /** Readers in every channel the scope covers: the agent's assigned channels, or every open channel of the community. */
  turnOnScope(orgId: string, installId: string, scope: "assigned" | "all", actorId: string, reason: string): ReaderRow[] {
    this.install(orgId, installId);
    this.ctx.authz.requirePermission(orgId, actorId, "ai.manage", 'Letting an agent read channels needs "Manage AI agents".');
    const channels =
      scope === "assigned"
        ? this.d.store.channelsOf(installId).map((c) => c.conversationId)
        : openChannelIds(this.ctx.db, orgId);
    const out: ReaderRow[] = [];
    for (const id of channels) {
      const conv = this.ctx.authz.conversation(id);
      // Channels the person can't manage are left as they are (each one is that channel's managers' choice).
      if (!conv || !this.ctx.authz.canManageConversation(conv, actorId)) continue;
      out.push(this.turnOn(orgId, installId, id, actorId, reason));
    }
    return out;
  }

  turnOff(orgId: string, readerId: string, actorId: string, reason: string): ReaderRow {
    const r = this.d.readers.row(readerId);
    if (!r || r.org_id !== orgId || r.state !== "on") throw new ApiError(404, "not_found", "No such reader, or it's already off.");
    const conv = this.ctx.authz.conversation(r.conversation_id);
    const may =
      this.ctx.authz.can(orgId, actorId, "ai.manage") ||
      this.ctx.authz.orgRole(orgId, actorId) === "OWNER" ||
      (conv !== undefined && this.ctx.authz.canManageConversation(conv, actorId)) ||
      (r.mode === "direct" && this.ctx.authz.isMember(r.conversation_id, actorId));
    if (!may) throw new ApiError(403, "forbidden", "Switching an agent's reading off needs \"Manage AI agents\" or managing that channel.");
    const off = this.d.readers.shred(readerId, actorId, reason)!;
    const name = this.d.store.install(r.install_id)?.displayName ?? "The agent";
    this.tell(off, `${name} can no longer read this conversation. What it kept has been erased.`);
    this.ctx.audit({ actorId, orgId, action: "ai.reader_off", target: r.conversation_id, detail: `${r.install_id}:${r.id}` });
    return off;
  }

  /**
   * [userId]'s direct conversation with [installId]'s agent: a DM between them and the agent's bot identity, read by a
   * reader there. Starting it is their choice to share what they write in it.
   */
  direct(orgId: string, installId: string, userId: string): { conversationId: string; reader: ReaderRow } {
    const install = this.install(orgId, installId);
    requireInvoke(this.ctx, install, userId);
    const { userId: agentUserId } = this.d.readers.identity(installId);
    const conv = { id: botDm(this.ctx.db, { id: newId("c"), userId, botUserId: agentUserId, at: this.d.clock() }) };
    const had = this.d.readers.readerOf(installId, conv.id);
    const reader = had ?? this.d.readers.create({ orgId, installId, conversationId: conv.id, actorId: userId, reason: "direct conversation", mode: "direct" });
    this.d.readers.choose(reader.id, userId, "share");
    if (!had) {
      this.tell(reader, `This is a direct conversation with ${install.displayName} (AI agent). Everything you write here is read by it: processed on Meldiq's servers and by ${this.providers()}, and kept at most ${CONTEXT_DAYS} days.`);
      this.ctx.audit({ actorId: userId, orgId, action: "ai.reader_direct", target: conv.id, detail: `${installId}:${reader.id}` });
    }
    return { conversationId: conv.id, reader };
  }

  /** A notice from the agent, in the conversation, for everyone in it; and members' apps refresh its keys. */
  private tell(r: ReaderRow, body: string): void {
    this.d.posts.add({ orgId: r.org_id, conversationId: r.conversation_id, threadRoot: null, installId: r.install_id, jobId: null, kind: "progress", body });
    const members = conversationMemberIds(this.ctx, r.conversation_id);
    this.ctx.hub.sendToUsers(members, { t: "conv.updated", conversationId: r.conversation_id });
    this.ctx.hub.sendToUsers(members, { t: "ai.posts", conversationId: r.conversation_id });
  }
}
