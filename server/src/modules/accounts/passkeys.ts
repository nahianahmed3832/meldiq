import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AppContext } from "../../app/context.js";
import type { Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { PasskeyLoginBody, PasskeyRegisterBody } from "../../shared/contracts/http/accounts.js";
import type { PasskeyConfig } from "./config.js";
import type { AccountService, SessionResponse } from "./service.js";
import type { ActiveSession } from "./store.js";

/** How long the platform's passkey prompt may take before the challenge expires. */
const CEREMONY_MS = 5 * 60_000;
/** Passkeys one account may have (a phone, a computer, a security key or two). */
export const MAX_PASSKEYS = 10;
const RP_NAME = "Meldiq";
/** ES256 and RS256: what phones, computers and security keys use. */
const ALGORITHMS = [-7, -257];

interface PasskeyRow {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Synced across the person's devices by their password manager (Google, iCloud…), not tied to one device. */
  synced: boolean;
}

const view = (r: PasskeyRow): PasskeyView => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, synced: r.backed_up === 1 });

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** "android:apk-key-hash:…": the origin an Android app signed with [certSha256] (AA:BB:… hex) reports in WebAuthn. */
export function androidOrigin(certSha256: string): string {
  return "android:apk-key-hash:" + b64url(Buffer.from(certSha256.replace(/:/g, ""), "hex"));
}

/**
 * Passkeys (2026-10-23, docs/PASSKEYS.md): WebAuthn credentials that sign in to an account instead of its password.
 * Adding one needs a signed-in session; signing in with one gives the same session a password sign-in gives, after the
 * same checks (account disabled, email verified, device proof). User verification (the phone's lock) is always
 * required and attestation is not asked for. A passkey never unlocks encrypted history: that stays with the device keys.
 */
export class PasskeyService {
  constructor(
    private readonly ctx: AppContext,
    private readonly accounts: AccountService,
  ) {}

  private get rows(): Rows {
    return this.ctx.safety;
  }

  private get cfg(): PasskeyConfig {
    return this.ctx.config.accounts.passkeys;
  }

  get available(): boolean {
    return this.cfg.rpId !== null;
  }

  /** The web apps on other hosts that may use passkeys (each its own relying party), for server-info. */
  get webOrigins(): string[] {
    return this.available ? this.cfg.webOrigins : [];
  }

  /**
   * Each relying party and the origins it accepts: this server's host with its own web origin and the Android apps, and
   * one per web app on another host (web.meldiq.app) with that origin only. A passkey belongs to the one it was made for.
   */
  private relyingParties(): Map<string, string[]> {
    const id = this.cfg.rpId;
    if (!id) throw new ApiError(503, "passkey_unavailable", "Passkeys aren't set up on this server.");
    const parties = new Map([[id, [`https://${id}`, ...this.cfg.androidApps.map((a) => androidOrigin(a.certSha256))]]]);
    for (const origin of this.cfg.webOrigins) {
      const host = new URL(origin).hostname;
      parties.set(host, [...(parties.get(host) ?? []), origin]);
    }
    return parties;
  }

  /** The relying party a client asks for ([requested]: its own host, for a web app), else this server's. */
  private rpId(requested?: string): string {
    const parties = this.relyingParties();
    const id = requested ?? this.cfg.rpId!;
    if (!parties.has(id)) throw new ApiError(503, "passkey_unavailable", "Passkeys aren't set up for this address.");
    return id;
  }

  /** What a verification accepts: any relying party with any of its origins (checked as a pair by [checkPair]). */
  private expected(): { expectedRPID: string[]; expectedOrigin: string[] } {
    const parties = this.relyingParties();
    return { expectedRPID: [...parties.keys()], expectedOrigin: [...parties.values()].flat() };
  }

  /** A passkey made for one relying party, answered from another one's origin, is refused. */
  private checkPair(rpId: string | undefined, origin: string): boolean {
    return rpId !== undefined && (this.relyingParties().get(rpId) ?? []).includes(origin);
  }

  /** Digital Asset Links for /.well-known/assetlinks.json: the apps that may use this server's passkeys. */
  assetLinks() {
    const byPackage = new Map<string, string[]>();
    for (const a of this.cfg.androidApps) byPackage.set(a.packageName, [...(byPackage.get(a.packageName) ?? []), a.certSha256]);
    return [...byPackage].map(([package_name, sha256_cert_fingerprints]) => ({
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: { namespace: "android_app" as const, package_name, sha256_cert_fingerprints },
    }));
  }

  list(accountId: string): { available: boolean; passkeys: PasskeyView[] } {
    const rows = this.rows.all<PasskeyRow>("account_passkeys", { where: { account_id: accountId }, orderBy: [["created_at", "asc"]] });
    return { available: this.available, passkeys: rows.map(view) };
  }

  private count(accountId: string): number {
    return this.rows.count("account_passkeys", { account_id: accountId });
  }

  private async saveChallenge(purpose: "register" | "login", accountId: string | null, challenge: string): Promise<string> {
    const id = randomBytes(18).toString("base64url");
    const t = now();
    await this.rows.write((w) => {
      w.delete("account_passkey_challenges", { expires_at: { lte: t } });
      w.insert("account_passkey_challenges", { id, purpose, account_id: accountId, challenge, created_at: t, expires_at: t + CEREMONY_MS });
    });
    return id;
  }

