import { buildApp } from "./app/server.js";
import { loadConfig } from "./app/config.js";
import { startJobs } from "./modules/administration/jobs.js";
import { MeldiqPostgres } from "./infrastructure/database/postgres/client.js";
import { openOperatorSocket } from "./app/operatorSocket.js";
import {afterDatabaseActivation} from "./app/databaseCutover.js";

const config = loadConfig();
const postgres = config.postgres ? new MeldiqPostgres(config.postgres) : undefined;
const { app, ctx } = await buildApp(config, { postgres }).catch(async (error) => {
  await postgres?.close();
  throw error;
});
const stopOperator = postgres ? await openOperatorSocket(ctx) : undefined;
let stopJobs: () => void | Promise<void> = () => {};
await afterDatabaseActivation(ctx.databaseCutover,()=>{stopJobs=startJobs(ctx);});
app.addHook("preClose", async () => {
  app.log.info({stage:"jobs",event:"start"}, "shutdown stage");
  await stopJobs();
  app.log.info({stage:"jobs",event:"end"}, "shutdown stage");
});

if (!config.livekit) app.log.warn("LIVEKIT_* not configured: voice/video calling is disabled");

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string): Promise<void> => shutdownPromise ??= (async () => {
  app.log.info({ signal, stage: "signal-received" }, "shutdown stage");
  const stage = async (name: string, run: () => unknown) => {
    app.log.info({ stage: name, event: "start" }, "shutdown stage");
    await run();
    app.log.info({ stage: name, event: "end" }, "shutdown stage");
  };
  await stage("operator", () => stopOperator?.());
  await stage("federation", () => ctx.federation?.stop());
  await stage("application", () => app.close());
  await stage("legacy-db", () => ctx.db.close());
  await stage("postgres-pool", () => postgres?.close());
  app.log.info({ stage: "process-exit", code: 0 }, "shutdown stage");
  process.exit(0);
})();
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
if (ctx.federation) {
  await afterDatabaseActivation(ctx.databaseCutover,()=>{
    ctx.federation!.start(); // announce to the core nodes, then heartbeats and outbox delivery
    app.log.info({ serverId: ctx.federation!.serverId, domain: ctx.federation!.domain }, "federation enabled");
  });
}
