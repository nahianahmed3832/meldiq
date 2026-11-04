import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe("approved bot message operations", () => {
  let h: Harness,
    owner: GriipClient,
    orgId: string,
    channelId: string,
    botId: string,
    token: string,
    roleId: string;
  const permissions = ["messages.history", "messages.react", "messages.manage"];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(h.baseUrl + path, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const target = (id: string) => `/v2/bot/channels/${channelId}/messages/${id}`;
  const history = () =>
    request("GET", `/v2/bot/conversations/${channelId}/messages`);
  const approve = async (selected: string[]) => {
    const prior = await owner.req(
      "GET",
      `/v1/orgs/${orgId}/bots/${botId}/permissions`,
    );
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: selected,
      manifestRev: 1,
      rev: prior.rev,
    });
  };
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("botmessageowner");
    owner.serverMessages = true;
    orgId = (
      await owner.req("POST", "/v1/orgs", { name: "Message controls lab" })
    ).org.id;
    channelId = (
      await owner.req("GET", `/v1/orgs/${orgId}/channels`)
    ).channels.find(
      (channel: { name: string }) => channel.name === "general",
    ).id;
    const made = await owner.req("POST", "/v2/developer/bots", {
      name: "Message bot",
    });
    botId = made.bot.id;
    token = made.token;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions,
      rev: 0,
    });
    await approve(permissions);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("projects current edits/deletions and excludes unrelated protocol controls without changing human history", async () => {
    const edited = await owner.send(channelId, {
      type: "text",
      text: "superseded-private-text",
      title: "superseded-title",
    });
    await owner.send(
      channelId,
      {
        type: "edit",
        target: edited.messageId,
        text: "current text",
        title: "current title",
      },
      "control",
    );
    const deleted = await owner.send(channelId, {
      type: "text",
      text: "deleted-private-text",
    });
    await owner.send(
      channelId,
      { type: "delete", target: deleted.messageId },
      "control",
    );
    await owner.send(
      channelId,
      {
        type: "call_key",
        callId: "synthetic-call",
        e2eeKey: "synthetic-protocol-secret",
      },
      "control",
    );
    const page = await history();
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(
      page.body.messages.find(
        (message: { id: string }) => message.id === edited.messageId,
      ).payload,
    ).toMatchObject({ text: "current text", title: "current title" });
    expect(JSON.stringify(page.body)).not.toMatch(
      /superseded-private-text|superseded-title|deleted-private-text|synthetic-protocol-secret/,
    );
    expect(
      page.body.messages.some(
        (message: { id: string }) => message.id === deleted.messageId,
      ),
    ).toBe(false);
    const native = await owner.req(
      "GET",
      `/v2/conversations/${channelId}/messages`,
    );
    expect(JSON.stringify(native)).toContain("superseded-private-text");
  });

  it("reads current context around a message without following anchors into another community", async () => {
    await owner.send(channelId, { type: "text", text: "before anchor" });
    const anchor = await owner.send(channelId, {
      type: "text",
      text: "old anchor text",
    });
    await owner.send(
      channelId,
      { type: "edit", target: anchor.messageId, text: "current anchor text" },
      "control",
    );
    await owner.send(channelId, { type: "text", text: "after anchor" });
    const page = await request(
      "GET",
      `/v2/bot/conversations/${channelId}/messages?around=${encodeURIComponent(anchor.messageId)}&limit=3`,
    );
    expect(page.status).toBe(200);
    expect(
      [...page.body.messages, ...(page.body.context ?? [])].find(
        (message: { id: string }) => message.id === anchor.messageId,
      )?.payload.text,
    ).toBe("current anchor text");
    expect(JSON.stringify(page.body)).not.toContain("old anchor text");
    const foreignOrg = (
      await owner.req("POST", "/v1/orgs", { name: "Unrelated anchor" })
    ).org.id;
    const foreignChannel = (
      await owner.req("GET", `/v1/orgs/${foreignOrg}/channels`)
    ).channels[0].id;
    const foreign = await owner.send(foreignChannel, {
      type: "text",
      text: "foreign anchor payload",
    });
    const denied = await request(
      "GET",
      `/v2/bot/conversations/${channelId}/messages?around=${encodeURIComponent(foreign.messageId)}`,
    );
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain("foreign anchor payload");
  });

  it("adds/removes this bot's reaction and returns the current aggregate", async () => {
    const message = await owner.send(channelId, {
      type: "text",
      text: "reaction target",
    });
    const path = `${target(message.messageId)}/reactions/${encodeURIComponent("👍")}`;
    expect((await request("PUT", path)).status).toBe(200);
    expect(
      (await request("GET", `${target(message.messageId)}/reactions`)).body,
    ).toEqual({ reactions: [{ emoji: "👍", userIds: [botId], count: 1 }] });
    expect((await request("DELETE", path)).status).toBe(200);
    expect(
      (await request("GET", `${target(message.messageId)}/reactions`)).body,
    ).toEqual({ reactions: [] });
  });

  it("requires native pin authority independently, then pins/unpins in the authoritative collection", async () => {
    const message = await owner.send(channelId, {
      type: "text",
      text: "pin target",
    });
    expect(
      (await request("PUT", `${target(message.messageId)}/pin`)).status,
    ).toBe(403);
    roleId = (
      await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
        name: "Bot moderator",
        permissions: ["messages.manage"],
      })
    ).role.id;
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    expect(
      (await request("PUT", `${target(message.messageId)}/pin`)).status,
    ).toBe(200);
    const pins = () =>
      request(
        "GET",
        `/v2/bot/conversations/${channelId}/message-collections?kind=pins`,
      );
    expect(
      (await pins()).body.messages.map((item: { id: string }) => item.id),
    ).toContain(message.messageId);
    expect(
      (await request("DELETE", `${target(message.messageId)}/pin`)).status,
    ).toBe(200);
    expect(
      (await pins()).body.messages.map((item: { id: string }) => item.id),
    ).not.toContain(message.messageId);
  });

  it("reports partial bulk deletion and never follows a target into another community", async () => {
    const message = await owner.send(channelId, {
      type: "text",
      text: "bulk target",
    });
    const elsewhere = (
      await owner.req("POST", "/v1/orgs", { name: "Other message lab" })
    ).org.id;
    const otherChannel = (
      await owner.req("GET", `/v1/orgs/${elsewhere}/channels`)
    ).channels[0].id;
    const other = await owner.send(otherChannel, {
      type: "text",
      text: "must remain",
    });
    const bulk = await request(
      "POST",
      `/v2/bot/channels/${channelId}/messages/bulk-delete`,
      { messageIds: [message.messageId, other.messageId, "unknown-message"] },
    );
    expect(bulk.body).toEqual({
      deleted: [message.messageId],
      failed: [
        { messageId: other.messageId, code: "not_found" },
        { messageId: "unknown-message", code: "not_found" },
      ],
    });
    expect(
      (await history()).body.messages.map((item: { id: string }) => item.id),
    ).not.toContain(message.messageId);
    expect(
      (
        await owner.req("GET", `/v2/conversations/${otherChannel}/messages`)
      ).messages.map((item: { id: string }) => item.id),
    ).toContain(other.messageId);
  });

  it("rechecks installation permission before returning an already-read native page", async () => {
    const messages = h.ctx.bots.messages,
      original = messages.projectNativePage.bind(messages);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    messages.projectNativePage = async (...args) => {
      entered();
      await barrier;
      return original(...args);
    };
    try {
      const pending = history();
      await waiting;
      await approve(["messages.react", "messages.manage"]);
      release();
      expect((await pending).status).toBe(403);
    } finally {
      release();
      messages.projectNativePage = original;
    }
    const message = await owner.send(channelId, {
      type: "text",
      text: "revoked moderation",
    });
    await approve(["messages.react"]);
    expect(
      (await request("DELETE", `/v2/bot/messages/${message.messageId}`)).status,
    ).toBe(403);
  });

  it("rechecks history authority after an asynchronous token check before returning reaction identities", async () => {
    await approve(permissions);
    const message = await owner.send(channelId, {
      type: "text",
      text: "reaction lookup race",
    });
    await request(
      "PUT",
      `${target(message.messageId)}/reactions/${encodeURIComponent("👍")}`,
    );
    const events = h.ctx.bots.events,
      original = events.fresh.bind(events);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    events.fresh = async (...args) => {
      entered();
      await barrier;
      return original(...args);
    };
    try {
      const pending = request("GET", `${target(message.messageId)}/reactions`);
      await waiting;
      await approve(["messages.react"]);
      release();
      expect((await pending).status).toBe(403);
    } finally {
      release();
      events.fresh = original;
    }
  });
});
