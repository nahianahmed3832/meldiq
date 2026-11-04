import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { startServer, type Harness, expectStatus } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe("revocable bot invitation links", () => {
  let h: Harness,
    owner: GriipClient,
    visitor: GriipClient,
    orgId: string,
    botId: string,
    token: string,
    roleId: string;
  const grant = async (permissions: string[]) => {
    const prior = await owner.req(
      "GET",
      `/v1/orgs/${orgId}/bots/${botId}/permissions`,
    );
    await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions,
      manifestRev: 1,
      rev: prior.rev,
    });
  };
  const create = async () => {
    const response = await fetch(`${h.baseUrl}/v2/bot/orgs/${orgId}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "MEMBER" }),
    });
    return { status: response.status, body: await response.json() };
  };
  const make = async () => {
    const result = await create();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.invite.code as string;
  };
  const preview = (code: string) =>
    visitor.req("POST", "/v1/invites/preview", { code });
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("botinviteowner");
    visitor = await h.client("botinvitevisitor");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Bot invite lab" }))
      .org.id;
    const made = await owner.req("POST", "/v2/developer/bots", {
      name: "Inviter",
    });
    botId = made.bot.id;
    token = made.token;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions: ["members.invite"],
      rev: 0,
    });
    roleId = (
      await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
        name: "Inviter",
        permissions: ["members.invite"],
      })
    ).role.id;
  });
  beforeEach(async () => {
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    await grant(["members.invite"]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  });

  it("checks current role and scope, then permanently rejects links from the previous token", async () => {
    const code = await make();
    expect((await preview(code)).org.id).toBe(orgId);
    await owner.req("DELETE", `/v1/roles/${roleId}/members/${botId}`);
    // Default member invitations may still be allowed. An explicit deny must stop the link too.
    await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, {
      permissions: [],
    });
    await expectStatus(preview(code), 404);
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    await grant([]);
    await expectStatus(preview(code), 404);
    await grant(["members.invite"]);
    expect((await preview(code)).org.id).toBe(orgId);
    token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
      .token;
    await expectStatus(preview(code), 404);
    expect((await preview(await make())).org.id).toBe(orgId);
  });

  it("rejects minting when rotation completes after asynchronous preparation but before the invitation write", async () => {
    const policy = h.ctx.bots.permissions,
      original = policy.prepareInvite.bind(policy);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    policy.prepareInvite = async (...args) => {
      const value = await original(...args);
      entered();
      await barrier;
      return value;
    };
    try {
      const pending = create();
      await Promise.race([
        waiting,
        pending.then((result) => {
          throw new Error(`Stopped before preparation: ${result.status}`);
        }),
      ]);
      token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
        .token;
      release();
      expect((await pending).status).toBe(403);
    } finally {
      release();
      policy.prepareInvite = original;
    }
  });

  it("honors current bot plan locks and platform suspension without affecting human-created invitations", async () => {
    const botCode = await make();
    const humanCode = (
      await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
    ).invite.code;
    const plan = vi
      .spyOn(h.ctx.mojo, "limitsOf")
      .mockReturnValue({ bots: 0 } as never);
    try {
      await expectStatus(preview(botCode), 404);
      expect((await preview(humanCode)).org.id).toBe(orgId);
    } finally {
      plan.mockRestore();
    }
    const original = h.ctx.accounts.identityBlocked.bind(h.ctx.accounts);
    const suspension = vi
      .spyOn(h.ctx.accounts, "identityBlocked")
      .mockImplementation((id) => id === botId || original(id));
    try {
      await expectStatus(preview(botCode), 404);
    } finally {
      suspension.mockRestore();
    }
    expect((await preview(botCode)).org.id).toBe(orgId);
  });

  it("revokes on uninstall, requires a fresh approval on reinstall and preserves denial after deletion", async () => {
    const code = await make();
    await owner.req("DELETE", `/v1/orgs/${orgId}/bots/${botId}`);
    await expectStatus(preview(code), 404);
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    await expectStatus(preview(code), 404);
    expect(
      (await owner.req("GET", `/v1/orgs/${orgId}/bots/${botId}/permissions`))
        .permissions,
    ).toEqual([]);
    await grant(["members.invite"]);
    await owner.req("PUT", `/v1/roles/${roleId}/members/${botId}`);
    await expectStatus(preview(code), 404);
    const fresh = await make();
    await owner.req("DELETE", `/v2/developer/bots/${botId}`);
    await expectStatus(preview(fresh), 404);
  });
});
