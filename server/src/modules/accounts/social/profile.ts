import type { SocialProvider } from "./config.js";

/** Cosmetic profile text only; never used to establish identity or account ownership. */
export function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  let result = "";
  for (const character of clean) {
    if (result.length + character.length > 80) break;
    result += character;
  }
  return result || undefined;
}

/** Read only the identity selected by this verified provider exchange, not user-editable broker metadata. */
export function providerDisplayName(
  provider: SocialProvider,
  data: Record<string, unknown>,
): string | undefined {
  const custom =
    data.custom_claims && typeof data.custom_claims === "object"
      ? (data.custom_claims as Record<string, unknown>)
      : {};
  const candidates =
    provider === "discord"
      ? [
          custom.global_name,
          data.global_name,
          data.full_name,
          data.preferred_username,
          data.user_name,
          data.username,
          data.name,
        ]
      : [
          data.name,
          data.full_name,
          data.preferred_username,
          data.user_name,
          data.username,
        ];
  return candidates.map(displayName).find(Boolean);
}
