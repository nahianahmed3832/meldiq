import { z } from "zod/v4";
import { LoginBody, SessionGrant } from "./accounts.js";
import { RegistrationAttestation } from "./registrationPolicy.js";
export const SocialProvider = z.enum(["google", "apple", "discord"]);
export const SocialToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const SocialFresh = z
  .object({
    password: z.string().max(128).optional(),
    totpCode: z.string().max(32).optional(),
  })
  .strict();
export const SocialStart = SocialFresh.extend({
  provider: SocialProvider,
  challenge: SocialToken,
  mode: z.enum(["login", "link"]).default("login"),
  platform: z.enum(["web", "android"]).default("web"),
}).strict();
export const SocialComplete = z
  .object({
    id: SocialToken,
    verifier: SocialToken,
    receipt: SocialToken,
    name: z.string().trim().min(1).max(80).optional(),
    inviteCode: z.string().max(100).optional(),
    deviceName: z.string().max(100).optional(),
    totpCode: z.string().max(32).optional(),
    device: LoginBody.shape.device,
    policyAcceptance: RegistrationAttestation.optional(),
  })
  .strict();
export const SocialNative = z
  .object({
    id: SocialToken,
    verifier: SocialToken,
    idToken: z.string().min(20).max(16384),
  })
  .strict();
export const SocialConfig = z.object({
  providers: z.array(SocialProvider),
  googleClientId: z.string().nullable(),
  authorizeOrigin: z.string().nullable(),
});
export const SocialStarted = z.object({
  id: SocialToken,
  authorizeUrl: z.string(),
  nonce: z.string(),
  expiresAt: z.number(),
});
export const SocialReceipt = z.object({
  id: SocialToken,
  receipt: SocialToken,
  platform: z.enum(["web", "android"]),
});
export const SocialCompleted = z.union([
  z.object({ linked: z.literal(true) }),
  z.object({ grant: SessionGrant }),
]);
export const SocialConnections = z.object({
  password: z.boolean(),
  identities: z.array(
    z.object({
      provider: SocialProvider,
      email: z.string().nullable(),
      connectedAt: z.number(),
    }),
  ),
  providers: z.array(SocialProvider),
});
