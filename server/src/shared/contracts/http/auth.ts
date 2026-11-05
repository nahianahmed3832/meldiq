import { z } from "zod/v4";
import { idParams, zKey, zSig, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Accounts v1 (device-key accounts, docs/ORBIT_2_ARCHITECTURE §5): sign-up and sign-in with a device key, linking a new
 * phone (pairing), the account's own devices and safety-number fingerprints. v1 sign-up and sign-in close when the
 * owner ends the migration window (legacy_registration_closed, legacy_login_closed).
 */

const USERNAME = /^[a-z0-9](?:[a-z0-9._]{1,22})[a-z0-9]$/;

/** A display name or device name. */
export const zName = z.string().trim().min(1).max(80);

/** A username: trimmed and lower-cased, then 3–24 characters. */
export const zUsername = z
  .string()
  .trim()
  .toLowerCase()
  .refine((u) => USERNAME.test(u) && !u.includes(".."), "3–24 chars: a–z, 0–9, '.', '_'; must start and end with a letter or digit");

/** A device's public keys and its certificate, signed by the account's identity key. */
export const DeviceKeysBody = z.object({ name: zName, signingKey: zKey, encryptionKey: zKey, certificate: zSig });
export type DeviceKeysBody = z.infer<typeof DeviceKeysBody>;

/** A challenge nonce the device signs to prove it holds its key. */
const zNonce = z.string().min(16).max(64);

export const RegisterBody = z.object({
  username: zUsername,
  displayName: zName,
  identityKey: zKey,
  avatarColor: z.number().int().min(0).max(15).default(0),
  device: DeviceKeysBody,
  nonce: zNonce,
  signature: zSig,
  inviteCode: z.string().trim().min(8).max(40).optional(),
});
export const LoginBody = z.object({ deviceId: z.string().max(64), nonce: zNonce, signature: zSig });
export const AddDeviceBody = z.object({ username: zUsername, device: DeviceKeysBody, nonce: zNonce, signature: zSig });
export const UsernameQuery = z.object({ username: z.string() });
export const PairingBody = z.object({ deviceName: zName, signingKey: zKey, encryptionKey: zKey, transferKey: zKey });
export const PairingIdParams = z.object({ pairingId: z.string().min(20).max(64) });
export const PairingCodeParams = z.object({ code: z.string().max(32) });
export const PairingApproveBody = z.object({ certificate: zSig, sealedIdentity: z.string().min(10).max(400), sealedEnc: zKey });
export const UserIdParams = z.object({ userId: z.string().max(64) });

export const OkTrue = z.strictObject({ ok: z.literal(true) });

/** A new session for this device: the bearer token for every authenticated route. */
export const Session = z.strictObject({ userId: z.string(), deviceId: z.string(), sessionToken: z.string(), expiresAt: zTime });

export const UsernameAvailability = z.union([
  /** Not a valid username: why. */
  z.strictObject({ available: z.literal(false), reason: z.string().optional() }),
  /** The username as it would be stored (trimmed, lower-cased), and whether it's free. */
  z.strictObject({ available: z.boolean(), username: z.string() }),
]);

/** What the new phone polls for: once approved, the account's identity key sealed to its transfer key. */
export const PairingStatus = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("approved"),
    username: z.string(),
    identityKey: z.string(),
    certificate: z.string(),
    sealedIdentity: z.string(),
    sealedEnc: z.string(),
  }),
]);

/** A pairing request as the approving (signed-in) device sees it. */
export const PairingRequest = z.strictObject({
  deviceName: z.string(),
  signingKey: z.string(),
  encryptionKey: z.string(),
  transferKey: z.string(),
  createdAt: zTime,
});

export const OwnDevice = z.strictObject({
  id: z.string(),
  name: z.string(),
  signingKey: z.string(),
  createdAt: zTime,
  lastSeenAt: zTime.nullable(),
  revokedAt: zTime.nullable(),
  /** The device making this request. */
  current: z.boolean(),
  /** Whether any of the account's devices is connected (the same for every entry). */
  online: z.boolean(),
});

