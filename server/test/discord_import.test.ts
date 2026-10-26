import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { CLIENT_ID, type FakeDiscord, fakeDiscord, GUILD, OTHER_GUILD } from "./support/fakeDiscord.js";

/**
 * Importing a Discord server's structure (docs/DISCORD_IMPORT.md), against a local stand-in for Discord's API: only
 * someone who manages the server can connect it; their Discord token is revoked at once; the preview says what's made
 * and what isn't; the import makes it once, retries without duplicates, and never writes to Discord.
 */
let h: Harness;
let off: Harness;
let fake: FakeDiscord;
let owner: GriipClient, member: GriipClient, other: GriipClient;

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    const err = e as { status?: number; body?: { error?: { code?: string } } };
    return { status: err.status ?? 0, code: err.body?.error?.code };
  }
};

/** Starts connecting as [c] and finishes it with a code Discord would hand back for [token]. */
async function connect(c: GriipClient, token: string, code: string, guildId: string | null = GUILD) {
  const { url } = await c.req("POST", "/v1/discord/connect");
  const state = new URL(url).searchParams.get("state")!;
  fake.codes.set(code, { token, guildId });
  return { state, result: c.req("POST", "/v1/discord/callback", { code, state, ...(guildId ? { guildId } : {}) }) };
}

async function finished(c: GriipClient, id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await c.req("GET", `/v1/discord/imports/${id}`);
    if (r.import.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("import didn't finish");
}

const ALL = { icon: true, roles: true, rolePermissions: false, channels: true, emojis: true };

beforeAll(async () => {
  fake = await fakeDiscord();
  h = await startServer(fake.env);
  off = await startServer();
  [owner, member, other] = await Promise.all(["dcowner", "dcmember", "dcother"].map((n) => h.client(n)));
  fake.users.set("tok-owner", { id: "900000000000000001", guilds: [{ id: GUILD, name: "Pixel Club", owner: true, permissions: "0" }] });
  fake.users.set("tok-member", {
    id: "900000000000000002",
    guilds: [
      { id: GUILD, name: "Pixel Club", owner: false, permissions: String(1n << 10n) },
      { id: OTHER_GUILD, name: "Other", owner: false, permissions: String(1n << 5n) },
    ],
  });
});
afterAll(async () => {
  await h.close();
  await off.close();
  await fake.close();
});

describe("Discord import, not set up", () => {
  it("says so, and refuses to start", async () => {
    const c = await off.client("dcoff");
    expect(await c.req("GET", "/v1/discord/status")).toEqual({ configured: false, connections: [] });
    expect(await status(c.req("POST", "/v1/discord/connect"))).toEqual({ status: 409, code: "discord_not_configured" });
    expect(await status(c.req("POST", "/v1/discord/imports", { connectionId: "x", destination: { name: "X" }, options: ALL }))).toMatchObject({ status: 409 });
  });
});

describe("connecting Discord", () => {
  it("asks Discord for the bot with only View Channels, and the person's identity and servers", async () => {
    const { url } = await owner.req("POST", "/v1/discord/connect");
    const u = new URL(url);
    expect(u.origin).toBe("https://discord.com");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("scope")).toBe("bot identify guilds");
    expect(u.searchParams.get("permissions")).toBe(String(1n << 10n));
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(40);
  });

  it("refuses a state it didn't issue, or one issued to someone else", async () => {
    expect(await status(owner.req("POST", "/v1/discord/callback", { code: "c-x", state: "a".repeat(43), guildId: GUILD }))).toMatchObject({ status: 400 });
    const { url } = await other.req("POST", "/v1/discord/connect");
    const state = new URL(url).searchParams.get("state")!;
    fake.codes.set("c-steal", { token: "tok-owner", guildId: GUILD });
    expect(await status(owner.req("POST", "/v1/discord/callback", { code: "c-steal", state, guildId: GUILD }))).toMatchObject({ status: 400 });
  });

  it("refuses someone without Manage Server there, and still revokes their token", async () => {
    const { result } = await connect(member, "tok-member", "c-member");
    expect(await status(result)).toEqual({ status: 403, code: "discord_not_allowed" });
    expect(fake.revoked).toContain("tok-member");
  });

  it("refuses a server the bot wasn't added to", async () => {
    const { result } = await connect(member, "tok-member", "c-other", OTHER_GUILD);
    expect(await status(result)).toEqual({ status: 409, code: "discord_bot_missing" });
  });

  it("connects the owner's server, keeps no token, and the state works once", async () => {
    const before = fake.revoked.length;
    const { state, result } = await connect(owner, "tok-owner", "c-owner");
    const { connection } = await result;
    expect(connection).toMatchObject({ guildId: GUILD, guildName: "Pixel Club" });
    expect(fake.revoked.slice(before)).toEqual(["tok-owner"]);
    fake.codes.set("c-again", { token: "tok-owner", guildId: GUILD });
    expect(await status(owner.req("POST", "/v1/discord/callback", { code: "c-again", state, guildId: GUILD }))).toMatchObject({ status: 400 });
    const s = await owner.req("GET", "/v1/discord/status");
    expect(s.configured).toBe(true);
    expect(s.connections.map((c: { id: string }) => c.id)).toEqual([connection.id]);
    const rows = h.ctx.db.prepare("SELECT * FROM discord_connections").all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain("tok-owner");
    expect(await other.req("GET", "/v1/discord/status")).toEqual({ configured: true, connections: [] });
  });
});

