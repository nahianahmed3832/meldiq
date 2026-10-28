import { activityRoutes } from "../activity.js";
import { authRoutes } from "../auth.js";
import { notificationRoutes } from "../notifications.js";
import { preferenceRoutes } from "../preferences.js";
import { connectionRoutes } from "../relationships.js";
import { reminderRoutes } from "../reminders.js";
import type { RouteContract } from "../route.js";
import { userRoutes } from "../users.js";

/** Route contracts of the identity area (docs/architecture/ARCHITECTURE_1_0_PLAN.md §11, step C2). */
export const identityRoutes: readonly RouteContract[] = [
  ...authRoutes,
  ...userRoutes,
  ...activityRoutes,
  ...notificationRoutes,
  ...connectionRoutes,
  ...preferenceRoutes,
  ...reminderRoutes,
];
