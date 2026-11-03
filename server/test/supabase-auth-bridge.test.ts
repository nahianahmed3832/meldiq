import crypto from "node:crypto";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from "jose";
import {preparePostgresHarness} from "./support/postgres.js";
import {startServer} from "./support/harness.js";
import {AccountClient, MemoryMailer, PASSWORD} from "./support/accounts.js";
import {sign} from "./support/griipClient.js";
import {supabaseDeviceProof} from "../src/modules/accounts/supabaseIdentity.js";
import {authenticateToken, stillAuthenticated} from "../src/modules/auth/index.js";
import {fromBase32, stepAt, totpCode} from "../src/modules/accounts/totp.js";

let storage: NonNullable<Awaited<ReturnType<typeof preparePostgresHarness>>>;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
const origin = "https://bridge.example.invalid";
beforeAll(async () => {
  const result = await preparePostgresHarness(process.env.MELDIQ_PG_TEST_URL);
  if (!result) throw new Error("Set MELDIQ_PG_TEST_URL to an owned loopback PostgreSQL test server");
  storage = result;
  pair = await generateKeyPair("ES256");
});
afterAll(async () => storage?.close());
async function fixture() {
  const keys = createLocalJWKSet({keys: [{...await exportJWK(pair.publicKey), kid: "bridge", alg: "ES256"}]});
  const mailer = new MemoryMailer();
  const h = await startServer({PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex")}, {postgres: storage.database, mailer, supabase: {projectUrl: origin, keys}});
  try {
    const person = await AccountClient.ready(h.baseUrl, mailer, `bridge${crypto.randomBytes(4).toString("hex")}`);
    const authUserId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    await storage.database.query("INSERT INTO auth.users(id) VALUES($1)", [authUserId]);
    const tokenFor = async (id: string) => new SignJWT({role: "authenticated", session_id: id, email: "same-email-does-not-prove-ownership@example.invalid", user_metadata: {userId: "victim", accountId: "victim", admin: true}})
      .setProtectedHeader({alg: "ES256", kid: "bridge"}).setIssuer(`${origin}/auth/v1`).setAudience("authenticated").setSubject(authUserId).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    const session = async (id = crypto.randomUUID()) => {
      await storage.database.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [id, authUserId]);
      return {id, token: await tokenFor(id)};
    };
    const current = await session(sessionId);
    const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, token = current.token) => h.app.inject({method, url, payload, headers: {authorization: `Bearer ${token}`}});
    const proof = async (id = sessionId, device = person) => {
      const {nonce} = await person.req("POST", "/v1/auth/challenge");
      return {deviceId: device.deviceId, nonce, signature: sign(device.device, supabaseDeviceProof({authUserId, sessionId: id}, device.deviceId, nonce))};
    };
    const link = async (extra: Record<string, unknown> = {}) => request("POST", "/v3/auth/legacy-link", {legacyAccessToken: person.accessToken, ...await proof(), ...extra});
    return {h, person, authUserId, sessionId, current, tokenFor, session, request, proof, link};
  } catch (error) {await h.close(); throw error;}
}

