/** "Log in with Meldiq" (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md); other modules reach it through ctx.oauth. */
export { OAuthService } from "./service.js";
export { MemoryOAuthStore, type OAuthStore } from "./store.js";
export { MongoOAuthStore } from "./mongoStore.js";
export { default as oauthRoutes } from "./routes.js";
