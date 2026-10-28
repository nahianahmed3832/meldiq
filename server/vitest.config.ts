import { defineConfig } from "vitest/config";

// With MELDIQ_TEST_MONGO_DOMAINS, each test server's first start creates every domain's collections, validators and
// indexes (about 170), and test files starting servers at once share one local replica set: set-up takes longer.
const mongo = !!process.env.MELDIQ_TEST_MONGO_DOMAINS;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: mongo ? 60000 : 20000,
    hookTimeout: mongo ? 90000 : 20000,
    pool: "forks",
    // A local MongoDB replica set for the MongoDB tests (test/support/mongoGlobal.ts).
    globalSetup: ["test/support/mongoGlobal.ts"],
  },
});
