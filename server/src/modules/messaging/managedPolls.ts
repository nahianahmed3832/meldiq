import type { FastifyInstance } from "fastify";
import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import {
  ManagedPollInput,
  ManagedPollPublic,
  ManagedPollVote,
} from "../../shared/contracts/http/managedPolls.js";
import type { SendMessage } from "../../shared/contracts/http/serverMessages.js";
import { parse } from "../../shared/validation/index.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";
import { memberIds } from "./memberUsers.js";
import { threadRootOf, type MessageEvent } from "./store/messageStore.js";
import { admitThreadReply, withThreadLock } from "./threadManagement.js";
type Poll = z.infer<typeof ManagedPollPublic>;
interface PollRow {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  definition: string;
  answer_key: string | null;
  fingerprint: string;
  closed_at: number | null;
  rev: number;
  created_at: number;
}
interface Ballot {
  message_id: string;
  user_id: string;
  choices: string;
  anonymous: number;
}
export interface PollReservation {
  poll: Poll;
  answers: string[] | null;
  fingerprint: string;
}

/** Answer keys are accepted only on creation and never retained in a message or a delivery envelope. */
export function prepareManagedPoll(
  message: SendMessage,
): PollReservation | null {
  if (message.payload.managedPoll === undefined) return null;
  if (
    message.cls !== "message" ||
    message.payload.type !== "text" ||
    message.payload.poll
  )
    throw badRequest("Create a managed poll as a new text message");
  const input = parse(ManagedPollInput, message.payload.managedPoll);
  const { correctOptionIds, ...poll } = input;
  const answers = correctOptionIds ?? null;
  const fingerprint = sha256Hex(JSON.stringify({ poll, answers }));
  message.payload = {
    ...message.payload,
    managedPoll: poll,
    text: `📊 ${poll.question}\n${poll.options.map((o, i) => `${i + 1}. ${o.text}`).join("\n")}`,
  };
  return { poll, answers, fingerprint };
}
export async function reserveManagedPoll(
  ctx: AppContext,
  message: SendMessage,
  senderId: string,
  reservation: PollReservation,
): Promise<void> {
  await ctx.ws.write((w) => {
    if (
      reservation.poll.endsAt !== undefined &&
      reservation.poll.endsAt <= now()
    )
      throw badRequest("Choose a future poll closing time");
    const prior = w.get<PollRow>("managed_polls", {
      message_id: message.messageId,
    });
    if (prior) {
      if (
        prior.sender_id !== senderId ||
        prior.conversation_id !== message.conversationId ||
        prior.fingerprint !== reservation.fingerprint
      )
        throw conflict("This poll message ID already has another definition");
      return;
    }
    w.insert("managed_polls", {
      message_id: message.messageId,
      conversation_id: message.conversationId,
      sender_id: senderId,
      definition: JSON.stringify(reservation.poll),
      answer_key: reservation.answers
        ? JSON.stringify(reservation.answers)
        : null,
      fingerprint: reservation.fingerprint,
      closed_at: null,
      rev: 1,
      created_at: now(),
    });
  });
}

/** Older poll controls still need authoritative target, option and expiry checks. Their name-hiding setting remains a legacy UI choice. */
export async function validateLegacyPollControl(
  ctx: AppContext,
  message: SendMessage,
  userId: string,
): Promise<void> {
  if (
    message.cls !== "control" ||
    !["vote", "poll_close"].includes(message.payload.type)
  )
    return;
  const target =
    typeof message.payload.target === "string"
      ? await ctx.messages.get(message.payload.target)
      : null;
  if (
    !target ||
    target.cls !== "message" ||
    target.conversation_id !== message.conversationId
  )
    throw notFound("Poll not found");
  let poll: Poll;
  try {
    poll = ManagedPollPublic.parse(JSON.parse(target.payload).poll);
  } catch {
    throw badRequest("That message is not a supported legacy poll");
  }
  if (
    (
      await ctx.messages.changesTo(message.conversationId, target.id, "delete")
    ).some((change) => change.audience !== "self")
  )
    throw notFound("Poll not found");
  const conv = requireScope(
    ctx,
    message.conversationId,
    userId,
    target.server_ts,
  );
  if (message.payload.type !== "vote") return;
  if (!ctx.authz.canPost(conv, userId))
    throw forbidden("You cannot vote in this conversation");
  if (
    (poll.endsAt !== undefined && now() >= poll.endsAt) ||
    (
      await ctx.messages.changesTo(
        message.conversationId,
        target.id,
        "poll_close",
      )
    ).some((change) => change.audience !== "self")
  )
    throw conflict("Voting has ended");
  const choices = message.payload.choices;
  if (
    !Array.isArray(choices) ||
    choices.length > 10 ||
    new Set(choices).size !== choices.length ||
    (!poll.multi && choices.length > 1) ||
    choices.some(
      (choice) =>
        typeof choice !== "string" ||
        !poll.options.some((option) => option.id === choice),
    ) ||
    (message.payload.anonymous !== undefined &&
      typeof message.payload.anonymous !== "boolean")
  )
    throw badRequest("Choose valid poll options");
}

