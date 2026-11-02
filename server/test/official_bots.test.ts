import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDice } from "../src/modules/officialBots/helper.js";
import { CommunityOfficialBots, OfficialBotOne, OfficialBotsCatalog } from "../src/shared/contracts/http/officialBots.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin } from "./support/adminConsole.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Official bots (community parity batch D, feature "community-bots", docs/COMMUNITY_PARITY_API.md › Official bots):
 * the catalog, turning bots on and off as members of the community with their own look, Plus extras behind Bots+,
 * Welcomer and Helper. Runs with the community tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const code = (e: { error: { code: string } }) => e.error.code;
let n = 0;
const nextId = () => `m_ob_${++n}_${Date.now()}`;

interface Stored {
  id: string;
  senderUserId: string;
  payload: { text?: string; mentions?: string[] };
}

describe("dice", () => {
  it("reads !roll, !roll 20 and !roll 2d6 within sane limits", () => {
    expect(parseDice("")).toEqual({ count: 1, sides: 6 });
    expect(parseDice("20")).toEqual({ count: 1, sides: 20 });
    expect(parseDice("2d6")).toEqual({ count: 2, sides: 6 });
    expect(parseDice("d8")).toEqual({ count: 1, sides: 8 });
    for (const bad of ["0d6", "21d6", "2d1", "2d1001", "lots", "-1"]) expect(parseDice(bad)).toBeNull();
  });
});

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("official bots with communities in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, member: GriipClient, other: GriipClient, newcomer: GriipClient, outsider: GriipClient;
  let orgId: string, general: string, staff: string, voice: string, invite: string, otherOrgChannel: string;
  const base = () => `/v1/orgs/${orgId}/official-bots`;
  const settle = () => h.ctx.officialBots.settled();
  const say = (c: GriipClient, conv: string, text: string, extra: Record<string, unknown> = {}) =>
    c.req("POST", "/v2/messages", { conversationId: conv, messageId: nextId(), cls: "message", sentAt: Date.now(), payload: { type: "text", text, ...extra } });
  const botSaid = async (conv: string, botId: string): Promise<Stored[]> => {
    await settle();
    return ((await owner.req("GET", `/v2/conversations/${conv}/messages?limit=100`)).messages as Stored[]).filter((m) => m.senderUserId === botId).reverse();
  };
  const put = (c: GriipClient, key: string, body: unknown) => c.req("PUT", `${base()}/${key}`, body);
  const plus = (on: boolean) => h.ctx.officialBots.setPlus(orgId, on ? { by: "test", expiresAt: null, reason: "tests" } : null);

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, member, other, newcomer, outsider] = await Promise.all(["obowner", "obmember", "obother", "obnewcomer", "oboutsider"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Night Owls" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [member, other]) await c.req("POST", "/v1/invites/accept", { code: invite });
    general = h.ctx.ws.get<{ id: string }>("conversations", { org_id: orgId, name: "general" })!.id;
    staff = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "staff", kind: "PRIVATE" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "hangout", voice: true })).channel.id;
    const elsewhere = (await outsider.req("POST", "/v1/orgs", { name: "Elsewhere" })).org.id;
    otherOrgChannel = h.ctx.ws.get<{ id: string }>("conversations", { org_id: elsewhere, name: "general" })!.id;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("is advertised with a catalog of nine bots, all but Alerts available without a YouTube API key", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-bots");
    const c = await member.req("GET", "/v1/official-bots");
    expect(OfficialBotsCatalog.safeParse(c).success).toBe(true);
    expect(c.bots.map((b: { key: string }) => b.key)).toEqual(["welcomer", "helper", "levels", "logger", "starboard", "giveaways", "tickets", "alerts", "wordy"]);
    expect(c.bots.filter((b: { available: boolean }) => b.available).map((b: { key: string }) => b.key)).toEqual(["welcomer", "helper", "levels", "logger", "starboard", "giveaways", "tickets", "wordy"]);
    expect(c.bots.find((b: { key: string }) => b.key === "alerts")).toMatchObject({ available: false, unavailableReason: "Needs a YouTube API key on this server" });
    expect(c.bots.find((b: { key: string }) => b.key === "helper").commands.map((x: { usage: string }) => x.usage)).toContain("!afk reason");
  });

  it("shows a community's bots to members, settings only to editors, and nothing to outsiders", async () => {
    const seen = await member.req("GET", base());
    expect(CommunityOfficialBots.safeParse(seen).success).toBe(true);
    expect(seen).toMatchObject({ botsPlus: false, botsPlusUntil: null, canEdit: false });
    expect(seen.bots.every((b: { settings: unknown; enabled: boolean }) => b.settings === null && !b.enabled)).toBe(true);
    const mine = await owner.req("GET", base());
    expect(mine.canEdit).toBe(true);
    expect(mine.bots.find((b: { key: string }) => b.key === "starboard").settings).toEqual({ channelId: null, threshold: 5, emoji: null, selfStar: false, excludeChannelIds: [] });
    expect(mine.bots.find((b: { key: string }) => b.key === "wordy")).toMatchObject({ available: true, settings: { channelId: null } });
    expect(mine.bots.find((b: { key: string }) => b.key === "alerts")).toMatchObject({ available: false, settings: null });
    expect(code(await expectStatus(outsider.req("GET", base()), 404))).toBe("not_found");
  });

  it("is changed only by people who can edit the community, and Alerts can't be turned on without a YouTube API key", async () => {
    expect(code(await expectStatus(put(member, "welcomer", { enabled: true }), 403))).toBe("forbidden");
    expect(code(await expectStatus(put(owner, "alerts", { enabled: true }), 409))).toBe("official_bot_unavailable");
    expect(code(await expectStatus(put(owner, "welcomer", { look: { name: "x".repeat(33) } }), 400))).toBe("bad_request");
    expect(code(await expectStatus(put(owner, "starboard", { settings: { threshold: 6 } }), 400))).toBe("bad_request");
    expect(code(await expectStatus(put(owner, "welcomer", { settings: { nonsense: true } }), 400))).toBe("bad_request");
  });

  it("turns a bot on as a bot member with its own name and picture, and off again keeping its settings", async () => {
    const on = await put(owner, "welcomer", { enabled: true, look: { name: "Doorbell" }, settings: { messages: ["Hi {user}! {name} makes {count} of us in {server}."] } });
    expect(OfficialBotOne.safeParse(on).success).toBe(true);
    expect(on.bot).toMatchObject({ key: "welcomer", enabled: true, look: { name: "Doorbell", displayName: "Doorbell", photoRev: null } });
    const botId = on.bot.userId as string;
    const members = (await member.req("GET", `/v1/orgs/${orgId}/members`)).members;
    expect(members.find((m: { id: string }) => m.id === botId)).toMatchObject({ bot: true, displayName: "Doorbell" });
    const pictured = await owner.req("PUT", `${base()}/welcomer/avatar`, undefined, JPEG);
    expect(pictured.bot.look.photoRev).toBeGreaterThan(0);
    expect(Buffer.compare(await member.req("GET", `/v1/users/${botId}/photo`), JPEG)).toBe(0);
    expect((await owner.req("DELETE", `${base()}/welcomer/avatar`)).bot.look.photoRev).toBeNull();
    expect((await put(owner, "welcomer", { enabled: false })).bot.enabled).toBe(false);
    expect((await member.req("GET", `/v1/orgs/${orgId}/members`)).members.some((m: { id: string }) => m.id === botId)).toBe(false);
    const back = await put(owner, "welcomer", { enabled: true });
    expect(back.bot).toMatchObject({ userId: botId, settings: { messages: ["Hi {user}! {name} makes {count} of us in {server}."] } });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "official_bot.on" })).toBe(2);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "official_bot.off" })).toBe(1);
  });

  it("turns off a bot that a manager removes from the member list", async () => {
    const botId = (await put(owner, "helper", { enabled: true })).bot.userId;
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${botId}`);
    await settle();
    expect((await owner.req("GET", `${base()}/helper`)).bot.enabled).toBe(false);
  });

  it("checks the channels and roles settings name", async () => {
    for (const channelId of [voice, otherOrgChannel, "c_nowhere"]) {
      const refused = await expectStatus(put(owner, "logger", { settings: { channelId } }), 400);
      expect(refused.error).toMatchObject({ code: "official_bot_channel_invalid", details: { field: "channelId", channelId } });
    }
    expect((await put(owner, "logger", { settings: { channelId: staff } })).bot.settings.channelId).toBe(staff);
    expect(code(await expectStatus(put(owner, "helper", { settings: { commands: [{ name: "roll", response: "no" }] } }), 403))).toBe("bots_plus_required");
  });

  it("refuses Plus extras without Bots+, and keeps them paused while it's gone", async () => {
    const refused = await expectStatus(put(owner, "welcomer", { settings: { messages: ["One", "Two"], goodbye: "Bye {user}" } }), 403);
    expect(refused.error).toMatchObject({ code: "bots_plus_required", details: { bot: "welcomer", settings: ["messages", "goodbye"] } });
    await plus(true);
    expect((await owner.req("GET", base())).botsPlus).toBe(true);
    expect(code(await expectStatus(put(owner, "helper", { settings: { commands: [{ name: "roll", response: "no" }] } }), 400))).toBe("bad_request");
    const set = await put(owner, "welcomer", { settings: { messages: ["Hi {user}!", "Hello {user}!"], goodbye: "Bye {user}, from {server}." } });
    expect(set.bot.settings.messages).toHaveLength(2);
    await plus(false);
    const paused = (await owner.req("GET", `${base()}/welcomer`)).bot;
    expect(paused.plusPaused).toEqual(["messages", "goodbye"]);
    expect(paused.settings.goodbye).toBe("Bye {user}, from {server}.");
    // Changing something else is fine; the extras stay stored.
    expect((await put(owner, "welcomer", { settings: { channelId: general } })).bot.settings.messages).toHaveLength(2);
  });

  it("Welcomer greets a newcomer once with the placeholders filled, and sends a test", async () => {
    await plus(true);
    await put(owner, "welcomer", { settings: { messages: ["Hi {user}! {name} makes {count} of us in {server}."], goodbye: null } });
    await plus(false);
    const botId = (await owner.req("GET", `${base()}/welcomer`)).bot.userId;
    await newcomer.req("POST", "/v1/invites/accept", { code: invite });
    const said = await botSaid(general, botId);
    expect(said).toHaveLength(1);
    expect(said[0]!.payload.text).toBe(`Hi @${newcomer.username}! obnewcomer makes 4 of us in Night Owls.`);
    expect(said[0]!.payload.mentions).toEqual([newcomer.userId]);
    const test = await owner.req("POST", `${base()}/welcomer/test`);
    expect(test.channelId).toBe(general);
    expect((await botSaid(general, botId)).at(-1)!.payload.text).toContain(`@${owner.username}`);
    expect(code(await expectStatus(member.req("POST", `${base()}/welcomer/test`), 403))).toBe("forbidden");
  });

  it("Welcomer says goodbye only with Bots+", async () => {
    const botId = (await owner.req("GET", `${base()}/welcomer`)).bot.userId;
    await plus(true);
    await put(owner, "welcomer", { settings: { goodbye: "Bye {user}, from {server}." } });
    const before = (await botSaid(general, botId)).length;
    await newcomer.req("DELETE", `/v1/orgs/${orgId}/members/${newcomer.userId}`);
    const said = await botSaid(general, botId);
    expect(said).toHaveLength(before + 1);
    expect(said.at(-1)!.payload).toEqual({ type: "text", text: "Bye obnewcomer, from Night Owls." });
    await plus(false);
    await newcomer.req("POST", "/v1/invites/accept", { code: invite });
    await newcomer.req("DELETE", `/v1/orgs/${orgId}/members/${newcomer.userId}`);
    // A greeting for coming back, no goodbye without Bots+.
    expect((await botSaid(general, botId)).filter((m) => m.payload.text?.startsWith("Bye"))).toHaveLength(1);
    await put(owner, "welcomer", { enabled: false });
    expect(code(await expectStatus(owner.req("POST", `${base()}/welcomer/test`), 409))).toBe("official_bot_off");
  });

  it("Helper answers commands where it can post, and !help lists every bot's commands", async () => {
    const botId = (await put(owner, "helper", { enabled: true })).bot.userId;
    await put(owner, "levels", { enabled: true });
    await say(member, general, "!roll 2d6");
    await say(member, general, "!roll 99d6");
    await say(member, general, "!flip");
    await say(member, general, "!choose tea | coffee");
    await say(member, general, "!8ball will it rain?");
    await say(member, general, "!help");
    await say(member, general, "!nothing-here");
    const said = (await botSaid(general, botId)).map((m) => m.payload.text ?? "");
    expect(said).toHaveLength(6);
    expect(said[0]).toMatch(/^🎲 obmember rolled 2d6: \d+ \+ \d+ = \d+$/);
    expect(said[1]).toContain("Try !roll");
    expect(said[2]).toMatch(/^🪙 obmember flipped a coin: (heads|tails)\.$/);
    expect(said[3]).toMatch(/^🤔 I pick: (tea|coffee)$/);
    expect(said[4]).toMatch(/^🎱 /);
    expect(said[5]).toContain("!roll or !roll 2d6");
    expect(said[5]).toContain("!rank");
    // Not in the private channel it isn't a member of.
    await say(owner, staff, "!flip");
    expect(await botSaid(staff, botId)).toHaveLength(0);
    await put(owner, "levels", { enabled: false });
  });

  it("Helper's away note answers a mention once per person and ends with the next message", async () => {
    const botId = (await owner.req("GET", `${base()}/helper`)).bot.userId;
    const before = (await botSaid(general, botId)).length;
    await say(member, general, "!afk walking the dog");
    await say(other, general, `@${member.username} are you there?`, { mentions: [member.userId] });
    await say(other, general, `@${member.username} hello?`, { mentions: [member.userId] });
    await say(member, general, "back now");
    const said = (await botSaid(general, botId)).slice(before).map((m) => m.payload.text ?? "");
    expect(said).toHaveLength(3);
    expect(said[0]).toContain("obmember is away: walking the dog");
    expect(said[1]).toMatch(/^💤 obmember is away: walking the dog \(/);
    expect(said[2]).toContain("Welcome back, obmember");
    expect(h.ctx.ws.count("bot_afk", { org_id: orgId })).toBe(0);
  });

  it("Helper runs a community's own commands with Bots+ only", async () => {
    const botId = (await owner.req("GET", `${base()}/helper`)).bot.userId;
    await plus(true);
    await put(owner, "helper", { settings: { commands: [{ name: "Rules", response: "{user}, read #rules first!" }] } });
    const before = (await botSaid(general, botId)).length;
    await say(member, general, "!rules");
    await plus(false);
    await say(member, general, "!rules");
    const said = (await botSaid(general, botId)).slice(before);
    expect(said).toHaveLength(1);
    expect(said[0]!.payload).toEqual({ type: "text", text: `@${member.username}, read #rules first!`, mentions: [member.userId] });
  });
});

