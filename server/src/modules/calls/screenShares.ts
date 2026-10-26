import type { AppContext } from "../../app/context.js";

/**
 * Who is sharing their screen in each live call, from LiveKit's own webhooks (track_published / track_unpublished with
 * source SCREEN_SHARE): the media server's account of it, whatever app the person uses, so channel lists can show "sharing
 * now" to members outside the call (community-first brief §E).
 *
 * Kept in memory per server (as the hub's connections are): a restart forgets it, which can only hide a share, never
 * claim one. callView reports a device only while it's still a participant, so someone who left or was moved out never
 * shows as sharing, even if LiveKit's "unpublished" never arrived.
 */
const byContext = new WeakMap<AppContext, Map<string, Set<string>>>();

function calls(ctx: AppContext): Map<string, Set<string>> {
  let m = byContext.get(ctx);
  if (!m) byContext.set(ctx, (m = new Map()));
  return m;
}

/** LiveKit's TrackSource.SCREEN_SHARE (the protocol's enum value; the webhook may also carry its name). */
const SCREEN_SHARE = 3;

export function isScreenShare(source: unknown): boolean {
  return source === SCREEN_SHARE || source === "SCREEN_SHARE";
}

/** Records [deviceId] starting ([on]) or stopping a screen share in [callId]; true if that changed anything. */
export function setSharing(ctx: AppContext, callId: string, deviceId: string, on: boolean): boolean {
  const m = calls(ctx);
  const devices = m.get(callId) ?? new Set<string>();
  if (devices.has(deviceId) === on) return false;
  if (on) devices.add(deviceId);
  else devices.delete(deviceId);
  if (devices.size) m.set(callId, devices);
  else m.delete(callId);
  return true;
}

/** The devices sharing in [callId] (callers keep only current participants). */
export function sharingDevices(ctx: AppContext, callId: string): ReadonlySet<string> {
  return calls(ctx).get(callId) ?? new Set();
}

/** Forgets a device (it left the call) or a whole call (it ended). */
export function forgetSharing(ctx: AppContext, callId: string, deviceId?: string): void {
  if (deviceId === undefined) calls(ctx).delete(callId);
  else setSharing(ctx, callId, deviceId, false);
}
