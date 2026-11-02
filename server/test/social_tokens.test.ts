import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { SupabaseIdentity } from "../src/modules/accounts/social/supabase.js";
import { socialConfig } from "../src/modules/accounts/social/config.js";
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let provider: SupabaseIdentity;
const cfg = {
  url: "https://identity.example",
  publishableKey: "sb_publishable_test",
  publicOrigin: "https://web.example",
  webOrigin: "https://web.example",
  providers: ["google", "apple"] as ("google" | "apple")[],
  googleClientId: "client.apps.googleusercontent.com",
};
let user: unknown;
beforeAll(async () => {
  key = await generateKeyPair("ES256");
  const jwk = await exportJWK(key.publicKey);
  provider = new SupabaseIdentity(
    cfg,
    async () => Response.json(user),
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }),
  );
});
async function jwt(
  patch: Record<string, unknown> = {},
  signingKey = key.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "authenticated",
    session_id: "session",
    iss: `${cfg.url}/auth/v1`,
    aud: "authenticated",
    sub: "supabase-user",
    exp: now + 60,
    iat: now,
    ...patch,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .sign(signingKey);
}
const setUser = (patch = {}) => {
  user = {
    id: "supabase-user",
    app_metadata: { provider: "google" },
    identities: [
      {
        provider: "google",
        identity_data: {
          sub: "google-subject",
          email: "verified@example.test",
          email_verified: true,
        },
      },
    ],
    ...patch,
  };
};
describe("Supabase identity verification", () => {
  it.each([
    [
      "google",
      { name: "Google Person", full_name: "Legacy Name" },
      "Google Person",
    ],
    [
      "discord",
      {
        full_name: "discordhandle",
        name: "discordhandle#0",
        custom_claims: { global_name: "Discord Display Name" },
      },
      "Discord Display Name",
    ],
    [
      "discord",
      { full_name: "discordhandle", custom_claims: { global_name: null } },
      "discordhandle",
    ],
  ] as const)(
    "reads %s cosmetic names from the selected verified provider identity",
    async (kind, metadata, expected) => {
      setUser({
        user_metadata: { name: "Ignored Broker Name" },
        identities: [
          {
            provider: kind,
            identity_data: {
              sub: "selected-subject",
              email: "verified@example.test",
              email_verified: true,
              ...metadata,
            },
          },
        ],
      });
      const result = await provider.verify({ access_token: await jwt() }, kind);
      expect(result.displayName).toBe(expected);
      expect(result.subject).toBe("selected-subject");
    },
  );
  it("validates a signed Supabase JWT and retrieves identity from its authenticated user endpoint", async () => {
    setUser();
    expect(
      await provider.verify({ access_token: await jwt() }, "google"),
    ).toEqual({
      provider: "google",
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: "verified@example.test",
    });
  });
  it.each([
    { iss: "https://attacker.example/auth/v1" },
    { aud: "service_role" },
    { exp: 1 },
    { iat: 1 },
    { role: "service_role" },
    { sub: "other-user" },
    { session_id: null },
  ])("refuses invalid claims: %j", async (claims) => {
    setUser();
    await expect(
      provider.verify({ access_token: await jwt(claims) }, "google"),
    ).rejects.toMatchObject({ code: "external_identity_invalid" });
  });
  it("refuses forged signatures, malformed JWTs and client supplied identity claims", async () => {
    setUser();
    const other = await generateKeyPair("ES256");
    for (const token of ["not-a-jwt", await jwt({}, other.privateKey)])
      await expect(
        provider.verify(
          { access_token: token, email: "victim@example.test" },
          "google",
        ),
      ).rejects.toMatchObject({ code: "external_identity_invalid" });
  });
  it("does not accept a different or ambiguous provider", async () => {
    setUser();
    await expect(
      provider.verify({ access_token: await jwt() }, "apple"),
    ).rejects.toMatchObject({ code: "external_identity_invalid" });
    setUser({
      identities: [
        { provider: "google", identity_data: { sub: "a" } },
        { provider: "google", identity_data: { sub: "b" } },
      ],
    });
    await expect(
      provider.verify({ access_token: await jwt() }, "google"),
    ).rejects.toMatchObject({ code: "external_identity_invalid" });
  });
  it("does not use unverified email or metadata as proof of email ownership", async () => {
    setUser({
      email: "victim@example.test",
      user_metadata: { email_verified: true },
      identities: [
        {
          provider: "google",
          identity_data: {
            sub: "subject",
            email: "victim@example.test",
            email_verified: false,
          },
        },
      ],
    });
    expect(
      (await provider.verify({ access_token: await jwt() }, "google")).email,
    ).toBeNull();
  });
  it("initiates PKCE server-side and exposes only the provider's state to the browser", async () => {
    let requested: URL | undefined;
    const initiating = new SupabaseIdentity(cfg, async (url) => {
      requested = new URL(String(url));
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://accounts.google.com/o/oauth2/v2/auth?state=upstream",
        },
      });
    });
    expect(await initiating.authorize("google", "private-challenge")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?state=upstream",
    );
    expect(requested!.origin).toBe(cfg.url);
    expect(requested!.searchParams.get("redirect_to")).toBe(
      `${cfg.publicOrigin}/v2/auth/social/callback`,
    );
    expect(requested!.searchParams.get("code_challenge")).toBe(
      "private-challenge",
    );
  });
  it("refuses provider substitution, open redirects and exposed server challenges", async () => {
    for (const location of [
      "https://evil.example/",
      "https://appleid.apple.com/auth/authorize",
      "https://accounts.google.com/o/oauth2/v2/auth?code_challenge=private",
    ]) {
      const bad = new SupabaseIdentity(
        cfg,
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(bad.authorize("google", "private")).rejects.toMatchObject({
        code: "external_identity_invalid",
      });
    }
  });
  it("verifies Discord as a separate provider subject even when Supabase auto-linked the user", async () => {
    setUser({
      identities: [
        {
          provider: "google",
          identity_data: {
            sub: "google-owner",
            email: "same@example.test",
            email_verified: true,
          },
        },
        {
          provider: "discord",
          identity_data: {
            sub: "discord-owner",
            email: "same@example.test",
            email_verified: true,
          },
        },
      ],
    });
    expect(
      await provider.verify({ access_token: await jwt() }, "discord"),
    ).toEqual({
      provider: "discord",
      issuer: "https://discord.com",
      subject: "discord-owner",
      email: "same@example.test",
    });
    const initiating = new SupabaseIdentity(
      cfg,
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://discord.com/api/oauth2/authorize?state=opaque",
          },
        }),
    );
    expect(
      await initiating.authorize("discord", "private-challenge"),
    ).toContain("https://discord.com/api/oauth2/authorize");
  });
  it("normalizes network failure without exposing upstream credentials or raw responses", async () => {
    const offline = new SupabaseIdentity(cfg, async () => {
      throw Error("secret upstream error");
    });
    await expect(
      offline.exchange("code", "verifier", "google"),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("is disabled by default and rejects insecure or secret-key configuration", () => {
    expect(socialConfig({})).toBeNull();
    expect(() =>
      socialConfig({ SUPABASE_AUTH_URL: "https://user:password@example.com" }),
    ).toThrow();
    expect(() =>
      socialConfig({
        SUPABASE_AUTH_URL: cfg.url,
        SUPABASE_AUTH_PUBLISHABLE_KEY: "sb_secret_private",
        SOCIAL_AUTH_PUBLIC_ORIGIN: cfg.publicOrigin,
        SOCIAL_AUTH_WEB_ORIGIN: cfg.webOrigin,
      }),
    ).toThrow();
  });
});

describe("native Google proof", () => {
  it("requires Google's signed issuer, configured audience, expiration and exact flow nonce", async () => {
    const crypto = await import("node:crypto");
    const google = await generateKeyPair("RS256");
    const googleJwk = await exportJWK(google.publicKey);
    const supabaseJwk = await exportJWK(key.publicKey);
    const native = new SupabaseIdentity(
      cfg,
      async (url) =>
        String(url).includes("token?")
          ? Response.json({ access_token: await jwt() })
          : Response.json({
              id: "supabase-user",
              app_metadata: { provider: "google" },
              identities: [
                {
                  provider: "google",
                  identity_data: {
                    sub: "native-google-sub",
                    email: "native@example.test",
                    email_verified: true,
                  },
                },
              ],
            }),
      createLocalJWKSet({ keys: [{ ...supabaseJwk, kid: "test" }] }),
      createLocalJWKSet({ keys: [{ ...googleJwk, kid: "google" }] }),
    );
    const nonce = "server-generated-nonce";
    const hashedNonce = crypto.createHash("sha256").update(nonce).digest("hex");
    const token = (patch: object = {}) =>
      new SignJWT({
        iss: "https://accounts.google.com",
        aud: cfg.googleClientId,
        sub: "native-google-sub",
        nonce: hashedNonce,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        ...patch,
      })
        .setProtectedHeader({ alg: "RS256", kid: "google" })
        .sign(google.privateKey);
    expect((await native.nativeGoogle(await token(), nonce)).subject).toBe(
      "native-google-sub",
    );
    for (const patch of [
      { nonce: "wrong" },
      { sub: "different-provider-subject" },
      { aud: "attacker-client" },
      { iss: "https://attacker.example" },
      { exp: 1 },
    ])
      await expect(
        native.nativeGoogle(await token(patch), nonce),
      ).rejects.toMatchObject({ code: "external_identity_invalid" });
  });
});