describe("staged Supabase Auth/device migration", () => {
  it("requires explicit fresh legacy ownership and device proof before a JWT can use existing APIs", async () => {
    const f = await fixture();
    try {
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect((await f.request("GET", "/v3/auth/me")).statusCode).toBe(401);
      const linked = await f.link(); expect(linked.statusCode).toBe(200);
      expect(linked.headers["cache-control"]).toBe("private, no-store");
      expect((await f.request("GET", "/v3/auth/me")).json()).toEqual({authUserId: f.authUserId, accountId: f.person.accountId, userId: f.person.userId});
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(200);
      expect(await authenticateToken(f.h.ctx, f.current.token)).toMatchObject({userId: f.person.userId, deviceId: f.person.deviceId});
      expect((await f.h.ctx.accounts.store.accountById(f.person.accountId))?.email).toBe(f.person.email);
      expect(f.h.ctx.identity.get<{identity_key: string}>("users", {id: f.person.userId})?.identity_key).toBe(f.person.identityKeyB64);
      const bob = await f.h.client("bridgebob");
      const dm = (await f.person.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
      expect((await f.request("POST", "/v3/realtime/grants", {conversationId: dm})).statusCode).toBe(200);
      expect((await f.request("POST", "/v3/realtime/grants", {conversationId: "foreign-conversation"})).statusCode).toBe(404);
      expect(f.h.ctx.postgres?.legacySqlAttempts).toBe(0);
    } finally {await f.h.close();}
  });
  it("rejects forged device proofs and nonce replay, and never transfers a bound session to another device", async () => {
    const f = await fixture();
    try {
      const bad = await f.proof();
      bad.signature = sign(f.person.device, supabaseDeviceProof({authUserId: crypto.randomUUID(), sessionId: f.sessionId}, bad.deviceId, bad.nonce));
      expect((await f.request("POST", "/v3/auth/legacy-link", {legacyAccessToken: f.person.accessToken, ...bad})).statusCode).toBe(401);
      const proof = await f.proof();
      expect((await f.request("POST", "/v3/auth/legacy-link", {legacyAccessToken: f.person.accessToken, ...proof})).statusCode).toBe(200);
      expect((await f.request("POST", "/v3/auth/device", proof)).statusCode).toBe(401);
      const other = new AccountClient(f.h.baseUrl, f.person.email);
      other.identity = f.person.identity;
      await other.signIn(); await other.addThisDevice();
      expect((await f.request("POST", "/v3/auth/device", await f.proof(f.sessionId, other))).statusCode).toBe(409);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(200);
    } finally {await f.h.close();}
  });
  it("keeps a second provider session unbound until proof, and checks live provider logout on requests and sockets", async () => {
    const f = await fixture();
    try {
      expect((await f.link()).statusCode).toBe(200);
      const first = (await authenticateToken(f.h.ctx, f.current.token))!;
      const next = await f.session();
      expect((await f.request("GET", "/v1/queue", undefined, next.token)).statusCode).toBe(401);
      const allowed = () => storage.database.asUser(f.authUserId, next.id, async () => (await storage.database.query<{active: boolean}>("SELECT meldiq_private.active_user_id() IS NOT NULL AS active")).rows[0].active);
      expect(await allowed()).toBe(false);
      expect((await f.request("POST", "/v3/auth/device", await f.proof(next.id), next.token)).statusCode).toBe(200);
      expect(await allowed()).toBe(true);
      await storage.database.query("DELETE FROM auth.sessions WHERE id=$1", [f.sessionId]);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect(await stillAuthenticated(f.h.ctx, f.current.token, first)).toBe(false);
      expect((await f.request("GET", "/v1/queue", undefined, next.token)).statusCode).toBe(200);
    } finally {await f.h.close();}
  });
  it("commits local logout revocation with its binding and refuses to rebind that provider session", async () => {
    const f = await fixture();
    try {
      expect((await f.link()).statusCode).toBe(200);
      expect((await f.request("DELETE", "/v3/auth/session")).statusCode).toBe(200);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect((await f.request("POST", "/v3/auth/device", await f.proof())).statusCode).toBe(401);
      expect((await storage.database.query("SELECT 1 FROM meldiq_private.revoked_auth_sessions WHERE session_id=$1", [f.sessionId])).rowCount).toBe(1);
    } finally {await f.h.close();}
  });
  it("rejects provider bans and soft deletion even while a signed token and live session remain", async () => {
    const f = await fixture();
    try {
      expect((await f.link()).statusCode).toBe(200);
      await storage.database.query("UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1", [f.authUserId]);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      await storage.database.query("UPDATE auth.users SET banned_until=now()-interval '1 hour' WHERE id=$1", [f.authUserId]);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(200);
      await storage.database.query("UPDATE auth.users SET deleted_at=now() WHERE id=$1", [f.authUserId]);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
    } finally {await f.h.close();}
  });
  it("allows explicit deletion of the mapped application account and immediately denies its old JWT", async () => {
    const f = await fixture();
    try {
      expect((await f.link()).statusCode).toBe(200);
      expect(await f.person.req("DELETE", "/v2/account", {password: PASSWORD, confirmEmail: f.person.email})).toMatchObject({deleted: true});
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect((await storage.database.query("SELECT 1 FROM meldiq_private.auth_links WHERE auth_user_id=$1", [f.authUserId])).rowCount).toBe(0);
      expect((await storage.database.query("SELECT 1 FROM meldiq.auth_device_sessions WHERE account_id=$1", [f.person.accountId])).rowCount).toBe(0);
    } finally {await f.h.close();}
  });
  it("propagates existing account-wide and device revocation to Supabase authorization", async () => {
    const f = await fixture();
    try {
      expect((await f.link()).statusCode).toBe(200);
      const active = (await authenticateToken(f.h.ctx, f.current.token))!;
      expect(await f.h.ctx.accounts.store.revokeAccountSessions(f.person.accountId, "admin_revocation", Date.now())).toContain(f.person.deviceId);
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect(await stillAuthenticated(f.h.ctx, f.current.token, active)).toBe(false);
      const next = await f.session();
      expect((await f.request("POST", "/v3/auth/device", await f.proof(next.id), next.token)).statusCode).toBe(200);
      expect((await f.request("DELETE", `/v1/devices/${f.person.deviceId}`, undefined, next.token)).statusCode).toBe(200);
      expect((await f.request("GET", "/v1/queue", undefined, next.token)).statusCode).toBe(401);
    } finally {await f.h.close();}
  });
  it("invalidates bindings after password changes and still requires the existing second factor during migration", async () => {
    const f = await fixture();
    try {
      const {secret} = await f.person.req("POST", "/v2/account/totp/setup", {password: PASSWORD});
      const {backupCodes} = await f.person.req("POST", "/v2/account/totp/enable", {code: totpCode(fromBase32(secret), stepAt(Date.now()))});
      expect((await f.link()).statusCode).toBe(401);
      expect((await f.link({totpCode: backupCodes[0]})).statusCode).toBe(200);
      await f.h.ctx.accounts.store.updateAccount(f.person.accountId, {password_changed_at: Date.now() + 1}, Date.now());
      expect((await f.request("GET", "/v1/queue")).statusCode).toBe(401);
      expect(await storage.database.asUser(f.authUserId, f.sessionId, async () => (await storage.database.query("SELECT meldiq_private.active_user_id() AS owner")).rows[0].owner)).toBeNull();
    } finally {await f.h.close();}
  });
  it("rolls mapping, binding and challenge consumption back together after a real database failure", async () => {
    const f = await fixture();
    try {
      await storage.database.query(`CREATE FUNCTION meldiq_private.test_auth_binding_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
        CREATE TRIGGER test_auth_binding_failure AFTER INSERT ON meldiq.auth_device_sessions FOR EACH ROW EXECUTE FUNCTION meldiq_private.test_auth_binding_failure();`);
      const proof = await f.proof();
      const existing = f.h.ctx.ephemeral.count("auth_challenges");
      try {
        expect((await f.request("POST", "/v3/auth/legacy-link", {legacyAccessToken: f.person.accessToken, ...proof})).statusCode).toBe(500);
        expect((await storage.database.query("SELECT 1 FROM meldiq_private.auth_links WHERE auth_user_id=$1", [f.authUserId])).rowCount).toBe(0);
        expect(f.h.ctx.postgres!.rows.get("auth_device_sessions", {id: f.sessionId})).toBeUndefined();
        expect(f.h.ctx.ephemeral.count("auth_challenges")).toBe(existing);
      } finally {await storage.database.query("DROP TRIGGER test_auth_binding_failure ON meldiq.auth_device_sessions; DROP FUNCTION meldiq_private.test_auth_binding_failure()");}
      expect((await f.request("POST", "/v3/auth/legacy-link", {legacyAccessToken: f.person.accessToken, ...proof})).statusCode).toBe(200);
    } finally {await f.h.close();}
  });
});
