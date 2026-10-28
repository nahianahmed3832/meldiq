import type { RowReader } from "../../infrastructure/database/rows/index.js";

export type PushState = "none" | "ok" | "failing";

/**
 * Wake-up registrations of [deviceIds] for the Platform Admin Console: whether each device has an FCM token or a
 * UnifiedPush endpoint and whether its last wake-up failed. Never the token or endpoint itself (they're capabilities).
 */
export function pushStatus(identity: RowReader, deviceIds: string[]): Map<string, { fcm: PushState; unifiedPush: PushState; lastWakeAt: number | null }> {
  const out = new Map<string, { fcm: PushState; unifiedPush: PushState; lastWakeAt: number | null }>();
  if (deviceIds.length === 0) return out;
  type Wake = { device_id: string; last_wake_at: number | null; failing_since: number | null };
  const fcm = identity.all<Wake>("fcm_tokens", { where: { device_id: { in: deviceIds } } });
  const up = identity.all<Wake>("push_endpoints", { where: { device_id: { in: deviceIds } } });
  for (const id of deviceIds) out.set(id, { fcm: "none", unifiedPush: "none", lastWakeAt: null });
  for (const r of fcm) {
    const cur = out.get(r.device_id)!;
    out.set(r.device_id, { ...cur, fcm: r.failing_since ? "failing" : "ok", lastWakeAt: Math.max(cur.lastWakeAt ?? 0, r.last_wake_at ?? 0) || null });
  }
  for (const r of up) {
    const cur = out.get(r.device_id)!;
    out.set(r.device_id, { ...cur, unifiedPush: r.failing_since ? "failing" : "ok", lastWakeAt: Math.max(cur.lastWakeAt ?? 0, r.last_wake_at ?? 0) || null });
  }
  return out;
}
