import type { AppContext } from "../../app/context.js";
import { requireFeature } from "../../app/platformControls.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { requireVoiceConnect } from "./voiceModeration.js";
import {
  assertCallHasRoom,
  broadcastCall,
  callAdmission,
  endCallRow,
} from "./routes.js";
import type { CallRow } from "./store.js";
import { isBotUser, namesOf } from "../accounts/index.js";

/** Calls owns all room/media operations. Bot policy and ephemeral leases belong to the bot module. */
export async function prepareBotMedia(
  ctx: AppContext,
  botId: string,
  channelId: string,
  participantId: string,
  waitForMember = false,
) {
  requireFeature(ctx.platform, "calls", botId);
  const conv = ctx.authz.requireMember(channelId, botId);
  if (
    conv.type !== "CHANNEL" ||
    !conv.org_id ||
    !conv.voice ||
    conv.archived_at
  )
    throw notFound("No active voice channel");
  requireVoiceConnect(ctx, conv, botId);
  if (!ctx.livekit)
    throw new ApiError(
      503,
      "media_unavailable",
      "Calling is not configured on this server",
    );
  const call = (await ctx.calls.liveIn([conv.id])).find(
    (row) => row.state === "ACTIVE" && row.room === 1 && !row.host_server_id,
  );
  if (!call && waitForMember) return null;
  if (!call)
    throw new ApiError(
      409,
      "conflict",
      "A member must open this voice room before the bot joins",
    );
  if (waitForMember) {
    const present = await ctx.livekit.participantIdentities(call.room_name);
    if (!present)
      throw new ApiError(
        503,
        "media_unavailable",
        "The media server could not confirm a connected member",
      );
    const admitted = callAdmission(ctx, conv.id);
    const humanPresent = present.some((identity) => {
      const [userId, deviceId] = identity.split(".");
      return (
        !!userId &&
        !!deviceId &&
        !isBotUser(ctx, userId) &&
        admitted(userId, deviceId)
      );
    });
    if (!humanPresent) return null;
  }
  await assertCallHasRoom(ctx, call, `${botId}.${participantId}`);
  requireVoiceConnect(ctx, conv, botId);
  return call;
}

export async function issueBotMedia(
  ctx: AppContext,
  call: CallRow,
  botId: string,
  participantId: string,
  canSpeak: boolean,
) {
  if (!ctx.bots.voice.mayIssueMedia(botId, participantId, call.id))
    throw forbidden("This bot media lease is not ready");
  if (!ctx.livekit)
    throw new ApiError(
      503,
      "media_unavailable",
      "Calling is not configured on this server",
    );
  const conv = ctx.authz.requireMember(call.conversation_id, botId);
  requireVoiceConnect(ctx, conv, botId);
  const name = namesOf(ctx.identity, [botId])[0]?.displayName ?? "";
  const token = await ctx.livekit.botToken({
    room: call.room_name,
    identity: `${botId}.${participantId}`,
    name,
    metadata: JSON.stringify({ bot: true, botId, leaseId: participantId }),
    // The current SFU admission/connected handler enables microphone publishing after a fresh authority check.
    canPublish: false,
  });
  return {
    url: ctx.livekit.publicUrl,
    token,
    room: call.room_name,
    canSpeak,
    limits: { screen: [], voiceKbps: ctx.mojo.voiceKbps(conv.org_id ?? null) },
  };
}

/** A bot cannot assert a connection merely by calling HTTP. */
export async function confirmBotMedia(
  ctx: AppContext,
  callId: string,
  botId: string,
  participantId: string,
) {
  const call = await ctx.calls.get(callId);
  if (!call || call.state !== "ACTIVE" || call.host_server_id)
    throw notFound("This voice call is no longer active");
  const present = await ctx.livekit?.participantIdentities(call.room_name);
  if (!present)
    throw new ApiError(
      503,
      "media_unavailable",
      "The media server could not confirm presence",
    );
  if (!present.includes(`${botId}.${participantId}`))
    throw forbidden("The bot is not connected to this media room");
  if (!ctx.bots.voice.admitted(botId, participantId, call.conversation_id))
    throw forbidden("This bot voice lease was revoked");
  if (
    (await ctx.livekit!.setCanPublish(
      call.room_name,
      `${botId}.${participantId}`,
      ctx.bots.voice.maySpeak(botId, participantId),
      false,
    )) === "error"
  ) {
    ctx.bots.voice.withdraw(botId, participantId);
    throw new ApiError(
      503,
      "media_unavailable",
      "Bot media permissions could not be applied",
    );
  }
  await ctx.calls.join(call.id, botId, participantId, Date.now(), false);
  if ((await ctx.calls.get(call.id))?.state !== "ACTIVE")
    throw notFound("This voice call ended");
  await broadcastCall(ctx, call, "updated");
}

/** Admission is closed before this runs. Failed SFU removals are retained for retry by the lease owner. */
export async function closeBotMedia(
  ctx: AppContext,
  call: Pick<CallRow, "id" | "room_name">,
  botId: string,
  participantId: string,
) {
  if (
    !ctx.livekit ||
    (await ctx.livekit.removeParticipant(
      call.room_name,
      `${botId}.${participantId}`,
    )) === "error"
  )
    throw new ApiError(
      503,
      "media_unavailable",
      "Bot media removal is waiting for the media server",
    );
  await ctx.calls.leave(call.id, participantId, Date.now());
  await ctx.calls.lowerHand(call.id, botId);
  const current = await ctx.calls.get(call.id);
  if (!current || current.state === "ENDED") return;
  if (!(await ctx.calls.present(call.id)).length)
    await endCallRow(ctx, current, "empty");
  else await broadcastCall(ctx, current, "updated");
}

/** Key senders must be an actual current human media participant with the call key in their client. */
export async function admitBotKeySender(
  ctx: AppContext,
  callId: string,
  userId: string,
  deviceId: string,
) {
  const call = await ctx.calls.get(callId);
  if (!call || call.state !== "ACTIVE" || call.host_server_id || !call.room)
    throw notFound("No active native voice call");
  const conv = ctx.authz.requireMember(call.conversation_id, userId);
  requireVoiceConnect(ctx, conv, userId);
  if (isBotUser(ctx, userId))
    throw forbidden("A human media participant must share this key");
  const present = await ctx.livekit?.participantIdentities(call.room_name);
  if (!present)
    throw new ApiError(
      503,
      "media_unavailable",
      "The media server could not confirm presence",
    );
  if (!present.includes(`${userId}.${deviceId}`))
    throw forbidden("Join the encrypted voice room before sharing its key");
  requireVoiceConnect(ctx, conv, userId);
  const current = () => {
    if (!callAdmission(ctx, conv.id)(userId, deviceId))
      throw forbidden("This device is no longer admitted to the voice room");
  };
  current();
  return current;
}

export async function announceBotKeyRequest(ctx: AppContext, call: CallRow) {
  await broadcastCall(ctx, call, "updated");
}
