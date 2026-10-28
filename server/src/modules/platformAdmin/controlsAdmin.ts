import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { type ControlKey, controlRowKey, isControlKey, readControl, signupMode } from "../../app/platformControls.js";
import { CONTROL_KEYS, CONTROL_SCHEMAS } from "../../shared/contracts/http/platformAdminInsights.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { flatDetail } from "./quotasAdmin.js";

/**
 * The console's view and changes of the platform controls (docs/PLATFORM_CONTROLS.md). Each change is validated
 * against its schema, stored, and audited with its before and after value and the operator's reason in one unit; the
 * server reads the new value on the next request.
 */
export class AdminControls {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  async list() {
    const rows = CONTROL_KEYS.map((key) => ({ key, row: this.ctx.platform.get<{ updated_by: string; updated_at: number }>("platform_settings", { key: controlRowKey(key) }) }));
    const names = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.row?.updated_by).filter((x): x is string => !!x))) {
      const a = await this.ctx.accounts.store.accountById(id);
      if (a) names.set(id, a.name);
    }
    const environment = this.ctx.config.registrationMode;
    return {
      controls: Object.fromEntries(
        rows.map(({ key, row }) => [
          key,
          { value: readControl(this.ctx.platform, key), updatedBy: row ? { accountId: row.updated_by, name: names.get(row.updated_by) ?? null } : null, updatedAt: row?.updated_at ?? null },
        ]),
      ) as { [K in ControlKey]: { value: unknown; updatedBy: { accountId: string; name: string | null } | null; updatedAt: number | null } },
      signups: { environment, effective: signupMode(this.ctx.platform, environment) },
    };
  }

  async set(p: AdminPrincipal, key: string, value: unknown, reason: string, meta: RequestMeta) {
    if (!isControlKey(key)) throw new ApiError(404, "not_found", "No such control.");
    const parsed = CONTROL_SCHEMAS[key].safeParse(value);
    if (!parsed.success) throw new ApiError(400, "invalid_policy", `${key}: ${parsed.error.issues[0]?.message ?? "not a valid value"}`);
    const after = key === "email_domains" ? { blocked: [...new Set((parsed.data as { blocked: string[] }).blocked)] } : parsed.data;
    await this.ctx.platform.write((w) => {
      const before = readControl(w, key);
      const stored = { value: JSON.stringify(after), updated_by: p.account.id, updated_at: now() };
      w.upsert("platform_settings", { key: controlRowKey(key), ...stored }, stored);
      this.audit.append(w, {
        action: "controls.update",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "control",
        targetId: key,
        reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: flatDetail({ before, after }),
      });
    });
    return this.list();
  }
}
