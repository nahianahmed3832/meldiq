import crypto from "node:crypto";
import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { SecretBox } from "../../infrastructure/crypto/secretBox.js";
import { type DocumentStore, openDocuments } from "../../infrastructure/database/documents.js";
import type { ConnectionEntry, LinkedItem, LinkedItemsKind, ProfileConnection } from "../../shared/contracts/http/linkedAccounts.js";
import { ApiError } from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";
import { LINKED_PROVIDERS, type LinkedProvider } from "./config.js";
import { Outbound, ProviderError } from "./outbound.js";
import { ConnectDenied, configuredProviders, type Provider, type PublicProfile, type Tokens } from "./providers.js";
import { pkcePair, STATE_TTL_MS, StateSigner } from "./state.js";

/** Public data older than this is fetched again when a profile is read (never while the reader waits). */
export const REFRESH_AFTER_MS = 6 * 3600_000;

/** One person's account at one provider ("<userId>|<provider>"). */
export interface LinkedAccount {
  id: string;
  userId: string;
  provider: LinkedProvider;
  externalId: string;
  name: string;
  url: string;
  itemsKind: LinkedItemsKind;
  items: LinkedItem[];
  visible: boolean;
  /** The provider's tokens as JSON, sealed with PLATFORM_SECRETS_KEY; null without the key, or when there are none (Steam). */
  tokens: string | null;
  connectedAt: number;
  /** When the public data was last fetched. */
  updatedAt: number;
  /** When it was last tried (successful or not): a failing provider is tried again only after REFRESH_AFTER_MS. */
  checkedAt: number;
}

/** A started connection, waiting for the browser to come back (keyed by the hash of its nonce, used once). */
export interface PendingStart {
  id: string;
  userId: string;
  provider: LinkedProvider;
  verifier: string;
  expiresAt: number;
}

export type CallbackError = "state" | "denied" | "failed" | "unavailable";

const accountId = (userId: string, provider: LinkedProvider) => `${userId}|${provider}`;
const sealedFor = (userId: string, provider: LinkedProvider) => `linked:${userId}:${provider}`;

/**
 * Linked accounts (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one
 * (`linked_accounts`, `linked_account_starts`), memory otherwise.
 */
export class LinkedAccountsService {
  private readonly providers: Map<LinkedProvider, Provider>;
  private readonly signer: StateSigner;
  private readonly box: SecretBox;
  /** Refreshes running now, so a busy profile starts one per account at a time. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: AppContext,
    readonly accounts: DocumentStore<LinkedAccount>,
    readonly starts: DocumentStore<PendingStart>,
    outbound = new Outbound(ctx.log),
  ) {
    const cfg = ctx.config.linkedAccounts;
    this.providers = cfg.apiBase && cfg.returnUrl ? configuredProviders(cfg, outbound) : new Map();
    this.signer = new StateSigner(ctx.config.platformSecretsKey);
    this.box = new SecretBox(ctx.config.platformSecretsKey);
  }

  static async open(ctx: AppContext): Promise<LinkedAccountsService> {
    const accounts = await openDocuments<LinkedAccount>(ctx.mongo, "linked_accounts", [{ name: "user_id", keys: { user_id: 1 } }]);
    const starts = await openDocuments<PendingStart>(ctx.mongo, "linked_account_starts", [{ name: "expires_at", keys: { expires_at: 1 } }]);
    return new LinkedAccountsService(ctx, accounts, starts);
  }

  available(provider: LinkedProvider): boolean {
    return this.providers.has(provider);
  }

  private callback(provider: LinkedProvider): string {
    return `${this.ctx.config.linkedAccounts.apiBase}/v2/connections/${provider}/callback`;
  }

  /** Where the browser lands after a callback. */
  returnTo(result: { connected: LinkedProvider } | { error: CallbackError; provider: string }): string {
    const base = this.ctx.config.linkedAccounts.returnUrl ?? "/";
    const q: Record<string, string> = "connected" in result ? { connected: result.connected } : { connectionError: result.error, provider: result.provider };
    return `${base}?${new URLSearchParams(q).toString()}`;
  }

  profileOf(a: LinkedAccount): z.infer<typeof ProfileConnection> {
    return { provider: a.provider, name: a.name, url: a.url, itemsKind: a.itemsKind, items: a.items, updatedAt: a.updatedAt };
  }

  entry(provider: LinkedProvider, a: LinkedAccount | null): z.infer<typeof ConnectionEntry> {
    return { provider, available: this.available(provider), connected: !!a, visible: a?.visible ?? false, account: a ? this.profileOf(a) : null, connectedAt: a?.connectedAt ?? null };
  }

  async list(userId: string) {
    const mine = await this.accounts.find({ userId });
    this.refreshStale(mine);
    return { connections: LINKED_PROVIDERS.map((p) => this.entry(p, mine.find((a) => a.provider === p) ?? null)) };
  }

  /** The provider's sign-in page for [userId], with a signed state that works once within 10 minutes. */
  async start(userId: string, provider: LinkedProvider): Promise<string> {
    const p = this.providers.get(provider);
    if (!p) throw new ApiError(409, "connection_unavailable", "Connecting that service isn't set up on this server yet.");
    const t = now();
    await this.starts.deleteBelow("expiresAt", t);
    const nonce = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = pkcePair();
    const expiresAt = t + STATE_TTL_MS;
    await this.starts.insert({ id: sha256Hex(nonce), userId, provider, verifier, expiresAt });
    return p.authorizeUrl(this.callback(provider), this.signer.sign({ userId, provider, nonce, expiresAt }), challenge);
  }

