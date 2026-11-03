import type {FastifyInstance, FastifyRequest} from "fastify";
import {z} from "zod/v4";
import type {AppContext} from "../../app/context.js";
import type {SupabaseAccessVerifier, SupabasePrincipal, SupabaseSession} from "../../infrastructure/database/postgres/auth.js";
import {verifyEd25519} from "../../shared/utilities/crypto.js";
import {ApiError, unauthorized} from "../../shared/errors.js";
import {consumeChallenge} from "./service.js";
import type {AuthInfo} from "../auth/index.js";
import {SupabaseDeviceProof, SupabaseLegacyLink} from "../../shared/contracts/http/supabaseAuth.js";

export interface AuthDeviceBinding {
  id: string; auth_user_id: string; account_id: string; user_id: string; device_id: string;
  link_method: "legacy_reauthentication" | "existing_mapping"; password_changed_at: number; bound_at: number; revoked_at: number | null;
}
const proofSchema = SupabaseDeviceProof;
const linkSchema = SupabaseLegacyLink;
type Proof = z.infer<typeof proofSchema>;

/** Canonical device signature; bound to this exact provider subject, provider session, device and one-use nonce. */
export function supabaseDeviceProof(session: SupabaseSession, deviceId: string, nonce: string): string {
  return `meldiq-supabase-device-v1\n${session.authUserId}\n${session.sessionId}\n${deviceId}\n${nonce}`;
}

/** Supabase remains the credential authority. This stores only device authorization and revocation state. */
export class SupabaseDeviceAuth {
  constructor(private readonly ctx: AppContext, readonly verifier: SupabaseAccessVerifier) {
    if (!ctx.postgres?.rows.has("auth_device_sessions")) throw new Error("Supabase device authorization requires the staged shared PostgreSQL writer");
  }
  device(principal: SupabasePrincipal): AuthInfo | null {
    const rows = this.ctx.postgres!.rows;
    const binding = rows.get<AuthDeviceBinding>("auth_device_sessions", {id: principal.sessionId});
    if (!binding || binding.revoked_at !== null || binding.auth_user_id !== principal.authUserId || binding.account_id !== principal.accountId || binding.user_id !== principal.userId) return null;
    const account = rows.get<{password_changed_at: number; disabled_at: number | null; user_id: string}>("accounts", {id: binding.account_id});
    const user = rows.get<{disabled_at: number | null; deleted_at: number | null}>("users", {id: binding.user_id});
    const device = rows.get<{user_id: string; revoked_at: number | null}>("devices", {id: binding.device_id});
    if (!account || account.user_id !== binding.user_id || account.disabled_at !== null || account.password_changed_at !== binding.password_changed_at ||
        !user || user.disabled_at !== null || user.deleted_at !== null || !device || device.user_id !== binding.user_id || device.revoked_at !== null) return null;
    return {userId: binding.user_id, deviceId: binding.device_id, supabase: {...principal}};
  }
  async authenticate(token: string): Promise<AuthInfo | null> {
    const principal = await this.verifier.verify(token);
    return principal ? this.device(principal) : null;
  }
  async stillValid(auth: AuthInfo): Promise<boolean> {
    if (!auth.supabase) return false;
    const principal = await this.verifier.resolveSession(auth.supabase);
    const current = principal ? this.device(principal) : null;
    return !!current && current.userId === auth.userId && current.deviceId === auth.deviceId;
  }
  private async prove(session: SupabaseSession, userId: string, proof: Proof) {
    const device = this.ctx.identity.get<{user_id: string; signing_key: string; revoked_at: number | null}>("devices", {id: proof.deviceId});
    if (!device || device.user_id !== userId || device.revoked_at !== null || !verifyEd25519(device.signing_key, supabaseDeviceProof(session, proof.deviceId, proof.nonce), proof.signature)) throw unauthorized("Invalid device proof");
    if (!await consumeChallenge(this.ctx, proof.nonce)) throw unauthorized("The device challenge expired or was already used");
  }
  private save(session: SupabaseSession, accountId: string, userId: string, passwordChangedAt: number, proof: Proof, method: AuthDeviceBinding["link_method"]) {
    return this.ctx.postgres!.rows.write(writer => {
      const existing = writer.get<AuthDeviceBinding>("auth_device_sessions", {id: session.sessionId});
      if (existing) {
        if (existing.revoked_at !== null || existing.auth_user_id !== session.authUserId || existing.account_id !== accountId || existing.user_id !== userId || existing.device_id !== proof.deviceId || existing.password_changed_at !== passwordChangedAt) throw new ApiError(409, "conflict", "Sign in again to authorize this device");
        return;
      }
      writer.insert("auth_device_sessions", {id: session.sessionId, auth_user_id: session.authUserId, account_id: accountId, user_id: userId,
        device_id: proof.deviceId, link_method: method, password_changed_at: passwordChangedAt, bound_at: Date.now(), revoked_at: null});
    });
  }
  async bind(principal: SupabasePrincipal, proof: Proof) {
    await this.ctx.postgres!.rows.transaction(async () => {
      const account = await this.ctx.accounts.store.accountById(principal.accountId);
      if (!account || account.user_id !== principal.userId) throw unauthorized();
      await this.prove(principal, principal.userId, proof);
      await this.ctx.accounts.service.secondFactor?.(account.id, proof.totpCode);
      await this.save(principal, account.id, principal.userId, account.password_changed_at, proof, "existing_mapping");
    });
  }
  async link(session: SupabaseSession, body: z.infer<typeof linkSchema>, request: FastifyRequest, reply: {header(k: string, v: string): unknown}) {
    const legacy = await this.ctx.accounts.service.sessions.authenticate(body.legacyAccessToken, Date.now());
    if (!legacy || !legacy.device_id || !legacy.user_id || legacy.device_id !== body.deviceId) throw unauthorized();
    const account = await this.ctx.accounts.social.fresh(legacy, body.password, body.totpCode, request.ip, reply);
    if (!account.email_verified_at || account.user_id !== legacy.user_id) throw unauthorized();
    await this.ctx.postgres!.rows.transaction(async () => {
      const current = await this.ctx.accounts.service.sessions.authenticate(body.legacyAccessToken, Date.now());
      if (!current || current.account_id !== account.id || current.user_id !== legacy.user_id || current.device_id !== body.deviceId) throw unauthorized();
      await this.prove(session, current.user_id!, body);
      await this.save(session, account.id, current.user_id!, account.password_changed_at, body, "legacy_reauthentication");
    });
  }
  async revoke(principal: SupabasePrincipal) {
    await this.ctx.postgres!.rows.write(writer => writer.update("auth_device_sessions", {id: principal.sessionId, auth_user_id: principal.authUserId, revoked_at: null}, {revoked_at: Date.now()}));
  }
}

