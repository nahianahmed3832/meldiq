import type { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import { gifInfo, type ImageInfo, readBody, sniff, webpInfo } from "../accounts/index.js";
import { ApiError, badRequest } from "../../shared/errors.js";

/**
 * Animated community icons and banners (API 0.64.0, docs/COMMUNITY_BRANDING.md): besides the JPEG the apps make from a
 * still picture, an animated GIF or WebP is stored as sent, like a person's animated avatar and banner. The kind isn't
 * stored: it's read from the file's first bytes when it's served, so an older server still serves the same files.
 */
export const COMMUNITY_IMAGE_LIMITS = {
  icon: { stillBytes: 512 * 1024, animatedBytes: 4 * 1024 * 1024, maxWidth: 1024, maxHeight: 1024, maxFrames: 600 },
  banner: { stillBytes: 1024 * 1024, animatedBytes: 6 * 1024 * 1024, maxWidth: 2048, maxHeight: 1024, maxFrames: 600 },
} as const;

type Which = keyof typeof COMMUNITY_IMAGE_LIMITS;

const MB = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

function check(info: ImageInfo | null, which: Which, what: string): void {
  const L = COMMUNITY_IMAGE_LIMITS[which];
  if (!info) throw badRequest(`That ${what} file is damaged or not a supported image.`);
  if (info.width > L.maxWidth || info.height > L.maxHeight) throw badRequest(`That ${what} is ${info.width} × ${info.height}; the most is ${L.maxWidth} × ${L.maxHeight}.`);
  if (info.frames > L.maxFrames) throw badRequest(`That ${what} has ${info.frames} frames; the most is ${L.maxFrames}.`);
}

/** A community icon or banner upload: a JPEG, or an animated GIF or WebP, checked by its bytes. */
export async function readCommunityImage(req: FastifyRequest, which: Which, what: string): Promise<Buffer> {
  const L = COMMUNITY_IMAGE_LIMITS[which];
  const buf = await readBody(req, L.animatedBytes, what);
  const kind = sniff(buf);
  if (kind === "jpeg") {
    if (buf.length > L.stillBytes) throw new ApiError(413, "too_large", `Still ${what.toLowerCase()} can be up to ${L.stillBytes >= 1024 * 1024 ? MB(L.stillBytes) : `${L.stillBytes / 1024} KB`}`);
    // The apps crop and re-encode still pictures themselves, as before 0.64.0: no further check.
    return buf;
  }
  if (kind === "gif" || kind === "webp") {
    check(kind === "gif" ? gifInfo(buf) : webpInfo(buf), which, what.toLowerCase());
    return buf;
  }
  throw badRequest(`${what} are JPEG images, or animated GIF or WebP images.`);
}

const TYPES: Record<string, string> = { jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The stored file's content type, read from its first bytes; the stream is handed back whole. JPEG when unsure. */
export function withImageType(stream: Readable): Promise<{ type: string; body: Readable }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      stream.pause();
      stream.unshift(chunk);
      resolve({ type: TYPES[sniff(chunk) ?? ""] ?? "image/jpeg", body: stream });
    };
    const onEnd = () => {
      cleanup();
      resolve({ type: "image/jpeg", body: stream });
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}
