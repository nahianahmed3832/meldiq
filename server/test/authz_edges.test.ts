import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
let owner: GriipClient, inviter: GriipClient;
let org: string, inviterRole: string;

beforeAll(async () => {
  h = await startServer();
  owner = await h.client("edgeowner");
  inviter = await h.client("edgemanager");
  org = (await owner.req("POST", "/v1/orgs", { name: "Edge Co" })).org.id;
  inviterRole = (await owner.req("POST", `/v1/orgs/${org}/roles`, { name: "Greeter", permissions: ["members.invite"], denies: [] })).role.id;
  const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })).invite.code;
  await inviter.req("POST", "/v1/invites/accept", { code });
  await owner.req("PUT", `/v1/roles/${inviterRole}/members/${inviter.userId}`);
});
afterAll(async () => h.close());

describe("invites are re-checked against their creator's current rights (T3.1)", () => {
  it("an invite from someone whose role let them invite stops working once the role is taken away", async () => {
    const code = (await inviter.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
    const early = await h.client("edgeearly");
    await early.req("POST", "/v1/invites/accept", { code }); // works while they may still invite

    await owner.req("DELETE", `/v1/roles/${inviterRole}/members/${inviter.userId}`);
    const late = await h.client("edgelate");
    await expectStatus(late.req("POST", "/v1/invites/preview", { code }), 404);
    await expectStatus(late.req("POST", "/v1/invites/accept", { code }), 404);
    expect((await owner.req("GET", `/v1/orgs/${org}/members`)).members.map((m: any) => m.id)).not.toContain(late.userId);
  });

  it("an admin invite stops working when its owner becomes an admin; others' invites are unaffected", async () => {
    const coOwner = await h.client("edgecoowner");
    const c1 = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "ADMIN" })).invite.code;
    await coOwner.req("POST", "/v1/invites/accept", { code: c1 });
    await owner.req("PATCH", `/v1/orgs/${org}/members/${coOwner.userId}`, { role: "OWNER" });

    const adminInvite = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "ADMIN" })).invite.code;
    const memberInvite = (await coOwner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })).invite.code;
    await coOwner.req("PATCH", `/v1/orgs/${org}/members/${owner.userId}`, { role: "ADMIN" });

    const x = await h.client("edgex");
    await expectStatus(x.req("POST", "/v1/invites/accept", { code: adminInvite }), 404);
    await x.req("POST", "/v1/invites/accept", { code: memberInvite });
    expect((await coOwner.req("GET", `/v1/orgs/${org}/members`)).members.find((m: any) => m.id === x.userId).orgRole).toBe("MEMBER");
  });
});

describe("accounts disabled from the admin CLI are disconnected (T3.3)", () => {
  it("closes their open sockets at the next cleanup run", async () => {
    const quiet = await h.client("edgequiet");
    await quiet.connect();
    const closed = new Promise<void>((r) => quiet.ws!.once("close", () => r()));
    // What `admin.js disable` writes from its own process: the API's hub doesn't hear about it.
    await h.ctx.identity.write((w) => w.update("users", { id: quiet.userId }, { disabled_at: Date.now() }));
    await h.ctx.ephemeral.write((w) => w.delete("sessions", { user_id: quiet.userId }));
    const r = await runCleanup(h.ctx);
    expect(r.disabledDisconnected).toBe(1);
    await closed;
  });
});

describe("archived channels are read-only (T3.2)", () => {
  it("blocks posts and calls until restored, and members keep reading", async () => {
    const o = await h.client("archowner");
    const m = await h.client("archmember");
    const orgId = (await o.req("POST", "/v1/orgs", { name: "Archive Co" })).org.id;
    const code = (await o.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await m.req("POST", "/v1/invites/accept", { code });
    // Posts in a text channel; calls in a voice channel (which takes no messages since batch B14).
    const ch = (await o.req("POST", `/v1/orgs/${orgId}/channels`, { name: "wind-down" })).channel.id;
    const room = (await o.req("POST", `/v1/orgs/${orgId}/channels`, { name: "wind-down-voice", voice: true })).channel.id;
    await m.send(ch, { type: "text", text: "before archiving" });
    await o.req("PATCH", `/v1/conversations/${ch}`, { archived: true });
    await o.req("PATCH", `/v1/conversations/${room}`, { archived: true });
    await expectStatus(m.send(ch, { type: "text", text: "after" }), 403);
    await expectStatus(m.req("POST", "/v1/calls", { conversationId: room }), 409);
    expect((await m.req("GET", `/v1/conversations/${ch}`)).conversation.canPost).toBe(false);
    await o.req("PATCH", `/v1/conversations/${ch}`, { archived: false });
    await m.send(ch, { type: "text", text: "back" });
  });
});
