import { z } from "zod/v4";
import { zCount, zKey, zSig, zTime } from "./primitives.js";

/**
 * The v2 account API (docs/ORBIT_2_ARCHITECTURE §6): email-and-password accounts, their sessions, recovery codes, key
 * backup, device setup, workspaces and the legacy migration. The Android models in data/account/AccountModels.kt mirror
 * these, and future clients implement the same ones.
 */

// ───────────── Request primitives ─────────────

/** The longest password accepted (characters); passwords.ts checks it with a clear message. */
export const PASSWORD_MAX_LENGTH = 128;

/** A display name, trimmed. */
export const zName = z.string().trim().min(1).max(80);

/** Lower-cased and trimmed; a deliberately loose shape check: the verification email is the real test. */
export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter an email address like name@example.com");

/** Length rules are checked with a clear message by passwordProblem(); this only bounds the request. */
export const zPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH * 4);

export const zVerifyCode = z.string().trim().min(4).max(32);
export const zRecoveryCode = z.string().trim().min(8).max(40);
/** A single-use /v1/auth/challenge nonce. */
const zNonce = z.string().min(16).max(64);
/** A ticket the server issued for the next step (recovery, legacy migration), or a refresh token. */
const zTicket = z.string().min(20).max(200);

/** Base64 of exactly [bytes] bytes (with padding). */
const b64OfBytes = (bytes: number) => z.string().length(4 * Math.ceil(bytes / 3)).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const DeviceKeys = z.object({ name: zName, signingKey: zKey, encryptionKey: zKey, certificate: zSig });
export type DeviceKeys = z.infer<typeof DeviceKeys>;

/** A device of the account signing in again proves it holds its device key (a fresh challenge signed with it). */
export const DeviceProof = z.object({ deviceId: z.string().min(3).max(64), nonce: zNonce, signature: zSig });

/**
 * The identity seed sealed under the password (docs/KEY_BACKUP.md): PBKDF2-HMAC-SHA256 with [iterations] over a 16-byte
 * salt, AES-256-GCM with a 12-byte nonce over the 32-byte seed (48 bytes with the tag).
 */
export const KeyBackupBody = z.object({
  version: z.literal(1),
  iterations: z.number().int().min(300_000).max(5_000_000),
  salt: b64OfBytes(16),
  nonce: b64OfBytes(12),
  ciphertext: b64OfBytes(48),
  identityKey: zKey,
});
export type KeyBackupBody = z.infer<typeof KeyBackupBody>;

// ───────────── Request bodies ─────────────

