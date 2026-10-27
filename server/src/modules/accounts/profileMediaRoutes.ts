import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import { ProfileStyleBody } from "../../shared/contracts/http/users.js";
import { ApiError, badRequest, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { deleteBlobNow } from "../files/index.js";
import { storePhoto } from "./photos.js";
import { allows, type ProfileRow, privacyOf, relation } from "./profile.js";
import { announceProfileChange } from "./profileEvents.js";
import { gifInfo, type ImageInfo, jpegInfo, sniff, webpInfo } from "./mediaFormats.js";
import { type AvatarMedia, avatarBlob, avatarMediaOf, type Banner, bannerBlob, bannerOf, posterBlob, type Style, styleOf } from "./profileMedia.js";

/**
 * Richer profiles (API 0.45.0, docs/PROFILE_MEDIA.md): an animated avatar (GIF, animated WebP, or a short video clip
 * the server cuts to 3 s, crops square, strips of sound and re-encodes), a profile banner (JPEG, or animated GIF or
 * WebP), and a style (a decoration, an effect and an accent from fixed lists). Every file is recognised by its bytes,
 * its size, dimensions, frames and length are checked here, and it's served with a fixed content type to whoever may
 * see the person's photo. Like the photo, none of it is end-to-end encrypted.
 */

export const PROFILE_MEDIA_LIMITS = {
  /** Animated avatars as uploaded (GIF or WebP). */
  avatarImageBytes: 4 * 1024 * 1024,
  avatarMaxSide: 1024,
  avatarMaxFrames: 600,
  /** A video clip as uploaded, before the server re-encodes it. */
  clipUploadBytes: 12 * 1024 * 1024,
  /** Clips longer than this are refused; up to it they're cut to [clipSeconds]. */
  clipMaxSeconds: 6,
  clipSeconds: 3,
  clipSide: 320,
  /** Banners: a still JPEG, or an animated GIF or WebP. */
  bannerJpegBytes: 1024 * 1024,
  bannerAnimatedBytes: 6 * 1024 * 1024,
  bannerMaxWidth: 2048,
  bannerMaxHeight: 1024,
  bannerMaxFrames: 600,
  toolMs: 60_000,
} as const;

const MIME = { gif: "image/gif", webp: "image/webp", jpeg: "image/jpeg", video: "video/mp4" } as const;

/** Reads an octet-stream body of at most [max] bytes, stopping as soon as it's larger. */
async function readBody(req: FastifyRequest, max: number, what: string): Promise<Buffer> {
  const body = req.body as Readable | undefined;
  if (!body || typeof body.pipe !== "function") throw badRequest("Expected application/octet-stream body");
  const tooLarge = () => new ApiError(413, "too_large", `${what} can be up to ${Math.round(max / (1024 * 1024))} MB`);
  if (Number(req.headers["content-length"] ?? Number.NaN) > max) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += (c as Buffer).length;
    if (size > max) {
      body.destroy();
      throw tooLarge();
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Runs ffmpeg or ffprobe with an argument array the server built (never a shell), within a time limit. */
function runTool(bin: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out = (out + c.toString("utf8")).slice(-200_000)));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString("utf8")).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), PROFILE_MEDIA_LIMITS.toolMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

const ffmpegBin = () => process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * A short video clip as a 3 s, square, silent H.264 MP4 and a JPEG poster frame. ffprobe checks it's really a video no
 * longer than the limit first; anything ffmpeg can't read is refused.
 */
