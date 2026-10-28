import { z } from "zod/v4";
import { ERROR_CODES, type ErrorCode } from "../../errors.js";
import { accountsRoutes } from "./areas/accounts.js";
import { billingRoutes } from "./areas/billing.js";
import { communityRoutes } from "./areas/community.js";
import { conversationsRoutes } from "./areas/conversations.js";
import { identityRoutes } from "./areas/identity.js";
import { organizationsRoutes } from "./areas/organizations.js";
import { callRoutes } from "./calls.js";
import { fileRoutes } from "./files.js";
import { gifRoutes } from "./gifs.js";
import { bugReportRoutes } from "./bugReports.js";
import { historyRoutes } from "./history.js";
import { messagingRoutes } from "./messaging.js";
import { systemRoutes } from "./system.js";
import type { RouteContract } from "./route.js";

export type { RouteContract } from "./route.js";

/** Every error answer: `{ error: { code, message, details? } }` with a catalogued code (src/shared/errors.ts). */
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** The documented routes. Routes not listed yet are still checked for the error envelope by the test suite. */
export const ROUTE_CONTRACTS: readonly RouteContract[] = [
  ...systemRoutes,
  ...messagingRoutes,
  ...gifRoutes,
  ...bugReportRoutes,
  ...historyRoutes,
  ...fileRoutes,
  ...callRoutes,
  ...accountsRoutes,
  ...identityRoutes,
  ...organizationsRoutes,
  ...communityRoutes,
  ...conversationsRoutes,
  ...billingRoutes,
];