/** A global deletion erases the answer key and ballots too. A retry completes this settlement if it failed after acceptance. */
export async function settlePollDeletion(
  ctx: AppContext,
  message: SendMessage,
): Promise<void> {
  if (
    message.cls !== "control" ||
    message.payload.type !== "delete" ||
    message.audience === "self" ||
    typeof message.payload.target !== "string"
  )
    return;
  const id = message.payload.target;
  if (ctx.ws.get("managed_polls", { message_id: id }))
    await ctx.ws.write((w) => w.delete("managed_polls", { message_id: id }));
}

function requireScope(
  ctx: AppContext,
  conversationId: string,
  userId: string,
  messageAt: number,
) {
  const conv = ctx.authz.conversation(conversationId);
  if (!conv || !ctx.authz.isMember(conversationId, userId))
    throw notFound("Poll not found");
  const since = ctx.authz.historySince(conv, userId);
  if (since !== null && messageAt < since) throw notFound("Poll not found");
  return conv;
}
async function load(
  ctx: AppContext,
  id: string,
  userId: string,
): Promise<{ row: PollRow; poll: Poll; message: MessageEvent }> {
  const row = ctx.ws.get<PollRow>("managed_polls", { message_id: id });
  if (!row) throw notFound("Poll not found");
  const message = await ctx.messages.get(id);
  if (
    !message ||
    message.cls !== "message" ||
    message.conversation_id !== row.conversation_id
  )
    throw notFound("Poll not found");
  requireScope(ctx, row.conversation_id, userId, message.server_ts);
  const deleted = (
    await ctx.messages.changesTo(row.conversation_id, id, "delete")
  ).some((change) => change.audience !== "self");
  if (deleted) throw notFound("Poll not found");
  requireScope(ctx, row.conversation_id, userId, message.server_ts);
  return {
    row,
    poll: ManagedPollPublic.parse(JSON.parse(row.definition)),
    message,
  };
}
const closed = (row: PollRow, poll: Poll) =>
  row.closed_at !== null || (poll.endsAt !== undefined && now() >= poll.endsAt);
