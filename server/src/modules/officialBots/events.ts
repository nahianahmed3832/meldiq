/**
 * What official bots react to (community parity batch D). Two hooks feed them, both synchronous and cheap: the message
 * path (messaging/serverSend.ts, after a message or change in a community channel was accepted) and the audit trail
 * (app/server.ts `ctx.audit`, which every membership and role change already writes with who did it). Each turns into
 * one of these events, queued and handled after the triggering write (runtime.ts).
 */

/** A message or change accepted in a community conversation (serverSend.ts). */
export interface NotedMessage {
  orgId: string;
  conversationId: string;
  userId: string;
  messageId: string;
  cls: "message" | "control";
  payload: Record<string, unknown>;
  at: number;
}

/** An audit entry as ctx.audit receives it. */
export interface NotedAudit {
  actorId?: string | null;
  orgId?: string | null;
  action: string;
  target?: string | null;
  detail?: string | null;
}

export type MemberChange = "join" | "leave" | "remove" | "expire" | "ban" | "unban" | "timeout" | "timeout_end";

interface Base {
  orgId: string;
  at: number;
}
export interface MessagePosted extends Base {
  kind: "message";
  conversationId: string;
  userId: string;
  messageId: string;
  payload: Record<string, unknown>;
}
export interface MessageEdited extends Base {
  kind: "edit";
  conversationId: string;
  userId: string;
  /** The edit's own event id, and the message it changes. */
  eventId: string;
  target: string;
  text: string;
}
export interface MessageDeleted extends Base {
  kind: "delete";
  conversationId: string;
  /** Who deleted it (its sender or a moderator). */
  userId: string;
  target: string;
}
export interface ReactionChanged extends Base {
  kind: "reaction";
  eventId: string;
  conversationId: string;
  userId: string;
  target: string;
  emoji: string;
  add: boolean;
}
export interface MemberChanged extends Base {
  kind: "member";
  change: MemberChange;
  userId: string;
  actorId: string | null;
  detail: string | null;
}
export interface RoleChanged extends Base {
  kind: "role";
  given: boolean;
  userId: string;
  roleId: string;
  roleName: string;
  actorId: string | null;
}

export type BotEvent = MessagePosted | MessageEdited | MessageDeleted | ReactionChanged | MemberChanged | RoleChanged;

/** The message path's side: new messages, edits, deletions and reactions; everything else is ignored. */
export function fromMessage(m: NotedMessage): BotEvent | null {
  const base = {
    orgId: m.orgId,
    conversationId: m.conversationId,
    userId: m.userId,
    at: m.at,
  };
  const { type, target } = m.payload;
  if (m.cls === "message")
    return {
      kind: "message",
      ...base,
      messageId: m.messageId,
      payload: m.payload,
    };
  if (typeof target !== "string") return null;
  if (type === "edit")
    return {
      kind: "edit",
      ...base,
      eventId: m.messageId,
      target,
      text: typeof m.payload.text === "string" ? m.payload.text : "",
    };
  if (type === "delete") return { kind: "delete", ...base, target };
  if (type === "reaction" && typeof m.payload.emoji === "string")
    return {
      kind: "reaction",
      ...base,
      eventId: m.messageId,
      target,
      emoji: m.payload.emoji,
      add: m.payload.add !== false,
    };
  return null;
}

/** Audit actions that mean someone joined, and where the newcomer's id is. */
const JOINS: Record<string, "actor" | "target"> = {
  "community.join": "target",
  "invite.accept": "actor",
  "member.add": "target",
  "application.approved": "target",
};
const MEMBER_CHANGES: Record<string, MemberChange> = {
  "member.leave": "leave",
  "member.remove": "remove",
  "member.expire": "expire",
  "member.ban": "ban",
  "member.unban": "unban",
  "member.timeout": "timeout",
  "member.timeout_end": "timeout_end",
};

/** The audit trail's side: joins, leaves, kicks, bans, unbans, timeouts and roles given or taken. */
export function fromAudit(e: NotedAudit, at: number): BotEvent | null {
  if (!e.orgId) return null;
  const actorId = e.actorId ?? null;
  const join = JOINS[e.action];
  if (join) {
    const userId = join === "actor" ? actorId : (e.target ?? null);
    return userId
      ? {
          kind: "member",
          orgId: e.orgId,
          at,
          change: "join",
          userId,
          actorId,
          detail: null,
        }
      : null;
  }
  const change = MEMBER_CHANGES[e.action];
  if (change)
    return e.target
      ? {
          kind: "member",
          orgId: e.orgId,
          at,
          change,
          userId: e.target,
          actorId,
          detail: e.detail ?? null,
        }
      : null;
  if (e.action === "role.assign" || e.action === "role.unassign") {
    const [roleId, userId] = (e.target ?? "").split(":");
    if (!roleId || !userId) return null;
    return {
      kind: "role",
      orgId: e.orgId,
      at,
      given: e.action === "role.assign",
      userId,
      roleId,
      roleName: e.detail ?? "a role",
      actorId,
    };
  }
  return null;
}
