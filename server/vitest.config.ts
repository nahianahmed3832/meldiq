import { defineConfig } from "vitest/config";

// With MELDIQ_TEST_MONGO_DOMAINS, each test server's first start creates every domain's collections, validators and
// indexes (about 170), and test files starting servers at once share one local replica set: set-up takes longer.
const mongo = !!process.env.MELDIQ_TEST_MONGO_DOMAINS;
const database = mongo || !!process.env.MELDIQ_TEST_PG_URL;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/supabase*.test.ts"], // Dedicated PostgreSQL harness: npm run test:supabase
    testTimeout: database ? 60000 : 20000,
    hookTimeout: database ? 90000 : 20000,
    pool: "forks",
    // A local MongoDB replica set for the MongoDB tests (test/support/mongoGlobal.ts).
    globalSetup: process.env.MELDIQ_TEST_PG_URL ? [] : ["test/support/mongoGlobal.ts"],
  },
});