describe("official bots switched off and Bots+ from the console", () => {
  let h: Harness;
  const mailer = new MemoryMailer();

  beforeAll(async () => {
    h = await startServer({ COMMUNITY_BOTS: "off", ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN }, { mailer });
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("answers 503 and keeps quiet while COMMUNITY_BOTS=off", async () => {
    const owner = await h.client("oboffowner");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Quiet" })).org.id;
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-bots");
    expect(code(await expectStatus(owner.req("GET", "/v1/official-bots"), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/official-bots`), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/official-bots/welcomer`, { enabled: true }), 503))).toBe("feature_disabled");
  });

  it("is granted and taken away by platform admins, with an end date and a reason", async () => {
    const owner = await h.client("obplusowner");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Plus Club" })).org.id;
    const billing = (await consoleAdmin(h, mailer, "billing_admin", "obbilling")).browser;
    const auditor = (await consoleAdmin(h, mailer, "auditor", "obauditor")).browser;
    const url = `/admin/v1/orgs/${orgId}/bots-plus`;
    const reason = "Early supporter of the community bots";
    await billing.expect(400, "PUT", url, { enabled: true, reason });
    await billing.expect(403, "PUT", url, { enabled: true, expiresAt: null, reason });
    await auditor.expect(403, "PUT", url, { enabled: true, expiresAt: Date.now() + 86_400_000, reason });
    const until = Date.now() + 30 * 86_400_000;
    const granted = await billing.expect(200, "PUT", url, { enabled: true, expiresAt: until, reason });
    expect(granted.botsPlus).toMatchObject({ enabled: true, expiresAt: until, reason });
    expect(h.ctx.officialBots.hasPlus(orgId)).toBe(true);
    expect((await billing.expect(200, "GET", url)).botsPlus.enabled).toBe(true);
    await billing.expect(200, "PUT", url, { enabled: false, reason });
    expect(h.ctx.officialBots.hasPlus(orgId)).toBe(false);
    expect(h.ctx.platform.count("platform_audit", { action: "org.bots_plus_grant" })).toBe(1);
    expect(h.ctx.platform.count("platform_audit", { action: "org.bots_plus_revoke" })).toBe(1);
  });
});
