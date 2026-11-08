import { commerceRoutes } from "./commerce.js";
import { cardSubscriptionRoutes } from "./cardSubscriptions.js";
import { giftRoutes } from "./gifts.js";
import { paymentMethodRoutes } from "./paymentMethods.js";
import { operationalControlRoutes } from "./areas/operationalControls.js";
import { socialAuthRoutes } from "./areas/socialAuth.js";
import { collectibleRoutes } from "./areas/collectibles.js";
import { leaderboardContracts } from "./leaderboards.js";
import { messageCollectionRoutes } from "./messageCollections.js";
import { supabaseAuthRoutes } from "./supabaseAuth.js";
import { z } from "zod/v4";
import { ERROR_CODES, type ErrorCode } from "../../errors.js";
import { adminOperationsRoutes } from "./areas/adminOperations.js";
import { accountsRoutes } from "./areas/accounts.js";
import { billingRoutes } from "./areas/billing.js";
import { mojoRoutes } from "./areas/mojo.js";
import { communityRoutes } from "./areas/community.js";
import { conversationsRoutes } from "./areas/conversations.js";
import { developerRoutes } from "./areas/developer.js";
import { identityRoutes } from "./areas/identity.js";
import { organizationsRoutes } from "./areas/organizations.js";
import { callRoutes } from "./calls.js";
import { fileRoutes } from "./files.js";
import { gifRoutes } from "./gifs.js";
import { bugReportRoutes } from "./bugReports.js";
import { historyRoutes } from "./history.js";
import { messagingRoutes } from "./messaging.js";
import { serverMessagesRoutes } from "./serverMessages.js";
import { threadLifecycleContracts } from "./threadLifecycle.js";
import { managedPollContracts } from "./managedPolls.js";
import { pingRoleContracts } from "./pingRoles.js";
import { partnerContracts } from "./partners.js";
import { systemRoutes } from "./system.js";
import { creatorRoutes } from "./creators.js";
import { linkedAccountRoutes } from "./linkedAccounts.js";
import type { RouteContract } from "./route.js";
import { BOT_DOMAIN_ADAPTERS } from "./botDomainAdapters.js";
import { botPlatformContracts } from "./botPlatform.js";
import { botMessageContracts } from "./botMessages.js";
import { botVoiceRoutes } from "./botVoice.js";

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
const NATIVE_ROUTE_CONTRACTS: readonly RouteContract[] = [
  ...botPlatformContracts,
  ...botMessageContracts,
  ...botVoiceRoutes,
  ...partnerContracts,
  ...pingRoleContracts,
  ...managedPollContracts,
  ...threadLifecycleContracts,
  ...supabaseAuthRoutes,
  ...collectibleRoutes,
  ...paymentMethodRoutes,
  ...commerceRoutes,
  ...cardSubscriptionRoutes,
  ...giftRoutes,
  ...operationalControlRoutes,
  ...adminOperationsRoutes,
  ...systemRoutes,
  ...messagingRoutes,
  ...serverMessagesRoutes,
  ...messageCollectionRoutes,
  ...leaderboardContracts,
  ...gifRoutes,
  ...bugReportRoutes,
  ...historyRoutes,
  ...fileRoutes,
  ...callRoutes,
  ...accountsRoutes,
  ...socialAuthRoutes,
  ...identityRoutes,
  ...organizationsRoutes,
  ...communityRoutes,
  ...conversationsRoutes,
  ...billingRoutes,
  ...mojoRoutes,
  ...creatorRoutes,
  ...linkedAccountRoutes,
  ...developerRoutes,
];

export const ROUTE_CONTRACTS: readonly RouteContract[] = [
  ...NATIVE_ROUTE_CONTRACTS,
  ...BOT_DOMAIN_ADAPTERS.map((adapter): RouteContract => {
    const source = NATIVE_ROUTE_CONTRACTS.find((item) => item.method === adapter.method && item.url === adapter.source);
    if (!source) throw new Error(`Missing native contract for bot adapter ${adapter.method} ${adapter.source}`);
    const projection = adapter.source.startsWith("/v2/conversations/") ? " Bot pages project current text, omit deleted messages and exclude historic edits and private protocol controls." : "";
    const summary = adapter.resource === "file" ? "Download native encrypted file bytes/ranges on a currently authorized API stream; no human media grant or redirect." : source.summary;
    return { ...source, url: adapter.url, auth: true, scheme: "bot", tag: "Bots", summary: `Bot adapter: ${summary} ${adapter.scope ? `Requires approved ${adapter.scope} scope and current native authority.` : "Own bot identity only."}${projection}` };
  }),
];
