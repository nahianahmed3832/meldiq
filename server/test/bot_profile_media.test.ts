import sharp from "sharp";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe("bot identity and native profile media", () => {
  let h: Harness, owner: GriipClient, botId: string, token: string;
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    raw?: Buffer,
  ) => {
    const response = await fetch(h.baseUrl + path, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        ...(raw
          ? { "content-type": "application/octet-stream" }
          : body
            ? { "content-type": "application/json" }
            : {}),
      },
      ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("botmediaowner");
    const made = await owner.req("POST", "/v2/developer/bots", {
      name: "Media Helper",
    });
    botId = made.bot.id;
    token = made.token;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("changes its own display/status and presence preference, with no owner-account mutation", async () => {
    const profile = await request("PATCH", "/v2/bot/users/me", {
      displayName: "Media Helper Updated",
      statusText: "Available for approved tasks",
    });
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect((await request("GET", "/v2/bot/me")).body.bot.displayName).toBe(
      "Media Helper Updated",
    );
    expect(
      (await request("PUT", "/v2/bot/users/me/presence", { mode: "idle" })).body
        .mode,
    ).toBe("idle");
    expect(
      (await owner.req("GET", `/v1/users/${owner.userId}`)).user.displayName,
    ).not.toBe("Media Helper Updated");
    expect(
      (
        await request("PATCH", `/v2/bot/users/${owner.userId}`, {
          displayName: "Must not change",
        })
      ).status,
    ).toBe(404);
  });

  it("uploads/serves/removes its GIF avatar through the existing MIME and privacy controller", async () => {
    const result = await request(
      "PUT",
      "/v2/bot/users/me/avatar-media",
      undefined,
      gif,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.avatarMedia).toMatchObject({
      kind: "gif",
      rev: expect.any(Number),
    });
    const stored = await owner.req("GET", `/v1/users/${botId}/avatar-media`);
    expect(Buffer.compare(stored, gif)).toBe(0);
    expect(
      (
        await request(
          "PUT",
          "/v2/bot/users/me/avatar-media",
          undefined,
          Buffer.from('<svg onload="alert(1)"></svg>'),
        )
      ).status,
    ).toBe(400);
    expect(
      (await request("DELETE", "/v2/bot/users/me/avatar-media")).body
        .avatarMedia,
    ).toBeNull();
  });

  it("uses native still-photo/banner storage and clears only its own media", async () => {
    const jpeg = await sharp({
      create: {
        width: 32,
        height: 16,
        channels: 3,
        background: { r: 17, g: 18, b: 19 },
      },
    })
      .jpeg()
      .toBuffer();
    const photo = await request(
      "PUT",
      "/v2/bot/users/me/photo",
      undefined,
      jpeg,
    );
    expect(photo.status, JSON.stringify(photo.body)).toBe(200);
    expect(photo.body.photoRev).toEqual(expect.any(Number));
    const banner = await request(
      "PUT",
      "/v2/bot/users/me/profile-banner",
      undefined,
      jpeg,
    );
    expect(banner.status, JSON.stringify(banner.body)).toBe(200);
    expect(banner.body.profileBanner).toMatchObject({
      kind: "jpeg",
      rev: expect.any(Number),
    });
    expect(
      Buffer.compare(
        await owner.req("GET", `/v1/users/${botId}/profile-banner`),
        jpeg,
      ),
    ).toBe(0);
    expect(
      (await request("DELETE", "/v2/bot/users/me/profile-banner")).body
        .profileBanner,
    ).toBeNull();
    expect(
      (await request("DELETE", "/v2/bot/users/me/photo")).body.photoRev,
    ).toBeNull();
    const ownerProfile = (await owner.req("GET", `/v1/users/${owner.userId}`))
      .user;
    expect(ownerProfile.avatarMedia).toBeUndefined();
    expect(ownerProfile.profileBanner).toBeUndefined();
  });
});
