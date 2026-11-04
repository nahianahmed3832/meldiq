import type { AppContext } from "../../app/context.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { broadcastCall, callView, endCallRow, evictFromCall, loadCall } from "./routes.js";
import type { CallRow } from "./store.js";

/**
 * Voice moderation across a community (community parity A2, docs/COMMUNITY_SAFETY_API.md): what voice bans, server
 * mutes and disconnecting do to calls that are live in the community's voice channels. The media server is reached
 * through ctx.livekit (tests replace its methods); when it can't be reached the call state is still corrected and a
 * later token carries the right grants.
 */

type Conv = Parameters<AppContext["authz"]["canConnectVoice"]>[0];

/** 403 voice_banned for someone kept out of the community's voice channels, the usual 403 for anyone else who can't join. */
export function requireVoiceConnect(ctx: AppContext, conv: Conv, userId: string): void {
  if (conv.type === "CHANNEL" && conv.org_id && ctx.authz.voiceBanned(conv.org_id, userId)) {
    throw new ApiError(403, "voice_banned", "You've been kept out of this community's voice channels. You can still chat.");
  }
  if (!ctx.authz.canConnectVoice(conv, userId)) throw forbidden("You can't join this voice channel");
}

/** The live calls of [orgId]'s voice channels. */
async function liveVoiceCalls(ctx: AppContext, orgId: string): Promise<CallRow[]> {
  const voice = ctx.authz.conversationIdsOf(orgId).filter((id) => ctx.authz.conversation(id)?.voice === 1);
  return voice.length ? ctx.calls.liveIn(voice) : [];
}

/** [userId]'s devices in [c]: what LiveKit reports, and the server's own records. */
async function devicesIn(ctx: AppContext, c: CallRow, userId: string): Promise<string[]> {
  const found = new Set((await ctx.calls.present(c.id)).filter((p) => p.user_id === userId).map((p) => p.device_id));
  for (const identity of (ctx.livekit && (await ctx.livekit.participantIdentities(c.room_name))) || []) {
    const [u, d] = identity.split(".");
    if (u === userId && d) found.add(d);
  }
  return [...found];
}

/** After a voice ban: everyone no longer admitted leaves the community's live voice calls. Devices removed. */
export async function evictFromCommunityVoice(ctx: AppContext, orgId: string): Promise<number> {
  let n = 0;
  for (const c of await liveVoiceCalls(ctx, orgId)) n += await evictFromCall(ctx, c);
  return n;
}

/**
 * After a server mute or unmute: [userId]'s devices in the community's live voice calls may publish or not, as their
 * permissions now say (unmuting gives speaking back only where `voice.speak` allows it). Devices changed.
 */
export async function applyVoiceSpeaking(ctx: AppContext, orgId: string, userId: string): Promise<number> {
  if (!ctx.livekit) return 0;
  let n = 0;
  for (const c of await liveVoiceCalls(ctx, orgId)) {
    const conv = ctx.authz.conversation(c.conversation_id);
    if (!conv) continue;
    const canSpeak = ctx.authz.canSpeakInVoice(conv, userId);
    for (const d of await devicesIn(ctx, c, userId)) {
      const botMedia = d.startsWith("botvoice_");
      const r = botMedia ? await ctx.livekit.setCanPublish(c.room_name, `${userId}.${d}`, canSpeak && ctx.bots.voice.maySpeak(userId, d), false) : await ctx.livekit.setCanPublish(c.room_name, `${userId}.${d}`, canSpeak);
      if (r === "updated") n++;
      if (r === "error") ctx.log.warn({ callId: c.id }, "voice moderation: LiveKit unreachable, the next token carries the change");
    }
    if (!canSpeak) ctx.hub.sendToUser(userId, { t: "call", event: "moderated", action: "mute", call: await callView(ctx, c) });
  }
  return n;
}

/** Takes [userId] out of every live call in the community's voice channels (they may join again). Devices removed. */
export async function disconnectFromCommunityVoice(ctx: AppContext, orgId: string, userId: string): Promise<number> {
  let n = 0;
  for (const c of await liveVoiceCalls(ctx, orgId)) {
    const devices = await devicesIn(ctx, c, userId);
    for (const d of devices) {
      ctx.bots.voice.withdraw(userId, d);
      await ctx.livekit?.removeParticipant(c.room_name, `${userId}.${d}`);
      await ctx.calls.leave(c.id, d, now());
      ctx.hub.sendToDevice(d, { t: "call", event: "ended", call: { ...(await callView(ctx, c)), endReason: "removed" } });
    }
    if (devices.length === 0) continue;
    n += devices.length;
    await ctx.calls.lowerHand(c.id, userId);
    const cur = (await loadCall(ctx, c.id))!;
    if ((await ctx.calls.present(c.id)).length === 0) await endCallRow(ctx, cur, "empty");
    else await broadcastCall(ctx, cur, "updated");
  }
  return n;
}
