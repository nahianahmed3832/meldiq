import {z} from "zod/v4";
import {route} from "./route.js";

export const SupabaseDeviceProof = z.strictObject({deviceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  nonce: z.string().min(16).max(128), signature: z.string().min(80).max(100), totpCode: z.string().max(64).optional()});
export const SupabaseLegacyLink = SupabaseDeviceProof.extend({legacyAccessToken: z.string().min(20).max(200), password: z.string().max(1024).optional()});
export const SupabaseOwner = z.strictObject({authUserId: z.uuid(), accountId: z.string(), userId: z.string()});
export const SupabaseGrantRequest = z.strictObject({conversationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)});
export const SupabaseGrants = z.strictObject({topics: z.array(z.string()), expiresIn: z.literal(120)});
const ok = z.strictObject({ok: z.literal(true)});
const staged = {tag: "staging-auth", auth: true, requires: "supabase_staging"} as const;
export const supabaseAuthRoutes = [
  route({...staged, method: "POST", url: "/v3/auth/legacy-link", body: SupabaseLegacyLink, response: ok,
    summary: "Staging only: explicitly link a provider session using fresh legacy authentication and signed certified-device proof.", errors: ["conflict", "fresh_auth_required"]}),
  route({...staged, method: "POST", url: "/v3/auth/device", body: SupabaseDeviceProof, response: ok,
    summary: "Staging only: authorize an existing certified device for this provider session; legacy MFA still applies.", errors: ["conflict"]}),
  route({...staged, method: "DELETE", url: "/v3/auth/session", response: ok,
    summary: "Staging only: revoke this application's provider-session binding and disconnect its device."}),
  route({...staged, method: "GET", url: "/v3/auth/me", response: SupabaseOwner,
    summary: "Staging only: resolve a verified provider subject to its explicitly linked internal owner."}),
  route({...staged, method: "POST", url: "/v3/realtime/grants", body: SupabaseGrantRequest, response: SupabaseGrants,
    summary: "Staging only: lease private topics after certified-device and current membership authorization.", errors: ["device_required", "not_found"]}),
];
