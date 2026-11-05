import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { newId } from "../../../shared/utilities/util.js";
import { createBotIdentity } from "../../accounts/index.js";
import { sendServerMessage } from "../../messaging/index.js";

/**
 * Who posts for the posting tools (community parity batch C). A webhook, and each community's "Tickets", has a sender
 * account of its own: a bot-kind account (users.kind 'agent', accounts/botIdentity.ts) that can never sign in and is a
 * member of nothing, so it isn't listed, counted or notified anywhere. Its messages go through the one message path
 * with a grant for the single channel the caller checked (messaging/serverSend.ts `channelGrant`), so they are ordinary
 * channel messages: stored, delivered, searchable, reacted to. The account outlives its webhook, so posts keep a name.
 */
export async function createSenderAccount(ctx: AppContext, displayName: string): Promise<string> {
  return (await createBotIdentity(ctx, displayName)).userId;
}

/** Posts [payload] as a message of [senderId] in [channelId], which the caller has checked it may post in. */
export function postAs(ctx: AppContext, senderId: string, channelId: string, payload: Record<string, unknown> & { type: string }, log: FastifyBaseLogger, beforeCommit?: (audience: readonly string[]) => void) {
  return sendServerMessage(ctx, { userId: senderId, deviceId: null, channelGrant: channelId, beforeCommit }, { conversationId: channelId, messageId: newId("m"), cls: "message", sentAt: Date.now(), payload }, log);
}
