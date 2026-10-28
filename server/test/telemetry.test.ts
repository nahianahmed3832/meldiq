import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyClient, requestKind } from "../src/modules/telemetry/index.js";
import { ActivityTracker } from "../src/modules/telemetry/activity.js";
import * as analytics from "../src/modules/telemetry/analytics.js";
import { parseCpu, parseCpuMax, parseDiskstats, parseMeminfo, parseNetDev, type Reader, ResourceSampler } from "../src/modules/telemetry/resources.js";
import { canonical, GriipClient, sign } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Platform telemetry (docs/ANALYTICS_DEFINITIONS.md): how requests count, DAU/WAU/MAU windows and their boundaries,
 * exclusions, retention and activation, live concurrency (people, devices and sockets kept apart), and the resource
 * parsers. Nothing measured is ever invented: missing inputs give no sample.
 */

describe("client classification", () => {
  it("knows the clients by what they already send, and takes a declared version only in the expected form", () => {
    expect(classifyClient("okhttp/4.12.0")).toEqual({ platform: "android", client: "OkHttp 4.12", version: "", os: "Android" });
    expect(classifyClient("Meldiq/57 CFNetwork/1568.100.1 Darwin/24.0.0")).toEqual({ platform: "ios", client: "Meldiq iOS", version: "57", os: "iOS" });
    const chrome = classifyClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
    expect(chrome).toEqual({ platform: "web", client: "Chrome 141", version: "", os: "macOS" });
    expect(classifyClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1").client).toBe("Safari 18");
    expect(classifyClient("okhttp/4.12.0", "android/0.31.2")).toMatchObject({ platform: "android", version: "0.31.2", client: "OkHttp 4.12" });
    expect(classifyClient("okhttp/4.12.0", "android/<script>")).toMatchObject({ version: "" });
    expect(classifyClient(undefined)).toEqual({ platform: "unknown", client: "", version: "", os: "" });
    expect(classifyClient("node")).toMatchObject({ platform: "other", client: "node" });
  });
});

describe("what counts as activity", () => {
  it("leaves background traffic out and counts real messages as actions", () => {
    expect(requestKind("POST", "/v2/auth/refresh")).toBe("passive");
    expect(requestKind("GET", "/v1/queue")).toBe("passive");
    expect(requestKind("POST", "/v1/queue/ack")).toBe("passive");
    expect(requestKind("PUT", "/v1/devices/current/fcm")).toBe("passive");
    expect(requestKind("GET", "/v1/conversations")).toBe("activity");
    expect(requestKind("POST", "/v1/messages", { cls: "message" })).toBe("action");
    expect(requestKind("POST", "/v1/messages", { cls: "control" })).toBe("activity");
    expect(requestKind("POST", "/v1/attachments/uploads/:id/complete")).toBe("action");
  });

  it("dedupes a person's requests into one row per day and client, keeping the first and last time", () => {
    const t = new ActivityTracker();
    const web = { platform: "web" as const, client: "Chrome 141", version: "", os: "macOS" };
    t.record("u1", web, Date.parse("2026-10-24T01:00:00Z"), false);
    t.record("u1", web, Date.parse("2026-10-24T09:00:00Z"), true);
    t.record("u1", web, Date.parse("2026-10-24T05:00:00Z"), false);
    expect(t.activeSince(Date.parse("2026-10-24T08:59:00Z")).users).toBe(1);
    expect(t.activeSince(Date.parse("2026-10-24T09:01:00Z")).users).toBe(0);
  });
});

describe("analytics windows", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TELEMETRY_TICK_MS: "0" });
  });
  afterAll(async () => h.close());

  const put = (day: string, userId: string, platform = "android", signupDay = "2026-09-01", actions = 0) =>
    h.ctx.db
      .prepare(
        `INSERT OR REPLACE INTO activity_daily (day, user_id, platform, client_version, first_at, last_at, requests, actions, first_action_at, signup_at)
         VALUES (?, ?, ?, '', ?, ?, 1, ?, ?, ?)`,
      )
      .run(day, userId, platform, Date.parse(`${day}T10:00:00Z`), Date.parse(`${day}T11:00:00Z`), actions, actions ? Date.parse(`${day}T10:30:00Z`) : null, Date.parse(`${signupDay}T08:00:00Z`));

  it("computes DAU on the UTC day and WAU/MAU over the 7 and 30 days ending with it, people counted once", () => {
    put("2026-10-01", "a");
    put("2026-10-01", "a", "web"); // the same person on a second platform: still one person
    put("2026-10-02", "b");
    put("2026-10-08", "c");
    put("2026-10-31", "d");
    const none = "[]";
    const [d8] = analytics.activeUsers(h.ctx.db, "2026-10-08", "2026-10-08", none);
    expect(d8).toMatchObject({ dau: 1, wau: 2, mau: 3 }); // WAU: Oct 2–8 has b and c; Oct 1 is outside the 7 days
    const [d31] = analytics.activeUsers(h.ctx.db, "2026-10-31", "2026-10-31", none);
    expect(d31).toMatchObject({ dau: 1, wau: 1, mau: 3 }); // MAU: Oct 2–31 (a's Oct 1 is the 31st day back)
    const [excl] = analytics.activeUsers(h.ctx.db, "2026-10-08", "2026-10-08", JSON.stringify(["c"]));
    expect(excl).toMatchObject({ dau: 0, wau: 1, mau: 2 });
  });

  it("splits new from returning people by the UTC day they signed up", () => {
    put("2026-11-05", "n1", "web", "2026-11-05");
    put("2026-11-05", "r1", "web", "2026-10-01");
    const [p] = analytics.activeUsers(h.ctx.db, "2026-11-05", "2026-11-05", "[]");
    expect(p).toMatchObject({ dau: 2, newActive: 1, returningActive: 1 });
  });

  it("measures retention only for days that are over and were collected, against all sign-ups of the cohort", () => {
    put("2026-12-02", "x1", "android", "2026-12-01");
    put("2026-12-08", "x1", "android", "2026-12-01");
    put("2026-12-08", "x2", "android", "2026-12-01");
    const rows = analytics.retention(h.ctx.db, [{ day: "2026-12-01", count: 4 }], "[]", "2026-12-09", "2026-11-30");
    expect(rows[0]).toEqual({ day: "2026-12-01", size: 4, d1: 1, d7: 2, d30: null });
    const before = analytics.retention(h.ctx.db, [{ day: "2026-12-01", count: 4 }], "[]", "2026-12-09", "2026-12-05");
    expect(before[0]).toMatchObject({ d1: null, d7: 2 }); // day 1 was before collection began: not zero, unknown
  });

  it("counts activation within 7 days of sign-up and the median time to the first action", () => {
    put("2027-01-03", "z1", "web", "2027-01-02", 1);
    put("2027-01-20", "z2", "web", "2027-01-02", 1); // 18 days later: not activated
    const a = analytics.activation(h.ctx.db, Date.parse("2027-01-01T00:00:00Z"), Date.parse("2027-01-10T00:00:00Z"), "[]");
    expect(a.activated).toBe(1);
    expect(a.medianMsToFirstAction).toBe(Date.parse("2027-01-03T10:30:00Z") - Date.parse("2027-01-02T08:00:00Z"));
  });
});

