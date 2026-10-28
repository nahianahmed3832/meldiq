import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConnectorStatus, stateFor } from "../src/modules/administration/ops/connectors.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** The connector register (docs/CONNECTORS.md): one honest list of every outside service. */
let h: Harness;
let admin: GriipClient, member: GriipClient;

beforeAll(async () => {
  h = await startServer();
  [admin, member] = await Promise.all(["connadmin", "connmember"].map((n) => h.client(n)));
  (h.ctx.config.platformAdmins as Set<string>).add(admin.userId);
});
afterAll(async () => h.close());

const report = async () => (await admin.req("GET", "/v1/admin/connectors")).connectors as ConnectorStatus[];
const byId = (list: ConnectorStatus[], id: string) => {
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`no connector ${id}`);
  return c;
};

describe("connector register", () => {
  it("is for platform admins only", async () => {
    await expectStatus(member.req("GET", "/v1/admin/connectors"), 403);
    await expectStatus(member.req("POST", "/v1/admin/connectors/storage/check"), 403);
  });

  it("lists only the infrastructure Meldiq runs on, with names of missing settings only", async () => {
    const list = await report();
    expect(list.map((c) => c.id).sort()).toEqual(["calls", "email", "mongodb", "push-fcm", "push-unifiedpush", "storage"]);
    // Optional product connectors (apps, inbox channels, AI providers, webhooks) were removed in the community rebuild.
    expect(byId(list, "push-fcm").missing).toEqual(["FCM_PROJECT_ID", "FCM_SERVICE_ACCOUNT_FILE"]);
    expect(byId(list, "push-fcm").ownerAction).toMatch(/Firebase project/);
  });

  it("never calls a configured service working before it was measured, and storage after a real check is", async () => {
    expect(byId(await report(), "storage").state).toBe("configured");
    const r = await admin.req("POST", "/v1/admin/connectors/storage/check");
    expect(r.result).toEqual({ ok: true, errorKind: null });
    expect(byId(r.connectors, "storage").state).toBe("working");
    expect(byId(r.connectors, "storage").lastOkAt).toBeGreaterThan(0);
    const audit = h.ctx.ws.get<{ detail: string }>("audit_log", { action: "connector.check", target: "storage" })!;
    expect(audit.detail).toBe("ok");
  });

  it("refuses checks that would send something or cost money", async () => {
    await expectStatus(admin.req("POST", "/v1/admin/connectors/calls/check"), 400);
    await expectStatus(admin.req("POST", "/v1/admin/connectors/github/check"), 400);
    const r = await admin.req("POST", "/v1/admin/connectors/push-fcm/check");
    expect(r.result).toEqual({ ok: false, errorKind: "not_configured" });
  });

  it("contains no secrets, user ids or addresses", async () => {
    const text = JSON.stringify(await report());
    expect(text).not.toContain(admin.userId);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(text).not.toMatch(/-----BEGIN|sk-|AKIA/);
  });
});

describe("connector state", () => {
  const t = 100 * 3600_000;
  const sig = (lastOkAt: number | null, lastFailureAt: number | null) => ({ lastOkAt, lastFailureAt, lastErrorKind: lastFailureAt ? "timeout" : null });
  it("puts configuration and provider blockers before measurements", () => {
    expect(stateFor([], sig(t, null), t, { planned: true })).toBe("planned");
    expect(stateFor([], sig(t, null), t, { awaiting: true })).toBe("awaiting_provider");
    expect(stateFor([], sig(t, null), t, { disabled: true })).toBe("disabled");
    expect(stateFor(["X"], sig(t, null), t)).toBe("needs_configuration");
  });
  it("is working only after a success, failing only while the latest outcome is a recent failure", () => {
    expect(stateFor([], sig(null, null), t)).toBe("configured");
    expect(stateFor([], sig(t - 1000, null), t)).toBe("working");
    expect(stateFor([], sig(t - 60_000, t - 1000), t)).toBe("failing");
    expect(stateFor([], sig(t - 1000, t - 60_000), t)).toBe("working");
    expect(stateFor([], sig(null, t - 48 * 3600_000), t)).toBe("configured");
  });
});
