import { botRoutes } from "../bots.js";
import { oauthAppRoutes } from "../oauthApps.js";
import type { RouteContract } from "../route.js";

/** Route contracts of settings parity batch B's developer area: "Log in with Meldiq" apps and bots (API 0.65.0). */
export const developerRoutes: readonly RouteContract[] = [...oauthAppRoutes, ...botRoutes];
