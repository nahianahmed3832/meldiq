import { buildApp } from "./app/server.js";
import { loadConfig } from "./app/config.js";
import { startJobs } from "./modules/administration/jobs.js";
import { MeldiqPostgres } from "./infrastructure/database/postgres/client.js";
import { openOperatorSocket } from "./modules/administration/operatorSocket.js";
import {afterDatabaseActivation} from "./app/databaseCutover.js";

const config = loadConfig();
const postgres = config.postgres ? new MeldiqPostgres(config.postgres) : undefined;
const { app, ctx } = await buildApp(config, { postgres }).catch(async (error) => {
  await postgres?.close();
  throw error;
});
const stopOperator = postgres ? await openOperatorSocket(ctx) : undefined;
let stopJobs=()=>{};
await afterDatabaseActivation(ctx.databaseCutover,()=>{stopJobs=startJobs(ctx);});

if (!config.livekit) app.log.warn("LIVEKIT_* not configured: voice/video calling is disabled");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopJobs();
  await stopOperator?.();
  ctx.federation?.stop();
  await app.close();
  ctx.db.close();
  await postgres?.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
if (ctx.federation) {
  await afterDatabaseActivation(ctx.databaseCutover,()=>{
    ctx.federation!.start(); // announce to the core nodes, then heartbeats and outbox delivery
    app.log.info({ serverId: ctx.federation!.serverId, domain: ctx.federation!.domain }, "federation enabled");
  });
}
