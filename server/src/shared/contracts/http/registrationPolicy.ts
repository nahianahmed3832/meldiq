import { z } from "zod/v4";

const revision = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const document = z.strictObject({ revision, url: z.url().max(2048) });

export const RegistrationPolicy = z.strictObject({
  minimumAge: z.literal(13),
  terms: document,
  privacy: document,
});
export type RegistrationPolicy = z.infer<typeof RegistrationPolicy>;

export const RegistrationAttestation = z.strictObject({
  termsRevision: revision,
  privacyRevision: revision,
  ageAtLeast13: z.literal(true),
  termsAccepted: z.literal(true),
  privacyAcknowledged: z.literal(true),
});
export type RegistrationAttestation = z.infer<typeof RegistrationAttestation>;
export const RegistrationPolicyResponse = z.strictObject({ policy: RegistrationPolicy.nullable() });