describe("live activity and concurrency", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TELEMETRY_TICK_MS: "0" });
  });
  afterAll(async () => h.close());

  it("records qualifying requests with their client, leaves background ones out, and writes once a minute", async () => {
    const c = await h.client("active");
    c.extraHeaders = { "user-agent": "okhttp/4.12.0" };
    await c.req("GET", "/v1/conversations");
    await c.req("GET", "/v1/queue");
    await h.ctx.telemetry.minute();
    const rows = h.ctx.db.prepare("SELECT platform, requests, signup_at FROM activity_daily WHERE user_id = ?").all(c.userId) as any[];
    expect(rows).toEqual([{ platform: "android", requests: 1, signup_at: expect.any(Number) }]);
    const traffic = h.ctx.db.prepare("SELECT metric FROM traffic_user_daily WHERE user_id = ?").all(c.userId) as any[];
    expect(traffic.map((r) => r.metric)).toContain("api.out");
  });

  it("counts a person with two devices and two sockets once, and keeps devices and sockets apart", async () => {
    const a = await h.client("multi");
    const phone = new GriipClient(h.baseUrl, a.username);
    phone.identity = a.identity;
    const { nonce } = await phone.req("POST", "/v1/auth/challenge");
    const added = await phone.req("POST", "/v1/auth/add-device", {
      username: a.username,
      device: { name: "phone", signingKey: phone.signingKeyB64, encryptionKey: phone.encKeyB64, certificate: phone.certificate() },
      nonce,
      signature: sign(phone.device, canonical.authProof("add-device", nonce, phone.signingKeyB64)),
    });
    phone.deviceId = added.deviceId;
    phone.userId = a.userId;
    phone.token = added.sessionToken;
    const tab = new GriipClient(h.baseUrl, a.username);
    Object.assign(tab, { identity: a.identity, device: a.device, deviceId: a.deviceId, userId: a.userId, token: a.token });
    await a.connect();
    await tab.connect();
    await phone.connect();
    const live = await h.ctx.telemetry.live();
    expect(live).toMatchObject({ users: 1, devices: 2, sockets: 3 });
    h.ctx.telemetry.setExcluded([a.userId]);
    expect(await h.ctx.telemetry.live()).toMatchObject({ users: 0, devices: 2, sockets: 3 });
    h.ctx.telemetry.setExcluded([]);
    await h.ctx.telemetry.minute();
    const sample = h.ctx.db.prepare("SELECT users, sockets, connects FROM presence_samples ORDER BY minute DESC LIMIT 1").get() as any;
    expect(sample).toMatchObject({ users: 1, sockets: 3 });
    expect(sample.connects).toBeGreaterThanOrEqual(3);
    await tab.disconnect();
    await phone.disconnect();
    await a.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect(await h.ctx.telemetry.live()).toMatchObject({ users: 0, devices: 0, sockets: 0 });
    expect(h.ctx.hub.stats.disconnects).toBeGreaterThanOrEqual(3);
  });

  it("counts sockets refused for bad credentials", async () => {
    const before = h.ctx.hub.stats.authFailures;
    const bad = await h.client("badtoken");
    bad.token = "x".repeat(40);
    await expect(bad.connect()).rejects.toThrow();
    expect(h.ctx.hub.stats.authFailures).toBe(before + 1);
  });

  it("rolls finished hours up and trims rows past their retention", () => {
    const db = h.ctx.db;
    // An hour after the ones the minute job already rolled up.
    const hour = Math.floor(Date.now() / 3_600_000) + 1;
    db.prepare("INSERT OR REPLACE INTO resource_samples (minute, series, value) VALUES (?, 'host.cpu.pct', 10), (?, 'host.cpu.pct', 30)").run(hour * 60 + 1, hour * 60 + 2);
    db.prepare("INSERT OR REPLACE INTO resource_samples (minute, series, value) VALUES (1, 'host.cpu.pct', 99)").run();
    h.ctx.telemetry.rollup((hour + 1) * 3_600_000 + 60_000);
    expect(db.prepare("SELECT avg, min, max, samples FROM resource_hourly WHERE series = 'host.cpu.pct' AND hour = ?").get(hour)).toEqual({ avg: 20, min: 10, max: 30, samples: 2 });
    h.ctx.telemetry.trim(Date.now());
    expect(db.prepare("SELECT COUNT(*) n FROM resource_samples WHERE minute = 1").get()).toEqual({ n: 0 });
  });

  it("shows the hours not rolled up yet in long ranges, from their minute samples", () => {
    const db = h.ctx.db;
    const t = Date.now();
    const minute = Math.floor(t / 60_000);
    // Two samples inside one hour three hours ago (never straddling an hour boundary), with no rollup for the series.
    const hour = Math.floor(t / 3_600_000) - 3;
    db.prepare("INSERT OR REPLACE INTO resource_samples (minute, series, value) VALUES (?, 'test.series', 5), (?, 'test.series', 7)").run(hour * 60 + 10, hour * 60 + 11);
    const [week] = analytics.resourceSeries(db, ["test.series"], t - 7 * 86_400_000, t);
    expect(week!.resolution).toBe("hour");
    expect(week!.points.at(-1)).toMatchObject({ at: hour * 3_600_000, value: 6, min: 5, max: 7 });
    // (The rollup test above rolled up hours ahead of now; real rollups only cover finished hours.)
    db.prepare("DELETE FROM presence_hourly WHERE hour >= ?").run(Math.floor(t / 3_600_000));
    db.prepare(
      "INSERT OR REPLACE INTO presence_samples (minute, users, active_users, devices, sockets, connects, disconnects, abnormal, auth_failures, calls, call_people, platforms) VALUES (?, 4, 2, 4, 5, 1, 0, 0, 0, 0, 0, '{}')",
    ).run(minute - 1);
    const p = analytics.presenceSeries(db, t - 7 * 86_400_000, t);
    expect(p.peakUsers).toBeGreaterThanOrEqual(4);
  });
});