async function transcodeClip(ctx: AppContext, input: Buffer): Promise<{ mp4: Buffer; poster: Buffer }> {
  const dir = await fs.promises.mkdtemp(path.join(ctx.blobs.spoolDir ?? os.tmpdir(), "clip-"));
  const src = path.join(dir, "in");
  const outMp4 = path.join(dir, "out.mp4");
  const outJpg = path.join(dir, "poster.jpg");
  try {
    await fs.promises.writeFile(src, input, { mode: 0o600 });
    let probe: { code: number | null; stdout: string };
    try {
      probe = await runTool(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", src]);
    } catch {
      throw new ApiError(503, "media_engine_unavailable", "This server can't process video clips (its media engine isn't installed). Use a GIF or WebP instead.");
    }
    const info = (() => {
      try {
        return JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
      } catch {
        return null;
      }
    })();
    const video = info?.streams?.find((s) => s.codec_type === "video");
    const duration = Number(info?.format?.duration ?? Number.NaN);
    if (probe.code !== 0 || !video || !Number.isFinite(duration)) throw badRequest("That file isn't a video this server can read.");
    if (duration > PROFILE_MEDIA_LIMITS.clipMaxSeconds) throw badRequest(`Video clips can be up to ${PROFILE_MEDIA_LIMITS.clipMaxSeconds} seconds; they're shown as ${PROFILE_MEDIA_LIMITS.clipSeconds} second loops.`);
    const side = PROFILE_MEDIA_LIMITS.clipSide;
    const crop = `crop='min(iw,ih)':'min(iw,ih)',scale=${side}:${side},fps=30`;
    const enc = await runTool(ffmpegBin(), [
      "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-t", String(PROFILE_MEDIA_LIMITS.clipSeconds), "-an", "-vf", crop,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "main", "-crf", "28", "-movflags", "+faststart", "-map_metadata", "-1", outMp4,
    ]);
    if (enc.code !== 0) throw badRequest("That video couldn't be converted. Try another clip.");
    const pos = await runTool(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-i", outMp4, "-frames:v", "1", "-q:v", "4", outJpg]);
    if (pos.code !== 0) throw badRequest("That video couldn't be converted. Try another clip.");
    return { mp4: await fs.promises.readFile(outMp4), poster: await fs.promises.readFile(outJpg) };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function checkImage(info: ImageInfo | null, maxW: number, maxH: number, maxFrames: number, what: string): void {
  if (!info) throw badRequest(`That ${what} file is damaged or not a supported image.`);
  if (info.width > maxW || info.height > maxH) throw badRequest(`That ${what} is ${info.width} × ${info.height}; the most is ${maxW} × ${maxH}.`);
  if (info.frames > maxFrames) throw badRequest(`That ${what} has ${info.frames} frames; the most is ${maxFrames}.`);
}

export default async function profileMediaRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  const row = (id: string) => ctx.db.prepare("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(id) as (ProfileRow & { avatar_media: string | null; profile_banner: string | null; profile_style: string | null }) | undefined;

  app.put("/v1/users/me/avatar-media", auth, async (req) => {
    const { userId } = me(req);
    const buf = await readBody(req, PROFILE_MEDIA_LIMITS.clipUploadBytes, "Animated avatars");
    const kind = sniff(buf);
    const L = PROFILE_MEDIA_LIMITS;
    const rev = Math.max(now(), (avatarMediaOf(row(userId) ?? {})?.rev ?? 0) + 1);
    let media: AvatarMedia;
    if (kind === "gif" || kind === "webp") {
      if (buf.length > L.avatarImageBytes) throw new ApiError(413, "too_large", `Animated avatars can be up to ${L.avatarImageBytes / (1024 * 1024)} MB`);
      checkImage(kind === "gif" ? gifInfo(buf) : webpInfo(buf), L.avatarMaxSide, L.avatarMaxSide, L.avatarMaxFrames, "avatar");
      await storePhoto(ctx, avatarBlob(userId, rev), buf);
      media = { kind, rev };
    } else if (kind === "mp4" || kind === "webm") {
      const { mp4, poster } = await transcodeClip(ctx, buf);
      await storePhoto(ctx, avatarBlob(userId, rev), mp4);
      await storePhoto(ctx, posterBlob(userId, rev), poster);
      media = { kind: "video", rev };
    } else throw badRequest("Animated avatars are GIF or WebP images, or short MP4 or WebM video clips.");
    const previous = avatarMediaOf(row(userId) ?? {});
    ctx.db.prepare("UPDATE users SET avatar_media = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(media), now(), userId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", avatarBlob(userId, previous.rev));
      if (previous.kind === "video") await deleteBlobNow(ctx, "profile-photos", posterBlob(userId, previous.rev));
    }
    ctx.audit({ actorId: userId, action: "profile.avatar_media", detail: media.kind });
    announceProfileChange(ctx, userId);
    return { avatarMedia: media };
  });

  app.delete("/v1/users/me/avatar-media", auth, async (req) => {
    const { userId } = me(req);
    const previous = avatarMediaOf(row(userId) ?? {});
    ctx.db.prepare("UPDATE users SET avatar_media = NULL, updated_at = ? WHERE id = ?").run(now(), userId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", avatarBlob(userId, previous.rev));
      if (previous.kind === "video") await deleteBlobNow(ctx, "profile-photos", posterBlob(userId, previous.rev));
      announceProfileChange(ctx, userId);
    }
    return { avatarMedia: null };
  });

  app.put("/v1/users/me/profile-banner", auth, async (req) => {
    const { userId } = me(req);
    const L = PROFILE_MEDIA_LIMITS;
    const buf = await readBody(req, L.bannerAnimatedBytes, "Profile banners");
    const kind = sniff(buf);
    if (kind === "jpeg") {
      if (buf.length > L.bannerJpegBytes) throw new ApiError(413, "too_large", "Still banners can be up to 1 MB");
      checkImage(jpegInfo(buf), L.bannerMaxWidth, L.bannerMaxHeight, 1, "banner");
    } else if (kind === "gif" || kind === "webp") {
      checkImage(kind === "gif" ? gifInfo(buf) : webpInfo(buf), L.bannerMaxWidth, L.bannerMaxHeight, L.bannerMaxFrames, "banner");
    } else throw badRequest("Profile banners are JPEG images, or animated GIF or WebP images. Video banners aren't supported.");
    const previous = bannerOf(row(userId) ?? {});
    const rev = Math.max(now(), (previous?.rev ?? 0) + 1);
    await storePhoto(ctx, bannerBlob(userId, rev), buf);
    const banner: Banner = { kind, rev };
    ctx.db.prepare("UPDATE users SET profile_banner = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(banner), now(), userId);
    if (previous) await deleteBlobNow(ctx, "profile-photos", bannerBlob(userId, previous.rev));
    ctx.audit({ actorId: userId, action: "profile.banner", detail: kind });
    announceProfileChange(ctx, userId);
    return { profileBanner: banner };
  });

  app.delete("/v1/users/me/profile-banner", auth, async (req) => {
    const { userId } = me(req);
    const previous = bannerOf(row(userId) ?? {});
    ctx.db.prepare("UPDATE users SET profile_banner = NULL, updated_at = ? WHERE id = ?").run(now(), userId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", bannerBlob(userId, previous.rev));
      announceProfileChange(ctx, userId);
    }
    return { profileBanner: null };
  });

  app.put("/v1/users/me/profile-style", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(ProfileStyleBody, req.body);
    const current = styleOf(row(userId) ?? {});
    const next: Style = {
      decoration: body.decoration === undefined ? current.decoration : body.decoration,
      effect: body.effect === undefined ? current.effect : body.effect,
      accent: body.accent === undefined ? current.accent : (body.accent?.toLowerCase() ?? null),
    };
    ctx.db.prepare("UPDATE users SET profile_style = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), userId);
    announceProfileChange(ctx, userId);
    return { profileStyle: next };
  });

  /** A person's profile file, to whoever may see their photo; the same 404 for "none" and "not allowed". */
  const serve = async (req: FastifyRequest, reply: FastifyReply, pick: (u: NonNullable<ReturnType<typeof row>>) => { blob: string; type: string; rev: number } | null) => {
    const { id } = parse(idParams, req.params);
    const u = row(id);
    if (!u || !allows(privacyOf(u).photo, relation(ctx, me(req).userId, u.id))) throw notFound("Not found");
    const chosen = pick(u);
    const stream = chosen ? await ctx.blobs.get("profile-photos", chosen.blob) : null;
    if (!chosen || !stream) throw notFound("Not found");
    return reply.header("content-type", chosen.type).header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=3600").header("etag", `"${chosen.rev}"`).send(stream);
  };

  app.get("/v1/users/:id/avatar-media", auth, async (req, reply) =>
    serve(req, reply, (u) => {
      const a = avatarMediaOf(u);
      return a ? { blob: avatarBlob(u.id, a.rev), type: MIME[a.kind], rev: a.rev } : null;
    }),
  );
  app.get("/v1/users/:id/avatar-poster", auth, async (req, reply) =>
    serve(req, reply, (u) => {
      const a = avatarMediaOf(u);
      return a?.kind === "video" ? { blob: posterBlob(u.id, a.rev), type: "image/jpeg", rev: a.rev } : null;
    }),
  );
  app.get("/v1/users/:id/profile-banner", auth, async (req, reply) =>
    serve(req, reply, (u) => {
      const b = bannerOf(u);
      return b ? { blob: bannerBlob(u.id, b.rev), type: MIME[b.kind], rev: b.rev } : null;
    }),
  );
}

