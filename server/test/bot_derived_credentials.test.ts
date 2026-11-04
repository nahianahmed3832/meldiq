import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe("bot-derived webhook credentials", () => {
  let h: Harness, owner: GriipClient;
  let orgId: string,
    channelId: string,
    botId: string,
    token: string,
    roleId: string;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    credential?: string,
  ) => {
    const response = await fetch(h.baseUrl + path, {
      method,
      headers: {
        ...(credential ? { authorization: `Bot ${credential}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const prefix = () => `/v1/orgs/${orgId}/channels/${channelId}/webhooks`;
  const make = async () => {
    const made = await request(
      "POST",
      prefix().replace("/v1/", "/v2/bot/"),
      { name: "Bound test hook" },
      token,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return {
      id: made.body.webhook.id as string,
      token: made.body.token as string,
    };
  };
  const post = (hook: { id: string; token: string }) =>
    request("POST", `/v1/webhooks/${hook.id}/${hook.token}`, {
      content: "Disposable synthetic post",
    });
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("credentialowner");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Credential lab" }))
      .org.id;
    channelId = (
      await owner.req("GET", `/v1/orgs/${orgId}/channels`)
    ).channels.find(
      (channel: { name: string }) => channel.name === "general",
    ).id;
    const made = await owner.req("POST", "/v2/developer/bots", {
      name: "Credential Bot",
      public: true,
    });
    botId = made.bot.id;
    token = made.token;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions: ["webhooks.manage"],
      rev: 0,
    });
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: ["webhooks.manage"],
      manifestRev: 1,
      rev: 0,
    });
    roleId = (
      await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
        name: "Hook manager",
        permissions: ["webhooks.manage"],
      })
    ).role.id;
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    const grant = await owner.req(
      "GET",
      `/v1/orgs/${orgId}/bots/${botId}/permissions`,
    );
    if (!grant.permissions.includes("webhooks.manage"))
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions: ["webhooks.manage"],
        manifestRev: 1,
        rev: grant.rev,
      });
  });

  it("checks current role, approval and token revision, while human rotation explicitly reclaims a hook", async () => {
    const hook = await make();
    expect((await post(hook)).status).toBe(200);
    await owner.req("DELETE", `/v1/roles/${roleId}/members/${botId}`);
    expect((await post(hook)).status).toBe(404);
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: [],
      manifestRev: 1,
      rev: 1,
    });
    expect((await post(hook)).status).toBe(404);
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: ["webhooks.manage"],
      manifestRev: 1,
      rev: 2,
    });
    token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
      .token;
    expect((await post(hook)).status).toBe(404);
    const reclaimed = await owner.req("POST", `${prefix()}/${hook.id}/token`);
    expect((await post({ id: hook.id, token: reclaimed.token })).status).toBe(
      200,
    );
    expect((await post(hook)).status).toBe(404);
  });

  it("cannot mint a credential bound to a newer token after request authentication was revoked", async () => {
    const policy = h.ctx.bots.permissions;
    const original = policy.prepareCredential.bind(policy);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    policy.prepareCredential = async (...args) => {
      entered();
      await barrier;
      return original(...args);
    };
    try {
      const pending = request(
        "POST",
        prefix().replace("/v1/", "/v2/bot/"),
        { name: "Must not survive rotation" },
        token,
      );
      await Promise.race([
        waiting,
        pending.then((response) => {
          throw new Error(
            `Request stopped before credential preparation: ${response.status}`,
          );
        }),
      ]);
      token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
        .token;
      release();
      expect((await pending).status).toBe(403);
    } finally {
      release();
      policy.prepareCredential = original;
    }
  });

  it("keeps a denial binding after uninstall/deletion instead of turning it into a human webhook", async () => {
    const hook = await make();
    await owner.req("DELETE", `/v1/orgs/${orgId}/bots/${botId}`);
    expect((await post(hook)).status).toBe(404);
    await owner.req("DELETE", `/v2/developer/bots/${botId}`);
    expect((await post(hook)).status).toBe(404);
    const reclaimed = await owner.req("POST", `${prefix()}/${hook.id}/token`);
    expect((await post({ id: hook.id, token: reclaimed.token })).status).toBe(
      200,
    );
  });
});
