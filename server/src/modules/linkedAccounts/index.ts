/** Linked accounts' public API (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md); other modules reach it through ctx.linkedAccounts. */
export { LINKED_PROVIDERS, type LinkedAccountsConfig, linkedAccountsConfig, type LinkedProvider } from "./config.js";
export { type LinkedAccount, LinkedAccountsService, REFRESH_AFTER_MS } from "./service.js";
export { default as linkedAccountRoutes } from "./routes.js";
