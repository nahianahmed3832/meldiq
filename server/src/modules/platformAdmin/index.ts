import { collectibleCommerceAdminRoutes } from "../billing/index.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { PlatformAudit } from "./audit.js";
import { AdminAuthService } from "./auth.js";
import adminAuthRoutes from "./authRoutes.js";
import adminDataRoutes from "./dataRoutes.js";
import adminOpsRoutes from "./opsRoutes.js";
import adminInsightsRoutes from "./insightsRoutes.js";
import collectibleAdminRoutes from "./collectibles.js";
import adminDecorationRoutes from "./decorations.js";
import adminCreatorRoutes from "./creators.js";
import adminBotsPlusRoutes from "./botsPlus.js";
import adminCommunityRoutes from "./community.js";
import adminDiscoveryRoutes from "./discovery.js";
import moderationRoutes from "./moderation.js";
import partnerAdminRoutes from "./partners.js";
import operationsAdminRoutes from "./operations.js";
import { gate } from "./guards.js";
import { PlatformAdminStore } from "./store.js";
import { exportJobRoutes } from "./exportJobs.js";
import { readAdminAccountAuthority } from "./authority.js";

export { PlatformAudit } from "./audit.js";
export { PlatformAdminStore } from "./store.js";
export { PLATFORM_ADMIN_COMMANDS, runPlatformAdminCommand } from "./cli.js";
export {
  CLI_ACTOR,
  grantAdmin,
  issueEnrolment,
  resetAdminPasskeys,
  revokeAdmin,
} from "./bootstrap.js";
export { PLATFORM_ROLES, type PlatformRole } from "./permissions.js";
export { platformSetting, communityClipsBlocked, SETTINGS, type SettingKey } from "./settings.js";

/**
 * The Platform Admin Console's API (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md): /admin/v1, registered only
 * when ADMIN_CONSOLE_ORIGIN is set. Everything in it runs behind [gate] (host, network, console header, origin) in its
 * own scope, so none of it touches the apps' routes.
 */
export async function registerPlatformAdmin(
  app: FastifyInstance,
  ctx: AppContext,
  version: string,
): Promise<void> {
  const cfg = ctx.config.adminConsole;
  if (!cfg) return;
  const store = new PlatformAdminStore(ctx.platform, ctx.ephemeral, id => readAdminAccountAuthority(ctx, id));
  const audit = new PlatformAudit(ctx.platform);
  const auth = new AdminAuthService(ctx, cfg, store, audit);
  await app.register(async (scope) => {
    scope.addHook("onRequest", gate(cfg));
    await adminAuthRoutes(scope, cfg, auth);
    const deps = { ctx, auth, audit, store, version };
    await adminDataRoutes(scope, deps);
    await moderationRoutes(scope, deps);
    await partnerAdminRoutes(scope, deps);
    await operationsAdminRoutes(scope, deps);
    await collectibleCommerceAdminRoutes(scope, deps);
    await adminOpsRoutes(scope, deps);
    await adminInsightsRoutes(scope, deps);
    await exportJobRoutes(scope, deps);
    await adminDecorationRoutes(scope, deps);
    await collectibleAdminRoutes(scope, deps);
    await adminCreatorRoutes(scope, deps);
    // Community parity batch D: Bots+ for a community, while billing for it is off.
    await adminBotsPlusRoutes(scope, deps);
    await adminDiscoveryRoutes(scope, deps);
    await adminCommunityRoutes(scope, deps);
  });
}

export { recoverReportWorkflows } from "./reportRecovery.js";

export { validateAuditChain } from "./auditValidation.js";

export { principal, requirePermission, metaOf } from "./guards.js";
export type { AdminDeps } from "./dataRoutes.js";
export type { Permission } from "./permissions.js";
export {
  legacyOperatorAllowed,
  eraseOperationalUserData,
} from "./operations.js";
export { runtimePolicy, inRollout } from "./runtimePolicy.js";

export { hasPlatformAdminAccount } from "./audience.js";

export { hasRecentOrgSafetyAction } from "./auditView.js";

export { currentFinancialPrincipal } from "./financialAuthority.js";
