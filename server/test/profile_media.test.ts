import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gifInfo, jpegInfo, sniff, webpInfo } from "../src/modules/accounts/mediaFormats.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.45.0 (docs/PROFILE_MEDIA.md): animated avatars, short video clips, profile banners and profile style. */

/** A GIF of [frames] frames of [w] × [h] (one-colour, uncompressed-ish LZW: enough for a parser). */
function gif(w: number, h: number, frames: number): Buffer {
  const head = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
  const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]);
  const frame = Buffer.concat([
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
  ]);
  return Buffer.concat([head, loop, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

/** An animated WebP's chunk structure (VP8X canvas, [frames] ANMF chunks): what the parser reads. */
function webp(w: number, h: number, frames: number): Buffer {
  const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from(Uint32Array.of(body.length).buffer), body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const u24 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
  const vp8x = chunk("VP8X", Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(w - 1), u24(h - 1)]));
  const anim = chunk("ANIM", Buffer.alloc(6));
  const anmf = chunk("ANMF", Buffer.alloc(24));
  const body = Buffer.concat([Buffer.from("WEBP"), vp8x, anim, ...Array.from({ length: frames }, () => anmf)]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

/** A baseline JPEG header with a size (SOF0), enough for the size check. */
function jpeg(w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3]), Buffer.alloc(9), Buffer.from([0xff, 0xd9])]);
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
function clip(seconds: number): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-test-"));
  const out = path.join(dir, "c.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=480x270:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=duration=${seconds}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
  const b = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return b;
}

let h: Harness;
let ada: GriipClient, bob: GriipClient, eve: GriipClient;

beforeAll(async () => {
  h = await startServer();
  [ada, bob, eve] = await Promise.all(["ada", "bob", "eve"].map((n) => h.client(n)));
  // Ada and Bob are contacts (a direct conversation); Eve is a stranger.
  await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId });
});
afterAll(async () => h.close());

describe("recognising media by its bytes", () => {
  it("reads GIF and WebP sizes and frames, JPEG sizes, and refuses broken files", () => {
    expect(sniff(gif(10, 10, 2))).toBe("gif");
    expect(gifInfo(gif(64, 32, 3))).toEqual({ width: 64, height: 32, frames: 3 });
    expect(gifInfo(gif(64, 32, 3).subarray(0, 40))).toBeNull();
    expect(webpInfo(webp(200, 100, 4))).toEqual({ width: 200, height: 100, frames: 4 });
    expect(jpegInfo(jpeg(1200, 480))).toEqual({ width: 1200, height: 480, frames: 1 });
    expect(sniff(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("animated avatars", () => {
  it("are advertised, and a GIF is served only to whoever may see the photo", async () => {
    expect((await ada.req("GET", "/v1/server-info")).features).toContain("profile-media");
    const g = gif(128, 128, 5);
    const { avatarMedia } = await ada.req("PUT", "/v1/users/me/avatar-media", undefined, g);
    expect(avatarMedia).toMatchObject({ kind: "gif", rev: expect.any(Number) });
    expect(Buffer.compare(await eve.req("GET", `/v1/users/${ada.userId}/avatar-media`), g)).toBe(0);
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.avatarMedia).toEqual(avatarMedia);
    await ada.req("PUT", "/v1/users/me/privacy", { photo: "contacts" });
    await expectStatus(eve.req("GET", `/v1/users/${ada.userId}/avatar-media`), 404);
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.avatarMedia).toBeUndefined();
    expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.avatarMedia).toEqual(avatarMedia);
    await ada.req("PUT", "/v1/users/me/privacy", { photo: "everyone" });
  });

  it("refuse other files, oversized images and too many frames", async () => {
    await expectStatus(ada.req("PUT", "/v1/users/me/avatar-media", undefined, Buffer.from("<svg onload=alert(1)>")), 400);
    await expectStatus(ada.req("PUT", "/v1/users/me/avatar-media", undefined, gif(2048, 2048, 1)), 400);
    await expectStatus(ada.req("PUT", "/v1/users/me/avatar-media", undefined, gif(16, 16, 700)), 400);
    await expectStatus(ada.req("PUT", "/v1/users/me/avatar-media", undefined, Buffer.concat([gif(16, 16, 1), Buffer.alloc(13 * 1024 * 1024)])), 413);
    expect((await ada.req("PUT", "/v1/users/me/avatar-media", undefined, webp(256, 256, 8))).avatarMedia.kind).toBe("webp");
  });

  it.skipIf(!hasFfmpeg)("turn a short video into a 3 s silent square loop with a poster, and refuse long ones", async () => {
    const { avatarMedia } = await ada.req("PUT", "/v1/users/me/avatar-media", undefined, clip(4));
    expect(avatarMedia.kind).toBe("video");
    const mp4 = await bob.req("GET", `/v1/users/${ada.userId}/avatar-media`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-out-"));
    fs.writeFileSync(path.join(dir, "o.mp4"), mp4);
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path.join(dir, "o.mp4")]).toString());
    fs.rmSync(dir, { recursive: true, force: true });
    expect(Number(info.format.duration)).toBeLessThanOrEqual(3.1);
    expect(info.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(["video"]);
    expect(info.streams[0]).toMatchObject({ width: 320, height: 320 });
    expect(sniff(await bob.req("GET", `/v1/users/${ada.userId}/avatar-poster`))).toBe("jpeg");
    await expectStatus(ada.req("PUT", "/v1/users/me/avatar-media", undefined, clip(8)), 400);
  }, 60_000);

  it("are removed cleanly", async () => {
    expect((await ada.req("DELETE", "/v1/users/me/avatar-media")).avatarMedia).toBeNull();
    await expectStatus(bob.req("GET", `/v1/users/${ada.userId}/avatar-media`), 404);
  });
});

describe("profile banners and style", () => {
  it("take a still JPEG or an animated GIF/WebP within the limits, never a video", async () => {
    expect((await ada.req("PUT", "/v1/users/me/profile-banner", undefined, jpeg(1200, 480))).profileBanner.kind).toBe("jpeg");
    expect(sniff(await eve.req("GET", `/v1/users/${ada.userId}/profile-banner`))).toBe("jpeg");
    expect((await ada.req("PUT", "/v1/users/me/profile-banner", undefined, gif(600, 240, 6))).profileBanner.kind).toBe("gif");
    await expectStatus(ada.req("PUT", "/v1/users/me/profile-banner", undefined, jpeg(4000, 3000)), 400);
    await expectStatus(ada.req("PUT", "/v1/users/me/profile-banner", undefined, Buffer.from("\x00\x00\x00\x18ftypisom")), 400);
    expect((await ada.req("DELETE", "/v1/users/me/profile-banner")).profileBanner).toBeNull();
  });

  it("keeps a decoration, effect and accent from the fixed lists, shown to everyone", async () => {
    const { profileStyle } = await ada.req("PUT", "/v1/users/me/profile-style", { decoration: "aurora", effect: "sparkles", accent: "#EC4899" });
    expect(profileStyle).toEqual({ decoration: "aurora", effect: "sparkles", accent: "#ec4899" });
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle).toEqual(profileStyle);
    await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { decoration: "nitro-clone" }), 400);
    await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { accent: "red" }), 400);
    expect((await ada.req("PUT", "/v1/users/me/profile-style", { effect: null })).profileStyle).toEqual({ decoration: "aurora", effect: null, accent: "#ec4899" });
  });
});
