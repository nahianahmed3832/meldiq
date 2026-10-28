import type { z } from "zod/v4";
import type { RowReader } from "../infrastructure/database/rows/index.js";
import { CONTROL_SCHEMAS } from "../shared/contracts/http/platformAdminInsights.js";
import { ApiError } from "../shared/errors.js";

/**
 * Platform controls (docs/PLATFORM_CONTROLS.md): switches set from the console that change what the server does at
 * once, for every request. They live in platform_settings under "control.<key>" (beside the console's settings, apart
 * from them), are read on each use (one indexed row), and fall back to their default when unset or no longer valid.
 */
export type ControlKey = keyof typeof CONTROL_SCHEMAS;
export type ControlValue<K extends ControlKey> = z.infer<(typeof CONTROL_SCHEMAS)[K]>;

export const CONTROL_DEFAULTS: { [K in ControlKey]: ControlValue<K> } = {
  maintenance: { enabled: false, message: "" },
  signups: { mode: "environment" },
  email_domains: { blocked: [] },
  features: { calls: true, uploads: true, orgCreation: true },
};

export const controlRowKey = (key: ControlKey) => `control.${key}`;
export const isControlKey = (k: string): k is ControlKey => Object.hasOwn(CONTROL_SCHEMAS, k);

export function readControl<K extends ControlKey>(platform: RowReader, key: K): ControlValue<K> {
  const row = platform.get<{ value: string }>("platform_settings", { key: controlRowKey(key) });
  if (!row) return CONTROL_DEFAULTS[key];
  const parsed = CONTROL_SCHEMAS[key].safeParse(JSON.parse(row.value));
  return (parsed.success ? parsed.data : CONTROL_DEFAULTS[key]) as ControlValue<K>;
}

// ── Maintenance ──

const MAINTENANCE_MESSAGE = "Meldiq is down for maintenance. Try again in a few minutes.";
export const MAINTENANCE_RETRY_SECONDS = 300;

/** Paths that keep answering during maintenance: health checks, server info (so apps can say why), payment and media
 * webhooks (providers retry, but shouldn't have to), and the console that turns maintenance off again. */
const MAINTENANCE_EXEMPT = [/^\/healthz(?:$|[/?])/, /^\/v1\/server-info(?:$|\?)/, /^\/admin\/v1\//, /^\/v1\/billing\/webhooks\//, /^\/v1\/livekit\/webhook/];

export function maintenanceExempt(url: string): boolean {
  return MAINTENANCE_EXEMPT.some((r) => r.test(url));
}

/** The maintenance answer for [url], or null when the request may go ahead. */
export function maintenanceError(platform: RowReader, url: string): ApiError | null {
  const m = readControl(platform, "maintenance");
  if (!m.enabled || maintenanceExempt(url)) return null;
  return new ApiError(503, "maintenance", m.message || MAINTENANCE_MESSAGE);
}

// ── Sign-ups ──

export type SignupMode = "open" | "invite" | "closed";

/** The sign-up mode in force: the console's choice, or the server's REGISTRATION_MODE when it says "environment". */
export function signupMode(platform: RowReader, environment: "open" | "invite"): SignupMode {
  const { mode } = readControl(platform, "signups");
  return mode === "environment" ? environment : mode;
}

/** Throws when new accounts are closed, or when [email]'s domain (or a parent domain) is blocked. */
export function requireSignupAllowed(platform: RowReader, environment: "open" | "invite", email?: string): void {
  if (signupMode(platform, environment) === "closed") throw new ApiError(403, "registration_closed", "New sign-ups are closed for now.");
  if (email && emailDomainBlocked(platform, email)) throw new ApiError(403, "email_domain_blocked", "Sign-ups with addresses at this domain aren't accepted. Use another email address.");
}

export function emailDomainBlocked(platform: RowReader, email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!domain) return false;
  const blocked = readControl(platform, "email_domains").blocked;
  return blocked.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ── Kill switches ──

export type Feature = keyof ControlValue<"features">;
const FEATURE_WORDS: Record<Feature, string> = { calls: "Calls are", uploads: "File uploads are", orgCreation: "Creating communities and teams is" };

/** Throws 503 feature_disabled while an operator has switched [feature] off. */
export function requireFeature(platform: RowReader, feature: Feature): void {
  if (!readControl(platform, "features")[feature]) throw new ApiError(503, "feature_disabled", `${FEATURE_WORDS[feature]} switched off for now. Try again later.`);
}
