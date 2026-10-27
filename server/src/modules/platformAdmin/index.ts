import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { PlatformAudit } from "./audit.js";
import { AdminAuthService } from "./auth.js";
import adminAuthRoutes from "./authRoutes.js";
import adminDataRoutes from "./dataRoutes.js";
import adminOpsRoutes from "./opsRoutes.js";
import adminInsightsRoutes from "./insightsRoutes.js";
import { gate } from "./guards.js";
import { PlatformAdminStore } from "./store.js";

export { PlatformAudit } from "./audit.js";
export { PlatformAdminStore } from "./store.js";
export { PLATFORM_ADMIN_COMMANDS, runPlatformAdminCommand } from "./cli.js";
export { CLI_ACTOR, grantAdmin, issueEnrolment, resetAdminPasskeys, revokeAdmin } from "./bootstrap.js";
export { PLATFORM_ROLES, type PlatformRole } from "./permissions.js";
export { platformSetting, SETTINGS, type SettingKey } from "./settings.js";

/**
 * The Platform Admin Console's API (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md): /admin/v1, registered only
 * when ADMIN_CONSOLE_ORIGIN is set. Everything in it runs behind [gate] (host, network, console header, origin) in its
 * own scope, so none of it touches the apps' routes.
 */
export async function registerPlatformAdmin(app: FastifyInstance, ctx: AppContext, version: string): Promise<void> {
  const cfg = ctx.config.adminConsole;
  if (!cfg) return;
  const store = new PlatformAdminStore(ctx.db);
  const audit = new PlatformAudit(ctx.db);
  const auth = new AdminAuthService(ctx, cfg, store, audit);
  await app.register(async (scope) => {
    scope.addHook("onRequest", gate(cfg));
    await adminAuthRoutes(scope, cfg, auth);
    const deps = { ctx, auth, audit, store, version };
    await adminDataRoutes(scope, deps);
    await adminOpsRoutes(scope, deps);
    await adminInsightsRoutes(scope, deps);
  });
}