export const RegisterBody = z.object({ name: zName, email: zEmail, password: zPassword, inviteCode: z.string().trim().min(8).max(40).optional() });
export type RegisterBody = z.infer<typeof RegisterBody>;
export const EmailBody = z.object({ email: zEmail });
/** The password chosen at sign-up goes with the code: whoever verifies an address is whoever set its password. */
export const VerifyEmailBody = z.object({ email: zEmail, code: zVerifyCode, password: zPassword });
export const LoginBody = z.object({
  email: zEmail,
  password: zPassword,
  deviceName: zName.optional(),
  device: DeviceProof.optional(),
  /** API 0.46.0: the authenticator app's code (or a backup code) when two-step sign-in is on. */
  totpCode: z.string().trim().min(6).max(20).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;
export const RefreshBody = z.object({ refreshToken: zTicket });
export const ResetPasswordBody = z.object({ email: zEmail, code: zVerifyCode, newPassword: zPassword });

/** Recovery codes (docs/ACCOUNT_RECOVERY.md): making or revoking a set needs the password again. */
export const RecoveryPasswordBody = z.object({ password: zPassword });
export const RecoveryStartBody = z.object({ email: zEmail, code: zRecoveryCode, newEmail: zEmail });
export const RecoveryCompleteBody = z.object({ ticket: zTicket, code: zVerifyCode, newPassword: zPassword });

export const UpdateAccountBody = z.object({ name: zName });
/** Deleting your account (docs/ACCOUNT_DELETION.md): the password again, and the account's email typed by the person. */
export const DeleteAccountBody = z.object({ password: zPassword, confirmEmail: zEmail });
/** [keyBackup]: the keys sealed again under the new password, so a backup survives the change. */
export const ChangePasswordBody = z.object({ currentPassword: zPassword, newPassword: zPassword, keyBackup: KeyBackupBody.optional() });
export const PutKeyBackupBody = z.object({ password: zPassword, backup: KeyBackupBody });
export const KeyUnlockBody = z.object({ code: zVerifyCode });
export const SessionIdParams = z.object({ id: z.string().min(3).max(64) });
export const PreferencesBody = z.object({ selectedWorkspaceId: z.string().min(3).max(64) });

export const EnrollDeviceBody = z.object({
  identityKey: zKey.optional(),
  username: z.string().trim().max(40).optional(),
  device: DeviceKeys,
  nonce: zNonce,
  signature: zSig,
});
export type EnrollDeviceBody = z.infer<typeof EnrollDeviceBody>;
export const ResetIdentityBody = z.object({ password: zPassword, identityKey: zKey, device: DeviceKeys, nonce: zNonce, signature: zSig });
export type ResetIdentityBody = z.infer<typeof ResetIdentityBody>;

export const LegacyVerifyBody = z.object({ username: z.string().trim().toLowerCase().min(1).max(40), nonce: zNonce, signature: zSig });
export type LegacyVerifyBody = z.infer<typeof LegacyVerifyBody>;
export const LegacyCompleteBody = z.object({ ticket: zTicket, name: zName, email: zEmail, password: zPassword });
export type LegacyCompleteBody = z.infer<typeof LegacyCompleteBody>;

// ───────────── Passkeys (2026-10-23, docs/PASSKEYS.md) ─────────────

/** A WebAuthn ceremony's answer as the platform gives it (JSON with base64url fields); verified by the server. */
const zWebAuthnResponse = z.object({ id: z.string().min(1).max(1024), rawId: z.string().min(1).max(1024), type: z.literal("public-key") }).passthrough();
const zChallengeId = z.string().min(16).max(64);
/** [rpId]: the relying party to make or use a passkey for; a web app on another host names its own (PASSKEY_WEB_ORIGINS). */
export const PasskeyOptionsBody = z.object({ rpId: z.string().min(1).max(253).optional() });
export type PasskeyOptionsBody = z.infer<typeof PasskeyOptionsBody>;
export const PasskeyRegisterBody = z.object({ challengeId: zChallengeId, response: zWebAuthnResponse, name: zName.optional() });
export type PasskeyRegisterBody = z.infer<typeof PasskeyRegisterBody>;
export const PasskeyLoginBody = z.object({ challengeId: zChallengeId, response: zWebAuthnResponse, deviceName: zName.optional(), device: DeviceProof.optional() });
export type PasskeyLoginBody = z.infer<typeof PasskeyLoginBody>;
export const PasskeyIdParams = z.object({ id: z.string().min(1).max(1024) });

/** API 0.46.0 (docs/ACCOUNT_SAFETY.md): two-step sign-in, changing the email. */
export const TotpSetupBody = z.object({ password: zPassword });
export const TotpCodeBody = z.object({ code: z.string().trim().min(6).max(20) });
export const TotpDisableBody = z.object({ password: zPassword, code: z.string().trim().min(6).max(20) });
export const EmailChangeStartBody = z.object({ password: zPassword, newEmail: zEmail });
export const EmailChangeConfirmBody = z.object({ code: z.string().trim().min(6).max(12) });

// ───────────── Answers ─────────────

export const Ok = z.strictObject({ ok: z.literal(true) });

export const TotpStatus = z.strictObject({ available: z.boolean(), enabled: z.boolean(), enabledAt: zTime.nullable(), backupCodesLeft: z.number().int() });
export const TotpSetup = z.strictObject({ secret: z.string(), uri: z.string() });
export const TotpEnabled = z.strictObject({ backupCodes: z.array(z.string()) });
export const EmailChangeStarted = z.strictObject({ email: z.string(), expiresAt: zTime });
export const EmailChanged = z.strictObject({ email: z.string() });
export const Standing = z.strictObject({
  level: z.enum(["good", "limited", "very_limited", "suspended"]),
  warnings: z.array(z.strictObject({ id: z.string(), reason: z.string(), createdAt: zTime, expiresAt: zTime })),
});

/** The signed-in account. [identity]: its encryption identity, null until the first device is set up. */
export const AccountView = z.strictObject({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: zTime,
  /** When a legacy (device-keyed) account was linked to this one; null for accounts that started here. */
  legacyLinkedAt: zTime.nullable(),
  selectedWorkspaceId: z.string().nullable(),
  identity: z.strictObject({ userId: z.string(), username: z.string(), identityKey: z.string() }).nullable(),
});

/** The session a request is made with. [deviceId]: the device it is bound to, null before device setup. */
export const SessionView = z.strictObject({ id: z.string(), deviceId: z.string().nullable(), createdAt: zTime });

/** A new or renewed session: both tokens with their expiry, the session and its account. */
export const SessionGrant = z.strictObject({
  accessToken: z.string(),
  accessTokenExpiresAt: zTime,
  refreshToken: z.string(),
  refreshTokenExpiresAt: zTime,
  session: SessionView,
  account: AccountView,
});

/** Sign-up and the legacy migration: a code went to [email] (the answer is the same whether the address is new or not). */
export const VerificationSent = z.strictObject({ status: z.literal("verification_sent"), email: z.string() });

export const AccountWithSession = z.strictObject({ account: AccountView, session: SessionView });
export const AccountOnly = z.strictObject({ account: AccountView });
export const AccountDeleted = z.strictObject({ deleted: z.literal(true), deletedAt: zTime });
export const PasswordChanged = z.strictObject({ ok: z.literal(true), keyBackup: z.boolean() });

/** Options for the platform's passkey prompt (WebAuthn JSON), and the id of this ceremony to send back with the answer. */
export const PasskeyOptions = z.strictObject({ challengeId: z.string(), options: z.record(z.string(), z.unknown()) });
export const PasskeyView = z.strictObject({ id: z.string(), name: z.string(), createdAt: zTime, lastUsedAt: zTime.nullable(), synced: z.boolean() });
export const PasskeyList = z.strictObject({ available: z.boolean(), passkeys: z.array(PasskeyView) });
export const PasskeyAdded = z.strictObject({ passkey: PasskeyView });
/** Digital Asset Links: which Android apps may use passkeys for this server. */
export const AssetLinks = z.array(
  z.strictObject({
    relation: z.array(z.string()),
    target: z.strictObject({ namespace: z.literal("android_app"), package_name: z.string(), sha256_cert_fingerprints: z.array(z.string()) }),
  }),
);

export const SessionList = z.strictObject({
  sessions: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      deviceId: z.string().nullable(),
      createdAt: zTime,
      lastUsedAt: zTime,
      /** The session this request was made with. */
      current: z.boolean(),
    }),
  ),
});

