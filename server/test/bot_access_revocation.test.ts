import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe("legacy bot authority remains constrained", () => {
  let h: Harness,
    owner: GriipClient,
    member: GriipClient,
    botId: string,
    token: string,
    orgId: string,
    channelId: string;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    credential = token,
  ) => {
    const response = await fetch(h.baseUrl + path, {
      method,
      headers: {
        authorization: `Bot ${credential}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const run = () =>
    member.req("POST", "/v2/interactions", {
      channelId,
      botId,
      command: "echo",
      options: { text: "private command argument" },
    });
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("botaccessowner");
    member = await h.client("botaccessmember");
    member.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Revocation lab" }))
      .org.id;
    const invite = (
      await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
    ).invite.code;
    await member.req("POST", "/v1/invites/accept", { code: invite });
    channelId = (
      await owner.req("GET", `/v1/orgs/${orgId}/channels`)
    ).channels.find(
      (channel: { name: string }) => channel.name === "general",
    ).id;
    const made = await owner.req("POST", "/v2/developer/bots", {
      name: "Access bot",
    });
    botId = made.bot.id;
    token = made.token;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    await request("PUT", "/v2/bot/commands", {
      commands: [
        {
          name: "echo",
          description: "Echo",
          options: [
            {
              name: "text",
              description: "Text",
              type: "string",
              required: true,
            },
          ],
        },
      ],
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  });

  it("requires approval for deleting another sender's message even when a native moderation role exists", async () => {
    const role = (
      await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
        name: "Message moderator",
        permissions: ["messages.manage"],
      })
    ).role;
    await owner.req("PUT", `/v1/roles/${role.id}/members/${botId}`);
    const sent = await member.send(channelId, {
      type: "text",
      text: "protected until installation approval",
    });
    expect(
      (await request("DELETE", `/v2/bot/messages/${sent.messageId}`)).status,
    ).toBe(403);
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions: ["messages.manage"],
      rev: 0,
    });
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: ["messages.manage"],
      manifestRev: 1,
      rev: 0,
    });
    expect(
      (await request("DELETE", `/v2/bot/messages/${sent.messageId}`)).status,
    ).toBe(200);
  });

  it("wakes and rejects a long poll when its token rotates", async () => {
    const claim = h.ctx.bots.store.claim.bind(h.ctx.bots.store);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi
      .spyOn(h.ctx.bots.store, "claim")
      .mockImplementation(async (...args) => {
        const result = await claim(...args);
        entered();
        return result;
      });
    try {
      const pending = request("GET", "/v2/bot/interactions?wait=10");
      await ready;
      token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
        .token;
      expect((await pending).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not return arguments or ephemeral replies after uninstall, including after a fresh reinstall", async () => {
    const queued = await run();
    await owner.req("DELETE", `/v1/orgs/${orgId}/bots/${botId}`);
    expect(
      (await request("GET", "/v2/bot/interactions")).body.interactions,
    ).toEqual([]);
    expect(
      (
        await request(
          "POST",
          `/v2/bot/interactions/${queued.interaction.id}/reply`,
          { content: "must not arrive", ephemeral: true },
        )
      ).status,
    ).toBe(404);
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    expect(
      (
        await request(
          "POST",
          `/v2/bot/interactions/${queued.interaction.id}/reply`,
          { content: "old incarnation", ephemeral: true },
        )
      ).status,
    ).toBe(404);
  });

  it("does not deliver a reply after the command author leaves", async () => {
    const queued = await run();
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`);
    expect(
      (
        await request(
          "POST",
          `/v2/bot/interactions/${queued.interaction.id}/reply`,
          { content: "no longer a member", ephemeral: true },
        )
      ).status,
    ).toBe(404);
    expect(
      (await request("GET", "/v2/bot/interactions")).body.interactions,
    ).toEqual([]);
  });
});
