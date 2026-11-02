import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MeldiqPostgres } from "../../src/infrastructure/database/postgres/client.js";

/** Fresh, owned loopback database per API harness. Never accepts a hosted/customer URL. */
export async function preparePostgresHarness(connection = process.env.MELDIQ_TEST_PG_URL) {
  if (!connection) return null;
  const endpoint = new URL(connection);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("API test harness refuses non-loopback PostgreSQL");
  const name = `meldiq_api_test_${process.pid}_${randomBytes(5).toString("hex")}`;
  const administrator = new pg.Pool({connectionString: endpoint.href, max: 1});
  await administrator.query(`CREATE DATABASE "${name}"`);
  endpoint.pathname = `/${name}`;
  const database = new MeldiqPostgres({url: endpoint.href, environment: "development", maxConnections: 6,
    deliveryMode: process.env.MELDIQ_TEST_PG_DELIVERY_MODE === "legacy" ? "legacy" : undefined});
  const close = async () => {
    await database.close();
    try { await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await administrator.end(); }
  };
  try {
    const root = process.env.MELDIQ_SUPABASE_WEB_ROOT ?? path.resolve(process.cwd(), "../../meldiq_web");
    await database.query(fs.readFileSync(path.join(root, "scripts/supabase/postgres-bootstrap.sql"), "utf8"));
    for (const file of fs.readdirSync(path.join(root, "supabase/migrations")).filter(file => file.endsWith(".sql")).sort()) {
      await database.transaction(async () => { await database.query(fs.readFileSync(path.join(root, "supabase/migrations", file), "utf8")); });
    }
    return {database, close};
  } catch (error) { await close(); throw error; }
}
