import { createHash } from "node:crypto";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { Policy } from "../../shared/contracts/http/operations.js";
const rollout = () => ({
  percent: 100,
  seed: "meldiq-v1",
  allowUsers: [] as string[],
  denyUsers: [] as string[],
});
export const DEFAULT_POLICY = {
  calls: rollout(),
  uploads: rollout(),
  orgCreation: rollout(),
  fileRetentionDays: null as number | null,
  reportRetentionDays: null as number | null,
  maxFileBytes: 1024000000,
  uploadStartsPerHour: 1000,
};
export function runtimePolicy(rows: RowReader) {
  const r = rows.get<{ value: string; updated_at: number }>(
    "platform_settings",
    { key: "operations.policy" },
  );
  if (!r) return { version: 0, policy: DEFAULT_POLICY, updatedAt: null };
  try {
    const v = JSON.parse(r.value);
    return {
      version: Number(v.version) || 0,
      policy: Policy.parse(v.policy),
      updatedAt: r.updated_at,
    };
  } catch {
    throw new Error("Invalid persisted operational policy");
  }
}
export function inRollout(
  rows: RowReader,
  feature: "calls" | "uploads" | "orgCreation",
  userId?: string,
) {
  const p = runtimePolicy(rows).policy[feature];
  if (userId && p.denyUsers.includes(userId)) return false;
  if (userId && p.allowUsers.includes(userId)) return true;
  if (p.percent === 100) return true;
  if (!userId || p.percent === 0) return false;
  return (
    createHash("sha256")
      .update(`${p.seed}:${feature}:${userId}`)
      .digest()
      .readUInt32BE(0) %
      10000 <
    p.percent * 100
  );
}
