import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { type Harness, startServer } from "./support/harness.js";
import { allCallIds, callRow } from "./support/calls.js";

let h: Harness;
beforeAll(async () => {
  h = await startServer();
});
afterAll(async () => h.close());

describe("operations hygiene (Tier 7)", () => {
  it("the public health check reveals no usage numbers (D28)", async () => {
    const r = await (await fetch(`${h.baseUrl}/healthz`)).json();
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("onlineDevices");
  });

  it("the database overwrites deleted rows (D17)", () => {
    expect(h.ctx.db.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("prunes ended calls past retention and old audit rows, keeping recent and live ones (D16)", async () => {
    const a = await h.client("hygalice");
    const b = await h.client("hygbob");
    const dm = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
    const day = 86_400_000;
    const call = (id: string, state: "ENDED" | "ACTIVE", at: number, endedAt: number | null) =>
      h.ctx.calls.insert(callRow({ id, conversation_id: dm, created_by: a.userId, state, created_at: at, ended_at: endedAt }));
    await call("call_old", "ENDED", Date.now() - 120 * day, Date.now() - 120 * day);
    await call("call_recent", "ENDED", Date.now() - 5 * day, Date.now() - 5 * day);
    await call("call_live_old", "ACTIVE", Date.now() - 120 * day, null);
    await h.ctx.calls.join("call_old", a.userId, a.deviceId, Date.now() - 120 * day, true);
    await h.ctx.ws.write((w) => {
      w.insert("audit_log", { at: Date.now() - 400 * day, action: "old.event" });
      w.insert("audit_log", { at: Date.now() - 10 * day, action: "recent.event" });
    });

    const r = await runCleanup(h.ctx);
    const calls = await allCallIds(h.ctx);
    expect(calls).not.toContain("call_old");
    expect(calls).toEqual(expect.arrayContaining(["call_recent"]));
    expect(await h.ctx.calls.participants("call_old")).toEqual([]);
    const actions = h.ctx.ws.all<{ action: string }>("audit_log").map((x) => x.action);
    expect(actions).not.toContain("old.event");
    expect(actions).toContain("recent.event");
    expect(r.callRecordsPruned).toBe(1);
    expect(r.auditPruned).toBeGreaterThanOrEqual(1);
  });
});
