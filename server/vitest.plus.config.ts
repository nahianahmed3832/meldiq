import { defineConfig } from "vitest/config";
/** SQLite API and policy checks do not need a MongoDB daemon. MongoDB behavior is tested separately. */
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60000, hookTimeout: 90000, pool: "forks", maxWorkers: 1, fileParallelism: false } });
