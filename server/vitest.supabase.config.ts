import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/supabase*.test.ts"], fileParallelism: false, hookTimeout: 30_000, testTimeout: 20_000 } });
