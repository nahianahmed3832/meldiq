import { MemoryMailer } from "./support/accounts.js";
import {
  ADMIN_ORIGIN,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Entitlements,
  entitlementConfig,
} from "../src/modules/administration/entitlements.js";
import {
  UsageMeter,
  utcDay,
} from "../src/modules/administration/usage/meter.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Round 7 slice C7: usage metering and plan limits (docs/USAGE_AND_PLANS.md). */
let h: Harness;
let owner: GriipClient, member: GriipClient, platform: GriipClient;
let orgId: string;
let admin: ConsoleAdmin;
const mailer = new MemoryMailer();
const setLimits = (limits: Record<string, number | null>) =>
  admin.browser.expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, {
    limits,
    expiresAt: Date.now() + 86400000,
    reason: "Verify canonical workspace limits",
  });

const join = async (c: GriipClient) => {
  const code = (
    await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
  ).invite.code;
  return c.req("POST", "/v1/invites/accept", { code });
};
const capability = async (key: string) =>
  (
    (await owner.req("GET", `/v1/orgs/${orgId}/plan`)).capabilities as {
      key: string;
      limit: number | null;
      used: number;
      source: string;
    }[]
  ).find((c) => c.key === key)!;

beforeAll(async () => {
  // A retired limit (documents) in an old environment file is ignored rather than stopping the server.
  h = await startServer(
    {
      ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN,
      WORKFLOW_TICK_MS: "0",
      ENTITLEMENT_LIMITS: "roles.custom=50,documents=5",
    },
    { mailer },
  );
  admin = await consoleAdmin(h, mailer, "super_admin", "usageconsoleoperator");
  [owner, member, platform] = await Promise.all(
    ["usowner", "usmember", "usplatform"].map((n) => h.client(n)),
  );
  (h.ctx.config.platformAdmins as Set<string>).add(platform.userId);
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Meter Co" })).org.id;
});
afterAll(async () => h.close());

