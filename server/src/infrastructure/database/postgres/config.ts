import fs from "node:fs";
import type { PostgresConfig } from "./client.js";

/** Database-only compatibility rollout; existing social Auth configuration remains a separate namespace. */
export function postgresConfig(env: NodeJS.ProcessEnv, production: boolean): PostgresConfig | null {
  if (env.DATABASE_MODE?.trim() !== "supabase") return null;
  const value = env.SUPABASE_DATABASE_URL;
  if (!value) throw new Error("DATABASE_MODE=supabase requires SUPABASE_DATABASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A valid PostgreSQL database URL is required");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash || (url.pathname !== "/postgres" && production))
    throw new Error("Use a direct or session-pool PostgreSQL URL without overrides");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const ref = env.SUPABASE_DATABASE_PROJECT_REF;
  if (production && local) throw new Error("Production requires the selected hosted PostgreSQL project");
  if (!local) {
    if (!ref || !/^[a-z]{20}$/.test(ref)) throw new Error("Set the expected Supabase database project reference");
    const direct = url.hostname === `db.${ref}.supabase.co`;
    const session = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && decodeURIComponent(url.username).endsWith(`.${ref}`);
    if ((!direct && !session) || (url.port && url.port !== "5432") || !url.password || !url.username) throw new Error("Database URL must identify the selected direct/session-pool project");
  }
  const max = Number(env.SUPABASE_DATABASE_POOL_SIZE ?? 6);
  if (!Number.isInteger(max) || max < 2 || max > 6) throw new Error("Supabase database pool size must be between 2 and 6");
  let ca: string | undefined;
  if (!local) {
    if (!env.SUPABASE_DB_CA_FILE) throw new Error("Verified PostgreSQL TLS requires SUPABASE_DB_CA_FILE");
    try {
      ca = fs.readFileSync(env.SUPABASE_DB_CA_FILE, "utf8");
    } catch {
      throw new Error("PostgreSQL CA certificate is unreadable");
    }
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("A PEM PostgreSQL CA certificate is required");
  }
  let productionAcceptance: PostgresConfig["productionAcceptance"];
  if (production) {
    const file = env.SUPABASE_PRODUCTION_ACCEPTANCE_FILE;
    if (!file) throw new Error("Production database activation requires its verified cutover acceptance receipt");
    let receipt: any;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error();
      receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("Production acceptance receipt must be a private regular JSON file");
    }
    if (
      receipt.version !== 1 ||
      receipt.projectRef !== ref ||
      receipt.mode !== "database-compatibility" ||
      receipt.legacyProtocols !== true ||
      !/^[a-f0-9]{40}$/.test(receipt.runtimeRevision ?? "") ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceSha256 ?? "") ||
      receipt.destinationReconciled !== true ||
      receipt.encryptedBackupVerified !== true ||
      receipt.rollbackPrepared !== true ||
      receipt.operatorAccessVerified !== true ||
      typeof receipt.acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.acceptedAt)) ||
      Date.parse(receipt.acceptedAt) > Date.now() + 60_000
    )
      throw new Error("Production cutover acceptance is incomplete or for another project");
    // Durable acceptance permits ordinary restarts after cutover; evidence is retained beside this file.
    productionAcceptance = {
      sourceSha256: receipt.sourceSha256,
      runtimeRevision: receipt.runtimeRevision,
      acceptedAt: receipt.acceptedAt,
    };
  }
  return {
    url: url.href,
    environment: production ? "production" : local ? "development" : "staging",
    deliveryMode: "legacy",
    projectRef: ref,
    maxConnections: max,
    ca,
    productionAcceptance,
  };
}
