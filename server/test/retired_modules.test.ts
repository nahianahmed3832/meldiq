import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitlementConfig } from "../src/modules/administration/entitlements.js";
import { mongoConfig } from "../src/infrastructure/database/mongo/config.js";
import { purgeRetiredData, RETIRED_TABLES, retiredDataReport } from "../src/modules/administration/retiredData.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * What the community rebuild removed (apps, inbox, workflows, documents, developer keys, AI, groups) leaves no way to
 * break a deploy, and its leftover rows can be reported and, on request, deleted (docs/COMMUNITY_REBUILD_2026-10-21.md).
 */
let h: Harness;
beforeAll(async () => {
  h = await startServer({ MONGODB_DOMAINS: "" });
});
afterAll(async () => h.close());

describe("retired modules", () => {
  it("reports and purges the rows left in their tables, keeping the tables", () => {
    const db = h.ctx.db;
    db.prepare("INSERT INTO integration_credentials (account_id, key_id, access_token, updated_at) VALUES ('acct1', 'k1', 'sealed', 1)").run();
    db.prepare("INSERT INTO integration_jobs (id, kind, workspace_id, idempotency_key, payload, state, attempts, next_at, created_at, updated_at) VALUES ('j1', 'x', 'o1', 'k', '{}', 'dead', 3, 0, 1, 1)").run();
    const report = retiredDataReport(db);
    expect(Object.keys(report).sort()).toEqual([...RETIRED_TABLES].sort());
    expect(report.integration_credentials).toBe(1);
    expect(report.integration_jobs).toBe(1);
    const removed = purgeRetiredData(db);
    expect(removed.integration_credentials).toBe(1);
    expect(Object.values(retiredDataReport(db)).every((n) => n === 0)).toBe(true);
  });

  it("starts with an old environment that still names removed limits or the integrations MongoDB domain", () => {
    expect(entitlementConfig({ ENTITLEMENT_LIMITS: "documents=5,members=10,inbox.accounts=1" }).limits).toEqual({ members: 10 });
    const m = mongoConfig({ MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DOMAINS: "accounts,integrations" }, "development", (_n, d) => d);
    expect([...m!.domains]).toEqual(["accounts"]);
    expect(() => mongoConfig({ MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DOMAINS: "nonsense" }, "development", (_n, d) => d)).toThrow(/unknown domain/);
  });
});
