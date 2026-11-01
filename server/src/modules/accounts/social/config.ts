export type SocialProvider = "google" | "apple" | "discord";
export interface SocialConfig {
  url: string;
  publishableKey: string;
  publicOrigin: string;
  webOrigin: string;
  providers: SocialProvider[];
  googleClientId: string | null;
}
function origin(value: string, development: boolean): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("Social Auth origins must be valid HTTPS origins");
  }
  if (
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        development &&
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      ))
  )
    throw new Error(
      "Social Auth origins must be HTTPS origins (loopback HTTP allowed in development)",
    );
  return u.origin;
}
export function socialConfig(env: NodeJS.ProcessEnv): SocialConfig | null {
  if (
    !env.SUPABASE_AUTH_URL &&
    !env.SUPABASE_AUTH_PUBLISHABLE_KEY &&
    !env.SOCIAL_AUTH_PROVIDERS
  )
    return null;
  const dev = (env.APP_ENV ?? "development") === "development";
  const url = origin(env.SUPABASE_AUTH_URL ?? "", dev);
  const publicOrigin = origin(env.SOCIAL_AUTH_PUBLIC_ORIGIN ?? "", dev);
  const webOrigin = origin(env.SOCIAL_AUTH_WEB_ORIGIN ?? "", dev);
  const publishableKey = env.SUPABASE_AUTH_PUBLISHABLE_KEY ?? "";
  if (!publishableKey || publishableKey.startsWith("sb_secret_"))
    throw new Error(
      "Use a Supabase publishable/anon key, never a secret/service-role key",
    );
  // Legacy anon JWTs are supported, service-role JWTs are explicitly refused.
  if (
    !publishableKey.startsWith("sb_publishable_") &&
    !publishableKey.includes(".")
  )
    throw new Error(
      "SUPABASE_AUTH_PUBLISHABLE_KEY must be a publishable or anon key",
    );
  if (publishableKey.includes(".")) {
    try {
      if (
        JSON.parse(
          Buffer.from(publishableKey.split(".")[1], "base64url").toString(),
        ).role !== "anon"
      )
        throw new Error();
    } catch {
      throw new Error(
        "SUPABASE_AUTH_PUBLISHABLE_KEY must be a publishable or anon key",
      );
    }
  }
  const providers = (env.SOCIAL_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (providers.some((p) => p !== "google" && p !== "apple" && p !== "discord"))
    throw new Error("SOCIAL_AUTH_PROVIDERS supports google,apple,discord only");
  return {
    url,
    publishableKey,
    publicOrigin,
    webOrigin,
    providers: [...new Set(providers)] as SocialProvider[],
    googleClientId: env.SOCIAL_AUTH_GOOGLE_CLIENT_ID || null,
  };
}
