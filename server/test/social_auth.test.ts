import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import {
  AccountClient,
  email,
  MemoryMailer,
  PASSWORD,
} from "./support/accounts.js";
import { digest, secret } from "../src/modules/accounts/social/service.js";
import type { ExternalIdentity } from "../src/modules/accounts/social/store.js";
import { canonical, sign } from "./support/griipClient.js";
import { ApiError } from "../src/shared/errors.js";

for (const backend of ["sqlite", "mongodb"])
  describe(`social auth: ${backend}`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    beforeAll(async () => {
      h = await startServer(
        {
          SUPABASE_AUTH_URL: "https://test-auth.example",
          SUPABASE_AUTH_PUBLISHABLE_KEY: "sb_publishable_test",
          SOCIAL_AUTH_PUBLIC_ORIGIN: "https://web.example",
          SOCIAL_AUTH_WEB_ORIGIN: "https://web.example",
          SOCIAL_AUTH_PROVIDERS: "google,apple,discord",
          ...(backend === "mongodb" ? { MONGODB_DOMAINS: "accounts" } : {}),
        },
        { mailer },
      );
      vi.spyOn(h.ctx.accounts.social.provider!, "authorize").mockResolvedValue(
        "https://accounts.google.com/o/oauth2/v2/auth?state=upstream-state",
      );
      vi.spyOn(h.ctx.accounts.social.provider!, "exchange").mockImplementation(
        async (code) => JSON.parse(code),
      );
    });
    afterAll(async () => {
      await h.close();
    });
    const identity = (
      provider: "google" | "apple" | "discord" = "google",
      address = email(provider),
    ): ExternalIdentity => ({
      provider,
      issuer:
        provider === "google"
          ? "https://accounts.google.com"
          : provider === "apple"
            ? "https://appleid.apple.com"
            : "https://discord.com",
      subject: secret(),
      email: address,
    });
    const account = async () => {
      const c = await new AccountClient(h.baseUrl, email("existing")).signUp(
        mailer,
      );
      await c.signIn();
      return c;
    };
    async function ready(i: ExternalIdentity, c?: AccountClient) {
      const verifier = secret();
      const started = await (c ?? new AccountClient(h.baseUrl, "")).req(
        "POST",
        "/v2/auth/social/start",
        {
          provider: i.provider,
          challenge: digest(verifier),
          mode: c ? "link" : "login",
          platform: "web",
        },
      );
      const auth = await h.app.inject({
        method: "GET",
        url: `/v2/auth/social/authorize/${started.id}`,
      });
      expect(auth.statusCode).toBe(302);
      const setCookie = String(auth.headers["set-cookie"]).split(";")[0];
      expect(setCookie).toContain("__Host-meldiq-social=");
      const result = await h.app.inject({
        method: "GET",
        url: `/v2/auth/social/callback?code=${encodeURIComponent(JSON.stringify(i))}`,
        headers: { cookie: setCookie },
      });
      expect(result.statusCode).toBe(302);
      const params = new URLSearchParams(
        new URL(String(result.headers.location)).hash.slice(1),
      );
      return { id: started.id, verifier, receipt: params.get("receipt")! };
    }
    const finish = (r: object, c?: AccountClient, extra: object = {}) =>
      (c ?? new AccountClient(h.baseUrl, "")).req(
        "POST",
        "/v2/auth/social/complete",
        { ...r, ...extra },
      );
    it.each(["google", "apple", "discord"] as const)(
      "links %s to the same account and preserves its password and identity",
      async (provider) => {
        const c = await account();
        await c.setUpIdentity();
        const before = await h.ctx.accounts.store.accountById(c.accountId);
        const i = identity(provider, c.email);
        expect(await finish(await ready(i, c), c)).toEqual({ linked: true });
        const r = await finish(await ready(i));
        expect(r.grant.account.id).toBe(c.accountId);
        expect(r.grant.account.identity.userId).toBe(c.userId);
        expect(
          await h.ctx.accounts.store.accountById(c.accountId),
        ).toMatchObject({ ...before, updated_at: expect.any(Number) });
        await c.signIn();
      },
    );
    it("never links or registers an identity by matching an existing email", async () => {
      const c = await account();
      const i = identity("google", c.email);
      expect((await expectStatus(finish(await ready(i)), 409)).error.code).toBe(
        "account_link_required",
      );
      expect(await h.ctx.accounts.social.store.find(i)).toBeNull();
    });
    it("preserves provider subjects when the provider email changes, including Apple relay", async () => {
      const c = await account();
      const i = identity("apple", "relay@privaterelay.appleid.com");
      await finish(await ready(i, c), c);
      const r = await finish(await ready({ ...i, email: email("changed") }));
      expect(r.grant.account.id).toBe(c.accountId);
      expect(r.grant.account.email).toBe(c.email);
    });
    it("does not merge a provider already owned by another account", async () => {
      const a = await account();
      const b = await account();
      const i = identity();
      await finish(await ready(i, a), a);
      expect(
        (await expectStatus(finish(await ready(i, b), b), 409)).error.code,
      ).toBe("identity_conflict");
      expect((await h.ctx.accounts.social.store.find(i))!.account_id).toBe(
        a.accountId,
      );
    });
    it("requires the exact same live session to complete linking", async () => {
      const a = await account();
      const b = await account();
      const r = await ready(identity(), a);
      await expectStatus(finish(r), 401);
      await expectStatus(finish(r, b), 401);
      await a.req("POST", "/v2/auth/logout", {});
      await expectStatus(finish(r, a), 401);
    });
    it("requires authentication to begin linking and to disconnect", async () => {
      const c = new AccountClient(h.baseUrl, "");
      await expectStatus(
        c.req("POST", "/v2/auth/social/start", {
          provider: "google",
          challenge: digest(secret()),
          mode: "link",
        }),
        401,
      );
      await expectStatus(
        c.req("DELETE", "/v2/account/identities/google", {}),
        401,
      );
    });
    it("uses client proof, one-use receipts, expiration and browser state", async () => {
      const c = await account();
      const i = identity();
      const r = await ready(i, c);
      await expectStatus(finish({ ...r, verifier: secret() }, c), 400);
      await expectStatus(finish({ ...r, receipt: secret() }, c), 400);
      await finish(r, c);
      await expectStatus(finish(r, c), 400);
      const noCookie = await h.app.inject({
        method: "GET",
        url: "/v2/auth/social/callback?code=fake",
      });
      expect(noCookie.statusCode).toBe(400);
      const exp = await ready(identity(), c);
      const f = (await h.ctx.accounts.social.store.flow(exp.id))!;
      await h.ctx.accounts.social.store.replace(
        { ...f, expiresAt: 1 },
        "ready",
      );
      await expectStatus(finish(exp, c), 400);
    });
    it("returns cancellation and provider network failures to the initiating app without secrets", async () => {
      const c = new AccountClient(h.baseUrl, "");
      const started = await c.req("POST", "/v2/auth/social/start", {
        provider: "google",
        challenge: digest(secret()),
      });
      const auth = await h.app.inject({
        method: "GET",
        url: `/v2/auth/social/authorize/${started.id}`,
      });
      const cookie = String(auth.headers["set-cookie"]).split(";")[0];
      const cancelled = await h.app.inject({
        method: "GET",
        url: "/v2/auth/social/callback?error=access_denied",
        headers: { cookie },
      });
      expect(cancelled.statusCode).toBe(302);
      expect(cancelled.headers.location).toContain("error=cancelled");
      expect((await h.ctx.accounts.social.store.flow(started.id))!.stage).toBe(
        "used",
      );
      const retry = await c.req("POST", "/v2/auth/social/start", {
        provider: "google",
        challenge: digest(secret()),
      });
      vi.mocked(
        h.ctx.accounts.social.provider!.authorize,
      ).mockRejectedValueOnce(new Error("upstream secret must not escape"));
      const failed = await h.app.inject({
        method: "GET",
        url: `/v2/auth/social/authorize/${retry.id}`,
      });
      expect(failed.statusCode).toBe(302);
      expect(failed.headers.location).toContain("error=verification_failed");
      expect(JSON.stringify(failed.headers)).not.toContain("upstream secret");
    });
    it("removes provider mappings when the owning account is deleted", async () => {
      const c = await account();
      const i = identity();
      await finish(await ready(i, c), c);
      await h.ctx.accounts.store.deleteAccount(c.accountId);
      expect(await h.ctx.accounts.social.store.find(i)).toBeNull();
    });
    it("creates a new social account only after explicit profile completion", async () => {
      const i = identity();
      const r = await ready(i);
      expect((await expectStatus(finish(r), 400)).error.code).toBe(
        "social_profile_required",
      );
      expect(
        await h.ctx.accounts.store.accountByEmail(i.email!),
      ).toBeUndefined();
      const created = await finish(r, undefined, { name: "New Meldiq Person" });
      expect(created.grant.account.name).toBe("New Meldiq Person");
      expect(
        (await h.ctx.accounts.store.accountById(created.grant.account.id))!
          .password_hash,
      ).toBe("!social-only");
      const subsequent = await finish(await ready(i));
      expect(subsequent.grant.account.id).toBe(created.grant.account.id);
    });
    it("refuses unverified provider email for new accounts", async () => {
      expect(
        (
          await expectStatus(
            finish(await ready({ ...identity(), email: null }), undefined, {
              name: "X",
            }),
            400,
          )
        ).error.code,
      ).toBe("provider_email_required");
    });
    it("keeps a last login method, supports adding both providers, and revokes other sessions on disconnect", async () => {
      const i = identity();
      const g = (await finish(await ready(i), undefined, { name: "Solo" }))
        .grant;
      const c = new AccountClient(h.baseUrl, i.email!);
      c.useSession(g);
      expect(
        (
          await expectStatus(
            c.req("DELETE", "/v2/account/identities/google", {}),
            409,
          )
        ).error.code,
      ).toBe("last_login_method");
      const apple = identity("apple");
      await finish(await ready(apple, c), c);
      const other = (await finish(await ready(apple))).grant;
      await c.req("DELETE", "/v2/account/identities/google", {});
      expect(
        (await c.req("GET", "/v2/account/identities")).identities.map(
          (x: any) => x.provider,
        ),
      ).toEqual(["apple"]);
      expect(
        await h.ctx.accounts.service.sessions.authenticate(
          other.accessToken,
          Date.now(),
        ),
      ).toBeNull();
      expect(
        await h.ctx.accounts.service.sessions.authenticate(
          c.accessToken,
          Date.now(),
        ),
      ).not.toBeNull();
    });
    it("serializes simultaneous disconnects so a social-only account retains a provider", async () => {
      const g = (
        await finish(await ready(identity()), undefined, { name: "Race" })
      ).grant;
      const c = new AccountClient(h.baseUrl, g.account.email);
      c.useSession(g);
      await finish(await ready(identity("apple"), c), c);
      const outcomes = await Promise.allSettled([
        c.req("DELETE", "/v2/account/identities/google", {}),
        c.req("DELETE", "/v2/account/identities/apple", {}),
      ]);
      expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(await h.ctx.accounts.social.store.list(c.accountId)).toHaveLength(
        1,
      );
    });
    it("retains TOTP checks on provider login", async () => {
      const c = await account();
      const i = identity();
      await finish(await ready(i, c), c);
      const original = h.ctx.accounts.service.secondFactor;
      h.ctx.accounts.service.secondFactor = () => {
        throw new ApiError(
          401,
          "totp_required",
          "Enter your authenticator code.",
        );
      };
      try {
        expect(
          (await expectStatus(finish(await ready(i)), 401)).error.code,
        ).toBe("totp_required");
      } finally {
        h.ctx.accounts.service.secondFactor = original;
      }
    });
    it("binds restored provider sessions only to a proven device of that account", async () => {
      const c = await account();
      await c.setUpIdentity();
      const i = identity();
      await finish(await ready(i, c), c);
      const { nonce } = await c.req("POST", "/v1/auth/challenge");
      const device = {
        deviceId: c.deviceId,
        nonce,
        signature: sign(
          c.device,
          canonical.authProof("login", nonce, c.signingKeyB64),
        ),
      };
      const restored = await finish(await ready(i), undefined, { device });
      expect(restored.grant.session.deviceId).toBe(c.deviceId);
      const other = await account();
      await other.setUpIdentity();
      await expectStatus(
        finish(await ready(i), undefined, {
          device: { ...device, deviceId: other.deviceId },
        }),
        401,
      );
    });
    it("requires fresh authentication for old sessions without rotating or deleting existing tokens", async () => {
      const c = await account();
      const store = h.ctx.accounts.store as any;
      if (backend === "sqlite")
        h.ctx.db
          .prepare("UPDATE account_sessions SET created_at = ? WHERE id = ?")
          .run(Date.now() - 600_000, c.sessionId);
      else
        await h.ctx
          .mongo!.db.collection("account_sessions")
          .updateOne(
            { id: c.sessionId },
            { $set: { created_at: Date.now() - 600_000 } },
          );
      const b = {
        provider: "google",
        challenge: digest(secret()),
        mode: "link",
      };
      expect(
        (await expectStatus(c.req("POST", "/v2/auth/social/start", b), 403))
          .error.code,
      ).toBe("fresh_auth_required");
      expect(
        (
          await c.req("POST", "/v2/auth/social/start", {
            ...b,
            password: PASSWORD,
          })
        ).id,
      ).toBeTruthy();
      expect(await store.sessionById(c.sessionId)).toMatchObject({
        revoked_at: null,
      });
    });
    it("awaits asynchronous second-factor rejection before issuing a session or changing providers", async () => {
      const c = await account();
      const i = identity("google", c.email);
      await finish(await ready(i, c), c);
      const login = await ready(i);
      const original = h.ctx.accounts.service.secondFactor;
      h.ctx.accounts.service.secondFactor = async () => {
        await Promise.resolve();
        throw new ApiError(401, "totp_required", "Authenticator required");
      };
      try {
        expect((await expectStatus(finish(login), 401)).error.code).toBe("totp_required");
        expect((await expectStatus(c.req("POST", "/v2/auth/social/start", {provider: "discord", challenge: digest(secret()), mode: "link"}), 401)).error.code).toBe("totp_required");
        expect((await expectStatus(c.req("DELETE", "/v2/account/identities/google", {}), 401)).error.code).toBe("totp_required");
        expect((await h.ctx.accounts.social.store.list(c.accountId)).map(x => x.provider)).toContain("google");
      } finally { h.ctx.accounts.service.secondFactor = original; }
    });

    it("enforces provider ownership and one provider per account in database indexes", async () => {
      const first = await account();
      const second = await account();
      const i = identity("discord");
      const store = h.ctx.accounts.social.store;
      await store.link({...i,id:secret(),account_id:first.accountId,connected_at:Date.now()});
      await expect(store.link({...i,id:secret(),account_id:second.accountId,connected_at:Date.now()})).rejects.toMatchObject({statusCode:409,code:"identity_conflict"});
      await expect(store.link({...i,subject:secret(),id:secret(),account_id:first.accountId,connected_at:Date.now()})).rejects.toMatchObject({statusCode:409,code:"identity_conflict"});
    });

  });