describe("usage metering", () => {
  it("counters add up per day; gauges are recomputed, never double-counted", async () => {
    const pure = (await owner.req("POST", "/v1/orgs", { name: "Pure Co" })).org
      .id;
    let t = Date.parse("2026-10-20T10:00:00Z");
    const m = new UsageMeter(
      h.ctx.identity,
      h.ctx.ws,
      h.ctx.files,
      h.ctx.calls,
      () => t,
    );
    await m.add(pure, "files.upload_bytes");
    await m.add(pure, "files.upload_bytes", 2);
    await m.add(null, "files.upload_bytes", 5); // no community: not metered
    await m.snapshot(true);
    await m.snapshot(true);
    const s = m.series(pure, 3);
    expect(s.find((x) => x.metric === "files.upload_bytes")?.total).toBe(3);
    expect(s.find((x) => x.metric === "seats.members")?.total).toBe(1);
    t += 86_400_000;
    await m.add(pure, "files.upload_bytes");
    const next = m
      .series(pure, 2)
      .find((x) => x.metric === "files.upload_bytes")!;
    expect(next.daily).toEqual([
      { day: "2026-10-20", value: 3 },
      { day: "2026-10-21", value: 1 },
    ]);
    expect(utcDay(Date.parse("2026-10-20T23:59:59Z"))).toBe("2026-10-20");
  });

  it("measures real actions: uploads and downloads, members", async () => {
    await join(member);
    const ch = (
      await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
        name: "files",
        scope: "ORG",
        kind: "PUBLIC",
      })
    ).channel.id;
    const up = await member.req(
      "POST",
      `/v1/attachments?conversationId=${ch}`,
      undefined,
      Buffer.alloc(1000, 1),
    );
    await owner.req("GET", `/v1/attachments/${up.id}`);
    const usage = (await owner.req("GET", `/v1/orgs/${orgId}/usage`)).metered
      .metrics as { metric: string; total: number }[];
    const total = (m: string) => usage.find((x) => x.metric === m)?.total;
    expect(total("files.upload_bytes")).toBeGreaterThanOrEqual(1000);
    expect(total("files.download_bytes")).toBeGreaterThanOrEqual(1000);
    expect(total("api.requests")).toBeUndefined();
    expect(total("seats.members")).toBe(2);
    expect(total("storage.bytes")).toBeGreaterThanOrEqual(1000);
    // Only counts and sizes: nothing that names a person or a file.
    expect(JSON.stringify(usage)).not.toContain(member.userId);
  });

  it("usage figures are for people allowed to see them; cross-workspace totals for platform admins only", async () => {
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/usage`), 403);
    await expectStatus(owner.req("GET", "/v1/admin/usage"), 403);
    const all = (await platform.req("GET", "/v1/admin/usage?days=7"))
      .workspaces as { id: string; usage: Record<string, number> }[];
    expect(
      all.find((w) => w.id === orgId)?.usage["files.upload_bytes"],
    ).toBeGreaterThanOrEqual(1000);
  });
});

describe("plan limits", () => {
  it("shows where each limit comes from: the server's, the workspace's own, or none", async () => {
    expect(await capability("roles.custom")).toMatchObject({
      limit: 50,
      source: "server",
    });
    expect(await capability("storage.bytes")).toMatchObject({
      limit: null,
      source: "none",
    });
    expect(await capability("documents")).toBeUndefined();
    expect((await owner.req("GET", `/v1/orgs/${orgId}/plan`)).plan).toBeNull(); // no plans exist: never invented
  });

  it("only fresh console administrators set a workspace's limits; app allowlists and owners cannot", async () => {
    await expectStatus(
      owner.req("PUT", `/v1/admin/orgs/${orgId}/limits`, {
        limits: { members: 100 },
      }),
      403,
    );
    await expectStatus(
      platform.req("PUT", `/v1/admin/orgs/${orgId}/limits`, {
        limits: { nonsense: 1 },
      }),
      403,
    );
    expect(
      (
        await admin.browser.req("PUT", `/admin/v1/orgs/${orgId}/limits`, {
          limits: { nonsense: 1 },
          expiresAt: null,
          reason: "Reject unknown limit keys",
        })
      ).status,
    ).toBe(400);
    await setLimits({ members: 2, "roles.custom": 1 });
    expect(await capability("roles.custom")).toMatchObject({
      limit: 1,
      source: "workspace",
    });
    const audit = h.ctx.platform.get("platform_audit", {
      target_id: orgId,
      action: "org.limits",
    });
    expect(audit).toBeTruthy();
  });

  it("is enforced on the server when something is added", async () => {
    const third = await h.client("usthird");
    await expectStatus(join(third), 409); // members = 2, already two
    await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
      name: "One",
      permissions: [],
      denies: [],
    });
    await expectStatus(
      owner.req("POST", `/v1/orgs/${orgId}/roles`, {
        name: "Two",
        permissions: [],
        denies: [],
      }),
      409,
    );
    await setLimits({ members: null, "roles.custom": null });
    expect(await capability("roles.custom")).toMatchObject({
      limit: 50,
      source: "server",
    });
    await join(third);
  });

  it("stored files are limited by bytes, including the upload being added", async () => {
    await setLimits({ "storage.bytes": 1500 });
    const ch = (
      await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
        name: "more-files",
        scope: "ORG",
        kind: "PUBLIC",
      })
    ).channel.id;
    await expectStatus(
      owner.req(
        "POST",
        `/v1/attachments?conversationId=${ch}`,
        undefined,
        Buffer.alloc(1000, 2),
      ),
      409,
    );
    await setLimits({ "storage.bytes": null });
  });

  it("the server-wide configuration is validated", () => {
    expect(() =>
      entitlementConfig({ ENTITLEMENT_LIMITS: "members=ten" }),
    ).toThrow(/whole number/);
    expect(() => entitlementConfig({ ENTITLEMENT_LIMITS: "seats=10" })).toThrow(
      /unknown capability/,
    );
    const e = new Entitlements(
      entitlementConfig({ ENTITLEMENT_LIMITS: "members=3" }),
    );
    expect(() => e.check("members", 3)).toThrow(/This server allows 3 members/);
    expect(() => e.check("members", 2)).not.toThrow();
  });
});