describe("resource readings", () => {
  it("parses /proc and cgroup files", () => {
    expect(parseCpu("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3")).toEqual({ busy: 150, total: 1000 });
    expect(parseMeminfo("MemTotal:       8000000 kB\nMemFree: 1 kB\nMemAvailable:   2000000 kB\n")).toEqual({ total: 8_192_000_000, available: 2_048_000_000 });
    const net = parseNetDev("Inter-|   Receive\n face |bytes\n    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n  eth0: 1000 10 1 2 0 0 0 0 4000 20 3 4 0 0 0 0\n");
    expect(net).toEqual({ eth0: { rx: 1000, rxErrors: 1, rxDrops: 2, tx: 4000, txErrors: 3, txDrops: 4 } });
    expect(parseDiskstats("   8       0 sda 100 0 2000 0 50 0 4000 0 0 300 0\n   8       1 sda1 1 0 1 0 1 0 1 0 0 1 0\n")).toEqual({ readBytes: 2000 * 512, writeBytes: 4000 * 512, busyMs: 300 });
    expect(parseCpuMax("100000 100000\n")).toBe(1);
    expect(parseCpuMax("max 100000\n")).toBeNull();
  });

  it("gives rates only from a previous reading, and nothing for what can't be read", () => {
    const files: Record<string, string> = {
      "/proc/stat": "cpu  100 0 50 800 50 0 0 0\n",
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\n",
    };
    const reader: Reader = { read: (f) => files[f] ?? null, statfs: () => null };
    let t = 1_000_000;
    const s = new ResourceSampler({ dataDir: "/nowhere", databasePath: "/nowhere/db", hostMetricsFile: null, reader, clock: () => t });
    const first = s.sample().map((x) => x.series);
    expect(first).toContain("host.mem.used_bytes");
    expect(first).not.toContain("host.cpu.pct");
    expect(first).not.toContain("host.disk.used_bytes");
    files["/proc/stat"] = "cpu  200 0 100 900 50 0 0 0\n";
    t += 60_000;
    const cpu = s.sample().find((x) => x.series === "host.cpu.pct");
    expect(cpu?.value).toBe(60); // 150 busy of 250 jiffies
    s.stop();
  });

  it("reads the host collector only while it reports, and keeps other workloads as one group", () => {
    let t = 10_000_000;
    const file = (at: number, cpu: number, tx: number) =>
      JSON.stringify({
        version: 1,
        at,
        hostname: "srv",
        interfaces: { eth0: { rx: 0, tx, rxErrors: 0, txErrors: 0, rxDrops: 0, txDrops: 0 } },
        containers: [
          { group: "api", cpuUsec: cpu, memBytes: 100, memLimit: 512, netRx: 0, netTx: tx, ioRead: 0, ioWrite: 0 },
          { group: "somebody-elses-shop", cpuUsec: 1, memBytes: 1, memLimit: null, netRx: 0, netTx: 0, ioRead: 0, ioWrite: 0 },
        ],
      });
    const files: Record<string, string> = { "/host/m.json": file(t, 0, 0) };
    const s = new ResourceSampler({ dataDir: "/x", databasePath: "/x/db", hostMetricsFile: "/host/m.json", reader: { read: (f) => files[f] ?? null, statfs: () => null }, clock: () => t });
    s.sample();
    expect(s.collectorStatus()).toMatchObject({ configured: true, reporting: true, hostname: "srv" });
    t += 60_000;
    files["/host/m.json"] = file(t, 30_000_000, 6_000_000);
    const out = Object.fromEntries(s.sample().map((x) => [x.series, x.value]));
    expect(out["svc.api.cpu_pct"]).toBe(50); // 30 s of CPU in 60 s
    expect(out["host.net.tx_bps"]).toBe(100_000);
    expect(Object.keys(out).some((k) => k.includes("shop"))).toBe(false);
    t += 10 * 60_000;
    expect(s.sample().some((x) => x.series.startsWith("svc."))).toBe(false); // stale: nothing from it
    expect(s.collectorStatus().reporting).toBe(false);
    s.stop();
  });
});
