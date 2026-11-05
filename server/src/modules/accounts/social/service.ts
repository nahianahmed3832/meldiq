import crypto from "node:crypto";
import type { AppContext } from "../../../app/context.js";
import { ApiError, unauthorized } from "../../../shared/errors.js";
import type { RegistrationAttestation } from "../../../shared/contracts/http/registrationPolicy.js";
import { newId } from "../../../shared/utilities/util.js";
import { sessionProblem } from "../sessions.js";
import { requireSignupAttestation } from "../registrationPolicy.js";
import type { AccountRow, ActiveSession } from "../store.js";
import type { SocialConfig, SocialProvider } from "./config.js";
import {
  SocialStore,
  type ExternalIdentity,
  type SocialFlow,
} from "./store.js";
import { SupabaseIdentity } from "./supabase.js";
import { displayName } from "./profile.js";

export const secret = () => crypto.randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("base64url");
const expired = () =>
  new ApiError(
    400,
    "social_flow_expired",
    "This sign-in expired or was already used. Start again.",
  );
const collision = () =>
  new ApiError(
    409,
    "account_link_required",
    "Sign in with your existing Meldiq login, then connect this provider in Settings > Account > Connected Accounts.",
  );
export interface CompleteSocial {
  id: string;
  verifier: string;
  receipt: string;
  name?: string;
  inviteCode?: string;
  deviceName?: string;
  totpCode?: string;
  device?: { deviceId: string; nonce: string; signature: string };
  policyAcceptance?: RegistrationAttestation;
}
export class SocialAuth {
  readonly store: SocialStore;
  readonly provider: SupabaseIdentity | null;
  constructor(
    private readonly ctx: AppContext,
    readonly config: SocialConfig | null,
    provider?: SupabaseIdentity,
  ) {
    this.store = new SocialStore(ctx);
    this.provider = provider ?? (config ? new SupabaseIdentity(config) : null);
  }
  requireProvider(p: SocialProvider): SupabaseIdentity {
    if (!this.provider || !this.config?.providers.includes(p))
      throw new ApiError(
        503,
        "provider_not_configured",
        "This sign-in method isn't available on this server yet. Continue with email.",
      );
    return this.provider;
  }
  async fresh(
    s: ActiveSession,
    password: string | undefined,
    totpCode: string | undefined,
    ip: string,
    reply: { header: (k: string, v: string) => unknown },
  ): Promise<AccountRow> {
    const current = await this.ctx.accounts.store.sessionById(s.id);
    if (!current || sessionProblem(current, Date.now())) throw unauthorized();
    const a = await this.ctx.accounts.store.accountById(s.account_id);
    if (!a) throw unauthorized();
    if (password)
      await this.ctx.accounts.service.checkPassword(a, password, ip, reply);
    else if (Date.now() - s.created_at > 5 * 60_000)
      throw new ApiError(
        403,
        "fresh_auth_required",
        "Confirm your password or sign in again before changing connected accounts.",
      );
    await this.ctx.accounts.service.secondFactor?.(a.id, totpCode);
    return a;
  }
  async start(
    body: {
      provider: SocialProvider;
      challenge: string;
      platform: "web" | "android";
      mode: "login" | "link";
      password?: string;
      totpCode?: string;
    },
    s: ActiveSession | null,
    ip: string,
    reply: { header: (k: string, v: string) => unknown },
  ) {
    this.requireProvider(body.provider);
    if (body.mode === "link") {
      if (!s) throw unauthorized();
      await this.fresh(s, body.password, body.totpCode, ip, reply);
    }
    const f: SocialFlow = {
      id: secret(),
      provider: body.provider,
      challenge: body.challenge,
      verifier: secret(),
      cookie: secret(),
      nonce: secret(),
      accountId: body.mode === "link" ? s!.account_id : null,
      sessionId: body.mode === "link" ? s!.id : null,
      platform: body.platform,
      stage: "pending",
      expiresAt: Date.now() + 10 * 60_000,
    };
    await this.store.insertFlow(f);
    return {
      id: f.id,
      authorizeUrl: `${this.config!.publicOrigin}/v2/auth/social/authorize/${f.id}`,
      nonce: crypto.createHash("sha256").update(f.nonce).digest("hex"),
      expiresAt: f.expiresAt,
    };
  }
  async flow(id: string): Promise<SocialFlow> {
    const f = await this.store.flow(id);
    if (!f || f.expiresAt <= Date.now() || f.stage === "used") throw expired();
    return f;
  }
  async authorize(id: string) {
    const f = await this.flow(id);
    if (
      f.stage !== "pending" ||
      !(await this.store.replace({ ...f, stage: "authorizing" }, "pending"))
    )
      throw expired();
    return {
      flow: f,
      url: await this.requireProvider(f.provider).authorize(
        f.provider,
        digest(f.verifier),
      ),
    };
  }
  async callback(id: string, cookie: string, code: string) {
    const f = await this.flow(id);
    if (digest(cookie) !== digest(f.cookie) || f.stage !== "authorizing")
      throw expired();
    if (
      !(await this.store.replace({ ...f, stage: "exchanging" }, "authorizing"))
    )
      throw expired();
    const identity = await this.requireProvider(f.provider).exchange(
      code,
      f.verifier,
      f.provider,
    );
    return this.ready({ ...f, stage: "exchanging" }, identity);
  }
  async native(id: string, verifier: string, idToken: string) {
    const f = await this.flow(id);
    if (
      f.platform !== "android" ||
      f.provider !== "google" ||
      f.stage !== "pending" ||
      digest(verifier) !== f.challenge
    )
      throw expired();
    if (!(await this.store.replace({ ...f, stage: "exchanging" }, "pending")))
      throw expired();
    return this.ready(
      { ...f, stage: "exchanging" },
      await this.requireProvider("google").nativeGoogle(idToken, f.nonce),
    );
  }
  private async ready(f: SocialFlow, identity: ExternalIdentity) {
    const receipt = secret();
    if (
      !(await this.store.replace(
        {
          ...f,
          stage: "ready",
          verifier: "",
          cookie: "",
          nonce: "",
          receiptHash: digest(receipt),
          identity,
        },
        "exchanging",
      ))
    )
      throw expired();
    return { id: f.id, receipt, platform: f.platform };
  }
  async complete(
    body: CompleteSocial,
    s: ActiveSession | null,
    ip: string,
    reply: { header: (k: string, v: string) => unknown },
  ) {
    const f = await this.flow(body.id);
    if (
      f.stage !== "ready" ||
      digest(body.verifier) !== f.challenge ||
      digest(body.receipt) !== f.receiptHash ||
      !f.identity
    )
      throw expired();
    // The SAME live session must finish an explicit link. Expired/revoked/account-switched sessions cannot link.
    if (
      f.accountId &&
      (!s || s.account_id !== f.accountId || s.id !== f.sessionId)
    )
      throw unauthorized();
    // For a new provider account, a missing or stale review must not spend the verified receipt.
    if (this.ctx.config.signupPolicy && !f.accountId && !(await this.store.find(f.identity))) {
      requireSignupAttestation(this.ctx.config.signupPolicy, body.policyAcceptance);
    }
    return this.ctx.accounts.store.transaction(async () => {
      if (
        !(await this.store.replace(
          { ...f, stage: "used", identity: undefined, receiptHash: undefined },
          "ready",
        ))
      )
        throw expired();
      const existing = await this.store.find(f.identity!);
      if (f.accountId) {
        const live = await this.ctx.accounts.store.sessionById(s!.id);
        if (!live || sessionProblem(live, Date.now())) throw unauthorized();
        // A write serializes simultaneous provider mutations on this account in a MongoDB transaction.
        const owner = (await this.ctx.accounts.store.accountById(f.accountId))!;
        await this.ctx.accounts.store.updateAccount(
          f.accountId,
          { name: owner.name },
          Math.max(Date.now(), owner.updated_at + 1),
        );
        if (existing && existing.account_id !== f.accountId)
          throw new ApiError(
            409,
            "identity_conflict",
            "This identity belongs to another Meldiq account. Sign in to that account or recover it. Nothing was merged.",
          );
        if (!existing)
          await this.store.link({
            ...f.identity!,
            id: newId("si"),
            account_id: f.accountId,
            connected_at: Date.now(),
          });
        this.ctx.audit({
          actorId: s!.user_id,
          action: "account.provider_linked",
          target: f.accountId,
          detail: f.provider,
        });
        return { linked: true as const };
      }
      let account = existing
        ? await this.ctx.accounts.store.accountById(existing.account_id)
        : undefined;
      if (existing && !account) throw expired(); // deleted account's mapping never creates a new account
      if (!account) {
        if (!f.identity!.email)
          throw new ApiError(
            400,
            "provider_email_required",
            "The provider didn't supply a verified email. Use email sign-up, then connect this provider from Settings.",
          );
        if (await this.ctx.accounts.store.accountByEmail(f.identity!.email))
          throw collision();
        account = await this.ctx.accounts.service.registerExternal(
          {
            email: f.identity!.email,
            name:
              displayName(body.name) ??
              displayName(f.identity!.displayName) ??
              "Meldiq member",
            inviteCode: body.inviteCode,
            provider: f.provider,
            policyAcceptance: body.policyAcceptance,
          },
          ip,
          reply,
        );
        await this.store.link({
          ...f.identity!,
          id: newId("si"),
          account_id: account.id,
          connected_at: Date.now(),
        });
      }
      return {
        grant: await this.ctx.accounts.service.loginWithExternal(
          account,
          body,
          f.provider,
        ),
      };
    });
  }
  async list(s: ActiveSession) {
    const a = await this.ctx.accounts.store.accountById(s.account_id);
    return {
      password: !!a?.password_hash.startsWith("scrypt$"),
      identities: (await this.store.list(s.account_id)).map((i) => ({
        provider: i.provider,
        email: i.email,
        connectedAt: i.connected_at,
      })),
      providers: this.config?.providers ?? [],
    };
  }
  async disconnect(
    s: ActiveSession,
    p: SocialProvider,
    password: string | undefined,
    code: string | undefined,
    ip: string,
    reply: { header: (k: string, v: string) => unknown },
  ) {
    await this.fresh(s, password, code, ip, reply);
    await this.ctx.accounts.store.transaction(async () => {
      const a = (await this.ctx.accounts.store.accountById(s.account_id))!;
      await this.ctx.accounts.store.updateAccount(
        a.id,
        { name: a.name },
        Math.max(Date.now(), a.updated_at + 1),
      );
      const identities = await this.store.list(a.id);
      if (!identities.some((i) => i.provider === p)) return;
      if (!a.password_hash.startsWith("scrypt$") && identities.length < 2)
        throw new ApiError(
          409,
          "last_login_method",
          "Connect another provider or set a password using Forgot password before disconnecting your only login method.",
        );
      await this.store.unlink(a.id, p);
      await this.ctx.accounts.service.revokeSessions(
        a.id,
        "provider_disconnected",
        s.id,
      );
      this.ctx.audit({
        actorId: s.user_id,
        action: "account.provider_disconnected",
        target: a.id,
        detail: p,
      });
    });
    return { ok: true };
  }
}
