import { applicationRoutes } from "../applications.js";
import { communityDiscoveryRoutes, communityModerationRoutes, communityStructureRoutes } from "../community.js";
import { expressionRoutes } from "../expressions.js";
import { onboardingRoutes } from "../onboarding.js";
import { communityRulesRoutes } from "../communityRules.js";
import { communitySettingsRoutes } from "../communitySettings.js";
import { reportRoutes } from "../reports.js";
import type { RouteContract } from "../route.js";

/** Route contracts of the community area (docs/architecture/ARCHITECTURE_1_0_PLAN.md §11, step C2). */
export const communityRoutes: readonly RouteContract[] = [
  ...communityStructureRoutes,
  ...communityDiscoveryRoutes,
  ...communityModerationRoutes,
  ...applicationRoutes,
  ...expressionRoutes,
  ...onboardingRoutes,
  ...communityRulesRoutes,
  ...communitySettingsRoutes,
  ...reportRoutes,
];
