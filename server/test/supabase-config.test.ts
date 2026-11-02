import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { postgresConfig } from "../src/infrastructure/database/postgres/config.js";
import { databaseMode, loadConfig } from "../src/app/config.js";
import { buildApp } from "../src/app/server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-pg-config-"));
const ca = path.join(dir, "ca.pem"),
  acceptance = path.join(dir, "acceptance.json");
fs.writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");
const ref = "bkvlxbsnzqkhbifawcww";
const env = {
  DATABASE_MODE: "supabase",
  SUPABASE_DATABASE_URL: `postgresql://runtime.${ref}:fixture-password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`,
  SUPABASE_DATABASE_PROJECT_REF: ref,
  SUPABASE_DB_CA_FILE: ca,
  SUPABASE_PRODUCTION_ACCEPTANCE_FILE: acceptance,
};
const receipt = {
  version: 1,
  projectRef: ref,
  mode: "database-compatibility",
  legacyProtocols: true,
  runtimeRevision: "a".repeat(40),
  sourceSha256: "b".repeat(64),
  destinationReconciled: true,
  encryptedBackupVerified: true,
  rollbackPrepared: true,
  operatorAccessVerified: true,
  acceptedAt: "2026-01-01T00:00:00.000Z",
};
function save(value: unknown = receipt) {
  fs.writeFileSync(acceptance, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(acceptance, 0o600);
}
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("PostgreSQL production activation", () => {
  it("keeps Atlas and social Auth configuration independent", () => {
    expect(postgresConfig({ DATABASE_MODE: "atlas", SUPABASE_URL: "https://social.example" }, true)).toBeNull();
    expect(postgresConfig({ ...env, SUPABASE_URL: "https://social.example" }, false)).toMatchObject({
      projectRef: ref,
      environment: "staging",
      maxConnections: 6,
    });
  });
  it("requires the selected project and verified TLS without leaking connection secrets", () => {
    for (const value of [
      undefined,
      "not-a-url",
      env.SUPABASE_DATABASE_URL.replace(ref, "anotherprojectaaaaaa"),
      env.SUPABASE_DATABASE_URL + "?sslmode=no-verify",
      env.SUPABASE_DATABASE_URL.replace(":5432/", ":6543/"),
      "postgresql://runtime:fixture-password@unknown.example/postgres",
    ]) {
      let error: unknown;
      try {
        postgresConfig({ ...env, SUPABASE_DATABASE_URL: value }, false);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("fixture-password");
    }
    expect(() => postgresConfig({ ...env, SUPABASE_DB_CA_FILE: undefined }, false)).toThrow("TLS");
    expect(() => postgresConfig({ ...env, SUPABASE_DATABASE_POOL_SIZE: "20" }, false)).toThrow("pool size");
    expect(() =>
      postgresConfig(
        {
          ...env,
          SUPABASE_DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/local",
        },
        true,
      ),
    ).toThrow();
  });
  it("refuses absent, public, symlinked, incomplete and wrong-project acceptance", () => {
    expect(() => postgresConfig({ ...env, SUPABASE_PRODUCTION_ACCEPTANCE_FILE: undefined }, true)).toThrow("acceptance");
    save();
    fs.chmodSync(acceptance, 0o644);
    expect(() => postgresConfig(env, true)).toThrow("private");
    fs.unlinkSync(acceptance);
    fs.symlinkSync(ca, acceptance);
    expect(() => postgresConfig(env, true)).toThrow("private");
    fs.unlinkSync(acceptance);
    for (const value of [
      { ...receipt, projectRef: "sgowwdmnavcsofzlgggm" },
      { ...receipt, encryptedBackupVerified: false },
      { ...receipt, legacyProtocols: false },
      { ...receipt, acceptedAt: "invalid" },
      { ...receipt, acceptedAt: new Date(Date.now() + 3600_000).toISOString() },
    ]) {
      save(value);
      expect(() => postgresConfig(env, true)).toThrow("acceptance");
    }
  });
  it("retains accepted deployment evidence across later service restarts", () => {
    save();
    expect(postgresConfig(env, true)).toMatchObject({
      environment: "production",
      productionAcceptance: {
        sourceSha256: receipt.sourceSha256,
        acceptedAt: receipt.acceptedAt,
      },
    });
  });
  it("cannot silently open SQLite when PostgreSQL injection is missing", async () => {
    expect(() => databaseMode({ APP_ENV: "production", DATABASE_MODE: "supabase" })).toThrow("REDIS_URL");
    expect(() => databaseMode({ DATABASE_MODE: "superbase" })).toThrow("DATABASE_MODE");
    const config = loadConfig({
      DATA_DIR: dir,
      DATABASE_MODE: "supabase",
      SUPABASE_DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/local",
    });
    expect(config.mongo).toBeNull();
    await expect(buildApp(config)).rejects.toThrow("legacy fallback is forbidden");
  });
});