  /** Finishes a connection from the provider's redirect; where to send the browser next. Never throws. */
  async finish(provider: LinkedProvider, query: Record<string, string>): Promise<string> {
    const p = this.providers.get(provider);
    if (!p) return this.returnTo({ error: "unavailable", provider });
    const t = now();
    const state = this.signer.verify(query.state ?? "", provider, t);
    // Single use and this server's own: the nonce must match a start recorded for the same person and provider.
    const pending = state ? await this.starts.take(sha256Hex(state.nonce), { userId: state.userId, provider }) : null;
    if (!state || !pending || pending.expiresAt <= t) return this.returnTo({ error: "state", provider });
    try {
      const { profile, tokens } = await p.finish({ query, callback: this.callback(provider), verifier: pending.verifier });
      await this.store(state.userId, provider, profile, tokens, t);
      this.ctx.audit({ actorId: state.userId, action: "linked_account.connect", detail: provider });
      return this.returnTo({ connected: provider });
    } catch (err) {
      if (err instanceof ConnectDenied) return this.returnTo({ error: "denied", provider });
      if (!(err instanceof ProviderError)) this.ctx.log.error({ err, provider }, "linked accounts: connecting failed");
      return this.returnTo({ error: "failed", provider });
    }
  }

  private async store(userId: string, provider: LinkedProvider, profile: PublicProfile, tokens: Tokens | null, t: number): Promise<void> {
    const before = await this.accounts.get(accountId(userId, provider));
    const sealed = tokens && this.box.available ? this.box.seal(JSON.stringify(tokens), sealedFor(userId, provider)) : null;
    await this.accounts.put({
      id: accountId(userId, provider),
      userId,
      provider,
      ...profile,
      visible: before?.visible ?? true,
      tokens: sealed,
      connectedAt: before && before.externalId === profile.externalId ? before.connectedAt : t,
      updatedAt: t,
      checkedAt: t,
    });
  }

  async setVisible(userId: string, provider: LinkedProvider, visible: boolean) {
    const a = await this.accounts.update(accountId(userId, provider), {}, { visible });
    if (!a) throw new ApiError(404, "not_found", "That service isn't connected.");
    return { connection: this.entry(provider, a) };
  }

  async disconnect(userId: string, provider: LinkedProvider) {
    const a = await this.accounts.take(accountId(userId, provider));
    if (a) {
      this.revoke(a);
      this.ctx.audit({ actorId: userId, action: "linked_account.disconnect", detail: provider });
    }
    return { connection: this.entry(provider, null) };
  }

  /** Best effort, in the background: the provider forgets the tokens too (when it can be asked and we kept them). */
  private revoke(a: LinkedAccount): void {
    const p = this.providers.get(a.provider);
    if (!p?.revoke || !a.tokens || !this.box.available) return;
    let tokens: Tokens;
    try {
      tokens = JSON.parse(this.box.open(a.tokens, sealedFor(a.userId, a.provider))) as Tokens;
    } catch (err) {
      this.ctx.log.warn({ err, provider: a.provider }, "linked accounts: stored tokens couldn't be opened");
      return;
    }
    p.revoke(tokens).catch(() => undefined);
  }

  /**
   * What [viewerId] sees of [userId]'s linked accounts on a profile: the visible ones, none for someone they blocked.
   * Stale data is refreshed in the background; what's stored is served now.
   */
  async profileField(userId: string, blockedByTarget: boolean): Promise<{ connections?: z.infer<typeof ProfileConnection>[] }> {
    if (blockedByTarget) return {};
    try {
      const mine = await this.accounts.find({ userId });
      this.refreshStale(mine);
      const shown = mine.filter((a) => a.visible).sort((a, b) => LINKED_PROVIDERS.indexOf(a.provider) - LINKED_PROVIDERS.indexOf(b.provider));
      return shown.length ? { connections: shown.map((a) => this.profileOf(a)) } : {};
    } catch (err) {
      this.ctx.log.warn({ err }, "linked accounts: not read for a profile");
      return {};
    }
  }

  private refreshStale(accounts: readonly LinkedAccount[]): void {
    const t = now();
    for (const a of accounts) {
      if (t - a.checkedAt < REFRESH_AFTER_MS || this.refreshing.has(a.id)) continue;
      const p = this.providers.get(a.provider);
      if (!p) continue;
      const run = this.refreshOne(p, a, t).finally(() => this.refreshing.delete(a.id));
      this.refreshing.set(a.id, run);
    }
  }

  private async refreshOne(p: Provider, a: LinkedAccount, t: number): Promise<void> {
    try {
      // Marked first, so a failing provider isn't asked again on every read.
      if (!(await this.accounts.update(a.id, { checkedAt: a.checkedAt }, { checkedAt: t }))) return;
      const fresh = await p.refresh({ externalId: a.externalId, name: a.name });
      await this.accounts.update(a.id, { externalId: a.externalId }, { name: fresh.name, url: fresh.url, itemsKind: fresh.itemsKind, items: fresh.items, updatedAt: now() });
    } catch (err) {
      if (!(err instanceof ProviderError)) this.ctx.log.warn({ err, provider: a.provider }, "linked accounts: refresh failed");
    }
  }

  /** Resolves once the refreshes running now are done (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.refreshing.values()]);
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const a of await this.accounts.find({ userId })) this.revoke(a);
    await this.accounts.deleteMany({ userId });
    await this.starts.deleteMany({ userId });
  }
}
