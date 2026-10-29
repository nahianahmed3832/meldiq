import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Bots (API 0.65.0, settings parity batch B, docs/SETTINGS_PARITY_API.md): accounts of their own run by their owner's
 * token, added to communities by managers, posting through the server's message path, and answering slash commands
 * pulled with a long poll.
 */

interface Answer {
  status: number;
  body: any;
}

const command = { name: "roll", description: "Roll a die", options: [{ name: "sides", description: "How many sides", type: "number", required: true }, { name: "loud", description: "Shout it", type: "boolean" }] };

function suite(name: string, env: Record<string, string>) {
  describe(name, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    let admin: GriipClient, member: GriipClient, outsider: GriipClient;
    let orgId: string, channelId: string;

    const botReq = async (token: string, method: string, path: string, body?: unknown): Promise<Answer> => {
      const headers: Record<string, string> = { authorization: `Bot ${token}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${h.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    /** A bot of a fresh owner (free plans allow two bots each). */
    const newBot = async (opts: { public?: boolean; owner?: GriipClient } = {}) => {
      const owner = opts.owner ?? (await h.client("botowner"));
      const r = await owner.req("POST", "/v2/developer/bots", { name: "Dice Bot", public: opts.public ?? true });
      return { owner, id: r.bot.id as string, token: r.token as string };
    };
    const installed = async (opts: { public?: boolean } = {}) => {
      const bot = await newBot(opts);
      await admin.req("POST", `/v1/orgs/${orgId}/bots`, { botId: bot.id });
      return bot;
    };

    beforeAll(async () => {
      h = await startServer(env, { mailer });
      [admin, member, outsider] = await Promise.all([h.client("botadmin"), h.client("botmember"), h.client("botoutsider")]);
      member.serverMessages = true;
      orgId = (await admin.req("POST", "/v1/orgs", { name: "Bot Lab", visibility: "public", joinPolicy: "invite" })).org.id;
      const code = (await admin.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 50 })).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      channelId = (await admin.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG" })).channel.id;
      await Promise.all([admin.connect(), member.connect()]);
    });
    afterAll(async () => h.close());

    it("makes bots up to the owner's plan (2 on Free), each an account of its own marked bot", async () => {
      const owner = await h.client("quota");
      const first = await owner.req("POST", "/v2/developer/bots", { name: "Helper", username: `helper${Date.now() % 100000}` });
      expect(first.token).toMatch(/^mqb_[A-Za-z0-9_-]{43}$/);
      expect(first.bot).toMatchObject({ displayName: "Helper", public: false, commands: 0, communities: 0 });
      await owner.req("POST", "/v2/developer/bots", { name: "Helper 2" });
      const refused = await expectStatus(owner.req("POST", "/v2/developer/bots", { name: "Helper 3" }), 409);
      expect(refused.error).toMatchObject({ code: "limit_reached", details: { limit: 2, plan: "free" } });
      const list = await owner.req("GET", "/v2/developer/bots");
      expect(list).toMatchObject({ limit: 2, plan: "free" });
      expect(list.bots).toHaveLength(2);
      expect(JSON.stringify(list)).not.toContain(first.token);
      const profile = await member.req("GET", `/v1/users/${first.bot.id}`);
      expect(profile.user).toMatchObject({ id: first.bot.id, displayName: "Helper", bot: true });
      expect((await member.req("GET", `/v1/users/${member.userId}`)).user.bot).toBeUndefined();
      await expectStatus(owner.req("POST", "/v2/developer/bots", { name: "Taken", username: first.bot.username }), 409);
      const renamed = await owner.req("PATCH", `/v2/developer/bots/${first.bot.id}`, { name: "Helper Prime", public: true });
      expect(renamed.bot).toMatchObject({ displayName: "Helper Prime", public: true });
      await expectStatus(member.req("PATCH", `/v2/developer/bots/${first.bot.id}`, { public: false }), 404);
    });

    it("locks the newest bots beyond the plan after a downgrade, deleting nothing, while plan limits apply", async () => {
      const owner = await h.client("downgrader");
      const t = Date.now();
      // Mojo Go for a day (4 bots), as a gift would give it.
      await h.ctx.billing.rows.write((w) =>
        w.insert("billing_grants", { id: `grt_bots_${t}`, account_id: `acc_bots_${t}`, user_id: owner.userId, plan_key: "go", source: "gift", reference: `gft_bots_${t}`, starts_at: t - 1000, ends_at: t + 86_400_000, created_at: t }),
      );
      const made = [];
      for (const name of ["One", "Two", "Three"]) made.push(await owner.req("POST", "/v2/developer/bots", { name }));
      await h.ctx.billing.rows.write((w) => w.update("billing_grants", { id: `grt_bots_${t}` }, { ends_at: t }));
      // Back on Free (2 bots): nothing is locked until plan limits are enforced.
      expect((await owner.req("GET", "/v2/developer/bots")).bots.map((b: { locked: boolean }) => b.locked)).toEqual([false, false, false]);
      await h.ctx.billing.mojoControls.save({ enforce: "on", plans: {}, levels: {} }, "test", Date.now());
      try {
        const list = await owner.req("GET", "/v2/developer/bots");
        expect(list).toMatchObject({ limit: 2, plan: "free" });
        const locked = Object.fromEntries(list.bots.map((b: { id: string; locked: boolean }) => [b.id, b.locked]));
        expect(made.map((m) => locked[m.bot.id])).toEqual([false, false, true]);
        expect((await botReq(made[0].token, "GET", "/v2/bot/me")).status).toBe(200);
        const refused = await botReq(made[2].token, "GET", "/v2/bot/me");
        expect(refused).toMatchObject({ status: 403, body: { error: { code: "bot_locked" } } });
        // Deleting an older bot makes room: the locked one acts again.
        await owner.req("DELETE", `/v2/developer/bots/${made[0].bot.id}`);
        expect((await botReq(made[2].token, "GET", "/v2/bot/me")).status).toBe(200);
      } finally {
        await h.ctx.billing.mojoControls.save({ enforce: null, plans: {}, levels: {} }, "test", Date.now());
      }
    });

    it("accepts a bot token only as Authorization: Bot on /v2/bot, and a rotated token at once", async () => {
      const bot = await newBot();
      expect(await botReq(bot.token, "GET", "/v2/bot/me")).toMatchObject({ status: 200, body: { bot: { id: bot.id, ownerId: bot.owner.userId } } });
      const asBearer = await fetch(`${h.baseUrl}/v1/users/me`, { headers: { authorization: `Bearer ${bot.token}` } });
      expect(asBearer.status).toBe(401);
      const bearerOnBotRoute = await fetch(`${h.baseUrl}/v2/bot/me`, { headers: { authorization: `Bearer ${bot.token}` } });
      expect(bearerOnBotRoute.status).toBe(401);
      expect((await botReq(member.token!, "GET", "/v2/bot/me")).status).toBe(401);
      const rotated = await bot.owner.req("POST", `/v2/developer/bots/${bot.id}/token`);
      expect((await botReq(bot.token, "GET", "/v2/bot/me")).status).toBe(401);
      expect((await botReq(rotated.token, "GET", "/v2/bot/me")).status).toBe(200);
    });

    it("lets only managers add bots, and a private bot only by its owner", async () => {
      const pub = await newBot({ public: true });
      await expectStatus(member.req("POST", `/v1/orgs/${orgId}/bots`, { botId: pub.id }), 403);
      await expectStatus(outsider.req("POST", `/v1/orgs/${orgId}/bots`, { botId: pub.id }), 404);
      expect((await member.req("GET", `/v2/bots/${pub.id}`)).bot).toMatchObject({ id: pub.id, public: true, owner: { id: pub.owner.userId } });
      const added = await admin.req("POST", `/v1/orgs/${orgId}/bots`, { botId: pub.id });
      expect(added).toMatchObject({ installed: true, bot: { id: pub.id } });
      expect((await admin.req("POST", `/v1/orgs/${orgId}/bots`, { botId: pub.id })).installed).toBe(false);
      const members = (await member.req("GET", `/v1/orgs/${orgId}/members`)).members;
      expect(members.find((m: { id: string }) => m.id === pub.id)).toMatchObject({ bot: true, orgRole: "MEMBER" });

      const priv = await newBot({ public: false });
      await expectStatus(member.req("GET", `/v2/bots/${priv.id}`), 404);
      expect((await expectStatus(admin.req("POST", `/v1/orgs/${orgId}/bots`, { botId: priv.id }), 403)).error.code).toBe("bot_private");
      // Its owner, managing their own community, may add it.
      const own = (await priv.owner.req("POST", "/v1/orgs", { name: "Owner's place", visibility: "public", joinPolicy: "invite" })).org.id;
      expect((await priv.owner.req("POST", `/v1/orgs/${own}/bots`, { botId: priv.id })).installed).toBe(true);

      await expectStatus(member.req("DELETE", `/v1/orgs/${orgId}/bots/${pub.id}`), 403);
      expect(await admin.req("DELETE", `/v1/orgs/${orgId}/bots/${pub.id}`)).toEqual({ removed: true });
      expect(await admin.req("DELETE", `/v1/orgs/${orgId}/bots/${pub.id}`)).toEqual({ removed: false });
      expect((await botReq(pub.token, "GET", "/v2/bot/communities")).body.communities).toEqual([]);
    });

    it("posts, edits and deletes its own messages through the message path members read", async () => {
      const bot = await installed();
      const where = await botReq(bot.token, "GET", "/v2/bot/communities");
      const lab = where.body.communities.find((c: { id: string }) => c.id === orgId);
      expect(lab.channels.find((c: { id: string }) => c.id === channelId)).toMatchObject({ name: "general", canPost: true });

      const sent = await botReq(bot.token, "POST", `/v2/bot/channels/${channelId}/messages`, { content: "Hello, Bot Lab" });
      expect(sent).toMatchObject({ status: 200, body: { duplicate: false } });
      const got = await member.waitFor(() => member.received.find((m) => m.messageId === sent.body.messageId));
      expect(got).toMatchObject({ senderUserId: bot.id, conversationId: channelId, payload: { type: "text", text: "Hello, Bot Lab" } });
      const page = await member.req("GET", `/v2/conversations/${channelId}/messages`);
      expect(page.messages.find((m: { id: string }) => m.id === sent.body.messageId)).toMatchObject({ senderUserId: bot.id, senderDeviceId: null });

      expect((await botReq(bot.token, "PATCH", `/v2/bot/messages/${sent.body.messageId}`, { content: "Hello again" })).status).toBe(200);
      expect((await botReq(bot.token, "DELETE", `/v2/bot/messages/${sent.body.messageId}`)).status).toBe(200);
      const theirs = await member.send(channelId, { type: "text", text: "mine" });
      expect((await botReq(bot.token, "PATCH", `/v2/bot/messages/${theirs.messageId}`, { content: "hijacked" })).body.error.code).toBe("not_yours");
      // A channel it isn't in, and a DM-like target, look like nothing.
      const other = (await admin.req("POST", "/v1/orgs", { name: "Botless", visibility: "public", joinPolicy: "invite" })).org.id;
      const elsewhere = (await admin.req("POST", `/v1/orgs/${other}/channels`, { name: "quiet", scope: "ORG" })).channel.id;
      expect((await botReq(bot.token, "POST", `/v2/bot/channels/${elsewhere}/messages`, { content: "hi" })).status).toBe(404);
      // Bots never earn points.
      expect(await h.ctx.points.store.account(bot.id)).toBeNull();
    });

    it("validates slash commands and lists them to members", async () => {
      const bot = await installed();
      const put = (commands: unknown[]) => botReq(bot.token, "PUT", "/v2/bot/commands", { commands });
      expect((await put([{ name: "Roll", description: "x" }])).status).toBe(400);
      expect((await put([{ name: "a".repeat(33), description: "x" }])).status).toBe(400);
      expect((await put([{ name: "roll", description: "" }])).status).toBe(400);
      expect((await put([command, command])).status).toBe(400);
      const opts = Array.from({ length: 26 }, (_, i) => ({ name: `o${i}`, description: "x", type: "string" }));
      expect((await put([{ name: "many", description: "x", options: opts }])).status).toBe(400);
      expect((await put([{ name: "bad-type", description: "x", options: [{ name: "x", description: "x", type: "channel" }] }])).status).toBe(400);
      expect((await put(Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: "x" })))).status).toBe(400);
      expect((await put(Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, description: "x" })))).status).toBe(200);
      const ok = await put([command, { name: "ping", description: "Pong" }]);
      expect(ok.body.commands[1]).toEqual({ name: "ping", description: "Pong", options: [] });
      expect(ok.body.commands[0].options[1]).toMatchObject({ name: "loud", required: false });
      expect((await botReq(bot.token, "GET", "/v2/bot/commands")).body.commands).toHaveLength(2);

      const listed = await member.req("GET", `/v1/orgs/${orgId}/commands?channelId=${channelId}`);
      expect(listed.commands.filter((c: { botId: string }) => c.botId === bot.id).map((c: { name: string }) => c.name)).toEqual(["roll", "ping"]);
      await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/commands`), 404);
    });

    it("queues a command, hands it to the bot's long poll, and posts the answer in the channel", async () => {
      const bot = await installed();
      await botReq(bot.token, "PUT", "/v2/bot/commands", { commands: [command] });
      const run = (body: Record<string, unknown>) => member.req("POST", "/v2/interactions", { channelId, botId: bot.id, ...body });
      await expectStatus(run({ command: "roll", options: {} }), 400);
      await expectStatus(run({ command: "roll", options: { sides: "six" } }), 400);
      await expectStatus(run({ command: "roll", options: { sides: 6, colour: "red" } }), 400);
      await expectStatus(run({ command: "nope" }), 404);
      const absent = await newBot();
      expect((await expectStatus(member.req("POST", "/v2/interactions", { channelId, botId: absent.id, command: "roll" }), 404)).error.code).toBe("bot_not_here");
      await expectStatus(outsider.req("POST", "/v2/interactions", { channelId, botId: bot.id, command: "roll", options: { sides: 6 } }), 404);

      const started = Date.now();
      const poll = botReq(bot.token, "GET", "/v2/bot/interactions?wait=10");
      await new Promise((r) => setTimeout(r, 300));
      const queued = await run({ command: "roll", options: { sides: 6, loud: true } });
      expect(queued.interaction).toMatchObject({ botId: bot.id, command: "roll" });
      expect(queued.interaction.expiresAt - queued.interaction.createdAt).toBe(15 * 60_000);
      const polled = await poll;
      expect(Date.now() - started).toBeLessThan(8000);
      expect(polled.body.interactions).toEqual([
        expect.objectContaining({ id: queued.interaction.id, command: "roll", options: { sides: 6, loud: true }, user: { id: member.userId, username: member.username, displayName: "botmember" }, channelId, communityId: orgId }),
      ]);
      // Handed out once: an immediate poll finds nothing.
      expect((await botReq(bot.token, "GET", "/v2/bot/interactions")).body.interactions).toEqual([]);

      const reply = await botReq(bot.token, "POST", `/v2/bot/interactions/${queued.interaction.id}/reply`, { content: "You rolled a 4" });
      expect(reply.body).toMatchObject({ interactionId: queued.interaction.id, ephemeral: false });
      const msg = await member.waitFor(() => member.received.find((m) => m.messageId === reply.body.messageId));
      expect(msg).toMatchObject({ senderUserId: bot.id, payload: { type: "text", text: "You rolled a 4", interaction: { id: queued.interaction.id, command: "roll", userId: member.userId } } });
      expect((await botReq(bot.token, "POST", `/v2/bot/interactions/${queued.interaction.id}/reply`, { content: "again" })).body.error.code).toBe("interaction_answered");
      const stranger = await newBot();
      expect((await botReq(stranger.token, "POST", `/v2/bot/interactions/${queued.interaction.id}/reply`, { content: "mine" })).status).toBe(404);
    });

    it("sends an ephemeral answer only to the person who ran the command", async () => {
      const bot = await installed();
      await botReq(bot.token, "PUT", "/v2/bot/commands", { commands: [command] });
      const { interaction } = await member.req("POST", "/v2/interactions", { channelId, botId: bot.id, command: "roll", options: { sides: 20 } });
      const r = await botReq(bot.token, "POST", `/v2/bot/interactions/${interaction.id}/reply`, { content: "Psst: 17", ephemeral: true });
      expect(r.body).toEqual({ interactionId: interaction.id, ephemeral: true, messageId: null });
      const frame = await member.waitFor(() => (member.events as any[]).find((e) => e.t === "interaction.reply" && e.interactionId === interaction.id));
      expect(frame).toMatchObject({ conversationId: channelId, botId: bot.id, command: "roll", content: "Psst: 17" });
      await new Promise((res) => setTimeout(res, 300));
      expect((admin.events as any[]).some((e) => e.t === "interaction.reply")).toBe(false);
      expect(admin.received.some((m) => (m.payload as { text?: string }).text === "Psst: 17")).toBe(false);
    });

    it("lets an unanswered command expire after 15 minutes", async () => {
      const bot = await installed();
      await botReq(bot.token, "PUT", "/v2/bot/commands", { commands: [command] });
      const { interaction } = await member.req("POST", "/v2/interactions", { channelId, botId: bot.id, command: "roll", options: { sides: 6 } });
      const bots = h.ctx.bots as unknown as { clock: () => number };
      const real = bots.clock;
      bots.clock = () => Date.now() + 16 * 60_000;
      try {
        expect((await botReq(bot.token, "GET", "/v2/bot/interactions")).body.interactions).toEqual([]);
        const late = await botReq(bot.token, "POST", `/v2/bot/interactions/${interaction.id}/reply`, { content: "too late" });
        expect(late).toMatchObject({ status: 410, body: { error: { code: "interaction_expired" } } });
      } finally {
        bots.clock = real;
      }
    });

    it("limits each bot's requests on its own", async () => {
      const bot = await newBot();
      const other = await newBot();
      for (let i = 0; i < 10; i++) expect((await botReq(bot.token, "PUT", "/v2/bot/commands", { commands: [] })).status).toBe(200);
      expect((await botReq(bot.token, "PUT", "/v2/bot/commands", { commands: [] })).status).toBe(429);
      expect((await botReq(other.token, "PUT", "/v2/bot/commands", { commands: [] })).status).toBe(200);
    });

    it("removes a deleted bot from its communities, and deletes an owner's bots with their account", async () => {
      const bot = await installed();
      expect(await bot.owner.req("DELETE", `/v2/developer/bots/${bot.id}`)).toEqual({ deleted: true });
      expect((await botReq(bot.token, "GET", "/v2/bot/me")).status).toBe(401);
      const members = (await member.req("GET", `/v1/orgs/${orgId}/members`)).members;
      expect(members.some((m: { id: string }) => m.id === bot.id)).toBe(false);
      // Its account is erased like a person's ("Deleted account" on the messages it sent; no profile to open).
      await expectStatus(member.req("GET", `/v1/users/${bot.id}`), 404);

      const owner = await AccountClient.ready(h.baseUrl, mailer, "botleaver");
      const theirs = await newBot({ owner, public: true });
      await admin.req("POST", `/v1/orgs/${orgId}/bots`, { botId: theirs.id });
      await botReq(theirs.token, "PUT", "/v2/bot/commands", { commands: [command] });
      await owner.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: owner.email });
      expect((await botReq(theirs.token, "GET", "/v2/bot/me")).status).toBe(401);
      expect((await member.req("GET", `/v1/orgs/${orgId}/members`)).members.some((m: { id: string }) => m.id === theirs.id)).toBe(false);
      expect((await member.req("GET", `/v1/orgs/${orgId}/commands`)).commands.some((c: { botId: string }) => c.botId === theirs.id)).toBe(false);
      expect(await h.ctx.bots.store.bot(theirs.id)).toBeNull();
    });
  });
}

suite("bots on the default (memory) stores", {});
suite("bots on MongoDB", { MONGODB_DOMAINS: "preferences,reports,relationships,history,accounts,files,relay,billing" });
