/** Bots (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md); other modules reach them through ctx.bots. */
export { BotService } from "./service.js";
export { MemoryBotStore, type BotStore } from "./store.js";
export { MongoBotStore } from "./mongoStore.js";
export { default as botRoutes } from "./routes.js";
