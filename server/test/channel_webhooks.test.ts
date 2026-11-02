import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logUrl } from "../src/app/server.js";
import { webhookPayload } from "../src/modules/organizations/posting/webhookPayload.js";
import { WebhookMessageBody, WebhookWithToken } from "../src/shared/contracts/http/webhooks.js";
import { ApiError } from "../src/shared/errors.js";
import { sha256Hex } from "../src/shared/utilities/util.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Channel webhooks and "Make a post" (community parity batch C, feature "channel-webhooks",
 * docs/COMMUNITY_PARITY_API.md › Posting tools): holders of webhooks.manage make up to 10 per channel, the token is
 * shown once and kept hashed, and anyone with the address posts Discord's webhook JSON as an ordinary channel message.
 * Runs with the community tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const code = (e: { error: { code: string } }) => e.error.code;
/** MongoDB makes every community collection the first time a test database is used. */
const STARTUP_MS = 120_000;

/** POST to a webhook's address the way an outside tool does: no session. */
async function hook(h: Harness, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(h.baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("channel webhooks with communities in %s", (backend, env) => {
  let h: Harness;
  let owner: GriipClient, admin: GriipClient, mod: GriipClient, member: GriipClient;
  let orgId: string, general: string, voice: string, forum: string;
  let webhookId: string, token: string;
  const base = () => `/v1/orgs/${orgId}/channels/${general}/webhooks`;
  const history = async (c: GriipClient, conv: string) => (await c.req("GET", `/v2/conversations/${conv}/messages`)).messages;

  beforeAll(async () => {
    h = await startServer({ ...env });
    expect(!!h.ctx.mongo?.owns("workspace")).toBe(backend === "mongodb");
    [owner, admin, mod, member] = await Promise.all(["whowner", "whadmin", "whmod", "whmember"].map((x) => h.client(x)));
    for (const c of [owner, admin, mod, member]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Hook Town" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [admin, mod, member]) await c.req("POST", "/v1/invites/accept", { code: invite });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
    const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Moderators", template: "moderator" })).role;
    expect(role.permissions).toContain("webhooks.manage");
    await owner.req("PUT", `/v1/roles/${role.id}/members/${mod.userId}`);
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "news" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
    forum = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "ideas", format: "forum" })).channel.id;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("is advertised, and only holders of webhooks.manage see or make webhooks", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("channel-webhooks");
    expect(code(await expectStatus(member.req("GET", base()), 403))).toBe("forbidden");
    expect(code(await expectStatus(member.req("POST", base(), {}), 403))).toBe("forbidden");
    expect(await mod.req("GET", base())).toEqual({ webhooks: [], limit: 10 });
    expect(code(await expectStatus(admin.req("POST", `/v1/orgs/${orgId}/channels/${voice}/webhooks`, {}), 400))).toBe("webhook_channel");
  });

  it("gives a new webhook a friendly name and shows its token once, keeping only a hash", async () => {
    const made = await mod.req("POST", base(), {});
    expect(WebhookWithToken.safeParse(made).success).toBe(true);
    expect(made.webhook.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(made.webhook).toMatchObject({ channelId: general, avatarUrl: null, lastUsedAt: null, createdBy: { id: mod.userId } });
    expect(made.token).toMatch(/^mqw_[A-Za-z0-9_-]{43}$/);
    ({ id: webhookId } = made.webhook);
    token = made.token;
    const listed = await admin.req("GET", base());
    expect(JSON.stringify(listed)).not.toContain(token);
    const row = h.ctx.ws.get<{ token_hash: string }>("channel_webhooks", { id: webhookId })!;
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "webhook.create", target: webhookId })).toBe(1);
  });

  it("posts Discord's JSON as a channel message with boxes, buttons and the webhook's name", async () => {
    const r = await hook(h, `/v1/webhooks/${webhookId}/${token}?wait=true`, {
      content: "Deploy finished",
      username: "CI",
      embeds: [{ title: "Build 42", description: "All green", color: "#2ECC71", url: "https://ci.example.com/42", footer: { text: "main" }, fields: [{ name: "x", value: "y" }] }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open", url: "https://ci.example.com/42", emoji: { name: "🚀" } }] }],
      buttons: [{ label: "Docs", url: "https://docs.example.com" }],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: expect.any(String), channelId: general, serverTs: expect.any(Number) });
    const msg = (await history(member, general)).find((m: { id: string }) => m.id === r.json.id);
    expect(msg.payload).toEqual({
      type: "text",
      text: "Deploy finished",
      embeds: [{ title: "Build 42", description: "All green", url: "https://ci.example.com/42", color: 0x2ecc71, footer: { text: "main" } }],
      buttons: [
        { kind: "link", label: "Docs", emoji: null, url: "https://docs.example.com" },
        { kind: "link", label: "Open", emoji: "🚀", url: "https://ci.example.com/42" },
      ],
      webhook: { id: webhookId, name: "CI", avatarUrl: null },
    });
    // Its own sender account: a bot that is a member of nothing.
    const sender = h.ctx.ws.get<{ user_id: string }>("channel_webhooks", { id: webhookId })!.user_id;
    expect(msg.senderUserId).toBe(sender);
    expect(h.ctx.ws.count("org_members", { user_id: sender })).toBe(0);
    expect((await admin.req("GET", base())).webhooks[0].lastUsedAt).toBe(r.json.serverTs);
  });

  it("validates strictly: https only, Discord's limits, something to show", async () => {
    const post = (body: unknown) => hook(h, `/v1/webhooks/${webhookId}/${token}`, body);
    for (const bad of [
      {},
      { content: "   " },
      { content: "x".repeat(2001) },
      { embeds: Array.from({ length: 11 }, () => ({ title: "t" })) },
      { embeds: [{ title: "t".repeat(257) }] },
      { embeds: [{ description: "d".repeat(4000) }, { description: "d".repeat(2001) }] },
      { embeds: [{ url: "https://x.example" }] },
      { embeds: [{ title: "t", image: { url: "http://insecure.example/a.png" } }] },
      { content: "x", buttons: [{ label: "Bad", url: "javascript:alert(1)" }] },
      { content: "x", buttons: [{ url: "https://x.example" }] },
      { content: "x", buttons: Array.from({ length: 6 }, (_, i) => ({ label: `b${i}`, url: "https://x.example" })) },
      { content: "x", components: [{ type: 1, components: [{ type: 2, style: 1, label: "Click", custom_id: "a" }] }] },
      { content: "x", avatar_url: "ftp://x.example/a.png" },
    ]) {
      const r = await post(bad);
      expect([r.status, r.json.error?.code], JSON.stringify(bad).slice(0, 80)).toEqual([400, "bad_request"]);
    }
    expect((await post({ content: "ok", embeds: [{ title: "colour", color: 255 }] })).status).toBe(200);
  });

  it("refuses unknown and wrong tokens alike, and a new address retires the old one", async () => {
    expect((await hook(h, `/v1/webhooks/${webhookId}/mqw_${"A".repeat(43)}`, { content: "hi" })).status).toBe(404);
    expect((await hook(h, `/v1/webhooks/wh_nowhere/${token}`, { content: "hi" })).status).toBe(404);
    const rotated = await admin.req("POST", `${base()}/${webhookId}/token`);
    expect(rotated.token).not.toBe(token);
    expect((await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: "old" })).status).toBe(404);
    token = rotated.token;
    expect((await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: "new" })).status).toBe(200);
  });

  it("isn't held up by slowmode, but an archived channel refuses it", async () => {
    await owner.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 60 });
    for (const n of [1, 2]) expect((await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: `fast ${n}` })).status).toBe(200);
    await owner.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 0, archived: true });
    const r = await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: "late" });
    expect([r.status, r.json.error.code]).toEqual([403, "forbidden"]);
    await owner.req("PATCH", `/v1/conversations/${general}`, { archived: false });
  });

  it("never lets people's own messages carry boxes, buttons or webhook details", async () => {
    for (const extra of [{ embeds: [{ title: "Fake" }] }, { buttons: [] }, { webhook: { id: webhookId, name: "Admin", avatarUrl: null } }]) {
      const send = member.req("POST", "/v2/messages", { conversationId: general, messageId: `m_fake_${Math.random().toString(36).slice(2)}`, cls: "message", sentAt: Date.now(), payload: { type: "text", text: "hi", ...extra } });
      expect(code(await expectStatus(send, 400))).toBe("bad_request");
    }
  });

  it("makes a post for holders of webhooks.manage, and needs a title in a forum", async () => {
    const body = { content: "Welcome!", embeds: [{ title: "Rules", description: "Be kind." }], buttons: [{ emoji: "📜", label: "Guidelines", url: "https://meldiq.example/guidelines" }] };
    expect(code(await expectStatus(member.req("POST", `${base()}/${webhookId}/post`, body), 403))).toBe("forbidden");
    const posted = await mod.req("POST", `${base()}/${webhookId}/post`, body);
    expect(posted.channelId).toBe(general);
    const forumHook = (await admin.req("POST", `/v1/orgs/${orgId}/channels/${forum}/webhooks`, { name: "Ideas bot" })).webhook.id;
    const forumBase = `/v1/orgs/${orgId}/channels/${forum}/webhooks/${forumHook}/post`;
    expect(code(await expectStatus(admin.req("POST", forumBase, { content: "untitled" }), 400))).toBe("bad_request");
    const post = await admin.req("POST", forumBase, { thread_name: "Dark mode", embeds: [{ description: "Please add it" }] });
    const msg = (await history(member, forum)).find((m: { id: string }) => m.id === post.id);
    expect(msg.payload).toMatchObject({ title: "Dark mode", text: "Dark mode\n\nPlease add it", textFromEmbeds: true, webhook: { name: "Ideas bot" } });
  });

  it("renames, sets a picture members can fetch, and messages name it", async () => {
    expect((await mod.req("PATCH", `${base()}/${webhookId}`, { name: "Deploys" })).webhook.name).toBe("Deploys");
    const pictured = await mod.req("PUT", `${base()}/${webhookId}/avatar`, undefined, JPEG);
    expect(pictured.webhook.avatarUrl).toMatch(new RegExp(`^/v1/webhooks/${webhookId}/avatar\\?rev=\\d+$`));
    expect(Buffer.compare(await member.req("GET", pictured.webhook.avatarUrl), JPEG)).toBe(0);
    const r = await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: "with picture" });
    const msg = (await history(member, general)).find((m: { id: string }) => m.id === r.json.id);
    expect(msg.payload.webhook).toEqual({ id: webhookId, name: "Deploys", avatarUrl: pictured.webhook.avatarUrl });
    expect((await mod.req("DELETE", `${base()}/${webhookId}/avatar`)).webhook.avatarUrl).toBeNull();
  });

  it("stops at 10 per channel", async () => {
    const have = (await admin.req("GET", base())).webhooks.length;
    for (let i = have; i < 10; i++) await admin.req("POST", base(), { name: `Hook ${i}` });
    const refused = await expectStatus(admin.req("POST", base(), {}), 409);
    expect(refused.error).toMatchObject({ code: "webhook_limit", details: { limit: 10 } });
  });

  it("deletes a webhook: its address stops working and what it posted stays", async () => {
    const before = (await history(member, general)).filter((m: { payload: { webhook?: { id: string } } }) => m.payload.webhook?.id === webhookId).length;
    expect(before).toBeGreaterThan(0);
    expect(await mod.req("DELETE", `${base()}/${webhookId}`)).toEqual({ deleted: true });
    expect((await hook(h, `/v1/webhooks/${webhookId}/${token}`, { content: "gone" })).status).toBe(404);
    expect((await history(member, general)).filter((m: { payload: { webhook?: { id: string } } }) => m.payload.webhook?.id === webhookId).length).toBe(before);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "webhook.delete", target: webhookId })).toBe(1);
  });

  it("limits posts per webhook address", async () => {
    const made = await admin.req("POST", `/v1/orgs/${orgId}/channels/${forum}/webhooks`, {});
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await hook(h, `/v1/webhooks/${made.webhook.id}/${made.token}`, { thread_name: `t${i}`, content: "x" })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("channel webhooks switched off (CHANNEL_WEBHOOKS=off)", () => {
  it("aren't advertised and their routes answer 503", async () => {
    const h = await startServer({ CHANNEL_WEBHOOKS: "off" });
    try {
      const owner = await h.client("whoff");
      expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("channel-webhooks");
      const orgId = (await owner.req("POST", "/v1/orgs", { name: "No Hooks" })).org.id;
      const channel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
      expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/channels/${channel}/webhooks`), 503))).toBe("feature_disabled");
      expect((await hook(h, "/v1/webhooks/wh_x/mqw_y", { content: "hi" })).status).toBe(503);
    } finally {
      await h.close();
    }
  });
});

describe("webhook payloads", () => {
  const as = { id: "wh_1", name: "Plucky Puffin", avatarUrl: null };
  const payload = (body: unknown, forum = false) => webhookPayload(WebhookMessageBody.parse(body), as, forum);

  it("makes text from the boxes when there's no content, for apps that can't show boxes", () => {
    expect(payload({ embeds: [{ title: "Hello", description: "World" }, { title: "Again" }] })).toEqual({
      type: "text",
      text: "Hello\nWorld\n\nAgain",
      embeds: [{ title: "Hello", description: "World" }, { title: "Again" }],
      textFromEmbeds: true,
      webhook: as,
    });
  });

  it("takes the poster's name and picture over the webhook's", () => {
    expect(payload({ content: "hi", username: "Bob", avatar_url: "https://img.example/b.png" }).webhook).toEqual({ id: "wh_1", name: "Bob", avatarUrl: "https://img.example/b.png" });
  });

  it("refuses a box with nothing in it", () => {
    expect(() => payload({ content: "hi", embeds: [{ color: 3 }] })).toThrow(ApiError);
  });

  it("never logs a webhook's token", () => {
    expect(logUrl("/v1/webhooks/wh_1/mqw_secret?wait=true")).toBe("/v1/webhooks/wh_1/<token>?wait=true");
    expect(logUrl("/v1/webhooks/wh_1/avatar?rev=3")).toBe("/v1/webhooks/wh_1/avatar?rev=3");
  });
});
