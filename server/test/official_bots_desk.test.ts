import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fillAlert } from "../src/modules/officialBots/alerts.js";
import { type ChannelRef, parseChannelRef, type Upload, type VideoSource } from "../src/modules/officialBots/youtube.js";
import { AlertWatches } from "../src/shared/contracts/http/officialBotTools.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Official bots that work for the community (community parity batch D part 2, docs/COMMUNITY_PARITY_API.md › Official
 * bots): the Tickets bot (the tickets switch, its settings as the tickets config, Bots+ limits, support roles, welcome
 * lines and transcripts) and Alerts (a fake YouTube: new uploads only, never twice, role pings, unconfigured servers).
 * Runs with the community tables in SQLite and in MongoDB; never calls the real YouTube API.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;
const about = "My account got muted by mistake";

/** A YouTube that knows a few channels, whose uploads the test sets. */
class FakeYoutube implements VideoSource {
  readonly uploadsOf = new Map<string, Upload[]>();
  calls = 0;
  async channel(ref: ChannelRef) {
    const name = "handle" in ref ? ref.handle : "id" in ref ? ref.id : ref.username;
    return ["speedy", "UCaaaaaaaaaaaaaaaaaaaaaa", "chefanna", "drawdaily", "moremusic"].includes(name) ? { id: `UC_${name}`, title: `${name} TV`, uploadsId: `UU_${name}` } : null;
  }
  async uploads(uploadsId: string) {
    this.calls++;
    return this.uploadsOf.get(uploadsId) ?? [];
  }
}

