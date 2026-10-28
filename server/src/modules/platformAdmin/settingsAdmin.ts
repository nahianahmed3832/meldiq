import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { experimentsReport } from "../administration/index.js";
import type { AlertEngine } from "./alerts.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import type { Exclusions } from "./exclusions.js";
import { flatDetail } from "./quotasAdmin.js";
import { isSettingKey, platformSetting, SETTINGS, settingMeta, writeSetting } from "./settings.js";

const DELIVERIES_SHOWN = 50;

/**
 * Platform settings and alert rules in the console (docs/PLATFORM_SETTINGS.md, docs/ALERTS.md). Changes are audited
 * with their before and after. The environment list shows names and non-secret values the console may know; secrets
 * are never listed.
 */
export class AdminSettings {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
    private readonly alerts: AlertEngine,
    private readonly exclusions: Exclusions,
  ) {}

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids.filter((x): x is string => !!x))) {
      const a = await this.ctx.accounts.store.accountById(id);
      if (a) out.set(id, a.name);
    }
    return out;
  }

  async list() {
    const metas = Object.keys(SETTINGS).map((k) => ({ key: k, ...settingMeta(this.ctx.platform, k as keyof typeof SETTINGS) }));
    const n = await this.names(metas.map((m) => m.updatedBy));
    const c = this.ctx.config;
    return {
      settings: metas.map((m) => {
        const def = SETTINGS[m.key as keyof typeof SETTINGS];
        return {
          key: m.key,
          label: def.label,
          description: def.description,
          value: platformSetting(this.ctx.platform, m.key as keyof typeof SETTINGS),
          default: def.default,
          updatedBy: m.updatedBy ? { accountId: m.updatedBy, name: n.get(m.updatedBy) ?? null } : null,
          updatedAt: m.updatedAt,
        };
      }),
      experiments: experimentsReport(c.experiments),
      // Non-secret server settings that shape behaviour (changing them is a deploy: they live in the server's .env).
      environment: [
        { name: "REGISTRATION_MODE", value: c.registrationMode ?? "" },
        { name: "STORAGE_BACKEND", value: c.storage.backend },
        { name: "ANALYTICS_ENABLED (client events)", value: String(c.analyticsEnabled) },
        { name: "EXPERIMENTS_MODE", value: c.experiments.mode },
        { name: "ADMIN_SESSION_IDLE_MINUTES", value: String(c.adminConsole ? c.adminConsole.idleMs / 60_000 : "") },
        { name: "ADMIN_REAUTH_MINUTES", value: String(c.adminConsole ? c.adminConsole.reauthMs / 60_000 : "") },
        { name: "PLATFORM_SECRETS_KEY", value: c.platformSecretsKey ? "set" : "not set" },
        { name: "HOST_METRICS_FILE", value: process.env.HOST_METRICS_FILE ? "set" : "not set" },
        { name: "TELEMETRY_TICK_MS", value: String(c.telemetryTickMs) },
      ],
    };
  }

  async set(p: AdminPrincipal, key: string, value: unknown, reason: string, meta: RequestMeta) {
    if (!isSettingKey(key)) throw new ApiError(404, "not_found", "No such setting.");
    await this.ctx.platform.write((w) => {
      const { before, after } = writeSetting(w, key, value, p.account.id, now());
      this.audit.append(w, { action: "settings.update", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "setting", targetId: key, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: flatDetail({ before, after }) });
    });
    if (key.startsWith("analytics.")) this.exclusions.invalidate();
    return this.list();
  }

  alertsView() {
    const deliveries = this.ctx.platform.all<{ at: number; incident_id: string; channel: string; outcome: string; detail: string | null }>("alert_deliveries", {
      orderBy: [["id", "desc"]],
      limit: DELIVERIES_SHOWN,
    });
    return { rules: this.alerts.rules(), deliveries: deliveries.map((d) => ({ at: d.at, incidentId: d.incident_id, channel: d.channel, outcome: d.outcome, detail: d.detail })) };
  }

  async setRule(p: AdminPrincipal, key: string, b: { enabled: boolean; threshold: number; windowMinutes: number; severity: "sev1" | "sev2" | "sev3" | "sev4"; reason: string }, meta: RequestMeta) {
    const before = this.alerts.rules().find((r) => r.key === key);
    await this.alerts.setRule(key, b, p.account.id);
    await this.audit.record({
      action: "alerts.rule_update",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "alert_rule",
      targetId: key,
      reason: b.reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: flatDetail({ before: before ? { enabled: before.enabled, threshold: before.threshold, windowMinutes: before.windowMinutes, severity: before.severity } : null, after: { enabled: b.enabled, threshold: b.threshold, windowMinutes: b.windowMinutes, severity: b.severity } }),
    });
    return this.alertsView();
  }

  async evaluate(p: AdminPrincipal, meta: RequestMeta) {
    const changed = await this.alerts.evaluate();
    await this.audit.record({ action: "alerts.evaluate", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, requestId: meta.requestId, network: networkKey(meta.ip), detail: { changed: changed.join(",") || null } });
    return this.alertsView();
  }
}
