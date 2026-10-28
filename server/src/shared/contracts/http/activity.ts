import { z } from "zod/v4";
import { ActivityKind, ActivityWire } from "../realtime.js";
import { route } from "./route.js";

/**
 * Activity status (API 0.56.0, docs/ACTIVITY_STATUS.md): the game someone is playing, reported by their Android app
 * when they opted in. The server keeps it while they stay connected and for at most ACTIVITY_TTL_MS without a refresh,
 * and shows it only to the people who may see their presence, only while they appear online.
 */

/** No control characters or line breaks: a name is shown on one line. */
const zActivityName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((v) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v), "An activity name is one line of plain text");

/** An Android application id (com.tencent.ig). */
const zPackageId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, "Not an Android package name");

export const ActivityInput = z.strictObject({
  kind: ActivityKind,
  name: zActivityName,
  packageId: zPackageId.optional(),
  /** When the person started; the server uses the time it hears of it when absent, in the future or over a day old. */
  startedAt: z.number().int().nonnegative().optional(),
});
export type ActivityInput = z.infer<typeof ActivityInput>;

/** null clears it. The app sends the same activity again every few minutes while it lasts. */
export const ActivityBody = z.strictObject({ activity: ActivityInput.nullable() });

export const activityRoutes = [
  route({
    method: "PUT",
    url: "/v2/me/activity",
    tag: "users",
    auth: true,
    summary: "Set or clear what you're playing (opt-in on the app); it ends when your last app disconnects or after 10 minutes without a refresh.",
    body: ActivityBody,
    response: z.strictObject({ activity: ActivityWire.nullable() }),
  }),
  route({
    method: "GET",
    url: "/v2/me/activity",
    tag: "users",
    auth: true,
    summary: "What the server currently shows as your activity.",
    response: z.strictObject({ activity: ActivityWire.nullable() }),
  }),
];
