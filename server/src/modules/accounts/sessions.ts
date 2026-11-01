import crypto from "node:crypto";
import { ApiError } from "../../shared/errors.js";
import { newId, sha256Hex } from "../../shared/utilities/util.js";
import type { AccountsConfig } from "./config.js";
import type { AccountStore, ActiveSession, SessionRotation, SessionRow } from "./store.js";

const TOKEN_BYTES = 32;
/** Refreshes that lost the race to rotate one session, retried before giving up (a few at most in practice). */
const MAX_ROTATION_RACES = 5;
/** A refresh token replaced this recently is a retry (a lost answer, or a race), not a stolen copy. */
const REFRESH_RACE_MS = 30_000;

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  session: SessionRow;
}

export type SessionEnd = "session_expired" | "session_revoked" | "account_disabled";

const END_MESSAGES: Record<SessionEnd, string> = {
  session_expired: "Your session has ended. Sign in again.",
  session_revoked: "You were signed out on this device. Sign in again.",
  account_disabled: "This account is disabled.",
};

export const sessionEnded = (why: SessionEnd) => new ApiError(401, why, END_MESSAGES[why]);

const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");
/** "<session id>.<secret>": the session is found by its id, the secret is compared by hash. */
const refreshTokenFor = (sessionId: string) => `${sessionId}.${newToken()}`;
const sessionIdOf = (refreshToken: string): string | null => {
  const dot = refreshToken.indexOf(".");
  return dot > 0 ? refreshToken.slice(0, dot) : null;
};

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const ANSWER_KEY_INFO = "meldiq refresh answer v1";
const ANSWER_KEY_BYTES = 32;
const ANSWER_IV_BYTES = 12;
const ANSWER_TAG_BYTES = 16;

/** Only a holder of [refreshToken] can make this key: the stored hash is a different function of the token. */
const answerKey = (refreshToken: string) =>
  Buffer.from(crypto.hkdfSync("sha256", refreshToken, Buffer.alloc(0), ANSWER_KEY_INFO, ANSWER_KEY_BYTES));

