import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * "Log in with Meldiq" (API 0.65.0, settings parity batch B, docs/SETTINGS_PARITY_API.md): apps people make, the
 * authorization code flow with PKCE, rotating refresh tokens, userinfo, and the apps people signed in to.
 */

const REDIRECT = "https://app.example.test/callback";
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

interface Answer {
  status: number;
  body: any;
  headers: Headers;
}

function suite(name: string, env: Record<string, string>) {
  describe(name, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    let dev: AccountClient, ada: AccountClient;

    /** A token request, as a form (the standard) or JSON, with optional HTTP Basic client credentials. */
    const tokenReq = async (body: Record<string, string>, opts: { json?: boolean; basic?: [string, string] } = {}): Promise<Answer> => {
      const headers: Record<string, string> = { "content-type": opts.json ? "application/json" : "application/x-www-form-urlencoded" };
      if (opts.basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(opts.basic[0])}:${encodeURIComponent(opts.basic[1])}`).toString("base64")}`;
      const res = await fetch(`${h.baseUrl}/v2/oauth/token`, { method: "POST", headers, body: opts.json ? JSON.stringify(body) : new URLSearchParams(body).toString() });
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const bearer = async (path: string, token: string): Promise<Answer> => {
      const res = await fetch(`${h.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
      const ct = res.headers.get("content-type") ?? "";
      return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };
    const newApp = async (owner = dev, name = "Readme Club") => {
      const r = await owner.req("POST", "/v2/developer/apps", { name, redirectUris: [REDIRECT, "http://localhost:5173/cb"] });
      return { id: r.app.id as string, secret: r.clientSecret as string };
    };
    /** ada approves [appId] and gets a code. */
    const codeFor = async (appId: string, extra: Record<string, unknown> = {}) => {
      const r = await ada.req("POST", "/v2/oauth/authorize", { client_id: appId, redirect_uri: REDIRECT, state: "xyz", approve: true, ...extra });
      const u = new URL(r.redirect);
      expect(u.searchParams.get("state")).toBe("xyz");
      return u.searchParams.get("code")!;
    };
    /** A public client's full flow: authorize with S256, exchange with the verifier. */
    const signIn = async (appId: string, scope = "identify") => {
      const p = pkce();
      const code = await codeFor(appId, { scope, code_challenge: p.challenge, code_challenge_method: "S256" });
      const r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: appId, code_verifier: p.verifier });
      expect(r.status).toBe(200);
      return r.body;
    };

    beforeAll(async () => {
      h = await startServer(env, { mailer });
      dev = await AccountClient.ready(h.baseUrl, mailer, "oauthdev");
      ada = await AccountClient.ready(h.baseUrl, mailer, "oauthada");
    });
    afterAll(async () => h.close());

    it("is advertised in the server's features", async () => {
      expect((await dev.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["oauth-apps", "bots"]));
    });

    it("makes, lists, changes and deletes apps, showing the secret once and only https or localhost redirects", async () => {
      const created = await dev.req("POST", "/v2/developer/apps", { name: "Lab", redirectUris: [REDIRECT] });
      expect(created.clientSecret).toMatch(/^mqs_[A-Za-z0-9_-]{43}$/);
      expect(created.app).toMatchObject({ name: "Lab", redirectUris: [REDIRECT] });
      const listed = await dev.req("GET", "/v2/developer/apps");
      expect(listed.limit).toBe(10);
      expect(JSON.stringify(listed)).not.toContain(created.clientSecret);
      for (const bad of ["http://example.com/cb", "https://example.com/cb#frag", "ftp://x.test/", "https://user:pw@example.com/"]) {
        await expectStatus(dev.req("POST", "/v2/developer/apps", { name: "Bad", redirectUris: [bad] }), 400);
      }
      const patched = await dev.req("PATCH", `/v2/developer/apps/${created.app.id}`, { name: "Lab 2", redirectUris: ["http://127.0.0.1:8080/cb"] });
      expect(patched.app).toMatchObject({ name: "Lab 2", redirectUris: ["http://127.0.0.1:8080/cb"] });
      await expectStatus(ada.req("PATCH", `/v2/developer/apps/${created.app.id}`, { name: "Mine now" }), 404);
      await expectStatus(ada.req("DELETE", `/v2/developer/apps/${created.app.id}`), 404);
      expect(await dev.req("DELETE", `/v2/developer/apps/${created.app.id}`)).toEqual({ deleted: true });
      await expectStatus(dev.req("DELETE", `/v2/developer/apps/${created.app.id}`), 404);
    });

    it("allows 10 apps per person", async () => {
      const maker = await AccountClient.ready(h.baseUrl, mailer, "oauthmany");
      for (let i = 0; i < 10; i++) await maker.req("POST", "/v2/developer/apps", { name: `App ${i}`, redirectUris: [REDIRECT] });
      const refused = await expectStatus(maker.req("POST", "/v2/developer/apps", { name: "Eleventh", redirectUris: [REDIRECT] }), 409);
      expect(refused.error).toMatchObject({ code: "limit_reached", details: { limit: 10 } });
    });

    it("runs the full code flow with PKCE: consent info, code, tokens, userinfo with the verified email", async () => {
      const app = await newApp();
      const p = pkce();
      const q = new URLSearchParams({ response_type: "code", client_id: app.id, redirect_uri: REDIRECT, scope: "identify email", state: "s1", code_challenge: p.challenge, code_challenge_method: "S256" });
      const info = await ada.req("GET", `/v2/oauth/authorize/info?${q}`);
      expect(info).toMatchObject({ app: { id: app.id, name: "Readme Club", ownerUsername: dev.username }, redirectUri: REDIRECT, alreadyAuthorized: false });
      expect(info.scopes.map((s: { id: string }) => s.id)).toEqual(["identify", "email"]);

      const code = await codeFor(app.id, { scope: "identify email", code_challenge: p.challenge, code_challenge_method: "S256" });
      expect(code).toMatch(/^mqc_/);
      const t = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: app.id, code_verifier: p.verifier });
      expect(t.status).toBe(200);
      expect(t.headers.get("cache-control")).toBe("no-store");
      expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "identify email" });
      expect(t.body.access_token).toMatch(/^mqo_/);
      expect(t.body.refresh_token).toMatch(/^mqr_/);

      const me = await bearer("/v2/oauth/userinfo", t.body.access_token);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: ada.userId, username: ada.username, displayName: "oauthada", avatarUrl: null, email: ada.email, emailVerified: true });
      expect((await ada.req("GET", `/v2/oauth/authorize/info?${q}`)).alreadyAuthorized).toBe(true);
    });

    it("gives the email only with the email scope, and the avatar only when everyone may see it", async () => {
      const app = await newApp(dev, "No email");
      await ada.req("PUT", "/v1/users/me/photo", undefined, jpeg);
      const t = await signIn(app.id, "identify");
      expect(t.scope).toBe("identify");
      const me = await bearer("/v2/oauth/userinfo", t.access_token);
      expect(me.body.email).toBeUndefined();
      expect(me.body.avatarUrl).toMatch(/\/v2\/oauth\/userinfo\/avatar\?rev=\d+$/);
      const pic = await bearer(new URL(me.body.avatarUrl).pathname, t.access_token);
      expect(pic.status).toBe(200);
      expect(pic.headers.get("content-type")).toBe("image/jpeg");
      await ada.req("PUT", "/v1/users/me/privacy", { photo: "contacts" });
      expect((await bearer("/v2/oauth/userinfo", t.access_token)).body.avatarUrl).toBeNull();
      expect((await bearer("/v2/oauth/userinfo/avatar", t.access_token)).status).toBe(404);
      await ada.req("PUT", "/v1/users/me/privacy", { photo: "everyone" });
    });

    it("refuses a wrong verifier, a reused code (revoking what it gave) and a code without PKCE from a public client", async () => {
      const app = await newApp(dev, "Strict");
      const p = pkce();
      const code = await codeFor(app.id, { code_challenge: p.challenge, code_challenge_method: "S256" });
      const wrong = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: app.id, code_verifier: pkce().verifier });
      expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

      const p2 = pkce();
      const code2 = await codeFor(app.id, { code_challenge: p2.challenge, code_challenge_method: "S256" });
      const body = { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: app.id, code_verifier: p2.verifier };
      const first = await tokenReq(body, { json: true });
      expect(first.status).toBe(200);
      expect((await bearer("/v2/oauth/userinfo", first.body.access_token)).status).toBe(200);
      expect(await tokenReq(body)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      expect((await bearer("/v2/oauth/userinfo", first.body.access_token)).status).toBe(401);

      const bare = await codeFor(app.id);
      expect(await tokenReq({ grant_type: "authorization_code", code: bare, redirect_uri: REDIRECT, client_id: app.id })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      // With its secret (HTTP Basic), a confidential client needs no PKCE.
      const bare2 = await codeFor(app.id);
      const confidential = await tokenReq({ grant_type: "authorization_code", code: bare2, redirect_uri: REDIRECT }, { basic: [app.id, app.secret] });
      expect(confidential.status).toBe(200);
      const badSecret = await tokenReq({ grant_type: "authorization_code", code: await codeFor(app.id), redirect_uri: REDIRECT }, { basic: [app.id, "mqs_wrong"] });
      expect(badSecret).toMatchObject({ status: 401, body: { error: "invalid_client" } });
      expect(badSecret.headers.get("www-authenticate")).toContain("Basic");
      expect(await tokenReq({ grant_type: "password", client_id: app.id })).toMatchObject({ status: 400, body: { error: "unsupported_grant_type" } });
    });

    it("checks the redirect, the scopes and the PKCE method, and denying returns access_denied", async () => {
      const app = await newApp(dev, "Picky");
      const base = { client_id: app.id, redirect_uri: REDIRECT, approve: true };
      expect((await expectStatus(ada.req("POST", "/v2/oauth/authorize", { ...base, redirect_uri: "https://evil.example.test/cb" }), 400)).error.code).toBe("oauth_invalid_redirect");
      expect((await expectStatus(ada.req("POST", "/v2/oauth/authorize", { ...base, client_id: "app_nope" }), 400)).error.code).toBe("oauth_invalid_client");
      expect((await expectStatus(ada.req("POST", "/v2/oauth/authorize", { ...base, scope: "identify guilds" }), 400)).error.code).toBe("oauth_invalid_scope");
      const p = pkce();
      expect((await expectStatus(ada.req("POST", "/v2/oauth/authorize", { ...base, code_challenge: p.challenge, code_challenge_method: "plain" }), 400)).error.code).toBe("oauth_invalid_request");
      const denied = new URL((await ada.req("POST", "/v2/oauth/authorize", { ...base, approve: false, state: "st" })).redirect);
      expect(Object.fromEntries(denied.searchParams)).toEqual({ error: "access_denied", state: "st" });
      // The code was asked for with one redirect_uri; the token request must repeat it.
      const code = await codeFor(app.id, { code_challenge: p.challenge, code_challenge_method: "S256" });
      const mismatch = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:5173/cb", client_id: app.id, code_verifier: p.verifier });
      expect(mismatch).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    });

    it("rotates refresh tokens, and a replaced one presented again ends the sign-in", async () => {
      const app = await newApp(dev, "Refresher");
      const t = await signIn(app.id, "identify email");
      const r1 = await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: app.id });
      expect(r1.status).toBe(200);
      expect(r1.body.refresh_token).not.toBe(t.refresh_token);
      expect((await bearer("/v2/oauth/userinfo", t.access_token)).status).toBe(401);
      expect((await bearer("/v2/oauth/userinfo", r1.body.access_token)).status).toBe(200);
      const narrowed = await tokenReq({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: app.id, scope: "identify" });
      expect(narrowed.body.scope).toBe("identify");
      expect(await tokenReq({ grant_type: "refresh_token", refresh_token: narrowed.body.refresh_token, client_id: app.id, scope: "identify email" })).toMatchObject({ body: { error: "invalid_scope" } });
      // The token replaced by the narrowing comes back: a copy is in use, so the whole sign-in ends.
      expect(await tokenReq({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: app.id })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      expect((await bearer("/v2/oauth/userinfo", narrowed.body.access_token)).status).toBe(401);
      expect(await tokenReq({ grant_type: "refresh_token", refresh_token: narrowed.body.refresh_token, client_id: app.id })).toMatchObject({ body: { error: "invalid_grant" } });

      // A sign-in made with the secret needs the secret to refresh.
      const code = await codeFor(app.id);
      const conf = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: app.id, client_secret: app.secret });
      expect(await tokenReq({ grant_type: "refresh_token", refresh_token: conf.body.refresh_token, client_id: app.id })).toMatchObject({ status: 401, body: { error: "invalid_client" } });
      expect((await tokenReq({ grant_type: "refresh_token", refresh_token: conf.body.refresh_token, client_id: app.id, client_secret: app.secret })).status).toBe(200);
    });

    it("keeps OAuth access tokens off every other route, and sessions off userinfo", async () => {
      const app = await newApp(dev, "Contained");
      const t = await signIn(app.id);
      for (const path of ["/v1/users/me", "/v2/points", "/v1/orgs", "/v2/developer/apps", "/v2/oauth/grants", "/v2/messages/summary"]) {
        expect((await bearer(path, t.access_token)).status, path).toBe(401);
      }
      const bot = await fetch(`${h.baseUrl}/v2/bot/me`, { headers: { authorization: `Bot ${t.access_token}` } });
      expect(bot.status).toBe(401);
      const asSession = await bearer("/v2/oauth/userinfo", ada.token!);
      expect(asSession.status).toBe(401);
      expect(asSession.body.error.code).toBe("invalid_token");
      expect(asSession.headers.get("www-authenticate")).toContain("invalid_token");
    });

    it("lists the apps you signed in to and revokes one: its tokens stop at once", async () => {
      const app = await newApp(dev, "Revocable");
      const t = await signIn(app.id, "identify email");
      const { grants } = await ada.req("GET", "/v2/oauth/grants");
      expect(grants.find((g: { app: { id: string } }) => g.app.id === app.id)).toMatchObject({ app: { name: "Revocable", ownerUsername: dev.username }, scopes: ["identify", "email"] });
      expect(await ada.req("DELETE", `/v2/oauth/grants/${app.id}`)).toEqual({ revoked: true });
      expect(await ada.req("DELETE", `/v2/oauth/grants/${app.id}`)).toEqual({ revoked: false });
      expect((await bearer("/v2/oauth/userinfo", t.access_token)).status).toBe(401);
      expect(await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: app.id })).toMatchObject({ body: { error: "invalid_grant" } });
      expect((await ada.req("GET", "/v2/oauth/grants")).grants.some((g: { app: { id: string } }) => g.app.id === app.id)).toBe(false);
    });

    it("rotates the client secret: the old one stops working at once", async () => {
      const app = await newApp(dev, "Rotating");
      const rotated = await dev.req("POST", `/v2/developer/apps/${app.id}/secret`);
      expect(rotated.clientSecret).not.toBe(app.secret);
      expect(await tokenReq({ grant_type: "authorization_code", code: await codeFor(app.id), redirect_uri: REDIRECT, client_id: app.id, client_secret: app.secret })).toMatchObject({
        status: 401,
        body: { error: "invalid_client" },
      });
      const ok = await tokenReq({ grant_type: "authorization_code", code: await codeFor(app.id), redirect_uri: REDIRECT }, { basic: [app.id, rotated.clientSecret] });
      expect(ok.status).toBe(200);
      await expectStatus(ada.req("POST", `/v2/developer/apps/${app.id}/secret`), 404);
    });

    it("deletes an owner's apps with their account", async () => {
      const owner = await AccountClient.ready(h.baseUrl, mailer, "oauthleaver");
      const app = await newApp(owner, "Leaving");
      const t = await signIn(app.id);
      await owner.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: owner.email });
      expect((await bearer("/v2/oauth/userinfo", t.access_token)).status).toBe(401);
      const info = await expectStatus(ada.req("GET", `/v2/oauth/authorize/info?client_id=${app.id}&redirect_uri=${encodeURIComponent(REDIRECT)}`), 400);
      expect(info.error.code).toBe("oauth_invalid_client");
    });
  });
}

suite("Log in with Meldiq on the default (memory) stores", {});
suite("Log in with Meldiq on MongoDB", { MONGODB_DOMAINS: "preferences,reports,relationships,history,accounts,files,relay,billing" });
