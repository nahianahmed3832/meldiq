import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import crypto from "node:crypto";
import { ApiError } from "../../../shared/errors.js";
import type { SocialConfig, SocialProvider } from "./config.js";
import type { ExternalIdentity } from "./store.js";

const invalid = () =>
  new ApiError(
    401,
    "external_identity_invalid",
    "The provider could not verify this sign-in. Start again.",
  );
const identityData = z.object({
  sub: z.string().min(1).max(512),
  email: z.string().email().optional(),
  email_verified: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional(),
});
const userSchema = z.object({
  id: z.string(),
  app_metadata: z.object({ provider: z.string() }),
  identities: z.array(
    z.object({
      provider: z.string(),
      identity_data: identityData.passthrough(),
    }),
  ),
});
/** All tokens come directly from Supabase over TLS; none of its sessions or provider tokens are retained. */
export class SupabaseIdentity {
  private readonly keys: JWTVerifyGetKey;
  private readonly googleKeys: JWTVerifyGetKey;
  constructor(
    readonly config: SocialConfig,
    private readonly request: typeof fetch = fetch,
    keys?: JWTVerifyGetKey,
    googleKeys?: JWTVerifyGetKey,
  ) {
    this.googleKeys =
      googleKeys ??
      createRemoteJWKSet(
        new URL("https://www.googleapis.com/oauth2/v3/certs"),
        { timeoutDuration: 8_000 },
      );
    this.keys =
      keys ??
      createRemoteJWKSet(
        new URL(`${config.url}/auth/v1/.well-known/jwks.json`),
        { timeoutDuration: 8_000, cooldownDuration: 30_000 },
      );
  }
  async authorize(
    provider: SocialProvider,
    challenge: string,
  ): Promise<string> {
    const url = new URL(`${this.config.url}/auth/v1/authorize`);
    url.search = new URLSearchParams({
      provider,
      redirect_to: `${this.config.publicOrigin}/v2/auth/social/callback`,
      code_challenge: challenge,
      code_challenge_method: "s256",
      ...(provider === "google" ? { prompt: "select_account" } : {}),
    }).toString();
    // Keep Meldiq's Supabase PKCE challenge server-side. Otherwise a client could initiate another
    // provider with that public challenge and select a stale auto-linked identity from /user.
    let response: Response;
    try {
      response = await this.request(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(
        503,
        "provider_unavailable",
        "Can't reach the sign-in provider. Try again.",
      );
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (![302, 303].includes(response.status) || !location) throw invalid();
    const destination = new URL(location);
    const hosts =
      provider === "google"
        ? ["accounts.google.com"]
        : provider === "apple"
          ? ["appleid.apple.com", "account.apple.com"]
          : ["discord.com"];
    if (
      destination.protocol !== "https:" ||
      destination.username ||
      destination.password ||
      !hosts.includes(destination.hostname) ||
      destination.searchParams.get("code_challenge") === challenge
    )
      throw invalid();
    return destination.href;
  }
  private async json(
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.request(`${this.config.url}/auth/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          apikey: this.config.publishableKey,
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      throw new ApiError(
        503,
        "provider_unavailable",
        "Can't reach the sign-in provider. Try again.",
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw invalid();
    }
    return res.json();
  }
  async exchange(
    code: string,
    verifier: string,
    provider: SocialProvider,
  ): Promise<ExternalIdentity> {
    return this.verify(
      await this.json("token?grant_type=pkce", {
        auth_code: code,
        code_verifier: verifier,
      }),
      provider,
    );
  }
  async nativeGoogle(
    idToken: string,
    nonce: string,
  ): Promise<ExternalIdentity> {
    if (!this.config.googleClientId) throw invalid();
    let googleSubject = "";
    try {
      const { payload } = await jwtVerify(idToken, this.googleKeys, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: this.config.googleClientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
        maxTokenAge: "5 minutes",
        clockTolerance: 5,
      });
      googleSubject = payload.sub ?? "";
      if (
        payload.nonce !==
        crypto.createHash("sha256").update(nonce).digest("hex")
      )
        throw invalid();
    } catch {
      throw invalid();
    }
    // Supabase independently verifies the Google ID token and nonce too.
    const identity = await this.verify(
      await this.json("token?grant_type=id_token", {
        provider: "google",
        id_token: idToken,
        nonce,
      }),
      "google",
    );
    if (identity.subject !== googleSubject) throw invalid();
    return identity;
  }
  async verify(
    answer: unknown,
    provider: SocialProvider,
  ): Promise<ExternalIdentity> {
    const a = z
      .object({ access_token: z.string().max(16384) })
      .safeParse(answer);
    if (!a.success) throw invalid();
    let claims;
    try {
      claims = (
        await jwtVerify(a.data.access_token, this.keys, {
          issuer: `${this.config.url}/auth/v1`,
          audience: "authenticated",
          algorithms: ["ES256", "RS256"],
          requiredClaims: ["sub", "exp", "iat", "session_id"],
          maxTokenAge: "2 minutes",
          clockTolerance: 5,
        })
      ).payload;
    } catch {
      throw invalid();
    }
    if (
      claims.role !== "authenticated" ||
      typeof claims.session_id !== "string"
    )
      throw invalid();
    const u = userSchema.safeParse(
      await this.json("user", undefined, a.data.access_token),
    );
    // Select the provider used by THIS server-controlled exchange, never an arbitrary auto-linked identity.
    if (!u.success || u.data.id !== claims.sub) throw invalid();
    const matches = u.data.identities.filter((i) => i.provider === provider);
    if (matches.length !== 1) throw invalid();
    const d = matches[0].identity_data;
    const email =
      d.email && (d.email_verified === true || d.email_verified === "true")
        ? d.email.trim().toLowerCase()
        : null;
    return {
      provider,
      issuer:
        provider === "google"
          ? "https://accounts.google.com"
          : provider === "apple"
            ? "https://appleid.apple.com"
            : "https://discord.com",
      subject: d.sub,
      email,
    };
  }
}