export async function registerSupabaseIdentity(app: FastifyInstance, ctx: AppContext, auth: SupabaseDeviceAuth) {
  const token = (request: FastifyRequest) => request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
  app.addHook("onSend", async (_request, reply, payload) => {reply.header("Cache-Control", "private, no-store"); return payload;});
  app.post("/v3/auth/legacy-link", {bodyLimit: 8192}, async (request, reply) => {
    const session = await auth.verifier.verifySession(token(request));
    if (!session) throw unauthorized();
    const body = linkSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "bad_request", "Invalid device authorization request");
    try {await auth.link(session, body.data, request, reply);}
    catch (error) {
      if (["23505", "23514"].includes((error as {code?: string}).code ?? "")) throw new ApiError(409, "conflict", "This sign-in cannot be linked to that account");
      throw error;
    }
    return {ok: true};
  });
  app.post("/v3/auth/device", {bodyLimit: 2048}, async request => {
    const principal = await auth.verifier.verify(token(request));
    if (!principal) throw unauthorized();
    const body = proofSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "bad_request", "Invalid device authorization request");
    await auth.bind(principal, body.data);
    return {ok: true};
  });
  app.delete("/v3/auth/session", async request => {
    const principal = await auth.verifier.verify(token(request));
    if (!principal || !auth.device(principal)) throw unauthorized();
    const device = auth.device(principal)!;
    await auth.revoke(principal);
    ctx.hub.disconnectDevice(device.deviceId, "session revoked");
    return {ok: true};
  });
}
