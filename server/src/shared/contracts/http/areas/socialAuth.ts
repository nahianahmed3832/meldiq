import { z } from "zod/v4";
import { route } from "../route.js";
import {
  SocialStart,
  SocialComplete,
  SocialNative,
  SocialConfig,
  SocialStarted,
  SocialReceipt,
  SocialCompleted,
  SocialConnections,
  SocialFresh,
  SocialProvider,
  SocialToken,
} from "../socialAuth.js";
const tag = "accounts";
export const socialAuthRoutes = [
  route({
    method: "GET",
    url: "/v2/auth/social/config",
    summary: "Available external sign-in providers (disabled until configured)",
    tag,
    auth: false,
    response: SocialConfig,
  }),
  route({
    method: "POST",
    url: "/v2/auth/social/start",
    summary:
      "Start a client-proof-bound Google/Apple/Discord login or authenticated account link",
    tag,
    auth: false,
    body: SocialStart,
    response: SocialStarted,
  }),
  route({
    method: "GET",
    url: "/v2/auth/social/authorize/:id",
    summary:
      "Set the HttpOnly OAuth state cookie and redirect to Supabase PKCE",
    tag,
    auth: false,
    params: z.object({ id: SocialToken }),
    response: z.string(),
    binary: "response",
    status: 302,
  }),
  route({
    method: "GET",
    url: "/v2/auth/social/callback",
    summary:
      "Validate browser state and provider code; return a one-use receipt (never tokens)",
    tag,
    auth: false,
    response: z.string(),
    binary: "response",
    status: 302,
  }),
  route({
    method: "POST",
    url: "/v2/auth/social/native",
    summary: "Verify a nonce-bound native Google ID token through Supabase",
    tag,
    auth: false,
    body: SocialNative,
    response: SocialReceipt,
  }),
  route({
    method: "POST",
    url: "/v2/auth/social/complete",
    summary:
      "Redeem a receipt and client verifier for a Meldiq session or explicit account link",
    tag,
    auth: false,
    body: SocialComplete,
    response: SocialCompleted,
  }),
  route({
    method: "GET",
    url: "/v2/account/identities",
    summary: "List connected login providers and password availability",
    tag,
    auth: true,
    response: SocialConnections,
  }),
  route({
    method: "DELETE",
    url: "/v2/account/identities/:provider",
    summary:
      "Disconnect a provider after fresh authentication, retaining another login method",
    tag,
    auth: true,
    params: z.object({ provider: SocialProvider }),
    body: SocialFresh,
    response: z.object({ ok: z.literal(true) }),
  }),
];
