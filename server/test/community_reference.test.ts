import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

let h: Harness;
let owner: GriipClient, member: GriipClient, other: GriipClient;
let orgId: string, channelId: string;
beforeAll(async () => {
  h = await startServer();
  [owner, member, other] = await Promise.all(
    ["clipowner", "clipmember", "clipother"].map((name) => h.client(name)),
  );
  orgId = (
    await owner.req("POST", "/v1/orgs", {
      name: "Community reference",
      visibility: "public",
      joinPolicy: "open",
    })
  ).org.id;
  for (const person of [member, other])
    await person.req("POST", `/v1/communities/${orgId}/join`);
  channelId = (
    await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
      name: "updates",
      kind: "PUBLIC",
    })
  ).channel.id;
  for (const person of [member, other])
    await person.req("POST", `/v1/conversations/${channelId}/join`);
}, 120_000);
afterAll(async () => h?.close());

describe("community reference", () => {
  it("keeps ping groups separate from roles and includes only opted-in channel members in mentions", async () => {
    const path = `/v1/orgs/${orgId}/ping-roles`;
    await expectStatus(
      member.req("PUT", path, { rev: 0, roles: [{ name: "Events" }] }),
      403,
    );
    const settings = await owner.req("PUT", path, {
      rev: 0,
      roles: [{ name: "Events" }],
    });
    const id = settings.roles[0].id;
    expect(id).toMatch(/^png_/);
    expect(settings.rev).toBe(1);
    await expectStatus(owner.req("PUT", path, { rev: 0, roles: [] }), 409);
    await expectStatus(
      member.req("PUT", `${path}/me`, { roles: ["png_fabricated"] }),
      400,
    );
    expect(
      await member.req("PUT", `${path}/me`, { roles: [id] }),
    ).toMatchObject({ subscribed: [id], canManage: false });
    expect(await other.req("GET", path)).toMatchObject({
      subscribed: [],
      canManage: false,
    });
    const send = async (text: string) => {
      const messageId = randomUUID();
      await other.req("POST", "/v2/messages", {
        conversationId: channelId,
        messageId,
        cls: "message",
        sentAt: Date.now(),
        payload: { type: "text", text, roleMentions: [id] },
      });
      return JSON.parse((await h.ctx.messages.get(messageId))!.payload);
    };
    expect((await send("Hello @Events")).mentions).toEqual([member.userId]);
    expect((await send("No group in the text")).mentions ?? []).toEqual([]);
    expect(
      h.ctx.ws.get("org_role_members", { role_id: id, user_id: member.userId }),
    ).toBeUndefined();
    await member.req("PUT", `${path}/me`, { roles: [] });
    expect((await send("Hello @Events")).mentions ?? []).toEqual([]);
    await owner.req("PUT", path, { rev: 1, roles: [] });
    expect((await member.req("GET", path)).roles).toEqual([]);
  });

  it("lets managers enable clips, keeps the default off, and returns the member setting", async () => {
    const path = `/v1/orgs/${orgId}/settings`;
    expect((await owner.req("GET", path)).voiceClips).toBe(false);
    await expectStatus(member.req("PUT", path, { voiceClips: true }), 403);
    const updates = await Promise.all([
      owner.req("PUT", path, { voiceClips: true }),
      owner.req("PUT", path, { background: "#123abc" }),
    ]);
    expect(updates).toHaveLength(2);
    expect(await owner.req("GET", path)).toMatchObject({
      voiceClips: true,
      background: "#123abc",
    });
    const result = await member.req("GET", `/v1/orgs/${orgId}`);
    expect(result.org.voiceClips).toBe(true);
    await owner.req("PUT", path, { voiceClips: false });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.voiceClips).toBe(
      false,
    );
  });

  it("enforces sticker size and dimensions and advertises the correct quota", async () => {
    const url = `/v1/orgs/${orgId}/expressions`;
    expect((await owner.req("GET", url)).limits).toEqual({
      emoji: 50,
      sticker: 30,
    });
    const raw = Buffer.alloc(320 * 320 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i >>> 9)) % 256;
    const sticker = await sharp(raw, {
      raw: { width: 320, height: 320, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(sticker.length).toBeGreaterThan(256 * 1024);
    const uploaded = (
      await owner.req(
        "POST",
        `${url}?kind=sticker&name=valid_sticker`,
        undefined,
        sticker,
      )
    ).expression;
    expect(uploaded).toMatchObject({ kind: "sticker", size: sticker.length });
    expect(
      await member.req("GET", `/v1/expressions/${uploaded.id}/image`),
    ).toEqual(sticker);
    const oversized = await sharp({
      create: { width: 321, height: 100, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expectStatus(
      owner.req(
        "POST",
        `${url}?kind=sticker&name=wide_sticker`,
        undefined,
        oversized,
      ),
      400,
    );
    await expectStatus(
      owner.req(
        "POST",
        `${url}?kind=sticker&name=big_sticker`,
        undefined,
        Buffer.alloc(512 * 1024 + 1),
      ),
      413,
    );
  });

  it("shows the exact eligibility thresholds and prevents ineligible submissions", async () => {
    const eligibility = `/v1/orgs/${orgId}/partner-eligibility`;
    await expectStatus(member.req("GET", eligibility), 404);
    expect(await owner.req("GET", eligibility)).toMatchObject({
      eligible: false,
      members: 3,
      activeSparks: 0,
      ageDays: 0,
      activeMods: 0,
    });
    await expectStatus(
      owner.req("PUT", `/v1/orgs/${orgId}/partner-application`, {
        baseRev: 0,
        statement: "Insufficient membership",
        checklist: {
          guidelines: true,
          moderation: true,
          safety: true,
          activity: true,
        },
      }),
      409,
    );
  });
});
