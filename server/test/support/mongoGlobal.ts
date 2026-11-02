import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { TestProject } from "vitest/node";

/**
 * One local, throwaway MongoDB replica set for the whole test run (docs/MONGODB.md › Tests). Never a shared or
 * production database: it listens on 127.0.0.1 only and is deleted when the run ends. A replica set, so transactions
 * behave as on Atlas. Each test server uses its own database in it.
 */
let rs: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject): Promise<void> {
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    // Every test server makes its own database: a file per collection and index. WiredTiger keeps those handles open
    // long after a test drops its database, and a full parallel run reached macOS's open-file limit per process
    // (kern.maxfilesperproc, 10240): mongod aborted with EMFILE mid-run. Idle handles are closed after seconds instead,
    // and the cache stays small.
    instanceOpts: [
      {
        ip: "127.0.0.1",
        launchTimeout: 60_000,
        args: [
          "--wiredTigerCacheSizeGB",
          "0.25",
          "--wiredTigerEngineConfigString",
          "file_manager=(close_idle_time=5,close_scan_interval=5,close_handle_minimum=250)",
        ],
      },
    ],
  });
  project.provide("mongoUri", rs.getUri());
}

export async function teardown(): Promise<void> {
  await rs?.stop({ doCleanup: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