  /** The challenge of ceremony [id] for [purpose] (and [accountId] when adding), used up whether or not it then verifies. */
  private async takeChallenge(id: string, purpose: "register" | "login", accountId: string | null): Promise<string> {
    const row = await this.rows.write((w) => {
      const r = w.get<{ purpose: string; account_id: string | null; challenge: string; expires_at: number }>("account_passkey_challenges", { id });
      if (r) w.delete("account_passkey_challenges", { id });
      return r;
    });
    if (!row || row.purpose !== purpose || row.account_id !== accountId || row.expires_at <= now()) {
      throw new ApiError(401, "challenge_expired", "That took too long. Try again.");
    }
    return row.challenge;
  }

  // ───────────── Adding a passkey ─────────────

  async registrationOptions(s: ActiveSession, rpId?: string) {
    const rpID = this.rpId(rpId);
    const account = (await this.accounts.store.accountById(s.account_id))!;
    if (this.count(account.id) >= MAX_PASSKEYS) throw new ApiError(409, "passkey_limit", "This account already has as many passkeys as it can. Remove one first.");
    const existing = this.rows.all<{ id: string; transports: string | null }>("account_passkeys", { where: { account_id: account.id } });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      // An opaque handle, not the email: the platform stores it with the passkey.
      userID: createHash("sha256").update(`meldiq-passkey:${account.id}`).digest(),
      userName: account.email,
      userDisplayName: account.name,
      attestationType: "none",
      excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ? (JSON.parse(e.transports) as AuthenticatorTransport[]) : undefined })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
      timeout: CEREMONY_MS,
    });
    return { challengeId: await this.saveChallenge("register", account.id, options.challenge), options: options as unknown as Record<string, unknown> };
  }

  async register(s: ActiveSession, body: PasskeyRegisterBody): Promise<{ passkey: PasskeyView }> {
    const expected = this.expected();
    const expectedChallenge = await this.takeChallenge(body.challengeId, "register", s.account_id);
    if (this.count(s.account_id) >= MAX_PASSKEYS) throw new ApiError(409, "passkey_limit", "This account already has as many passkeys as it can. Remove one first.");
    const result = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge,
      ...expected,
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!result.verified || !this.checkPair(result.registrationInfo.rpID, result.registrationInfo.origin)) {
      throw new ApiError(401, "passkey_failed", "That passkey couldn't be verified. Try again.");
    }
    const { credential, credentialBackedUp } = result.registrationInfo;
    if (this.rows.get("account_passkeys", { id: credential.id })) {
      throw new ApiError(401, "passkey_failed", "That passkey is already registered.");
    }
    const t = now();
    const row: PasskeyRow = {
      id: credential.id,
      account_id: s.account_id,
      public_key: b64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports?.length ? JSON.stringify(credential.transports) : null,
      name: body.name?.trim() || "Passkey",
      backed_up: credentialBackedUp ? 1 : 0,
      created_at: t,
      last_used_at: null,
    };
    try {
      await this.rows.write((w) => w.insert("account_passkeys", { ...row }));
    } catch (e) {
      // The same passkey registered twice at once: one of them wins.
      if (String(e).includes("UNIQUE")) throw new ApiError(401, "passkey_failed", "That passkey is already registered.");
      throw e;
    }
    this.ctx.audit({ actorId: s.user_id, action: "account.passkey_added", target: s.account_id });
    return { passkey: view(row) };
  }

  async remove(s: ActiveSession, id: string): Promise<{ ok: true }> {
    const removed = await this.rows.write((w) => w.delete("account_passkeys", { id, account_id: s.account_id }));
    if (removed === 0) throw notFound("No such passkey");
    this.ctx.audit({ actorId: s.user_id, action: "account.passkey_removed", target: s.account_id });
    return { ok: true };
  }

  /** Account deletion: its passkeys go too (no foreign key, see migration 045). */
  removeAll(accountId: string): Promise<void> {
    return this.rows.write((w) => {
      w.delete("account_passkeys", { account_id: accountId });
      w.delete("account_passkey_challenges", { account_id: accountId });
    });
  }

  // ───────────── Signing in ─────────────

  async loginOptions(rpId?: string) {
    const rpID = this.rpId(rpId);
    // Discoverable passkeys: the platform offers whichever of the person's passkeys it holds for this server.
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [], timeout: CEREMONY_MS });
    return { challengeId: await this.saveChallenge("login", null, options.challenge), options: options as unknown as Record<string, unknown> };
  }

  async login(body: PasskeyLoginBody, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<SessionResponse> {
    const expected = this.expected();
    const expectedChallenge = await this.takeChallenge(body.challengeId, "login", null);
    const row = this.rows.get<PasskeyRow>("account_passkeys", { id: body.response.id });
    if (!row) throw new ApiError(401, "passkey_unknown", "This passkey isn't registered here. Sign in with your password and add it again.");
    const result = await verifyAuthenticationResponse({
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      ...expected,
      credential: {
        id: row.id,
        publicKey: Buffer.from(row.public_key, "base64url"),
        counter: row.counter,
        transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransport[]) : undefined,
      },
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!result.verified || !this.checkPair(result.authenticationInfo.rpID, result.authenticationInfo.origin)) {
      throw new ApiError(401, "passkey_failed", "That passkey couldn't be verified. Try again, or sign in with your password.");
    }
    const info = result.authenticationInfo;
    await this.rows.write((w) => w.update("account_passkeys", { id: row.id }, { counter: info.newCounter, backed_up: info.credentialBackedUp ? 1 : 0, last_used_at: now() }));
    return this.accounts.loginWithPasskey(row.account_id, body, ip, reply);
  }
}
