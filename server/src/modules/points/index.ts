/** The points module's public API (API 0.65.0, docs/SETTINGS_PARITY_API.md); other modules reach it through ctx.points. */
export { PointsService, type SentMessage } from "./service.js";
export { MemoryPointsStore, type PointsStore } from "./store.js";
export { MongoPointsStore } from "./mongoStore.js";
export { POINTS, QUESTS } from "./rules.js";
export { default as pointsRoutes } from "./routes.js";
