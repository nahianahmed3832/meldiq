import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Assignment, assignments, experimentsConfig } from "../src/modules/administration/experiments/assign.js";
import { definitionProblems, EXPERIMENTS, type ExperimentDef } from "../src/modules/administration/experiments/definitions.js";
import { cleanEvents } from "../src/modules/administration/experiments/events.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Meldiq 2.0: communities as a kind of workspace, experiments (off by default) and content-free analytics counts.
const def = (over: Partial<ExperimentDef>): ExperimentDef => ({
  id: "test-exp",
  description: "",
  layer: "test",
  traffic: 1,
  control: "a",
  variants: [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ],
  status: "running",
  startsAt: null,
  endsAt: null,
  metrics: ["app.opened"],
  successCriteria: "",
  ...over,
});
const users = Array.from({ length: 2000 }, (_, i) => `u_${i}`);

describe("experiment definitions", () => {
  it("are sound and all start as drafts", () => {
    expect(definitionProblems()).toEqual([]);
    expect(EXPERIMENTS.every((d) => d.status === "draft")).toBe(true);
  });

  it("reject overlapping traffic in one layer and a control that isn't a variant", () => {
    expect(definitionProblems([def({ id: "x1", traffic: 0.7 }), def({ id: "x2", traffic: 0.7 })])).toContain("layer test: traffic adds up to 1.4");
    expect(definitionProblems([def({ control: "z" })])).toContain("test-exp: control z isn't a variant");
  });
});

describe("assignment", () => {
  const on = experimentsConfig({ EXPERIMENTS_MODE: "on" });

  it("assigns nobody while experiments are off (the default) or still drafts", () => {
    expect(experimentsConfig({}).mode).toBe("off");
    expect(users.flatMap((u) => assignments(experimentsConfig({}), u, false, Date.now(), [def({})]))).toEqual([]);
    expect(users.flatMap((u) => assignments(on, u, false, Date.now(), [def({ status: "draft" })]))).toEqual([]);
  });

  it("is stable per person and splits by weight", () => {
    const defs = [def({})];
    const first = users.map((u) => assignments(on, u, false, 1, defs)[0].variant);
    expect(users.map((u) => assignments(on, u, false, 1, defs)[0].variant)).toEqual(first);
    const b = first.filter((v) => v === "b").length / users.length;
    expect(b).toBeGreaterThan(0.45);
    expect(b).toBeLessThan(0.55);
  });

  it("never puts one person in two experiments of the same layer, and stopping one moves nobody else", () => {
    const defs = [def({ id: "one", traffic: 0.5 }), def({ id: "two", traffic: 0.5 })];
    const all = users.map((u) => assignments(on, u, false, 1, defs));
    expect(all.every((a) => a.length === 1)).toBe(true);
    const share = all.filter((a) => a[0].experiment === "one").length / users.length;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
    const stopped = experimentsConfig({ EXPERIMENTS_MODE: "on", EXPERIMENT_STATUS: "one=stopped" });
    const after = users.map((u) => assignments(stopped, u, false, 1, defs));
    users.forEach((_, i) => {
      if (all[i][0].experiment === "two") expect(after[i]).toEqual(all[i]);
      else expect(after[i]).toEqual([]);
    });
  });

  it("respects dates, and preview mode reaches preview people only", () => {
    const later = [def({ startsAt: "2999-01-01T00:00:00Z" })];
    expect(assignments(on, "u_1", false, Date.now(), later)).toEqual([]);
    const preview = experimentsConfig({ EXPERIMENTS_MODE: "preview", EXPERIMENT_PREVIEW_USER_IDS: "u_7" });
    const p = [def({ status: "preview" })];
    expect(assignments(preview, "u_1", false, 1, p)).toEqual([]);
    expect(assignments(preview, "u_7", false, 1, p).map((a: Assignment) => a.experiment)).toEqual(["test-exp"]);
    expect(assignments(on, "u_1", false, 1, p)).toEqual([]);
  });

  it("refuses a bad operator setting at start", () => {
    expect(() => experimentsConfig({ EXPERIMENTS_MODE: "maybe" })).toThrow();
    expect(() => experimentsConfig({ EXPERIMENT_STATUS: "home-layout=live" })).toThrow();
  });
});

describe("analytics events", () => {
  it("keep only catalogued events with allowed property values, never free text", () => {
    const clean = cleanEvents({
      platform: "web",
      events: [
        { name: "search.performed", props: { scope: "messages", results: "2-5" } },
        { name: "search.performed", props: { scope: "messages", results: "2-5", query: "salary review" } },
        { name: "message.sent", props: { surface: "a private note" } },
        { name: "made.up" },
        { name: "onboarding.completed", props: { kind: "community" }, value: 61_000.4 },
      ],
    });
    expect(clean).toEqual([
      { name: "search.performed", dims: '{"results":"2-5","scope":"messages"}', value: null },
      { name: "onboarding.completed", dims: '{"kind":"community"}', value: 61_000 },
    ]);
  });
});