describe("Alerts' parts", () => {
  it("read YouTube links and handles", () => {
    expect(parseChannelRef("https://www.youtube.com/@Speedy")).toEqual({ handle: "Speedy" });
    expect(parseChannelRef("youtube.com/@speedy/videos")).toEqual({ handle: "speedy" });
    expect(parseChannelRef("@speedy")).toEqual({ handle: "speedy" });
    expect(parseChannelRef("https://youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa")).toEqual({ id: "UCaaaaaaaaaaaaaaaaaaaaaa" });
    expect(parseChannelRef("https://m.youtube.com/user/oldname")).toEqual({ username: "oldname" });
    for (const bad of ["https://example.com/@speedy", "speedy", "https://youtube.com/watch?v=abc", "@x"]) expect(parseChannelRef(bad)).toBeNull();
  });

  it("fill the line, with the role only when there is one", () => {
    const v = { creator: "Ana", title: "Night run", url: "https://www.youtube.com/watch?v=1" };
    expect(fillAlert("{role} 📣 {creator}: {title}\n{url}", { ...v, role: null })).toBe("📣 Ana: Night run\nhttps://www.youtube.com/watch?v=1");
    expect(fillAlert("{role} 📣 {creator}: {title}", { ...v, role: "Fans" })).toBe("@Fans 📣 Ana: Night run");
    expect(fillAlert("New from {creator}: {url}", { ...v, role: "Fans" })).toBe("@Fans New from Ana: https://www.youtube.com/watch?v=1");
  });
});

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("official bots that work for the community, in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, member: GriipClient, helper: GriipClient;
  let orgId: string, support: string, logs: string, videos: string, fansRole: string;
  const base = () => `/v1/orgs/${orgId}/official-bots`;
  const put = (key: string, body: unknown) => owner.req("PUT", `${base()}/${key}`, body);
  const plus = (on: boolean) => h.ctx.officialBots.setPlus(orgId, on ? { by: "test", expiresAt: null, reason: "tests" } : null);
  const history = async (conv: string) => {
    await h.ctx.officialBots.settled();
    return (await owner.req("GET", `/v2/conversations/${conv}/messages?limit=100`)).messages as { senderUserId: string; payload: { text?: string; mentions?: string[]; roleMentions?: string[] } }[];
  };
  const panel = (name: string, extra: Record<string, unknown> = {}) => ({ name, postChannelId: support, categoryId: null, logChannelId: logs, ...extra });

  beforeAll(async () => {
    h = await startServer({ ...env, YOUTUBE_API_KEY: "test-key-never-used" });
    expect(h.ctx.ws.backend).toBe(_backend);
    [owner, member, helper] = await Promise.all(["obdowner", "obdmember", "obdhelper"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Help Desk" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [member, helper]) await c.req("POST", "/v1/invites/accept", { code: invite });
    const channel = async (name: string, kind = "PUBLIC") => (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name, kind })).channel.id as string;
    support = await channel("support");
    logs = await channel("ticket-log", "PRIVATE");
    videos = await channel("videos");
    fansRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Fans", permissions: [] })).role.id;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  describe("Tickets", () => {
    let botId: string;
    let helpers: string;

    it("is the tickets switch: on here turns tickets on, and its account posts for them", async () => {
      const on = await put("tickets", { enabled: true, look: { name: "Desk" } });
      botId = on.bot.userId;
      expect(on.bot).toMatchObject({ enabled: true, settings: { maxOpenPerPerson: 2, panels: [], transcripts: false } });
      expect((await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`)).enabled).toBe(true);
      expect((await member.req("GET", `/v1/orgs/${orgId}/members`)).members.find((m: { id: string }) => m.id === botId)).toMatchObject({ bot: true, displayName: "Desk" });
      await owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, { enabled: false, maxOpenPerPerson: 2, panels: [] });
      expect((await owner.req("GET", `${base()}/tickets`)).bot.enabled).toBe(false);
      expect((await member.req("GET", `/v1/orgs/${orgId}/members`)).members.some((m: { id: string }) => m.id === botId)).toBe(false);
      await put("tickets", { enabled: true });
      expect((await member.req("GET", `/v1/orgs/${orgId}/members`)).members.some((m: { id: string }) => m.id === botId)).toBe(true);
    });

    it("takes the tickets config as its settings, with 10 panels, 10 per person and extras only with Bots+", async () => {
      const three = [panel("Support"), panel("Reports"), panel("Appeals")];
      expect((await expectStatus(put("tickets", { settings: { panels: three } }), 403)).error).toMatchObject({ code: "bots_plus_required", details: { bot: "tickets", settings: ["panels"] } });
      expect(code(await expectStatus(put("tickets", { settings: { maxOpenPerPerson: 5 } }), 403))).toBe("bots_plus_required");
      expect(code(await expectStatus(put("tickets", { settings: { transcripts: true } }), 403))).toBe("bots_plus_required");
      await plus(true);
      helpers = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Helpers", permissions: [] })).role.id;
      await owner.req("PUT", `/v1/roles/${helpers}/members/${helper.userId}`);
      expect(code(await expectStatus(put("tickets", { settings: { panels: [panel("Support", { supportRoleId: "r_nowhere" })] } }), 400))).toBe("bad_request");
      const saved = await put("tickets", {
        settings: { maxOpenPerPerson: 5, transcripts: true, panels: [panel("Support", { supportRoleId: helpers, welcomeMessage: "Hi {user}, {panel} will be right with you." }), panel("Reports"), panel("Appeals")] },
      });
      expect(saved.bot.settings).toMatchObject({ maxOpenPerPerson: 5, transcripts: true });
      expect(saved.bot.settings.panels.map((p: { name: string; supportRoleId: string | null }) => [p.name, p.supportRoleId])).toEqual([["Support", helpers], ["Reports", null], ["Appeals", null]]);
      const cfg = await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`);
      expect(cfg).toMatchObject({ maxOpenPerPerson: 5, panelLimit: 10 });
      expect(cfg.panels.map((p: { id: string }) => p.id)).toEqual(saved.bot.settings.panels.map((p: { id: string }) => p.id));
    });

    it("lets the support role see and hear about new tickets, says the welcome line, and logs a transcript on close", async () => {
      const panels = (await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`)).panels;
      const { ticket } = await member.req("POST", `/v1/orgs/${orgId}/tickets`, { about, notABugReport: true, panelId: panels[0].id });
      expect((await helper.req("GET", `/v1/conversations/${ticket.channelId}`)).conversation.id).toBe(ticket.channelId);
      const said = (await history(ticket.channelId)).reverse();
      expect(said[0]).toMatchObject({ senderUserId: botId, payload: { roleMentions: [helpers] } });
      expect(said[0]!.payload.text).toMatch(/^@Helpers Ticket #\d+ · Support/);
      expect(said[1]).toMatchObject({ senderUserId: botId, payload: { text: `Hi @${member.username}, Support will be right with you.`, mentions: [member.userId] } });
      const say = (c: GriipClient, text: string) => c.req("POST", "/v2/messages", { conversationId: ticket.channelId, messageId: `m_obd_${text.length}_${Date.now()}`, cls: "message", sentAt: Date.now(), payload: { type: "text", text } });
      await say(member, "Screenshots attached soon");
      await say(helper, "Looking into it");
      await owner.req("POST", `/v1/orgs/${orgId}/tickets/${ticket.channelId}/close`);
      const logged = (await history(logs)).map((m) => m.payload.text ?? "");
      const transcript = logged.find((t) => t.startsWith("📄 Transcript of Ticket"))!;
      expect(transcript).toContain(`obdmember: Screenshots attached soon`);
      expect(transcript).toContain(`obdhelper: Looking into it`);
      expect(transcript).toContain(about);
    });

    it("logs a close notice without copying private transcript text to a public destination", async () => {
      const endpoint = `/v1/orgs/${orgId}/tickets`;
      const cfg = await owner.req("GET", `${endpoint}/config`);
      const editable = cfg.panels.map(({ postedMessageId: _ignored, ...p }: Record<string, unknown>) => p);
      const marker = "synthetic confidential public-log probe";
      try {
        await owner.req("PUT", `${endpoint}/config`, { enabled: true, maxOpenPerPerson: cfg.maxOpenPerPerson, panels: editable.map((p: Record<string, unknown>, i: number) => i === 0 ? { ...p, logChannelId: support } : p) });
        const { ticket } = await member.req("POST", endpoint, { about: marker, notABugReport: true, panelId: editable[0].id });
        await owner.req("POST", `${endpoint}/${ticket.channelId}/close`);
        const result = await helper.req("GET", `/v2/conversations/${support}/messages?limit=100`);
        expect(JSON.stringify(result)).toContain(`Ticket #${ticket.number} · Support closed by`);
        expect(JSON.stringify(result)).not.toContain(marker);
      } finally {
        await owner.req("PUT", `${endpoint}/config`, { enabled: true, maxOpenPerPerson: cfg.maxOpenPerPerson, panels: editable });
      }
    });

    it("rechecks a private transcript's readers after the ticket history read has started", async () => {
      const endpoint = `/v1/orgs/${orgId}/tickets`;
      const newcomer = await h.client("obdlogreader");
      const { invite } = await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 1 });
      await newcomer.req("POST", "/v1/invites/accept", { code: invite.code });
      const marker = "synthetic confidential transcript race probe";
      const { ticket } = await member.req("POST", endpoint, { about: marker, notABugReport: true });
      const read = h.ctx.messages.page.bind(h.ctx.messages);
      let added = false;
      const hook = vi.spyOn(h.ctx.messages, "page").mockImplementation(async (...args) => {
        if (!added && args[0] === ticket.channelId) {
          added = true;
          await owner.req("PUT", `/v1/conversations/${logs}/members/${newcomer.userId}`);
        }
        return read(...args);
      });
      try {
        await owner.req("POST", `${endpoint}/${ticket.channelId}/close`);
        expect(added).toBe(true);
        await expectStatus(newcomer.req("GET", `/v2/conversations/${ticket.channelId}/messages`), 404);
        expect(JSON.stringify(await history(logs))).not.toContain(marker);
      } finally {
        hook.mockRestore();
        if (added) await owner.req("DELETE", `/v1/conversations/${logs}/members/${newcomer.userId}`);
      }
    });

    it("falls back to the free limits while Bots+ is gone, keeping what was set", async () => {
      await plus(false);
      expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets).toMatchObject({ maxOpenPerPerson: 3 });
      expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets.panels).toHaveLength(2);
      expect((await owner.req("GET", `${base()}/tickets`)).bot.plusPaused.sort()).toEqual(["maxOpenPerPerson", "panels", "transcripts"]);
    });

    it("keeps a panel's paused extras when the panels are saved without them, and clears them on null", async () => {
      const [first, second] = (await owner.req("GET", `${base()}/tickets`)).bot.settings.panels as { id: string }[];
      const kept = await put("tickets", { settings: { panels: [panel("Help desk", { id: first!.id }), panel("Reports", { id: second!.id })] } });
      expect(kept.bot.settings.panels[0]).toMatchObject({ name: "Help desk", supportRoleId: helpers, welcomeMessage: "Hi {user}, {panel} will be right with you." });
      await plus(true);
      const cleared = await put("tickets", { settings: { panels: [panel("Help desk", { id: first!.id, supportRoleId: null, welcomeMessage: null }), panel("Reports", { id: second!.id })] } });
      expect(cleared.bot.settings.panels[0]).toMatchObject({ supportRoleId: null, welcomeMessage: null });
      await plus(false);
    });
  });

  describe("Alerts", () => {
    let botId: string;
    let fake: FakeYoutube;
    const watches = () => `${base()}/alerts/watches`;
    beforeAll(() => {
      fake = new FakeYoutube();
      h.ctx.officialBots.videoSource = fake;
    });

    it("is unavailable, and refuses, on a server without a YouTube API key", async () => {
      h.ctx.officialBots.videoSource = null;
      try {
        expect((await owner.req("GET", "/v1/official-bots")).bots.find((b: { key: string }) => b.key === "alerts")).toMatchObject({ available: false, unavailableReason: "Needs a YouTube API key on this server" });
        expect(code(await expectStatus(owner.req("GET", watches()), 503))).toBe("alerts_unconfigured");
        expect(code(await expectStatus(put("alerts", { enabled: true }), 409))).toBe("official_bot_unavailable");
      } finally {
        h.ctx.officialBots.videoSource = fake;
      }
    });

    it("follows up to 3 YouTube channels (25 with Bots+), by link or handle", async () => {
      botId = (await put("alerts", { enabled: true })).bot.userId;
      expect(code(await expectStatus(member.req("GET", watches()), 403))).toBe("forbidden");
      expect(code(await expectStatus(owner.req("POST", watches(), { source: "@nobodyhere", channelId: videos }), 400))).toBe("alerts_source_unknown");
      expect(code(await expectStatus(owner.req("POST", watches(), { source: "@speedy", channelId: logs + "x" }), 400))).toBe("official_bot_channel_invalid");
      const { watch } = await owner.req("POST", watches(), { source: "https://www.youtube.com/@speedy", channelId: videos, roleId: fansRole, message: "{role} {creator} is live with {title}: {url}" });
      expect(watch).toMatchObject({ creator: "speedy TV", youtubeChannelId: "UC_speedy", roleId: fansRole, active: true, checkedAt: null });
      expect(code(await expectStatus(owner.req("POST", watches(), { source: "@speedy", channelId: videos }), 409))).toBe("conflict");
      await owner.req("POST", watches(), { source: "@chefanna", channelId: videos });
      await owner.req("POST", watches(), { source: "youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa", channelId: videos });
      expect(code(await expectStatus(owner.req("POST", watches(), { source: "@drawdaily", channelId: videos }), 403))).toBe("bots_plus_required");
      const listed = await owner.req("GET", watches());
      expect(AlertWatches.safeParse(listed).success).toBe(true);
      expect(listed).toMatchObject({ limit: 3 });
      expect(listed.watches).toHaveLength(3);
    });

    it("posts only uploads published after a channel was added, each once, pinging the role", async () => {
      const added = (await owner.req("GET", watches())).watches[0].createdAt as number;
      fake.uploadsOf.set("UU_speedy", [
        { videoId: "new1", title: "Any% in 12 minutes", publishedAt: added + 60_000 },
        { videoId: "old1", title: "Last year's run", publishedAt: added - 60_000 },
      ]);
      await h.ctx.officialBots.scheduler.checkAlerts(Date.now());
      await h.ctx.officialBots.scheduler.checkAlerts(Date.now());
      fake.uploadsOf.set("UU_speedy", [{ videoId: "new2", title: "Glitchless", publishedAt: added + 120_000 }, ...fake.uploadsOf.get("UU_speedy")!]);
      await h.ctx.officialBots.scheduler.checkAlerts(Date.now());
      const posted = (await history(videos)).filter((m) => m.senderUserId === botId).reverse();
      expect(posted.map((m) => m.payload.text)).toEqual([
        "@Fans speedy TV is live with Any% in 12 minutes: https://www.youtube.com/watch?v=new1",
        "@Fans speedy TV is live with Glitchless: https://www.youtube.com/watch?v=new2",
      ]);
      expect(posted[0]!.payload.roleMentions).toEqual([fansRole]);
      expect((await owner.req("GET", watches())).watches[0].checkedAt).toEqual(expect.any(Number));
    });

    it("changes and stops following", async () => {
      const id = (await owner.req("GET", watches())).watches[1].id;
      expect((await owner.req("PATCH", `${watches()}/${id}`, { message: "{creator}: {url}", roleId: null })).watch).toMatchObject({ message: "{creator}: {url}", roleId: null });
      expect(await owner.req("DELETE", `${watches()}/${id}`)).toEqual({ deleted: true });
      expect(await owner.req("DELETE", `${watches()}/${id}`)).toEqual({ deleted: false });
      await plus(true);
      await owner.req("POST", watches(), { source: "@drawdaily", channelId: videos });
      await owner.req("POST", watches(), { source: "@moremusic", channelId: videos });
      expect((await owner.req("GET", watches())).limit).toBe(25);
      await plus(false);
      expect((await owner.req("GET", watches())).watches.map((w: { active: boolean }) => w.active)).toEqual([true, true, true, false]);
    });
  });
});
