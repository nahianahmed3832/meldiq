import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ticketChannelName } from "../src/modules/organizations/posting/ticketDesk.js";
import { TicketsConfig } from "../src/shared/contracts/http/tickets.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Tickets (community parity batch C, feature "community-tickets", docs/COMMUNITY_PARITY_API.md › Posting tools): a
 * member opens a private channel only they and the moderators see; panels say where the "Open a ticket" message goes,
 * which category tickets open in and where they're logged; the opener or a moderator closes it. Runs with the community
 * tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;
const about = "Someone keeps sending me spam in DMs";

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("tickets with communities in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, mod: GriipClient, member: GriipClient, bystander: GriipClient, outsider: GriipClient;
  let orgId: string, support: string, logs: string, voice: string, modRole: string;
  let panels: { id: string; name: string; categoryId: string }[];
  let first: string, second: string;
  const history = async (c: GriipClient, conv: string) => (await c.req("GET", `/v2/conversations/${conv}/messages`)).messages;
  const config = (panelsBody: unknown[], enabled = true, maxOpenPerPerson = 2) => ({ enabled, maxOpenPerPerson, panels: panelsBody });
  const open = (c: GriipClient, body: Record<string, unknown> = {}) => c.req("POST", `/v1/orgs/${orgId}/tickets`, { about, notABugReport: true, ...body });

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, mod, member, bystander, outsider] = await Promise.all(["tkowner", "tkmod", "tkmember", "tkbystander", "tkoutsider"].map((x) => h.client(x)));
    for (const c of [owner, mod, member, bystander]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Help Desk" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [mod, member, bystander]) await c.req("POST", "/v1/invites/accept", { code: invite });
    modRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Mods", permissions: ["members.timeout"] })).role.id;
    await owner.req("PUT", `/v1/roles/${modRole}/members/${mod.userId}`);
    support = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "support" })).channel.id;
    logs = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "ticket-log", kind: "PRIVATE" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("is advertised, off until a community turns it on, and configured by people who can edit the community", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-tickets");
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets).toBeUndefined();
    expect(code(await expectStatus(member.req("GET", `/v1/orgs/${orgId}/tickets/config`), 403))).toBe("forbidden");
    expect(await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`)).toEqual({ enabled: false, maxOpenPerPerson: 2, panels: [], panelLimit: 2 });
    expect(code(await expectStatus(open(member), 409))).toBe("tickets_off");
  });

  it("checks the panels' channels and limits", async () => {
    const panel = { name: "Support", postChannelId: support, categoryId: null, logChannelId: logs };
    expect(code(await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([panel])), 403))).toBe("forbidden");
    for (const bad of [{ postChannelId: voice }, { postChannelId: logs }, { postChannelId: "c_nowhere" }, { logChannelId: voice }, { categoryId: "cat_nowhere" }]) {
      expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([{ ...panel, ...bad }])), 400))).toBe("ticket_channel_invalid");
    }
    // Beyond 2 panels and 3 per person is Bots+ (the Tickets bot, community parity batch D part 2); 10 at most.
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([panel, panel, panel])), 403))).toBe("bots_plus_required");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([panel], true, 4)), 403))).toBe("bots_plus_required");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([panel], true, 11)), 400))).toBe("bad_request");
  });

  it("turns on with panels in an automatic Tickets category, keeping panel ids", async () => {
    const v = await owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config([
      { name: "Support", postChannelId: support, categoryId: null, logChannelId: logs },
      { name: "Appeals", postChannelId: support, categoryId: null, logChannelId: null },
    ]));
    expect(TicketsConfig.safeParse(v).success).toBe(true);
    panels = v.panels;
    expect(panels[0]!.categoryId).toBe(panels[1]!.categoryId);
    expect(h.ctx.ws.get<{ name: string }>("channel_categories", { id: panels[0]!.categoryId })?.name).toBe("Tickets");
    const again = await owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, config(v.panels.map((p: Record<string, unknown>) => ({ id: p.id, name: p.name, postChannelId: p.postChannelId, categoryId: p.categoryId, logChannelId: p.logChannelId }))));
    expect(again.panels.map((p: { id: string }) => p.id)).toEqual(panels.map((p) => p.id));
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets).toEqual({ panels: [{ id: panels[0]!.id, name: "Support" }, { id: panels[1]!.id, name: "Appeals" }], maxOpenPerPerson: 2, openByMe: 0 });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "tickets.config" })).toBe(2);
  });

  it("posts a panel with an Open a ticket button, as the community's Tickets account", async () => {
    expect(code(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/tickets/panels/${panels[0]!.id}/post`), 403))).toBe("forbidden");
    const posted = await owner.req("POST", `/v1/orgs/${orgId}/tickets/panels/${panels[0]!.id}/post`);
    expect(posted.channelId).toBe(support);
    const msg = (await history(member, support)).find((m: { id: string }) => m.id === posted.messageId);
    expect(msg.payload.buttons).toEqual([{ kind: "action", action: "open_ticket", panelId: panels[0]!.id, label: "Open a ticket", emoji: "🎫" }]);
    expect(msg.payload.embeds[0].title).toBe("Support");
    // Turning tickets on brought the Tickets bot in: its account posts for tickets.
    const poster = h.ctx.ws.get<{ user_id: string }>("official_bots", { org_id: orgId, bot_key: "tickets" })!.user_id;
    expect(msg.senderUserId).toBe(poster);
    expect((await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`)).panels[0].postedMessageId).toBe(posted.messageId);
  });

  it("opens a private channel only the opener and the moderators see, with the text first and a log line", async () => {
    expect(code(await expectStatus(open(member, { notABugReport: false }), 400))).toBe("ticket_confirm_required");
    expect(code(await expectStatus(outsider.req("POST", `/v1/orgs/${orgId}/tickets`, { about, notABugReport: true }), 404))).toBe("not_found");
    const { ticket } = await open(member, { panelId: panels[0]!.id });
    first = ticket.channelId;
    expect(ticket).toMatchObject({ number: 1, name: ticketChannelName(1, member.username), panelName: "Support", about, closedAt: null, joined: true, opener: { id: member.userId } });
    const channel = (await member.req("GET", `/v1/conversations/${first}`)).conversation;
    expect(channel).toMatchObject({ kind: "PRIVATE", categoryId: panels[0]!.categoryId });
    for (const c of [owner, mod]) expect((await c.req("GET", `/v1/conversations/${first}`)).conversation.id).toBe(first);
    expect(code(await expectStatus(bystander.req("GET", `/v1/conversations/${first}`), 404))).toBe("not_found");
    const [opening] = await history(mod, first);
    expect(opening.payload).toMatchObject({ embeds: [{ title: "Ticket #1 · Support", description: about }], buttons: [{ action: "close_ticket" }] });
    // The opener and the moderators talk there.
    await member.send(first, { type: "text", text: "Here are screenshots" });
    await mod.send(first, { type: "text", text: "On it" });
    expect((await history(owner, logs))[0].payload.text).toMatch(/^🎫 Ticket #1 · Support opened by /);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "ticket.open", target: first })).toBe(1);
  });

  it("allows only so many open tickets per person", async () => {
    second = (await open(member)).ticket.channelId;
    const refused = await expectStatus(open(member), 409);
    expect(refused.error).toMatchObject({ code: "ticket_limit", details: { max: 2 } });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets.openByMe).toBe(2);
  });

  it("lists every open ticket for moderators and your own for others", async () => {
    expect((await mod.req("GET", `/v1/orgs/${orgId}/tickets`)).tickets.map((t: { number: number }) => t.number)).toEqual([1, 2]);
    expect((await member.req("GET", `/v1/orgs/${orgId}/tickets`)).tickets).toHaveLength(2);
    expect((await bystander.req("GET", `/v1/orgs/${orgId}/tickets`)).tickets).toEqual([]);
  });

  it("lets only the opener or a moderator close a ticket: archived, out of the category, logged", async () => {
    expect(code(await expectStatus(bystander.req("POST", `/v1/orgs/${orgId}/tickets/${first}/close`), 403))).toBe("forbidden");
    const { ticket } = await member.req("POST", `/v1/orgs/${orgId}/tickets/${first}/close`);
    expect(ticket).toMatchObject({ closedAt: expect.any(Number), closedBy: { id: member.userId } });
    const channel = (await owner.req("GET", `/v1/conversations/${first}`)).conversation;
    expect(channel.archived).toBe(true);
    expect(channel.categoryId).toBeNull();
    expect((await history(owner, logs))[0].payload.text).toMatch(/^🔒 Ticket #1 · Support closed by /);
    expect(code(await expectStatus(mod.req("POST", `/v1/orgs/${orgId}/tickets/${first}/close`), 409))).toBe("ticket_closed");
    expect((await open(member)).ticket.number).toBe(3);
  });

  it("lets someone who becomes a moderator later join open tickets", async () => {
    expect(code(await expectStatus(bystander.req("POST", `/v1/orgs/${orgId}/tickets/${second}/join`), 403))).toBe("forbidden");
    await owner.req("PUT", `/v1/roles/${modRole}/members/${bystander.userId}`);
    const listed = (await bystander.req("GET", `/v1/orgs/${orgId}/tickets`)).tickets.find((t: { channelId: string }) => t.channelId === second);
    expect(listed.joined).toBe(false);
    expect((await bystander.req("POST", `/v1/orgs/${orgId}/tickets/${second}/join`)).ticket.joined).toBe(true);
    await bystander.send(second, { type: "text", text: "Joining in" });
    await bystander.req("POST", `/v1/orgs/${orgId}/tickets/${second}/close`);
  });

  it("stops new tickets when the community turns them off; open ones still close", async () => {
    const cfg = await owner.req("GET", `/v1/orgs/${orgId}/tickets/config`);
    await owner.req("PUT", `/v1/orgs/${orgId}/tickets/config`, { ...config([]), enabled: false, panels: [] });
    expect(cfg.panels).toHaveLength(2);
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.tickets).toBeUndefined();
    expect(code(await expectStatus(open(member), 409))).toBe("tickets_off");
    const [open3] = (await member.req("GET", `/v1/orgs/${orgId}/tickets`)).tickets;
    expect((await owner.req("POST", `/v1/orgs/${orgId}/tickets/${open3.channelId}/close`)).ticket.closedBy.id).toBe(owner.userId);
  });
});

describe("tickets switched off (COMMUNITY_TICKETS=off)", () => {
  it("aren't advertised and answer 503", async () => {
    const h = await startServer({ COMMUNITY_TICKETS: "off" });
    try {
      const owner = await h.client("tkoff");
      expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-tickets");
      const orgId = (await owner.req("POST", "/v1/orgs", { name: "No Desk" })).org.id;
      expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/tickets/config`), 503))).toBe("feature_disabled");
      expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/tickets`, { about, notABugReport: true }), 503))).toBe("feature_disabled");
    } finally {
      await h.close();
    }
  });
});

describe("ticket channel names", () => {
  it("are ticket-<n>-<username> in letters, digits and dashes", () => {
    expect(ticketChannelName(7, "Ana.Silva")).toBe("ticket-7-ana-silva");
    expect(ticketChannelName(12, "...")).toBe("ticket-12-member");
    expect(ticketChannelName(3, "x".repeat(80))).toHaveLength(60);
  });
});
