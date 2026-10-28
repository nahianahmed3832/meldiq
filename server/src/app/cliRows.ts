import type { Config } from "./config.js";
import type { DB } from "../infrastructure/database/db.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import { openMongo } from "../infrastructure/database/mongo/index.js";
import type { Rows } from "../infrastructure/database/rows/index.js";
import { openDomainRows } from "./domainRows.js";
import { openWorkspaceRows } from "./workspaceRows.js";

/** What the operator CLI works on: every rows domain, in SQLite or MongoDB as MONGODB_DOMAINS says. */
export interface CliRows {
  mongo?: MeldiqMongo;
  ws: Rows;
  identity: Rows;
  platform: Rows;
  fed: Rows;
  safety: Rows;
  ephemeral: Rows;
  /** Waits for every unit, then closes MongoDB (the SQLite database is the caller's). */
  close(): Promise<void>;
}

export async function openCliRows(cfg: Config, db: DB): Promise<CliRows> {
  const mongo = cfg.mongo ? await openMongo(cfg.mongo, db) : undefined;
  const ws = await openWorkspaceRows(db, mongo, console);
  const [identity, platform, fed, safety, ephemeral] = await Promise.all(
    (["identity", "platform", "federation", "safety", "ephemeral"] as const).map((d) => openDomainRows(db, d, mongo, console)),
  );
  return {
    mongo,
    ws,
    identity,
    platform,
    fed,
    safety,
    ephemeral,
    close: async () => {
      for (const r of [ws, identity, platform, fed, safety, ephemeral]) {
        await r.settled();
        await r.close();
      }
      await mongo?.close();
    },
  };
}
