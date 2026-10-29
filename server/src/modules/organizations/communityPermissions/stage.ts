import type { AppContext } from "../../../app/context.js";
import { badRequest, forbidden, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import type { ConversationRow } from "../authz.js";
import { broadcastCall } from "../../calls/index.js";
import { notifyConversation } from "../orgsRoutes.js";

/**
 * Stages (community parity A1, docs/COMMUNITY_PERMISSIONS.md): voice channels where people listen until a moderator
 * lets them speak. Listeners raise a hand in the call (POST /v1/calls/:id/hand); a moderator (the channel's managers)
 * lets them speak or sends them back. Their media credentials say so (Authz.canSpeakInVoice), and people already in
 * the call are changed on the media server at once.
 */

function loadStage(ctx: AppContext, conversationId: string, actorId: string): ConversationRow {
  const conv = ctx.authz.conversation(conversationId);
  if (!conv || !ctx.authz.isMember(conv.id, actorId)) throw notFound("Channel not found");
  if (conv.type !== "CHANNEL" || conv.voice !== 1 || !ctx.communityPermissions.channelOptions(conv.id).stage) throw badRequest("This channel isn't a stage");
  return conv;
}

/** Brings the person's devices in the live call in line: publishing allowed or not, and their hand down. */
async function applyLive(ctx: AppContext, conv: ConversationRow, userId: string, canSpeak: boolean): Promise<void> {
  for (const call of await ctx.calls.liveIn([conv.id])) {
    await ctx.calls.lowerHand(call.id, userId);
    const devices = (await ctx.calls.present(call.id)).filter((p) => p.user_id === userId);
    for (const d of devices) {
      const identity = `${userId}.${d.device_id}`;
      await ctx.livekit?.setCanPublish(call.room_name, identity, canSpeak);
      if (!canSpeak) await ctx.livekit?.muteAudio(call.room_name, identity);
    }
    await broadcastCall(ctx, call, "updated");
  }
}

function changed(ctx: AppContext, conv: ConversationRow, userId: string) {
  notifyConversation(ctx, conv.id);
  ctx.hub.sendToUser(userId, { t: "conv.updated", conversationId: conv.id });
  return { conversationId: conv.id, speakerIds: ctx.communityPermissions.stageSpeakers(conv.id) };
}

/** PUT /v1/conversations/:id/stage/speakers/:userId: a moderator lets someone in the channel speak. */
export async function grantSpeaker(ctx: AppContext, conversationId: string, actorId: string, userId: string) {
  const conv = loadStage(ctx, conversationId, actorId);
  if (!ctx.authz.moderatesStage(conv, actorId)) throw forbidden("Only this stage's moderators let people speak");
  if (!ctx.authz.isMember(conv.id, userId)) throw notFound("They aren't in this channel");
  const added = await ctx.ws.write((w) => {
    if (w.get("stage_speakers", { conversation_id: conv.id, user_id: userId })) return false;
    w.insert("stage_speakers", { conversation_id: conv.id, user_id: userId, granted_by: actorId, granted_at: now() });
    return true;
  });
  if (added) {
    ctx.audit({ actorId, orgId: conv.org_id, action: "stage.speaker_add", target: userId, detail: conv.id });
    await applyLive(ctx, conv, userId, ctx.authz.canSpeakInVoice(conv, userId));
  }
  return changed(ctx, conv, userId);
}

/** DELETE /v1/conversations/:id/stage/speakers/:userId: a moderator sends a speaker back, or a speaker steps down. */
export async function revokeSpeaker(ctx: AppContext, conversationId: string, actorId: string, userId: string) {
  const conv = loadStage(ctx, conversationId, actorId);
  if (actorId !== userId && !ctx.authz.moderatesStage(conv, actorId)) throw forbidden("Only this stage's moderators send speakers back");
  const removed = (await ctx.ws.write((w) => w.delete("stage_speakers", { conversation_id: conv.id, user_id: userId }))) > 0;
  if (removed) {
    ctx.audit({ actorId, orgId: conv.org_id, action: "stage.speaker_remove", target: userId, detail: conv.id });
    await applyLive(ctx, conv, userId, ctx.authz.canSpeakInVoice(conv, userId));
  }
  return changed(ctx, conv, userId);
}
