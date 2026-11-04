import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness, expectStatus } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { BOT_DOMAIN_ADAPTERS } from "../src/shared/contracts/http/botDomainAdapters.js";

describe("scoped bot platform", () => {
  let h: Harness, owner: GriipClient, member: GriipClient;
  let orgId: string, botId: string, token: string;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    credential = `Bot ${token}`,
  ) => {
    const response = await fetch(h.baseUrl + path, {
      method,
      headers: {
        authorization: credential,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("platformowner");
    member = await h.client("platformmember");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Scoped bot lab" }))
      .org.id;
    const invite = (
      await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
    ).invite.code;
    await member.req("POST", "/v1/invites/accept", { code: invite });
    const bot = await owner.req("POST", "/v2/developer/bots", {
      name: "Scoped Bot",
      public: true,
    });
    botId = bot.bot.id;
    token = bot.token;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("requires explicit installation approval and refuses stale or unrequested permission grants", async () => {
    const path = `/v2/bot/orgs/${orgId}/channels`;
    expect((await request("GET", path)).status).toBe(403);
    const manifest = await owner.req(
      "PUT",
      `/v2/developer/bots/${botId}/permissions`,
      {
        permissions: ["channels.read", "channels.manage", "members.ban"],
        rev: 0,
      },
    );
    expect(manifest.rev).toBe(1);
    expect(await owner.req("GET", `/v2/bots/${botId}/permissions`)).toEqual(manifest);
    await expectStatus(
      member.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        permissions: [],
        rev: 1,
      }),
      404,
    );
    await expectStatus(
      owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions: ["channels.read"],
        manifestRev: 99,
        rev: 0,
      }),
      409,
    );
    await expectStatus(
      owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions: ["roles.manage"],
        manifestRev: 1,
        rev: 0,
      }),
      403,
    );
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions: ["channels.read", "channels.manage"],
      manifestRev: 1,
      rev: 0,
    });
    expect((await request("GET", path)).status).toBe(200);
    expect((await request("GET", `/v1/orgs/${orgId}/channels`)).status).toBe(
      401,
    );
    expect(
      (await request("GET", path, undefined, `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it("keeps native role authority independent of approval and immediately observes role removal", async () => {
    const path = `/v2/bot/orgs/${orgId}/channels`;
    expect(
      (await request("POST", path, { name: "denied-before-role" })).status,
    ).toBe(403);
    const { role } = await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
      name: "Bot channel editor",
      permissions: ["channels.manage", "channels.create"],
    });
    await owner.req("PUT", `/v1/roles/${role.id}/members/${botId}`);
    const created = await request("POST", path, {
      name: "approved-bot-channel",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await owner.req("DELETE", `/v1/roles/${role.id}/members/${botId}`);
    expect(
      (await request("POST", path, { name: "denied-after-role" })).status,
    ).toBe(403);
  });

  it("does not let a limited manager approve powers they lack", async () => {
    const { role } = await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
      name: "Bot installer",
      permissions: ["workspace.edit"],
    });
    await owner.req("PUT", `/v1/roles/${role.id}/members/${member.userId}`);
    await owner.req("PATCH", `/v2/developer/bots/${botId}`, { public: false });
    await expectStatus(member.req("GET", `/v2/bots/${botId}/permissions`), 404);
    const review = await member.req(
      "GET",
      `/v1/orgs/${orgId}/bots/${botId}/permission-review`,
    );
    expect(review.manifest.botId).toBe(botId);
    expect(review.approvable).toContain("channels.read");
    expect(review.approvable).not.toContain("members.ban");
    await expectStatus(
      member.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions: ["members.ban"],
        manifestRev: 1,
        rev: 1,
      }),
      403,
    );
    expect(
      (await owner.req("GET", `/v1/orgs/${orgId}/bots/${botId}/permissions`))
        .rev,
    ).toBe(1);
  });

  it("manifest expansion never expands an old approval and removal immediately retracts access", async () => {
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions: [
        "channels.read",
        "channels.manage",
        "members.ban",
        "events.read",
      ],
      rev: 1,
    });
    expect(
      h.ctx.bots.permissions.allows(
        (await h.ctx.bots.store.bot(botId))!,
        orgId,
        "events.read",
      ),
    ).toBe(false);
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions: [],
      rev: 2,
    });
    expect(
      (await request("GET", `/v2/bot/orgs/${orgId}/channels`)).status,
    ).toBe(403);
  });

  it("every administrative adapter rejects missing bot credentials before handling its body", async () => {
    for (const route of BOT_DOMAIN_ADAPTERS) {
      const path = route.url.replace(/:[A-Za-z]+/g, "unknown");
      const response = await h.app.inject({
        method: route.method,
        url: path,
        ...(route.method === "GET" || route.method === "DELETE"
          ? {}
          : { payload: {} }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });
});