describe("previewing and importing", () => {
  let connectionId: string;
  beforeAll(async () => {
    connectionId = (await owner.req("GET", "/v1/discord/status")).connections[0].id;
  });

  it("previews every item with what happens to it, and what is never imported", async () => {
    const p = await owner.req("GET", `/v1/discord/connections/${connectionId}/preview`);
    expect(p.guild).toEqual({ id: GUILD, name: "Pixel Club", description: "We make pixel art" });
    const by = (key: string) => p.items.find((i: { key: string }) => i.key === key);
    expect(by(`role:${GUILD}`)).toBeUndefined();
    expect(by("role:300000000000000003")).toMatchObject({ action: "skip" });
    expect(by("role:300000000000000002").note).toContain("not copied: Administrator");
    expect(by("channel:500000000000000012")).toMatchObject({ action: "create", note: expect.stringContaining("Private in Discord") });
    expect(by("channel:500000000000000021").note).toContain("voice channel");
    expect(by("channel:500000000000000030")).toMatchObject({ action: "skip" });
    expect(by("emoji:400000000000000003")).toMatchObject({ action: "skip" });
    expect(p.excluded.join(" ")).toContain("Messages");
    expect(await status(other.req("GET", `/v1/discord/connections/${connectionId}/preview`))).toMatchObject({ status: 404 });
  });

  it("imports into a new private community, item by item, without writing to Discord", async () => {
    const r = await owner.req("POST", "/v1/discord/imports", { connectionId, destination: { name: "Pixel Club" }, options: ALL });
    expect(r.import.status).toBe("running");
    const done = await finished(owner, r.import.id);
    expect(done.import.status).toBe("completed");
    const orgId = done.import.orgId as string;
    const org = (await owner.req("GET", `/v1/orgs/${orgId}`)).org;
    expect(org).toMatchObject({ name: "Pixel Club", visibility: "private", joinPolicy: "invite", myRole: "OWNER" });
    expect(org.photoRev).toBeGreaterThan(0);

    const channels = h.ctx.db.prepare("SELECT name, kind, voice, format, category_id FROM conversations WHERE org_id = ? AND type = 'CHANNEL' ORDER BY name").all(orgId) as any[];
    expect(channels.map((c) => c.name)).toEqual(["Lounge 🎧", "Stage", "announcements", "general", "showcase", "staff-only"]);
    expect(channels.find((c) => c.name === "staff-only").kind).toBe("PRIVATE");
    expect(channels.find((c) => c.name === "announcements").kind).toBe("ANNOUNCEMENT");
    expect(channels.find((c) => c.name === "showcase").format).toBe("forum");
    expect(channels.find((c) => c.name === "Stage").voice).toBe(1);
    const cats = h.ctx.db.prepare("SELECT id, name FROM channel_categories WHERE org_id = ? ORDER BY position").all(orgId) as { id: string; name: string }[];
    expect(cats.map((c) => c.name)).toEqual(["Info", "Voice"]);
    expect(channels.find((c) => c.name === "general").category_id).toBe(cats[0].id);

    const roles = h.ctx.db.prepare("SELECT name, color, permissions FROM org_roles WHERE org_id = ? ORDER BY name").all(orgId) as any[];
    expect(roles).toEqual([
      { name: "Admins", color: "#E74C3C", permissions: "[]" },
      { name: "Moderators", color: "#3498DB", permissions: "[]" },
    ]);
    const emoji = h.ctx.db.prepare("SELECT name FROM community_expressions WHERE org_id = ? ORDER BY name").all(orgId) as { name: string }[];
    expect(emoji.map((e) => e.name)).toEqual(["party_parrot", "wave_hi"]);

    const writes = fake.requests.filter((q) => q.method !== "GET" && !q.path.startsWith("/api/oauth2/"));
    expect(writes).toEqual([]);
    expect(done.items.every((i: { status: string }) => i.status === "done" || i.status === "skipped")).toBe(true);
    expect(await status(other.req("GET", `/v1/discord/imports/${r.import.id}`))).toMatchObject({ status: 404 });
  });

  it("copies role permissions only when asked, never Administrator", async () => {
    const own = (await owner.req("POST", "/v1/orgs", { name: "Perm Test" })).org.id;
    const r = await owner.req("POST", "/v1/discord/imports", {
      connectionId,
      destination: { orgId: own },
      options: { icon: false, roles: true, rolePermissions: true, channels: false, emojis: false },
    });
    await finished(owner, r.import.id);
    const roles = h.ctx.db.prepare("SELECT name, permissions FROM org_roles WHERE org_id = ? ORDER BY name").all(own) as { name: string; permissions: string }[];
    expect(JSON.parse(roles.find((x) => x.name === "Moderators")!.permissions).sort()).toEqual(["members.ban", "members.remove", "members.timeout"]);
    expect(JSON.parse(roles.find((x) => x.name === "Admins")!.permissions)).toEqual([]);
  });

  it("retries only what failed, without making anything twice", async () => {
    fake.failEmoji.add("400000000000000001");
    fake.rateLimitOnce.add(`/api/guilds/${GUILD}/channels`);
    const r = await owner.req("POST", "/v1/discord/imports", { connectionId, destination: { name: "Pixel Club Two" }, options: ALL });
    const first = await finished(owner, r.import.id);
    expect(first.import.status).toBe("completed_with_errors");
    expect(first.items.find((i: { key: string }) => i.key === "emoji:400000000000000001").status).toBe("failed");
    const orgId = first.import.orgId;
    const count = () => (h.ctx.db.prepare("SELECT COUNT(*) n FROM conversations WHERE org_id = ?").get(orgId) as { n: number }).n;
    const channelsBefore = count();
    expect(channelsBefore).toBe(6);

    fake.failEmoji.clear();
    await owner.req("POST", `/v1/discord/imports/${r.import.id}/retry`);
    const second = await finished(owner, r.import.id);
    expect(second.import.status).toBe("completed");
    expect(second.import.orgId).toBe(orgId);
    expect(count()).toBe(channelsBefore);
    expect((h.ctx.db.prepare("SELECT COUNT(*) n FROM orgs WHERE name = 'Pixel Club Two'").get() as { n: number }).n).toBe(1);
    expect((h.ctx.db.prepare("SELECT COUNT(*) n FROM community_expressions WHERE org_id = ?").get(orgId) as { n: number }).n).toBe(2);
  });

  it("refuses an existing community where the person can't make those things, and a name they already own", async () => {
    const theirs = (await other.req("POST", "/v1/orgs", { name: "Not Yours" })).org.id;
    const code = (await other.req("POST", `/v1/orgs/${theirs}/invites`, { role: "MEMBER" })).invite.code;
    await owner.req("POST", "/v1/invites/accept", { code });
    expect(await status(owner.req("POST", "/v1/discord/imports", { connectionId, destination: { orgId: theirs }, options: ALL }))).toMatchObject({ status: 403 });
    expect(await status(owner.req("POST", "/v1/discord/imports", { connectionId, destination: { name: "Pixel Club" }, options: ALL }))).toEqual({ status: 409, code: "org_name_taken" });
    expect(await status(other.req("POST", "/v1/discord/imports", { connectionId, destination: { name: "Mine" }, options: ALL }))).toMatchObject({ status: 404 });
  });

  it("disconnects, and the bot leaves only when asked", async () => {
    const r = await owner.req("DELETE", `/v1/discord/connections/${connectionId}?leave=true`);
    expect(r).toEqual({ ok: true, botLeft: true });
    expect(fake.botIn.has(GUILD)).toBe(false);
    expect((await owner.req("GET", "/v1/discord/status")).connections).toEqual([]);
    expect(await status(owner.req("GET", `/v1/discord/connections/${connectionId}/preview`))).toMatchObject({ status: 404 });
  });
});