/** [pair] sealed (AES-256-GCM, bound to the session) with a key from the refresh token it replaces. */
function sealAnswer(replaced: string, sessionId: string, pair: TokenPair): string {
  const iv = crypto.randomBytes(ANSWER_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", answerKey(replaced), iv);
  cipher.setAAD(Buffer.from(sessionId));
  const body = Buffer.concat([cipher.update(JSON.stringify(pair), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The pair [sealAnswer] sealed with [replaced], or null when there is none or it doesn't open with that token. */
function openAnswer(sealed: string | null, replaced: string, sessionId: string): TokenPair | null {
  if (!sealed) return null;
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= ANSWER_IV_BYTES + ANSWER_TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", answerKey(replaced), bytes.subarray(0, ANSWER_IV_BYTES));
    decipher.setAAD(Buffer.from(sessionId));
    decipher.setAuthTag(bytes.subarray(bytes.length - ANSWER_TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(ANSWER_IV_BYTES, bytes.length - ANSWER_TAG_BYTES)), decipher.final()]);
    const pair = JSON.parse(plain.toString("utf8")) as Partial<TokenPair>;
    return typeof pair.accessToken === "string" && typeof pair.refreshToken === "string"
      ? { accessToken: pair.accessToken, refreshToken: pair.refreshToken }
      : null;
  } catch {
    // Tampered with, or sealed with another token: the caller rotates instead, as it does when nothing was kept.
    return null;
  }
}

/** The session's current pair for [replaced], the token its last swap replaced, if that swap's answer was kept. */
function answerAgain(s: ActiveSession, replaced: string): IssuedSession | null {
  const pair = openAnswer(s.previous_refresh_answer, replaced, s.id);
  if (!pair || sha256Hex(pair.refreshToken) !== s.refresh_hash || sha256Hex(pair.accessToken) !== s.access_hash) return null;
  return { ...pair, accessTokenExpiresAt: s.access_expires_at, refreshTokenExpiresAt: s.refresh_expires_at, session: s };
}

/** Why [s] can't be used at time [t], or null when it can (access-token expiry aside). */
export function sessionProblem(s: ActiveSession, t: number): SessionEnd | null {
  if (s.revoked_at !== null) return "session_revoked";
  if (s.account_disabled_at !== null || s.user_disabled_at !== null) return "account_disabled";
  if (s.device_id !== null && s.device_revoked_at !== null) return "session_revoked";
  if (s.expires_at <= t || s.refresh_expires_at <= t) return "session_expired";
  return null;
}

/**
 * Access and refresh tokens (docs/ORBIT_2_ARCHITECTURE §2). Only SHA-256 hashes are stored, and the last refresh's answer
 * sealed with the token it replaced ([refresh]). Every refresh replaces both tokens; an older refresh token of the
 * session coming back means someone copied it, so the session is revoked.
 */
export class SessionService {
  constructor(
    private readonly store: AccountStore,
    private readonly config: AccountsConfig,
  ) {}

  async issue(accountId: string, label: string, deviceId: string | null, t: number, secondFactorVerified = false): Promise<IssuedSession> {
    const id = newId("s");
    const accessToken = newToken();
    const refreshToken = refreshTokenFor(id);
    const expiresAt = t + this.config.sessionMaxMs;
    const session: SessionRow = {
      id,
      account_id: accountId,
      second_factor_at: secondFactorVerified ? t : null,
      device_id: deviceId,
      label,
      access_hash: sha256Hex(accessToken),
      access_expires_at: t + this.config.accessTokenTtlMs,
      refresh_hash: sha256Hex(refreshToken),
      previous_refresh_hash: null,
      previous_refresh_answer: null,
      refresh_expires_at: Math.min(t + this.config.refreshIdleMs, expiresAt),
      expires_at: expiresAt,
      created_at: t,
      refreshed_at: t,
      last_used_at: t,
      revoked_at: null,
      revoke_reason: null,
    };
    await this.store.insertSession(session);
    return { accessToken, accessTokenExpiresAt: session.access_expires_at, refreshToken, refreshTokenExpiresAt: session.refresh_expires_at, session };
  }

  /**
   * Swaps a refresh token for new tokens. The token names its session, so every refresh token the session ever had is
   * recognised:
   * - the current one rotates;
   * - the one it just replaced, for [REFRESH_RACE_MS] after the swap, gets that swap's answer again (the app didn't get
   *   it, or several of its requests raced): the same pair, so whichever answer the app keeps is the current pair;
   * - any other one means a copy is in use: the session is revoked, and [onReuse] disconnects its device and records it.
   * The answer is kept sealed with a key from the token it replaced ([sealAnswer]): useless to anyone without that token,
   * and overwritten by the next swap, after which that token is a copy like any other.
   */
  async refresh(refreshToken: string, t: number, onReuse: (s: SessionRow) => void, attempt = 0): Promise<IssuedSession> {
    const s = await this.store.sessionById(sessionIdOf(refreshToken) ?? "");
    if (!s) throw sessionEnded("session_expired");
    const hash = sha256Hex(refreshToken);
    const current = hash === s.refresh_hash;
    const justReplaced = hash === s.previous_refresh_hash && t - s.refreshed_at <= REFRESH_RACE_MS;
    if (!current && !justReplaced) {
      if (s.revoked_at === null && (await this.store.revokeSession(s.id, "refresh_reuse", t))) onReuse(s);
      throw sessionEnded("session_revoked");
    }
    const problem = sessionProblem(s, t);
    if (problem) throw sessionEnded(problem);
    const again = current ? null : answerAgain(s, refreshToken);
    if (again) return again;
    const accessToken = newToken();
    const next = refreshTokenFor(s.id);
    const rotation: SessionRotation = {
      access_hash: sha256Hex(accessToken),
      access_expires_at: Math.min(t + this.config.accessTokenTtlMs, s.expires_at),
      refresh_hash: sha256Hex(next),
      // The token sent is the one replaced. It is already the previous one when nothing was kept to answer it again (a
      // session last rotated by an older server): it rotates once more, and the window still counts from the first swap.
      previous_refresh_hash: hash,
      previous_refresh_answer: sealAnswer(refreshToken, s.id, { accessToken, refreshToken: next }),
      refresh_expires_at: Math.min(t + this.config.refreshIdleMs, s.expires_at),
      refreshed_at: current ? t : s.refreshed_at,
      last_used_at: t,
    };
    // Conditional on the refresh hash it read: of refreshes racing, one rotates and the others, retried, find their
    // token just replaced and get its answer.
    if (!(await this.store.rotateSession(s.id, rotation, s.refresh_hash))) {
      if (attempt >= MAX_ROTATION_RACES) throw sessionEnded("session_expired");
      return this.refresh(refreshToken, t, onReuse, attempt + 1);
    }
    return {
      accessToken,
      accessTokenExpiresAt: rotation.access_expires_at,
      refreshToken: next,
      refreshTokenExpiresAt: rotation.refresh_expires_at,
      session: { ...s, ...rotation },
    };
  }

  /** The session an access token belongs to, if the token is current and the session may be used. */
  async authenticate(accessToken: string | undefined, t: number): Promise<ActiveSession | null> {
    if (!accessToken || accessToken.length < 20 || accessToken.length > 200) return null;
    const s = await this.store.sessionByAccessHash(sha256Hex(accessToken));
    if (!s || s.access_expires_at <= t || sessionProblem(s, t)) return null;
    await this.store.touchSession(s.id, t);
    return s;
  }

  /** Whether a session may still be used from [deviceId], whatever happened to its access token since (open WebSockets). */
  async stillValid(sessionId: string, deviceId: string, t: number): Promise<boolean> {
    const s = await this.store.sessionById(sessionId);
    return !!s && s.device_id === deviceId && sessionProblem(s, t) === null;
  }
}