/** Recovery codes: [remaining] still usable; 0 with [createdAt] null means no set was ever made. */
export const RecoveryStatus = z.strictObject({ remaining: zCount, total: zCount, createdAt: zTime.nullable() });
/** A new set, shown once (formatted "ABCD-EFGH-JKLM"); the old set stopped working. */
export const RecoveryCodes = z.strictObject({ codes: z.array(z.string()), createdAt: zTime });
/** A code went to [email] (the new address); the ticket carries the recovery on until [expiresAt]. */
export const RecoveryTicket = z.strictObject({ ticket: z.string(), email: z.string(), expiresAt: zTime });
export const RecoveryDone = z.strictObject({ email: z.string(), remainingCodes: zCount });

/** Whether the account has a key backup its current password and identity can use. */
export const KeyBackupStatus = z.strictObject({ exists: z.boolean(), updatedAt: zTime.nullable() });
export const KeyBackupSaved = z.strictObject({ updatedAt: zTime });
/** An unlock code went to [email] (masked, "n****2@gmail.com"), valid until [expiresAt]. */
export const KeyUnlockStarted = z.strictObject({ email: z.string(), expiresAt: zTime });
/** The sealed keys, as written by the device that backed them up. */
export const KeyBackupView = z.strictObject({
  version: z.number().int(),
  iterations: z.number().int(),
  salt: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
  identityKey: z.string(),
});

/** Device setup: made the account's encryption identity, added a device to it, or found the device already there. */
export const EnrollResult = z.strictObject({
  userId: z.string(),
  deviceId: z.string(),
  username: z.string(),
  result: z.enum(["identity", "device", "existing"]),
});

export const WorkspaceView = z.strictObject({
  id: z.string(),
  kind: z.enum(["personal", "organization"]),
  name: z.string(),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]),
  slug: z.string().nullable(),
  /** The organisation's avatar revision (GET /v1/orgs/:id/photo); null for the personal workspace or no avatar. */
  photoRev: zCount.nullable(),
});
export const WorkspaceList = z.strictObject({ workspaces: z.array(WorkspaceView), selectedWorkspaceId: z.string() });
export const SelectedWorkspace = z.strictObject({ selectedWorkspaceId: z.string() });

export const LegacyVerified = z.strictObject({
  ticket: z.string(),
  expiresAt: zTime,
  legacyUser: z.strictObject({ username: z.string(), displayName: z.string() }),
});