function state(ctx: AppContext, row: PollRow, poll: Poll, userId: string) {
  const votes = ctx.ws.all<Ballot>("managed_poll_votes", {
    where: { message_id: row.message_id },
  });
  const mine = votes.find((v) => v.user_id === userId),
    isClosed = closed(row, poll);
  const voters = votes.map((v) => ({
    userId: v.anonymous ? null : v.user_id,
    choices: JSON.parse(v.choices) as string[],
  }));
  // Anonymous records have no ID, name, timestamp, account-derived key or stable input ordering.
  voters.sort((a, b) =>
    a.userId === null && b.userId === null
      ? JSON.stringify(a.choices).localeCompare(JSON.stringify(b.choices))
      : (a.userId ?? "~").localeCompare(b.userId ?? "~"),
  );
  return {
    id: row.message_id,
    poll,
    closed: isClosed,
    rev: row.rev,
    mine: mine
      ? {
          choices: JSON.parse(mine.choices) as string[],
          anonymous: !!mine.anonymous,
        }
      : null,
    total: voters.length,
    counts: poll.options.map((option) => ({
      id: option.id,
      votes: voters.filter((v) => v.choices.includes(option.id)).length,
    })),
    voters,
    correctOptionIds:
      isClosed && poll.quiz && row.answer_key
        ? (JSON.parse(row.answer_key) as string[])
        : null,
    canClose: row.sender_id === userId && !isClosed,
  };
}
export async function managedPollState(
  ctx: AppContext,
  id: string,
  userId: string,
) {
  const { row, poll } = await load(ctx, id, userId);
  return state(ctx, row, poll, userId);
}
function changed(ctx: AppContext, message: MessageEvent, rev: number) {
  const users = memberIds(ctx, message.conversation_id).filter((userId) => {
    try {
      requireScope(ctx, message.conversation_id, userId, message.server_ts);
      return true;
    } catch {
      return false;
    }
  });
  ctx.hub.sendToUsers(users, {
    t: "poll.updated",
    conversationId: message.conversation_id,
    messageId: message.id,
    rev,
  });
}
export default async function managedPollRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = { preHandler: requireAuth(ctx) };
  app.get("/v1/polls/:id", auth, async (req) =>
    managedPollState(ctx, parse(idParams, req.params).id, me(req).userId),
  );
  app.put("/v1/polls/:id/vote", auth, async (req) => {
    const id = parse(idParams, req.params).id,
      userId = me(req).userId,
      body = parse(ManagedPollVote, req.body);
    const { poll, message } = await load(ctx, id, userId);
    const conv = requireScope(
      ctx,
      message.conversation_id,
      userId,
      message.server_ts,
    );
    const rootId =
      threadRootOf(message) ?? (conv.format === "forum" ? message.id : null);
    const vote = async () => {
      if (rootId) await admitThreadReply(ctx, conv, userId, rootId);
      return ctx.ws.write((w) => {
        const conv = requireScope(
          ctx,
          message.conversation_id,
          userId,
          message.server_ts,
        );
        if (!ctx.authz.canPost(conv, userId))
          throw forbidden("You cannot vote in this conversation");
        const row = w.get<PollRow>("managed_polls", { message_id: id });
        if (!row) throw notFound("Poll not found");
        if (closed(row, poll)) throw conflict("Voting has ended");
        if (
          (!poll.multi && body.choices.length > 1) ||
          body.choices.some(
            (choice) => !poll.options.some((option) => option.id === choice),
          )
        )
          throw badRequest("Choose valid poll options");
        const prior = w.get<Ballot>("managed_poll_votes", {
          message_id: id,
          user_id: userId,
        });
        const choices = [...body.choices].sort(),
          anonymous =
            body.anonymous === undefined
              ? (prior?.anonymous ?? 0)
              : body.anonymous
                ? 1
                : 0;
        if (
          !choices.length
            ? !prior
            : prior?.choices === JSON.stringify(choices) &&
              prior.anonymous === anonymous
        )
          return { row, changed: false };
        if (!choices.length)
          w.delete("managed_poll_votes", { message_id: id, user_id: userId });
        else
          w.upsert(
            "managed_poll_votes",
            {
              message_id: id,
              user_id: userId,
              choices: JSON.stringify(choices),
              anonymous,
            },
            "replace",
          );
        const next = { ...row, rev: row.rev + 1 };
        w.update("managed_polls", { message_id: id }, { rev: next.rev });
        return { row: next, changed: true };
      });
    };
    const accepted = rootId
      ? await withThreadLock(ctx, rootId, vote)
      : await vote();
    if (accepted.changed) changed(ctx, message, accepted.row.rev);
    return managedPollState(ctx, id, userId);
  });
  app.post("/v1/polls/:id/close", auth, async (req) => {
    const id = parse(idParams, req.params).id,
      userId = me(req).userId,
      { poll, message } = await load(ctx, id, userId);
    const result = await ctx.ws.write((w) => {
      requireScope(ctx, message.conversation_id, userId, message.server_ts);
      const row = w.get<PollRow>("managed_polls", { message_id: id });
      if (!row) throw notFound("Poll not found");
      if (row.sender_id !== userId)
        throw forbidden("Only the poll author can close it");
      if (row.closed_at !== null) return { row, changed: false };
      const next = { ...row, closed_at: now(), rev: row.rev + 1 };
      w.update(
        "managed_polls",
        { message_id: id },
        { closed_at: next.closed_at, rev: next.rev },
      );
      return { row: next, changed: true };
    });
    if (result.changed) changed(ctx, message, result.row.rev);
    return state(ctx, result.row, poll, userId);
  });
}
