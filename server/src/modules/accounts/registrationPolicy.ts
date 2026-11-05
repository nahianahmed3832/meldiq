import { conflict } from "../../shared/errors.js";
import { type RegistrationAttestation, RegistrationPolicy } from "../../shared/contracts/http/registrationPolicy.js";

export function signupPolicyConfig(raw: string | undefined): RegistrationPolicy | null {
  if (!raw) return null;
  try {
    const policy = RegistrationPolicy.parse(JSON.parse(raw));
    for (const key of ["terms", "privacy"] as const) {
      const entry = policy[key];
      // A mutable current-policy page is not the document a person reviewed.
      if (entry.url !== `https://meldiq.app/legal/${key}/${encodeURIComponent(entry.revision)}`) throw new Error();
    }
    return policy;
  } catch {
    throw new Error("MELDIQ_SIGNUP_POLICY requires revision-specific Meldiq Terms and Privacy URLs and a minimum age of 13");
  }
}

export function requireSignupAttestation(policy: RegistrationPolicy | null, accepted: RegistrationAttestation | undefined): void {
  if (!policy) return;
  if (!accepted || accepted.termsRevision !== policy.terms.revision || accepted.privacyRevision !== policy.privacy.revision) {
    throw conflict("Review the current Terms and Privacy notice before creating an account.", { requirement: "signup_policy", policy });
  }
}

export type SignupEntryPath = "email" | "google" | "discord" | "apple" | "operator-activation";

export function signupAcceptance(policy: RegistrationPolicy | null, accepted: RegistrationAttestation | undefined, entryPath: SignupEntryPath, recordedAt: number): string | null {
  requireSignupAttestation(policy, accepted);
  return policy ? JSON.stringify({ termsRevision: policy.terms.revision, privacyRevision: policy.privacy.revision, declaredMinimumAge: policy.minimumAge, entryPath, recordedAt }) : null;
}