export const authRoutes = [
  route({
    method: "POST",
    url: "/v1/auth/challenge",
    tag: "auth",
    summary: "A single-use nonce (valid for 2 minutes) for a device to sign when registering, signing in or adding itself.",
    auth: false,
    response: z.strictObject({ nonce: z.string(), expiresAt: zTime }),
  }),
  route({
    method: "GET",
    url: "/v1/auth/username-available",
    tag: "auth",
    summary: "Whether a username is valid and free.",
    auth: false,
    query: UsernameQuery,
    response: UsernameAvailability,
  }),
  route({
    method: "POST",
    url: "/v1/auth/register",
    tag: "auth",
    summary: "v1 sign-up: create an account and its first device (an invitation code may join a community too).",
    auth: false,
    body: RegisterBody,
    response: Session.extend({ orgId: z.string().nullable() }),
    errors: [
      "legacy_registration_closed",
      "update_required",
      "invite_required",
      "invalid_invite",
      "registration_limited",
      "registration_paused",
      "invalid_certificate",
      "conflict",
      "banned",
      "invites_paused",
    ],
  }),
  route({
    method: "POST",
    url: "/v1/auth/login",
    tag: "auth",
    summary: "v1 sign-in: a device proves it holds its signing key and gets a session.",
    auth: false,
    body: LoginBody,
    response: Session,
    errors: ["legacy_login_closed", "account_deleted", "device_revoked", "account_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/auth/add-device",
    tag: "auth",
    summary: "v1: add a device to an account with a certificate signed by the account's identity key (pairing or recovery).",
    auth: false,
    body: AddDeviceBody,
    response: Session,
    errors: ["legacy_login_closed", "account_disabled", "too_many_devices", "conflict"],
  }),
  route({
    method: "POST",
    url: "/v1/auth/logout",
    tag: "auth",
    summary: "End this session; the device stops getting push wake-ups.",
    auth: true,
    response: OkTrue,
  }),
  route({
    method: "POST",
    url: "/v1/pairing",
    tag: "auth",
    summary: "A new phone asks to be linked: a code (valid for 10 minutes) to enter on a signed-in device.",
    auth: false,
    body: PairingBody,
    response: z.strictObject({ pairingId: z.string(), code: z.string(), expiresAt: zTime }),
  }),
  route({
    method: "GET",
    url: "/v1/pairing/:pairingId",
    tag: "auth",
    summary: "The new phone polls its pairing request: pending, expired, or approved with the sealed identity.",
    auth: false,
    params: PairingIdParams,
    response: PairingStatus,
  }),
  route({
    method: "GET",
    url: "/v1/pairing/code/:code",
    tag: "auth",
    summary: "A signed-in device looks up a pending pairing request by its code.",
    auth: true,
    params: PairingCodeParams,
    response: PairingRequest,
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v1/pairing/code/:code/approve",
    tag: "auth",
    summary: "A signed-in device approves a pairing request: the new device's certificate and the sealed identity.",
    auth: true,
    params: PairingCodeParams,
    body: PairingApproveBody,
    response: OkTrue,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "GET",
    url: "/v1/devices",
    tag: "auth",
    summary: "This account's devices, including removed ones.",
    auth: true,
    response: z.strictObject({ devices: z.array(OwnDevice) }),
  }),
  route({
    method: "DELETE",
    url: "/v1/devices/:id",
    tag: "auth",
    summary: "Remove one of this account's devices: its sessions end and nothing more is delivered to it.",
    auth: true,
    params: idParams,
    response: OkTrue,
    errors: ["not_found"],
  }),
  route({
    method: "GET",
    url: "/v1/fingerprint/:userId",
    tag: "auth",
    summary: "A person's identity key fingerprint (to compare safety numbers).",
    auth: true,
    params: UserIdParams,
    response: z.strictObject({ fingerprint: z.string() }),
    errors: ["not_found"],
  }),
];