let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer(
    { REMINDER_TICK_MS: "0", EXPERIMENTS_MODE: "on", EXPERIMENT_STATUS: "home-layout=running", ANALYTICS_ENABLED: "true" },
    { mailer },
  );
});
afterAll(async () => h.close());

describe("communities", () => {
  it("every new workspace is a community with its starter channels; the old kind field is accepted and ignored", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "commowner");
    const member = await AccountClient.ready(h.baseUrl, mailer, "commmember");
    const org = (await owner.req("POST", "/v1/orgs", { name: "Bangla Makers", kind: "community" })).org;
    expect(org.kind).toBe("community");
    const channels = h.ctx.ws.all<{ name: string; kind: string; voice: number }>("conversations", { where: { org_id: org.id, type: "CHANNEL" }, orderBy: [["name", "asc"]] }).map(({ name, kind, voice }) => ({ name, kind, voice }));
    expect(channels.map((c) => c.name)).toEqual(["announcements", "general", "introductions", "lounge", "welcome"]);
    expect(channels.find((c) => c.name === "lounge")?.voice).toBe(1);
    // Older apps still send "team": it makes a community all the same.
    expect((await owner.req("POST", "/v1/orgs", { name: "Plain team", kind: "team" })).org.kind).toBe("community");
    await expectStatus(owner.req("POST", "/v1/orgs", { name: "Odd", kind: "club" }), 400);

    const code = (await owner.req("POST", `/v1/orgs/${org.id}/invites`, { role: "ADMIN" })).invite.code;
    await member.req("POST", "/v1/invites/accept", { code });
    expect((await member.req("PATCH", `/v1/orgs/${org.id}`, { kind: "team", description: "Makers in Dhaka" })).org).toMatchObject({ kind: "community", description: "Makers in Dhaka" });
  });

  it("answers the removed workplace and app routes with 404 for everyone", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "permowner");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Probe" })).org.id;
    const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 0);
    const gone = [
      owner.req("POST", `/v1/orgs/${orgId}/branches`, { name: "Dhaka office" }),
      owner.req("GET", `/v1/orgs/${orgId}/inbox/accounts`),
      owner.req("GET", `/v1/orgs/${orgId}/apps`),
      owner.req("GET", `/v1/orgs/${orgId}/workflows`),
      owner.req("GET", `/v1/orgs/${orgId}/documents`),
      owner.req("GET", `/v1/orgs/${orgId}/api-keys`),
      owner.req("GET", `/v1/orgs/${orgId}/groups`),
      owner.req("GET", "/v1/workspace-templates"),
      owner.req("GET", "/v1/integrations/oauth/callback"),
    ];
    expect(await Promise.all(gone.map(status))).toEqual(gone.map(() => 404));
  });
});

describe("experiments and analytics over the API", () => {
  it("tells each person their stable assignments and counts events without who sent them", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "exper");
    const first = await c.req("GET", "/v1/experiments");
    expect(first).toMatchObject({ mode: "on", analytics: true });
    expect((await c.req("GET", "/v1/experiments")).assignments).toEqual(first.assignments);
    expect(first.assignments.every((a: Assignment) => a.experiment === "home-layout")).toBe(true);

    const r = await c.req("POST", "/v1/analytics/events", {
      platform: "android",
      events: [{ name: "app.opened" }, { name: "integration.viewed", props: { connector: "github" } }, { name: "integration.viewed", props: { connector: "someone@example.com" } }],
    });
    // App-directory events went with the apps: only the catalogued event is kept.
    expect(r).toEqual({ accepted: 1, enabled: true });
    const rows = h.ctx.ws.all<Record<string, unknown>>("analytics_daily", { where: { event: "app.opened" } });
    expect(rows.find((x) => x.experiment === "")).toMatchObject({ count: 1, platform: "android", dims: "{}" });
    expect(rows.filter((x) => x.experiment !== "").length).toBe(first.assignments.length);
    const cols = Object.keys(rows[0]);
    expect(cols.some((k) => /user|device|account/.test(k))).toBe(false);
    await expectStatus(c.req("POST", "/v1/analytics/events", { platform: "ios", events: [{ name: "app.opened" }] }), 400);
  });

  it("keeps the report for platform admins", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "notadmin");
    await expectStatus(c.req("GET", "/v1/admin/experiments"), 403);
  });
});

describe("with analytics off (the default)", () => {
  it("accepts nothing and stores nothing", async () => {
    const off = await startServer({ REMINDER_TICK_MS: "0" }, { mailer });
    try {
      const c = await AccountClient.ready(off.baseUrl, mailer, "quiet");
      expect(await c.req("GET", "/v1/experiments")).toEqual({ mode: "off", analytics: false, assignments: [] });
      expect(await c.req("POST", "/v1/analytics/events", { platform: "web", events: [{ name: "app.opened" }] })).toEqual({ accepted: 0, enabled: false });
      expect(off.ctx.ws.count("analytics_daily")).toBe(0);
    } finally {
      await off.close();
    }
  });
});
