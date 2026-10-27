/**
 * Recognising profile media by its bytes, never by a name or a declared type (docs/PROFILE_MEDIA.md): JPEG, GIF, WebP
 * and the video containers ffmpeg then checks itself. GIF and WebP are walked block by block to read their size and
 * count their frames; anything that doesn't parse cleanly is refused. Pure functions, no I/O.
 */
export type ImageKind = "jpeg" | "gif" | "webp" | "png";
export type VideoKind = "mp4" | "webm";

export function sniff(b: Buffer): ImageKind | VideoKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  return null;
}

export interface ImageInfo {
  width: number;
  height: number;
  frames: number;
}

/** A GIF's logical screen size and its number of images; null when the stream is malformed or truncated. */
export function gifInfo(b: Buffer): ImageInfo | null {
  if (sniff(b) !== "gif" || b.length < 13) return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1));
  let frames = 0;
  const skipBlocks = (): boolean => {
    for (;;) {
      if (p >= b.length) return false;
      const n = b[p++];
      if (n === 0) return true;
      p += n;
    }
  };
  for (;;) {
    if (p >= b.length) return null;
    const tag = b[p++];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      p++;
      if (!skipBlocks()) return null;
    } else if (tag === 0x2c) {
      if (p + 9 > b.length) return null;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1));
      p++; // LZW minimum code size
      if (!skipBlocks()) return null;
      frames++;
    } else return null;
  }
  return frames > 0 && width > 0 && height > 0 ? { width, height, frames } : null;
}

/** A WebP's canvas size and frame count (1 for a still image); null when the chunks don't add up. */
export function webpInfo(b: Buffer): ImageInfo | null {
  if (sniff(b) !== "webp") return null;
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  let p = 12;
  let width = 0;
  let height = 0;
  let frames = 0;
  let still = false;
  while (p + 8 <= riffEnd) {
    const id = b.toString("latin1", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (body + size > riffEnd) return null;
    if (id === "VP8X" && size >= 10) {
      width = 1 + b.readUIntLE(body + 4, 3);
      height = 1 + b.readUIntLE(body + 7, 3);
    } else if (id === "ANMF") frames++;
    else if (id === "VP8 " && size >= 10 && !width) {
      width = b.readUInt16LE(body + 6) & 0x3fff;
      height = b.readUInt16LE(body + 8) & 0x3fff;
      still = true;
    } else if (id === "VP8L" && size >= 5 && !width) {
      const bits = b.readUInt32LE(body + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      still = true;
    } else if (id === "VP8 " || id === "VP8L") still = true;
    p = body + size + (size & 1);
  }
  if (!width || !height) return null;
  return { width, height, frames: frames || (still ? 1 : 0) };
}

/** A JPEG's size from its first start-of-frame marker; null when there's none. */
export function jpegInfo(b: Buffer): ImageInfo | null {
  if (sniff(b) !== "jpeg") return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    const len = b.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7), frames: 1 };
    }
    p += 2 + len;
  }
  return null;
}
